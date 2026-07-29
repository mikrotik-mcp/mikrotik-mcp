/**
 * Per-device capability cache.
 *
 * A probe costs seven commands, so it must happen once per device and be shared
 * by everything that asks. The cache therefore stores the **in-flight promise**,
 * not the resolved value: if five tools are invoked concurrently against a cold
 * cache they all await the same probe instead of firing thirty-five commands.
 * The resolved value is mirrored onto the same entry so the registration path,
 * which cannot await, can read it synchronously.
 *
 * In-memory only. A restart costs one probe per device, which is cheaper than
 * reasoning about a stale persisted model after a firmware upgrade.
 */
import { probeDevice } from "./capability-probe";
import { unknownCapabilities } from "./capability";
import type { Capabilities } from "./capability";
import { createContext } from "./context";
import { resolveDeviceName } from "./runtime";
import { logger } from "../logger";

/** How long a probe stays fresh. RouterOS facts change only on upgrade/reboot. */
export const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  /** The probe promise — shared by every concurrent caller. */
  promise: Promise<Capabilities>;
  /** When the probe STARTED, so a slow probe cannot extend its own freshness. */
  startedAt: number;
  /** Mirrored on resolution, so `peekCapabilities` can be synchronous. */
  value?: Capabilities;
}

const cache = new Map<string, Entry>();

/** Test seam: `Date.now()` by default. */
let clock = (): number => Date.now();

/** Replace the clock (tests only). Pass nothing to restore the real one. */
export function setCapabilityClock(fn?: () => number): void {
  clock = fn ?? ((): number => Date.now());
}

/** Test seam: the probe function, so the cache can be exercised without a device. */
let prober = probeDevice;

/** Replace the prober (tests only). Pass nothing to restore the real one. */
export function setCapabilityProber(fn?: typeof probeDevice): void {
  prober = fn ?? probeDevice;
}

/**
 * Capabilities for a device, probing at most once per TTL.
 *
 * Never rejects: a probe that throws resolves to {@link unknownCapabilities},
 * which every predicate reads as "do not block". A capability lookup must not be
 * able to fail a tool call that would otherwise have succeeded.
 */
export function getCapabilities(deviceName?: string): Promise<Capabilities> {
  const key = resolveDeviceName(deviceName);
  const now = clock();
  const hit = cache.get(key);
  if (hit && now - hit.startedAt < CAPABILITY_TTL_MS) return hit.promise;

  const entry: Entry = {
    startedAt: now,
    promise: Promise.resolve()
      .then(() => prober(createContext(undefined, deviceName), now))
      .catch((e: unknown) => {
        // Drop the failed entry so the next call retries rather than serving a
        // failure for six hours.
        cache.delete(key);
        logger.debug(
          `[capability] probe failed for '${key}': ${e instanceof Error ? e.message : String(e)}`,
        );
        return { ...unknownCapabilities(), probedAt: now };
      })
      .then((caps) => {
        entry.value = caps;
        return caps;
      }),
  };

  cache.set(key, entry);
  return entry.promise;
}

/**
 * The cached model if a probe has already resolved, else undefined.
 *
 * Synchronous, for the registration path — tool descriptions are fixed when the
 * server starts and cannot await a probe. A cold cache returns undefined, which
 * callers MUST read as "no information", never as "unsupported".
 */
export function peekCapabilities(deviceName?: string): Capabilities | undefined {
  const key = resolveDeviceName(deviceName);
  const hit = cache.get(key);
  if (!hit || clock() - hit.startedAt >= CAPABILITY_TTL_MS) return undefined;
  return hit.value;
}

/**
 * Drop the cached probe for one device, or all of them.
 *
 * Call after anything that can change what a device supports: a firmware
 * upgrade, a package enable/disable, a config reload that redefines the device,
 * or a `commandUnsupported()` hit (which proves the model is stale).
 */
export function invalidateCapabilities(deviceName?: string): void {
  if (deviceName === undefined) {
    cache.clear();
    return;
  }
  cache.delete(resolveDeviceName(deviceName));
}

/** Seed the cache directly (tests, and the dashboard's reprobe-then-reload path). */
export function primeCapabilities(deviceName: string | undefined, caps: Capabilities): void {
  const key = resolveDeviceName(deviceName);
  cache.set(key, { promise: Promise.resolve(caps), startedAt: clock(), value: caps });
}
