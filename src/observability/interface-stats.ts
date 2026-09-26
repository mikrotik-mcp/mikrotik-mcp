import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { Cmd, looksLikeError } from "../core/routeros";
import { parseRecords, parseSize } from "../core/routeros-parse";
import { resolveDeviceName } from "../core/runtime";
import { isYes } from "../utils/yes";
import { clientError } from "./http-error";

export interface InterfaceStats {
  name: string;
  type: string;
  comment: string;
  running: boolean;
  disabled: boolean;
  dynamic: boolean;
  mtu: number | null;
  mac: string;
  rxBytes: number | null;
  txBytes: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDrops: number | null;
  txDrops: number | null;
  queueDrops: number | null;
  linkDowns: number | null;
  rxRate: number | null;
  txRate: number | null;
  rxPps: number | null;
  txPps: number | null;
}

export interface InterfaceSample {
  device: string;
  ts: number;
  interfaces: InterfaceStats[];
  error?: string;
}

const INTERVAL = 2000;
const counter = (value?: string): number | null => {
  const n = parseSize(value);
  return n != null && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Stats-detail groups digits with spaces. Collapse numeric fields only, never names/comments. */
export function parseInterfaceStats(detail: string, stats: string): InterfaceStats[] {
  const normalized = stats.replace(
    /((?:rx|tx|fp-rx|fp-tx)-(?:byte|packet|error|drop|queue-drop)=)(\d+(?:[ \t]+\d{3})*)(?=\s|$)/g,
    (_match, key: string, value: string) => key + value.replace(/[ \t]/g, ""),
  );
  const counters = new Map(parseRecords(normalized).rows.map((r) => [r.name, r]));
  return parseRecords(detail)
    .rows.filter((r) => r.name)
    .map((r) => {
      const s = counters.get(r.name) ?? {};
      const flags = s.flags ?? r.flags ?? "";
      return {
        name: r.name,
        type: r.type || "unknown",
        comment: r.comment || "",
        running: isYes(r.running ?? "") || flags.includes("R"),
        disabled: isYes(r.disabled ?? "") || flags.includes("X"),
        dynamic: isYes(r.dynamic ?? "") || flags.includes("D"),
        mtu: counter(r["actual-mtu"] ?? r.mtu),
        mac: r["mac-address"] || "",
        rxBytes: counter(s["rx-byte"]),
        txBytes: counter(s["tx-byte"]),
        rxPackets: counter(s["rx-packet"]),
        txPackets: counter(s["tx-packet"]),
        rxErrors: counter(s["rx-error"]),
        txErrors: counter(s["tx-error"]),
        rxDrops: counter(s["rx-drop"]),
        txDrops: counter(s["tx-drop"]),
        queueDrops: counter(s["tx-queue-drop"]),
        linkDowns: counter(s["link-downs"] ?? r["link-downs"]),
        rxRate: null,
        txRate: null,
        rxPps: null,
        txPps: null,
      };
    });
}

/** Real elapsed time, not the timer interval; resets/missing reads must not become spikes or zeroes. */
export function interfaceRates(
  current: InterfaceSample,
  previous?: InterfaceSample,
): InterfaceSample {
  if (!previous || previous.error || previous.device !== current.device) return current;
  const seconds = (current.ts - previous.ts) / 1000;
  if (seconds <= 0 || seconds > 30) return current;
  const old = new Map(previous.interfaces.map((row) => [row.name, row]));
  const rate = (a: number | null, b: number | null | undefined, multiplier = 1) =>
    a != null && b != null && a >= b ? ((a - b) * multiplier) / seconds : null;
  return {
    ...current,
    interfaces: current.interfaces.map((row) => {
      const before = old.get(row.name);
      if (!before || before.type !== row.type || before.mac !== row.mac) return row;
      return {
        ...row,
        rxRate: rate(row.rxBytes, before.rxBytes, 8),
        txRate: rate(row.txBytes, before.txBytes, 8),
        rxPps: rate(row.rxPackets, before.rxPackets),
        txPps: rate(row.txPackets, before.txPackets),
      };
    }),
  };
}

async function readInterfaces(device: string): Promise<InterfaceSample> {
  const ctx = createContext(undefined, device);
  const read = async (mode: string) => {
    const output = await executeMikrotikCommand(
      new Cmd("/interface print").raw(mode).raw("without-paging").build(),
      ctx,
    );
    if (looksLikeError(output)) throw new Error(output);
    return output;
  };
  // Sequential reads also work when commands share an interactive Safe Mode session.
  const detail = await read("detail");
  const stats = await read("stats-detail");
  const interfaces = parseInterfaceStats(detail, stats);
  if (!interfaces.length && detail.trim())
    throw new Error("No readable interface records returned");
  return { device, ts: Date.now(), interfaces };
}

type Listener = (sample: InterfaceSample) => void;
interface Hub {
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setTimeout>;
  last?: InterfaceSample;
}
const hubs = new Map<string, Hub>();

/** One non-overlapping bulk reader per router; stop when the last viewer leaves. */
export function subscribeInterfaces(target: string, listener: Listener): () => void {
  const device = resolveDeviceName(target);
  let hub = hubs.get(device);
  if (!hub) {
    hub = { listeners: new Set() };
    hubs.set(device, hub);
    const active = hub;
    const poll = async () => {
      let sample: InterfaceSample;
      try {
        sample = interfaceRates(await readInterfaces(device), active.last);
      } catch (error) {
        sample = { device, ts: Date.now(), interfaces: [], error: clientError(error) };
      }
      if (hubs.get(device) !== active) return;
      active.last = sample;
      for (const fn of active.listeners) fn(sample);
      active.timer = setTimeout(() => void poll(), INTERVAL);
    };
    void poll();
  }
  hub.listeners.add(listener);
  if (hub.last) listener(hub.last);
  const active = hub;
  return () => {
    active.listeners.delete(listener);
    if (!active.listeners.size) {
      clearTimeout(active.timer);
      if (hubs.get(device) === active) hubs.delete(device);
    }
  };
}

/** Uses the dashboard's authenticated same-origin SSE transport; carries no router credentials. */
export function interfaceStatsResponse(req: Request, target: string): Response {
  const device = resolveDeviceName(target);
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe?.();
    clearInterval(heartbeat);
    req.signal.removeEventListener("abort", cleanup);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      if (req.signal.aborted) {
        controller.close();
        return;
      }
      unsubscribe = subscribeInterfaces(device, (sample) =>
        send(`event: interfaces\ndata: ${JSON.stringify(sample)}\n\n`),
      );
      heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
