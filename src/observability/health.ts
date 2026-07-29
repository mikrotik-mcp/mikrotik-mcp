/**
 * Device connectivity health checks for the dashboard.
 *
 * Periodically opens a short-lived SSH connection to each configured device and
 * caches a {@link DeviceStatus} (reachable? latency? identity/version?). The
 * dashboard's `/api/devices` reads the cache; the SPA renders it as a live
 * connectivity graph + status table. Probes are best-effort and never throw.
 *
 * Only started when the dashboard is enabled, so the SSH client (and `ssh2`) is
 * never exercised by the offline test runner.
 */
import type { DeviceConfig } from "../config";
import { getConfig } from "../core/runtime";
import { parseDisks, parseKeyValues, parseSystemResource } from "../core/routeros-parse";
import type { RouterDisk } from "../core/routeros-parse";
import { createDeviceClient } from "../core/transport";
import { logger } from "../logger";
import { emitAlertEvent } from "../alerts/engine";
import { parseNeighbors } from "./topology";
import type { Neighbor } from "./topology";

/** Log tag for health-probe diagnostics. */
const LOG_TAG = "mikrotik-mcp";

export interface DeviceStatus {
  /** true = reachable, false = unreachable, null = not probed yet. */
  reachable: boolean | null;
  /** Epoch ms of the last probe, or null. */
  checkedAt: number | null;
  /** Round-trip of the probe (connect + identity), ms, when reachable. */
  latencyMs: number | null;
  /** RouterOS identity name, when reachable. */
  identity?: string;
  /** RouterOS version, when reachable. */
  version?: string;
  /** Failure reason, when unreachable. */
  error?: string;
  // ── live system info (from `/system resource print`, when reachable) ──
  /** Board / model name. */
  boardName?: string;
  /** CPU architecture. */
  architecture?: string;
  /** Number of CPU cores. */
  cpuCount?: number;
  /** Current CPU load, percent 0–100. */
  cpuLoad?: number;
  /** Free RAM, bytes. */
  freeMemory?: number;
  /** Total RAM, bytes. */
  totalMemory?: number;
  /** Used RAM, percent 0–100. */
  memUsedPct?: number;
  /** Free disk (HDD) space, bytes. */
  freeHdd?: number;
  /** Total disk (HDD) space, bytes. */
  totalHdd?: number;
  /** Used disk, percent 0–100. */
  hddUsedPct?: number;
  /**
   * Attached external disks (`/disk print detail`) — USB/NVMe storage that the
   * internal `total-hdd-space` figure does NOT include. Empty when none.
   */
  disks?: RouterDisk[];
  /** Human uptime string (e.g. `1w2d3h`). */
  uptime?: string;
}

/** One sampled point of a device's health, for the realtime sparkline charts. */
export interface MetricSample {
  ts: number;
  cpuLoad: number | null;
  memUsedPct: number | null;
  hddUsedPct: number | null;
  latencyMs: number | null;
}

/** How many samples to keep per device (≈ last 30 min at a 30s cadence). */
const HISTORY_CAP = 60;

const statuses = new Map<string, DeviceStatus>();
const histories = new Map<string, MetricSample[]>();
const neighbors = new Map<string, Neighbor[]>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

const UNKNOWN: DeviceStatus = { reachable: null, checkedAt: null, latencyMs: null };

/** The most recent probe result for a device (UNKNOWN until first probe). */
export function getDeviceStatus(name: string): DeviceStatus {
  return statuses.get(name) ?? UNKNOWN;
}

/** The neighbours (`/ip neighbor`) most recently discovered from a device. */
export function getDeviceNeighbors(name: string): Neighbor[] {
  return neighbors.get(name) ?? [];
}

/** The rolling health-metric history for a device (oldest → newest). */
export function getDeviceHistory(name: string): MetricSample[] {
  return histories.get(name) ?? [];
}

function pushHistory(name: string, sample: MetricSample): void {
  const arr = histories.get(name) ?? [];
  arr.push(sample);
  if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
  histories.set(name, arr);
}

/** Probe one device once and cache the result. */
export async function probeDevice(name: string, dc: DeviceConfig): Promise<DeviceStatus> {
  // MAC-Telnet devices ARE probed (so CPU/memory/disk health is collected for
  // them too), but a MAC-Telnet login is a slow ~30s console negotiation and the
  // device serves one session at a time — so `probeAll` throttles them to a long
  // interval (MAC_PROBE_INTERVAL_MS) to avoid contending with real tool calls.
  // SSH devices are cheap and probed every cycle.
  // Pick the transport by config (SSH or MAC-Telnet). The 8s probe clamp keeps
  // the SSH path snappy; a MAC-Telnet client floors its own prime budget higher
  // (RouterOS's ~10s console stall), so the clamp simply doesn't shorten it.
  const client = createDeviceClient({
    ...dc,
    timeoutMs: Math.min(dc.timeoutMs ?? 10_000, 8_000),
  });
  const t0 = Date.now();
  let status: DeviceStatus;
  try {
    const ok = await client.connect();
    if (!ok) {
      status = {
        reachable: false,
        checkedAt: Date.now(),
        latencyMs: null,
        error: client.lastError ?? "connection failed",
      };
    } else {
      // Fetch the system resource dump FIRST — it carries the metrics this card
      // exists to show (cpu / memory / disk / version / uptime). Doing it as the
      // primary command (rather than after identity) means a fragile transport
      // that only reliably serves the first request per connection still yields
      // the health data; identity is a nice-to-have fetched best-effort below.
      const rawResource = await client.run("/system resource print");
      const checkedAt = Date.now();
      const latencyMs = checkedAt - t0;
      const sys = parseSystemResource(rawResource);

      if (!sys) {
        // Reachable, but the resource dump came back empty/unparseable. Surface
        // the raw output (trimmed) once per probe so this is diagnosable instead
        // of silently showing blank gauges forever.
        logger.warn(
          `[${LOG_TAG}] '${name}' is reachable but '/system resource print' returned no ` +
            `parseable metrics. Raw output: ${JSON.stringify(rawResource.slice(0, 200))}`,
        );
      }

      // Identity is secondary: never let it fail the probe or zero the metrics.
      let identity: string | undefined;
      try {
        identity = parseKeyValues(await client.run("/system identity print")).name || undefined;
      } catch {
        /* identity is optional — the device name from config is the fallback */
      }

      status = {
        reachable: true,
        checkedAt,
        latencyMs,
        identity,
        version: sys?.version,
        boardName: sys?.boardName,
        architecture: sys?.architecture,
        cpuCount: sys?.cpuCount,
        cpuLoad: sys?.cpuLoad,
        freeMemory: sys?.freeMemory,
        totalMemory: sys?.totalMemory,
        memUsedPct: sys?.memUsedPct,
        freeHdd: sys?.freeHdd,
        totalHdd: sys?.totalHdd,
        hddUsedPct: sys?.hddUsedPct,
        uptime: sys?.uptime,
        error: sys ? undefined : "reachable, but no system metrics returned",
      };
      pushHistory(name, {
        ts: checkedAt,
        cpuLoad: sys?.cpuLoad ?? null,
        memUsedPct: sys?.memUsedPct ?? null,
        hddUsedPct: sys?.hddUsedPct ?? null,
        latencyMs,
      });
      // Reuse the open connection to read this device's MNDP/CDP/LLDP neighbour
      // cache for the live topology map. Best-effort: a failure here must never
      // demote an otherwise-healthy device, so it's caught and the prior list is
      // kept (clearing on a transient error would make the map flicker).
      try {
        neighbors.set(name, parseNeighbors(await client.run("/ip neighbor print detail")));
      } catch {
        /* keep the last known neighbour list */
      }
      // External storage: `/system resource` reports only the internal flash, so
      // read `/disk` for any attached USB/NVMe. Best-effort — a device with no
      // `/disk` support (older ROS) or none attached just yields an empty list.
      try {
        status.disks = parseDisks(await client.run("/disk print detail"));
      } catch {
        /* no disk subsystem / none attached — leave undefined */
      }
    }
  } catch (e) {
    status = {
      reachable: false,
      checkedAt: Date.now(),
      latencyMs: null,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    client.disconnect();
  }
  // Emit only on a TRANSITION, never on every probe. The alert engine has its
  // own dedup, but feeding it one "still offline" event per cycle would make
  // every `for` window trivially satisfied and defeat the point of the setting.
  const previous = statuses.get(name)?.reachable ?? null;
  statuses.set(name, status);
  if (previous !== null && previous !== status.reachable) {
    emitAlertEvent({
      kind: "device_state",
      to: status.reachable ? "online" : "offline",
      device: name,
      detail: status.reachable
        ? `Reachable again${status.latencyMs != null ? ` (${status.latencyMs}ms)` : ""}`
        : (status.error ?? "unreachable"),
    });
  }
  return status;
}

/** How often MAC-Telnet devices are background-probed (vs every cycle for SSH).
 * A MAC-Telnet login is slow and serializes with tool calls, so we keep it rare. */
const MAC_PROBE_INTERVAL_MS = 5 * 60_000;
const lastMacProbe = new Map<string, number>();

/** Probe every configured device concurrently (reentrancy-guarded). */
export async function probeAll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = getConfig();
    const now = Date.now();
    await Promise.all(
      Object.entries(cfg.devices).map(([name, dc]) => {
        // Throttle the expensive MAC-Telnet probe so it can't monopolise the
        // device's single session and starve real tool calls.
        if (dc.mac) {
          if (now - (lastMacProbe.get(name) ?? 0) < MAC_PROBE_INTERVAL_MS) return Promise.resolve();
          lastMacProbe.set(name, now);
        }
        return probeDevice(name, dc).catch(() => {
          /* probeDevice never throws, but stay defensive */
        });
      }),
    );
  } finally {
    inFlight = false;
  }
}

/** Start periodic health checks (one immediate pass, then every `intervalMs`). */
export function startHealthChecks(intervalMs = 30_000): void {
  void probeAll();
  timer = setInterval(() => void probeAll(), intervalMs);
}

/** Stop periodic health checks. */
export function stopHealthChecks(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
