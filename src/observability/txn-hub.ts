/**
 * Live broadcaster for cross-device transactions.
 *
 * A transaction's whole value on screen is seeing WHERE it is — which
 * participant is preparing while another is already committing. Polling would
 * miss exactly that, so the tools publish one update per action and the
 * dashboard replays them into the swimlane over the existing `/api/stream`
 * socket (message type `txn`).
 *
 * Deliberately dumb: no timers, no state beyond the last update per transaction
 * (replayed to a newcomer so a page opened mid-run isn't blank until the next
 * action lands). Nothing here can fail a transaction — publishing is fire and
 * forget.
 */
import type { Participant, TerminalState, TxnPhase } from "../txn/model";

/** One broadcast frame: the transaction as it stands after an action. */
export interface TxnUpdate {
  txnId: string;
  ts: number;
  phase: TxnPhase;
  state?: TerminalState;
  /** The action just performed (`prepare`, `verify`, `commit`, …). */
  action: string;
  device?: string;
  ok: boolean;
  detail?: string;
  participants: Participant[];
}

type Listener = (update: TxnUpdate) => void;

const listeners = new Set<Listener>();
/** Last frame per transaction, so a late subscriber sees the current lane. */
const lastByTxn = new Map<string, TxnUpdate>();

/** Broadcast one update. Never throws — a dead subscriber is skipped. */
export function publishTxn(update: TxnUpdate): void {
  lastByTxn.set(update.txnId, update);
  if (update.state !== undefined) {
    // Terminal: keep the final frame briefly for anyone connecting right after,
    // but don't accumulate finished transactions forever — the store has them.
    setTimeout(() => lastByTxn.delete(update.txnId), 60_000).unref?.();
  }
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      // a subscriber that blew up must not break the transaction
    }
  }
}

/** Subscribe to live transaction updates; returns an unsubscribe function. */
export function subscribeTxn(fn: Listener): () => void {
  listeners.add(fn);
  for (const update of lastByTxn.values()) {
    try {
      fn(update);
    } catch {
      // ignore a replay failure
    }
  }
  return () => listeners.delete(fn);
}

/** Live frames for transactions still in flight (used by `GET /api/txn`). */
export function liveTxnUpdates(): TxnUpdate[] {
  return [...lastByTxn.values()].sort((a, b) => b.ts - a.ts);
}
