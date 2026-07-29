/**
 * Live broadcaster for staged fleet rollouts.
 *
 * A rollout is minutes long and mostly spent waiting — a wave applying, a gate
 * probing, a soak counting down. Polling would make the wave board lag exactly
 * when it matters, so the tools publish one update per action and the dashboard
 * replays them over the existing `/api/stream` socket (message type `rollout`).
 *
 * Same shape as `txn-hub.ts`: no timers, no state beyond the last frame per
 * rollout (replayed to a newcomer so a page opened mid-run isn't blank), and
 * publishing can never fail a rollout.
 */
import type { DeviceState, GateResult, RolloutOutcome } from "../rollout/model";

export interface RolloutUpdate {
  rolloutId: string;
  ts: number;
  phase: string;
  currentWave: number;
  /** The action just performed (`apply`, `gate`, `soak`, `revert`). */
  action: string;
  device?: string;
  ok: boolean;
  outcome?: RolloutOutcome;
  devices: DeviceState[];
  gates: GateResult[];
}

type Listener = (update: RolloutUpdate) => void;

const listeners = new Set<Listener>();
const lastByRollout = new Map<string, RolloutUpdate>();

/** Broadcast one update. Never throws — a dead subscriber is skipped. */
export function publishRollout(update: RolloutUpdate): void {
  lastByRollout.set(update.rolloutId, update);
  if (update.outcome !== undefined) {
    // Keep the final frame briefly for anyone connecting right after, then let
    // it go — the store has the history.
    setTimeout(() => lastByRollout.delete(update.rolloutId), 60_000).unref?.();
  }
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      // a subscriber that blew up must not break the rollout
    }
  }
}

/** Subscribe to live rollout updates; returns an unsubscribe function. */
export function subscribeRollout(fn: Listener): () => void {
  listeners.add(fn);
  for (const update of lastByRollout.values()) {
    try {
      fn(update);
    } catch {
      // ignore a replay failure
    }
  }
  return () => listeners.delete(fn);
}

/** Live frames for rollouts still in flight (used by `GET /api/rollout`). */
export function liveRolloutUpdates(): RolloutUpdate[] {
  return [...lastByRollout.values()].sort((a, b) => b.ts - a.ts);
}
