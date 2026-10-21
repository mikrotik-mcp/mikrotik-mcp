/**
 * Process-global tool-call recorder — the bridge between the registry choke
 * point and the dashboard.
 *
 * The registry calls {@link recordToolCall} after every tool invocation. When
 * the dashboard is disabled (the default) that call is a single boolean check
 * and returns immediately — zero overhead and no `bun:sqlite` in the import
 * graph. When enabled at serve time, {@link configureRecorder} installs a store
 * and each event is persisted (SQLite) and fanned out to live subscribers (the
 * dashboard's WebSocket clients).
 */
import { buildEvent } from "./event";
import type { CaptureOptions, RawCall, ToolEvent } from "./event";
import type { EventStore } from "./store";

let enabled = false;
let store: EventStore | null = null;
let capture: CaptureOptions = { captureBody: true, maxBodyBytes: 16_384 };
let maxEvents = 100_000;
let transport = "stdio";
let sinceLastPrune = 0;
const subscribers = new Set<(e: ToolEvent) => void>();

/** How often (in inserts) to run a retention prune. */
const PRUNE_EVERY = 500;

export interface RecorderConfig {
  store: EventStore;
  capture: CaptureOptions;
  maxEvents: number;
  transport?: string;
}

/** Turn the recorder on with a backing store. Called once at serve startup. */
export function configureRecorder(cfg: RecorderConfig): void {
  store = cfg.store;
  capture = cfg.capture;
  maxEvents = cfg.maxEvents;
  if (cfg.transport) transport = cfg.transport;
  enabled = true;
}

/** Whether recording is active (the registry's fast-path guard). */
export function isRecording(): boolean {
  return enabled;
}

/** Override the transport label attached to subsequent events. */
export function setRecorderTransport(t: string): void {
  transport = t;
}

/** The active event store (for the dashboard's queries), or null when disabled. */
export function getEventStore(): EventStore | null {
  return store;
}

/** Subscribe to live events; returns an unsubscribe function. */
export function subscribe(fn: (e: ToolEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Number of currently-connected live subscribers (for the dashboard banner). */
export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Record one finished tool call. No-ops instantly when disabled. Never throws —
 * observability must not break the tool path — so storage/broadcast failures are
 * swallowed (and would surface in logs via the caller, not here).
 */
export function recordToolCall(raw: Omit<RawCall, "transport">, id = crypto.randomUUID()): boolean {
  if (!enabled || !store) return false;
  try {
    const event = buildEvent({ ...raw, transport }, id, capture);
    store.insert(event);
    // A maintenance failure must not misreport an already-persisted call as missing.
    try {
      if (++sinceLastPrune >= PRUNE_EVERY) {
        sinceLastPrune = 0;
        store.prune(maxEvents);
      }
    } catch {
      /* retention can retry on the next batch */
    }
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // a misbehaving subscriber must not stop the others
      }
    }
    return true;
  } catch {
    // recording is best-effort; never disrupt the tool call
    return false;
  }
}

/** Tear down the recorder (closes the store). Used on shutdown / in tests. */
export function shutdownRecorder(): void {
  try {
    store?.close();
  } catch {
    // ignore
  }
  store = null;
  enabled = false;
  subscribers.clear();
  sinceLastPrune = 0;
}
