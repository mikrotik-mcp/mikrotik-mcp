/**
 * Usage sampler — the background job that fills {@link UsageStore}.
 *
 * On an interval (default 1 min) it walks every SSH-reachable configured device
 * and, per device:
 *   • snapshots existing Kid Control counters, with exact-host simple queues
 *     as a fallback, into `usage_samples`, and
 *   • ingests `/user-manager session` accounting records (de-duped by accounting
 *     id) into `vpn_sessions` — so the 3-month usage graphs and the forever
 *     connection heatmap keep accumulating even when nobody's watching.
 *
 * MAC-Telnet devices are skipped: a Layer-2 login is slow and serialises with
 * real tool calls, so we never sample them on a timer. Failures are swallowed
 * per device (offline routers must not stop the others).
 *
 * This module is only ever imported by the dashboard server, never by the tool/
 * registry/test graph, so it may freely pull in the device I/O layer.
 */
import { executeMikrotikCommand } from "../core/connector";
import { isIPv4 } from "node:net";
import { createContext } from "../core/context";
import { commandUnsupported, isEmpty, looksLikeError } from "../core/routeros";
import {
  parseLeadingNumber,
  parseRecords,
  parseRouterosDate,
  parseSize,
} from "../core/routeros-parse";
import { getConfig } from "../core/runtime";
import { logger } from "../logger";
import { parseKidControlOutput } from "../tools/connected-devices";
import type { ClientCounter, UsageStore, VpnSession } from "./usage-store";

const SERVER_TAG = "mikrotik-mcp";
/** Keep ~3 months of client snapshots; sessions are kept forever by the store. */
export const USAGE_RETENTION_MS = 93 * 24 * 60 * 60 * 1000;

/** Default sampling cadence and the bounds the Settings tab is clamped to. */
export const DEFAULT_USAGE_INTERVAL_MS = 60_000; // 1 minute
export const MIN_USAGE_INTERVAL_MS = 30_000; // never hammer the router faster than 30s
export const MAX_USAGE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let currentStore: UsageStore | null = null;
let currentIntervalMs = DEFAULT_USAGE_INTERVAL_MS;

/** Clamp a requested interval into the supported range. */
function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_USAGE_INTERVAL_MS;
  return Math.max(MIN_USAGE_INTERVAL_MS, Math.min(MAX_USAGE_INTERVAL_MS, Math.round(ms)));
}

/** Bytes from a RouterOS size/number field (`"12345"` or `"1.2MiB"`). */
function bytesOf(v: string | undefined): number {
  return parseSize(v) ?? parseLeadingNumber(v) ?? 0;
}

/** Only a single host queue can be attributed to one client. */
function ipOf(target: string): string {
  const [ip, mask, extra] = target.trim().split("/");
  return isIPv4(ip ?? "") && (!mask || mask === "32") && !extra ? ip : "";
}

/** Read existing counters; never enable monitoring or create queues while sampling. */
async function sampleClients(store: UsageStore, device: string, ts: number): Promise<void> {
  const ctx = createContext(undefined, device);
  const samples = new Map<string, ClientCounter>();
  const kid = await executeMikrotikCommand(
    "/ip kid-control device print detail without-paging",
    ctx,
  );
  if (!looksLikeError(kid) && !commandUnsupported(kid)) {
    for (const [ip, counter] of Object.entries(parseKidControlOutput(kid))) {
      // The Clients table uses IPv4. Do not persist IPv6 aliases as extra clients.
      if (isIPv4(ip))
        samples.set(ip, {
          ip,
          rx: counter.rxBytes,
          tx: counter.txBytes,
          source: "kid-control",
        });
    }
  }
  const out = await executeMikrotikCommand("/queue simple print stats detail", ctx);
  const queues =
    isEmpty(out) || looksLikeError(out) || commandUnsupported(out) ? [] : parseRecords(out).rows;
  for (const row of queues) {
    const ip = ipOf(row.target ?? "");
    if (!ip || samples.has(ip) || !row.bytes) continue;
    // `bytes` is RouterOS's `upload/download` (tx/rx).
    const [tx, rx] = (row.bytes ?? "0/0").split("/");
    samples.set(ip, { ip, rx: bytesOf(rx), tx: bytesOf(tx), source: "queue" });
  }
  store.recordClientSamples(device, ts, [...samples.values()]);
}

/**
 * Devices known to lack the `user-manager` package. Once `/user-manager …` comes
 * back as an unsupported command, we stop probing that device so the background
 * sampler doesn't re-issue a failing command every interval — which RouterOS logs
 * as `bad command name user-manager` on the device each time. Re-probed on
 * restart (rare: installing User Manager is a deliberate, infrequent act).
 */
const noUserManager = new Set<string>();

/** Ingest User Manager accounting sessions for one device (deduped by acct id). */
async function ingestSessions(store: UsageStore, device: string): Promise<void> {
  if (noUserManager.has(device)) return; // no user-manager package here — don't spam its log
  const ctx = createContext(undefined, device);
  const out = await executeMikrotikCommand("/user-manager session print detail", ctx);
  // Package not installed → remember and never probe this device again this run.
  if (commandUnsupported(out)) {
    noUserManager.add(device);
    return;
  }
  if (isEmpty(out) || looksLikeError(out)) return;
  const sessions: VpnSession[] = [];
  for (const row of parseRecords(out).rows) {
    const user = row.user ?? "";
    const started = parseRouterosDate(row.started ?? row["start-time"]);
    if (!user || started == null) continue;
    // A stable identity for de-dup: prefer the RADIUS accounting id, else a
    // composite of the fields that uniquely pin one connection.
    const sessionId =
      row["acct-session-id"] ||
      `${user}|${started}|${row["calling-station-id"] ?? row["nas-port-id"] ?? ""}`;
    sessions.push({
      sessionId,
      user,
      service: row.service,
      nas: row["nas-ip-address"] ?? row["nas-port-id"],
      started,
      rx: bytesOf(row.download),
      tx: bytesOf(row.upload),
    });
  }
  store.upsertSessions(device, sessions);
}

/** One sampling pass across every SSH device (reentrancy-guarded). */
export async function sampleUsageOnce(store: UsageStore): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const ts = Date.now();
  let phase = "sampling pass";
  try {
    const cfg = getConfig();
    await Promise.all(
      Object.entries(cfg.devices).map(async ([name, dc]) => {
        if (dc.mac) return; // skip slow MAC-Telnet devices on the timer
        try {
          await sampleClients(store, name, ts);
          await ingestSessions(store, name);
        } catch (e) {
          logger.warn(`[${SERVER_TAG}] usage sample failed for '${name}': ${String(e)}`);
        }
      }),
    );
    phase = "retention cleanup";
    store.pruneSamples(ts - USAGE_RETENTION_MS);
  } catch (e) {
    // Timer callers intentionally do not await this pass. Keep storage failures
    // observable without turning a background task into an unhandled rejection.
    logger.warn(`[${SERVER_TAG}] usage ${phase} failed; next pass will retry: ${String(e)}`);
  } finally {
    inFlight = false;
  }
}

/** Start periodic sampling (one immediate pass, then every `intervalMs`). */
export function startUsageSampler(store: UsageStore, intervalMs = DEFAULT_USAGE_INTERVAL_MS): void {
  currentStore = store;
  currentIntervalMs = clampInterval(intervalMs);
  void sampleUsageOnce(store);
  timer = setInterval(() => void sampleUsageOnce(store), currentIntervalMs);
}

/** The active sampling interval in milliseconds. */
export function getUsageSamplerInterval(): number {
  return currentIntervalMs;
}

/**
 * Change the sampling cadence at runtime (restarting the timer with the new,
 * clamped interval). Returns the interval actually applied.
 */
export function setUsageSamplerInterval(intervalMs: number): number {
  currentIntervalMs = clampInterval(intervalMs);
  if (timer) clearInterval(timer);
  if (currentStore) {
    const store = currentStore;
    timer = setInterval(() => void sampleUsageOnce(store), currentIntervalMs);
  }
  return currentIntervalMs;
}

/** Stop periodic sampling. */
export function stopUsageSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  currentStore = null;
}
