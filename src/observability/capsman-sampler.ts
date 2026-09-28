/**
 * CAPsMAN sampler — the slow background job that fills {@link CapsmanStore}.
 *
 * On an interval (default 5 min) it walks every SSH-reachable configured device,
 * fetches the CAPsMAN state ({@link fetchCapsmanState}), and snapshots each
 * radio's *instantaneous* associated-client count + current channel into
 * `capsman_samples` — so the trend graphs keep accumulating even when nobody's
 * watching.
 *
 * Two costs are avoided the same way the usage sampler avoids them:
 *   • MAC-Telnet devices are skipped (a Layer-2 login is slow and serialises with
 *     real tool calls), and
 *   • a device that reports no wireless family at all is memoised in `noCapsman`
 *     so we don't re-run the ~6 detection/read commands against it every tick
 *     (re-probed on restart, exactly like the usage sampler's `noUserManager`).
 *
 * This module is only ever imported by the dashboard server, never by the tool/
 * registry/test graph, so it may freely pull in the device I/O layer.
 */
import { capsmanOverview } from "../core/capsman";
import { createContext } from "../core/context";
import { getConfig } from "../core/runtime";
import { fetchCapsmanState } from "../utils/wifi-query";
import { logger } from "../logger";
import type { CapsmanStore, RadioSample } from "./capsman-store";

const SERVER_TAG = "mikrotik-mcp";
/** Keep ~30 days of radio snapshots. */
export const CAPSMAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default cadence and the bounds the sampler is clamped to (CAPsMAN reads are
 * heavier than a single queue print, so we sample slower than usage). */
export const DEFAULT_CAPSMAN_INTERVAL_MS = 5 * 60_000; // 5 minutes
export const MIN_CAPSMAN_INTERVAL_MS = 60_000; // never faster than 1 min
export const MAX_CAPSMAN_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * Devices with no wireless family at all. Once `fetchCapsmanState` returns a
 * null-path state (no `/interface wifi`, `wifiwave2`, `wireless`, or `/caps-man`),
 * we stop probing that device so the sampler doesn't re-issue the detection
 * sweep every tick. Re-probed on restart.
 */
const noCapsman = new Set<string>();

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_CAPSMAN_INTERVAL_MS;
  return Math.max(MIN_CAPSMAN_INTERVAL_MS, Math.min(MAX_CAPSMAN_INTERVAL_MS, Math.round(ms)));
}

/** Snapshot every radio's current client load for one device. */
async function sampleDevice(store: CapsmanStore, device: string, ts: number): Promise<void> {
  if (noCapsman.has(device)) return;
  const ctx = createContext(undefined, device);
  const state = await fetchCapsmanState(ctx);
  if (state.path === null) {
    noCapsman.add(device); // no wireless here — stop probing this run
    return;
  }
  // `capsmanOverview` already reconciles registrations onto radios (clientCount);
  // reuse it so the sampled load matches what the audit/report shows.
  const overview = capsmanOverview(state);
  const samples: RadioSample[] = overview.radios.map((r) => ({
    radioId: r.radioId,
    cap: r.cap,
    band: r.band,
    channel: r.channel,
    clients: r.clientCount,
  }));
  store.recordRadioSamples(device, ts, samples);
}

/** One sampling pass across every SSH device (reentrancy-guarded). */
export async function sampleCapsmanOnce(store: CapsmanStore): Promise<void> {
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
          await sampleDevice(store, name, ts);
        } catch (e) {
          logger.warn(`[${SERVER_TAG}] capsman sample failed for '${name}': ${String(e)}`);
        }
      }),
    );
    phase = "retention cleanup";
    store.pruneSamples(ts - CAPSMAN_RETENTION_MS);
  } catch (e) {
    // Timer callers do not await this pass. Report failures (including retention)
    // without an unhandled rejection, then release the guard for the next pass.
    logger.warn(`[${SERVER_TAG}] capsman ${phase} failed; next pass will retry: ${String(e)}`);
  } finally {
    inFlight = false;
  }
}

/** Start periodic sampling (one immediate pass, then every `intervalMs`). */
export function startCapsmanSampler(
  store: CapsmanStore,
  intervalMs = DEFAULT_CAPSMAN_INTERVAL_MS,
): void {
  const ms = clampInterval(intervalMs);
  void sampleCapsmanOnce(store);
  timer = setInterval(() => void sampleCapsmanOnce(store), ms);
}

/** Stop periodic sampling. */
export function stopCapsmanSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
