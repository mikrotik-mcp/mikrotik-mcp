/**
 * Server-side traffic broadcaster for the Clients page.
 *
 * Instead of every dashboard client polling `/api/clients/traffic-bulk` on its
 * own 1-second timer, ONE poller per device samples `sampleAllTraffic` and pushes
 * each result to all subscribers (over WebSocket, or SSE as a fallback). That is
 * both lighter on the router and — for the `/ip accounting` path — a correctness
 * fix: `snapshot take` resets the live counters, so two independent pollers would
 * steal each other's deltas and report half-rates. With a single poller there is
 * exactly one taker per interval.
 *
 * A device's poller starts when its first subscriber arrives and stops when the
 * last leaves, so an idle dashboard touches no router.
 */
import { createContext } from "../core/context";
import { resolveDeviceName } from "../core/runtime";
import { sampleAllTraffic } from "../tools/connected-devices";
import type { BulkTrafficPayload } from "../tools/connected-devices";

type Listener = (sample: BulkTrafficPayload) => void;

interface Hub {
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setTimeout>;
  reading: boolean;
  /** The most recent sample, replayed to a newcomer so it isn't blank for ~1s. */
  last?: BulkTrafficPayload;
}

const POLL_MS = 1000;

/** One hub per device name (`""` = the default device). */
const hubs = new Map<string, Hub>();

/**
 * Subscribe to a device's live traffic samples. Returns an unsubscribe function;
 * when the last subscriber for a device unsubscribes, its poller is stopped.
 */
export function subscribeTraffic(target: string, fn: Listener): () => void {
  const device = resolveDeviceName(target || undefined);
  let hub = hubs.get(device);
  if (!hub) {
    hub = { listeners: new Set(), reading: false };
    const active = hub;
    hubs.set(device, active);
    const poll = async (): Promise<void> => {
      active.reading = true;
      let sample: BulkTrafficPayload;
      try {
        sample = await sampleAllTraffic(createContext(undefined, device));
      } catch (e) {
        // A connection failure throws; surface it as an empty sample so the
        // client shows the notice rather than freezing on stale numbers.
        sample = {
          ts: Date.now(),
          source: "none",
          note: e instanceof Error ? e.message : String(e),
          hosts: {},
          limits: {},
        };
      }
      active.reading = false;
      if (hubs.get(device) !== active) return;
      if (!active.listeners.size) {
        hubs.delete(device);
        return;
      }
      active.last = sample;
      for (const listener of active.listeners) listener(sample);
      if (active.listeners.size) active.timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll(); // seed immediately rather than waiting a full interval
  }

  hub.listeners.add(fn);
  if (hub.last) fn(hub.last);

  const active = hub;
  return () => {
    active.listeners.delete(fn);
    if (!active.listeners.size) {
      clearTimeout(active.timer);
      // A reconnect must share the unfinished read instead of racing a new snapshot.
      if (!active.reading && hubs.get(device) === active) hubs.delete(device);
    }
  };
}

/** HTTP fallback shares the same read as WS/SSE, including destructive v6 snapshots. */
export function readTrafficSample(device: string): Promise<BulkTrafficPayload> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeTraffic(device, (sample) => {
      resolve(sample);
      // Cached samples can be delivered synchronously before subscribe returns.
      queueMicrotask(() => unsubscribe());
    });
  });
}

/** Total live traffic subscribers across all devices (for diagnostics). */
export function trafficSubscriberCount(): number {
  let n = 0;
  for (const h of hubs.values()) n += h.listeners.size;
  return n;
}
