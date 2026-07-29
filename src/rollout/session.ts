/**
 * Live rollouts — the state the four rollout tools share.
 *
 * A rollout spans tool calls (start → status → hold/abort) and, once started,
 * runs to a terminal state on its own, so the in-flight ones live in a
 * process-local map keyed by id. The SQLite history (`./store.ts`) is the
 * durable record the dashboard reads and is written best-effort after every
 * step — a rollout must never fail because its history could not be recorded.
 */
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { logger } from "../logger";
import { openRolloutStore, toRecord } from "./store";
import type { RolloutStore } from "./store";
import type { RolloutState } from "./model";

export interface LiveRollout {
  state: RolloutState;
  /** Commands this rollout applies to every device. */
  commands: string[];
  ts: number;
  label?: string;
}

const live = new Map<string, LiveRollout>();

/** `rollout_<ts>_<rand>` — time-sortable and unique within a process. */
export function newRolloutId(): string {
  return `rollout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function putRollout(entry: LiveRollout): LiveRollout {
  live.set(entry.state.id, entry);
  return entry;
}

export function getRollout(id: string): LiveRollout | undefined {
  return live.get(id);
}

export function dropRollout(id: string): void {
  live.delete(id);
}

/** In-flight rollouts, newest first. */
export function listRollouts(): LiveRollout[] {
  return [...live.values()].sort((a, b) => b.ts - a.ts);
}

let storePromise: Promise<RolloutStore> | null = null;

export function rolloutStore(): Promise<RolloutStore> {
  storePromise ??= openRolloutStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Persist the current state of a rollout. Never throws. */
export async function persistRollout(entry: LiveRollout): Promise<void> {
  try {
    const store = await rolloutStore();
    store.save({
      ...toRecord(entry.state, entry.ts, { label: entry.label, commands: entry.commands }),
      updated: Date.now(),
    });
  } catch (e) {
    logger.error(`rollout history write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Append one timeline entry. Never throws. */
export async function logRolloutEvent(event: {
  rolloutId: string;
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}): Promise<void> {
  try {
    const store = await rolloutStore();
    store.appendEvent({ ...event, ts: Date.now() });
  } catch (e) {
    logger.error(`rollout event write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
