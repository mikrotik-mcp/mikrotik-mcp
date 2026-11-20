/**
 * Packet loss on the management path, for the dashboard's Devices page.
 *
 * Every 5 s the server opens a TCP connection to each management address of
 * each router and closes it again. No answer in 1 s counts as a lost probe.
 * A TCP probe needs no raw socket and no OS `ping`, and it measures the same
 * path that SSH uses. Thirty minutes of probes stay in memory.
 *
 * Not probed: MAC-Telnet routers (no IP) and routers behind a jump host (this
 * machine cannot reach their address).
 */
import { connect } from "node:net";
import type { DeviceConfig } from "../config";
import { getConfig } from "../core/runtime";

export const LOSS_PROBE_INTERVAL_MS = 5_000;
export const LOSS_PROBE_LIMIT_MS = 1_000;
export const LOSS_WINDOW_MS = 30 * 60_000;
/** Probes drawn as ticks in the table and beside each address. */
export const LOSS_TAPE_PROBES = 30;

/** One probe: when it started, and the answer time. `null` = no answer. */
export interface LossProbe {
  ts: number;
  ms: number | null;
}

export interface LossMinute {
  /** Start of the minute, epoch ms. */
  ts: number;
  sent: number;
  lost: number;
  pct: number;
  avgMs: number | null;
}

export interface LossSummary {
  sent: number;
  lost: number;
  pct: number;
  /** Longest run of lost probes, as time without an answer. */
  longestGapMs: number;
  longestGapAt: number | null;
  avgMs: number | null;
  /** Mean change between one answer time and the next. */
  jitterMs: number | null;
  /** The newest probes, oldest first: true = lost. */
  recent: boolean[];
  minutes: LossMinute[];
}

export interface AddressLoss {
  host: string;
  sent: number;
  lost: number;
  pct: number;
  recent: boolean[];
}

export interface DeviceLoss extends LossSummary {
  /** The address these figures are for: the one MCP uses now. */
  host: string;
  addresses: AddressLoss[];
}

const pctOf = (lost: number, sent: number): number => (sent ? (lost / sent) * 100 : 0);
const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

/** Totals, the longest gap, answer times and a row for each minute. Pure. */
export function summarizeLoss(probes: readonly LossProbe[]): LossSummary {
  const answers = probes.flatMap((p) => (p.ms == null ? [] : [p.ms]));
  const lost = probes.length - answers.length;

  let longestGapMs = 0;
  let longestGapAt: number | null = null;
  let runStart: number | null = null;
  let runLength = 0;
  for (const probe of probes) {
    if (probe.ms != null) {
      runStart = null;
      runLength = 0;
      continue;
    }
    runStart ??= probe.ts;
    runLength += 1;
    if (runLength * LOSS_PROBE_INTERVAL_MS > longestGapMs) {
      longestGapMs = runLength * LOSS_PROBE_INTERVAL_MS;
      longestGapAt = runStart;
    }
  }

  const byMinute = new Map<number, LossProbe[]>();
  for (const probe of probes) {
    const minute = Math.floor(probe.ts / 60_000) * 60_000;
    const list = byMinute.get(minute);
    if (list) list.push(probe);
    else byMinute.set(minute, [probe]);
  }
  const minutes = [...byMinute.entries()].map(([ts, list]): LossMinute => {
    const minuteLost = list.filter((p) => p.ms == null).length;
    return {
      ts,
      sent: list.length,
      lost: minuteLost,
      pct: pctOf(minuteLost, list.length),
      avgMs: mean(list.flatMap((p) => (p.ms == null ? [] : [p.ms]))),
    };
  });

  return {
    sent: probes.length,
    lost,
    pct: pctOf(lost, probes.length),
    longestGapMs,
    longestGapAt,
    avgMs: mean(answers),
    jitterMs: mean(answers.slice(1).map((ms, i) => Math.abs(ms - answers[i]!))),
    recent: probes.slice(-LOSS_TAPE_PROBES).map((p) => p.ms == null),
    minutes,
  };
}

/** Time for a TCP connection to open, or `null` when it does not open in `limitMs`. */
export function tcpProbe(host: string, port: number, limitMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port });
    const cleanup: (() => void)[] = [() => socket.destroy()];
    const done = (ms: number | null): void => {
      for (const step of cleanup) step();
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), limitMs);
    cleanup.push(() => clearTimeout(timer));
    socket.once("connect", () => done(Math.round(performance.now() - started)));
    socket.once("error", () => done(null));
  });
}

/** device name → address → probes, oldest first. */
const store = new Map<string, Map<string, LossProbe[]>>();
let timer: ReturnType<typeof setInterval> | null = null;

/** The addresses this machine can probe for a router. */
function probeTargets(dc: DeviceConfig): string[] {
  if (dc.mac || dc.disabled || dc.jumpVia || dc.jumpHost) return [];
  return [dc.host, ...(dc.fallbackHosts ?? [])];
}

/** Probe every address of every router once and store the results. */
export async function sampleLoss(probe: typeof tcpProbe = tcpProbe): Promise<void> {
  const devices = getConfig().devices;
  for (const name of store.keys()) if (!devices[name]) store.delete(name);
  const now = Date.now();
  await Promise.all(
    Object.entries(devices).flatMap(([name, dc]) => {
      const hosts = probeTargets(dc);
      const byHost = store.get(name) ?? new Map<string, LossProbe[]>();
      store.set(name, byHost);
      for (const host of byHost.keys()) if (!hosts.includes(host)) byHost.delete(host);
      // Create the lists first, so the addresses keep their configured order.
      for (const host of hosts) if (!byHost.has(host)) byHost.set(host, []);
      return hosts.map(async (host) => {
        const ms = await probe(host, dc.port, LOSS_PROBE_LIMIT_MS);
        const list = byHost.get(host);
        if (!list) return;
        list.push({ ts: now, ms });
        while (list.length && list[0]!.ts < now - LOSS_WINDOW_MS) list.shift();
      });
    }),
  );
}

/**
 * Loss for one router. The main figures are for `inUse`, the address MCP
 * connects to now; every address has its own short summary.
 */
export function getDeviceLoss(name: string, inUse?: string): DeviceLoss | undefined {
  const byHost = store.get(name);
  if (!byHost?.size) return undefined;
  const host = inUse && byHost.has(inUse) ? inUse : [...byHost.keys()][0]!;
  return {
    host,
    ...summarizeLoss(byHost.get(host)!),
    addresses: [...byHost.entries()].map(([address, probes]) => {
      const { sent, lost, pct, recent } = summarizeLoss(probes);
      return { host: address, sent, lost, pct, recent };
    }),
  };
}

export function startLossSampler(): void {
  if (timer) return;
  void sampleLoss();
  timer = setInterval(() => void sampleLoss(), LOSS_PROBE_INTERVAL_MS);
}

export function stopLossSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  store.clear();
}
