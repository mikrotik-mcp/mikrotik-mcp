/**
 * Live transactions — the bit of state the five `txn` tools share.
 *
 * A cross-device transaction spans several tool calls (begin → add steps →
 * verify → commit/abort), so the open ones live in a process-local map keyed by
 * id. That map is authoritative while the server runs; the SQLite log
 * (`./store.ts`) is the durable record the dashboard reads and is written
 * best-effort after every change.
 *
 * Best-effort is deliberate: a transaction must never fail because the log could
 * not be written (the log is observability, the fleet is the product), and the
 * store dynamically imports `bun:sqlite`, which does not exist in the Node test
 * runtime.
 */
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { logger } from "../logger";
import { openTxnStore, toRecord } from "./store";
import type { TxnStore } from "./store";
import type { Txn } from "./model";

export interface LiveTxn {
  txn: Txn;
  /** Queued commands per device, applied during PREPARE. */
  steps: Record<string, string[]>;
  /** When the transaction was opened (epoch ms). */
  ts: number;
  label?: string;
}

const live = new Map<string, LiveTxn>();

/** `txn_<ts>_<rand>` — time-sortable and unique within a process. */
export function newTxnId(): string {
  return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function putTxn(entry: LiveTxn): LiveTxn {
  live.set(entry.txn.id, entry);
  return entry;
}

export function getTxn(id: string): LiveTxn | undefined {
  return live.get(id);
}

export function dropTxn(id: string): void {
  live.delete(id);
}

/** Open transactions, newest first. */
export function listTxns(): LiveTxn[] {
  return [...live.values()].sort((a, b) => b.ts - a.ts);
}

// The txn log is opened once and reused for the life of the process.
let storePromise: Promise<TxnStore> | null = null;

export function txnStore(): Promise<TxnStore> {
  storePromise ??= openTxnStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Persist the current state of a transaction. Never throws. */
export async function persistTxn(entry: LiveTxn): Promise<void> {
  try {
    const store = await txnStore();
    store.save({ ...toRecord(entry.txn, entry.ts, entry.label), updated: Date.now() });
  } catch (e) {
    logger.error(`txn log write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Append one timeline entry for a transaction. Never throws. */
export async function logTxnEvent(event: {
  txnId: string;
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}): Promise<void> {
  try {
    const store = await txnStore();
    store.appendEvent({ ...event, ts: Date.now() });
  } catch (e) {
    logger.error(`txn event write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
