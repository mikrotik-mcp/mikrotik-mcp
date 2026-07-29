/**
 * Transaction log — persistence for cross-device transactions.
 *
 * Mirrors `src/snapshots/store.ts` exactly: `bun:sqlite` is imported
 * **dynamically** inside {@link openTxnStore} so this module stays safe to
 * reference from the Node/Vitest import graph (which aliases `"bun"` to a stub
 * and must never load the real driver); only erased *types* are imported
 * statically.
 *
 * It shares the snapshots database file rather than opening a new one — a
 * transaction's whole value is the link between a participant and the
 * pre-change snapshot it can be restored from, and keeping both in one file
 * keeps that link from outliving its target.
 *
 * The row is the transaction as the model sees it (participants, assertion
 * results and warnings stored as JSON), plus an append-only event log that the
 * dashboard replays as a timeline.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { AssertionResult, Participant, TerminalState, Txn, TxnPhase } from "./model";

/** One persisted transaction. */
export interface TxnRecord {
  id: string;
  /** When the transaction was opened (epoch ms). */
  ts: number;
  /** Last write (epoch ms) — a live transaction updates on every action. */
  updated: number;
  devices: string[];
  commitOrder: string[];
  phase: TxnPhase;
  /** Terminal state once finished; undefined while the transaction is live. */
  state?: TerminalState;
  participants: Participant[];
  results: AssertionResult[];
  warnings: string[];
  label?: string;
}

/** One step of a transaction's timeline (append-only). */
export interface TxnEvent {
  txnId: string;
  /** Monotonic per transaction, assigned by the store. */
  seq: number;
  ts: number;
  /** The action taken: prepare | verify | commit | rollback | restore. */
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}

export interface TxnStore {
  /** Insert or replace the transaction row. */
  save(record: TxnRecord): void;
  get(id: string): TxnRecord | null;
  /** Transactions, newest first. */
  list(limit?: number): TxnRecord[];
  /** Append one timeline entry; returns the assigned sequence number. */
  appendEvent(event: Omit<TxnEvent, "seq">): number;
  /** Timeline for one transaction, oldest first. */
  events(txnId: string): TxnEvent[];
  /** Delete a transaction and its events. True when a row was removed. */
  remove(id: string): boolean;
  close(): void;
}

/** Snapshot the live model state into a persistable record. */
export function toRecord(txn: Txn, ts: number, label?: string): TxnRecord {
  return {
    id: txn.id,
    ts,
    updated: ts,
    devices: txn.devices,
    commitOrder: txn.commitOrder,
    phase: txn.phase,
    state: txn.state,
    participants: txn.participants,
    results: txn.results,
    warnings: txn.warnings,
    label,
  };
}

interface TxnRow {
  id: string;
  ts: number;
  updated: number;
  devices: string;
  commit_order: string;
  phase: string;
  state: string | null;
  participants: string;
  results: string;
  warnings: string;
  label: string | null;
}

interface EventRow {
  txn_id: string;
  seq: number;
  ts: number;
  kind: string;
  device: string | null;
  ok: number;
  detail: string | null;
}

function rowToRecord(r: TxnRow): TxnRecord {
  return {
    id: r.id,
    ts: r.ts,
    updated: r.updated,
    devices: JSON.parse(r.devices) as string[],
    commitOrder: JSON.parse(r.commit_order) as string[],
    phase: r.phase as TxnPhase,
    state: (r.state ?? undefined) as TerminalState | undefined,
    participants: JSON.parse(r.participants) as Participant[],
    results: JSON.parse(r.results) as AssertionResult[],
    warnings: JSON.parse(r.warnings) as string[],
    label: r.label ?? undefined,
  };
}

function rowToEvent(r: EventRow): TxnEvent {
  return {
    txnId: r.txn_id,
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    device: r.device ?? undefined,
    ok: r.ok === 1,
    detail: r.detail ?? undefined,
  };
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transactions (
     id           TEXT PRIMARY KEY,
     ts           INTEGER NOT NULL,
     updated      INTEGER NOT NULL,
     devices      TEXT NOT NULL,
     commit_order TEXT NOT NULL,
     phase        TEXT NOT NULL,
     state        TEXT,
     participants TEXT NOT NULL,
     results      TEXT NOT NULL,
     warnings     TEXT NOT NULL,
     label        TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_transactions_ts ON transactions(ts)",
  `CREATE TABLE IF NOT EXISTS txn_events (
     txn_id  TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     ts      INTEGER NOT NULL,
     kind    TEXT NOT NULL,
     device  TEXT,
     ok      INTEGER NOT NULL,
     detail  TEXT,
     PRIMARY KEY (txn_id, seq)
   )`,
];

class SqliteTxnStore implements TxnStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  save(record: TxnRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO transactions
         (id, ts, updated, devices, commit_order, phase, state, participants, results, warnings, label)
         VALUES ($id,$ts,$updated,$devices,$order,$phase,$state,$participants,$results,$warnings,$label)`,
      )
      .run({
        $id: record.id,
        $ts: record.ts,
        $updated: record.updated,
        $devices: JSON.stringify(record.devices),
        $order: JSON.stringify(record.commitOrder),
        $phase: record.phase,
        $state: record.state ?? null,
        $participants: JSON.stringify(record.participants),
        $results: JSON.stringify(record.results),
        $warnings: JSON.stringify(record.warnings),
        $label: record.label ?? null,
      });
  }

  get(id: string): TxnRecord | null {
    const row = this.db.query("SELECT * FROM transactions WHERE id = $id").get({ $id: id }) as
      | TxnRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(limit = 50): TxnRecord[] {
    const rows = this.db
      .query("SELECT * FROM transactions ORDER BY ts DESC LIMIT $limit")
      .all({ $limit: limit }) as TxnRow[];
    return rows.map(rowToRecord);
  }

  appendEvent(event: Omit<TxnEvent, "seq">): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max FROM txn_events WHERE txn_id = $id")
      .get({ $id: event.txnId }) as { max: number };
    const seq = row.max + 1;
    this.db
      .query(
        `INSERT INTO txn_events (txn_id, seq, ts, kind, device, ok, detail)
         VALUES ($id,$seq,$ts,$kind,$device,$ok,$detail)`,
      )
      .run({
        $id: event.txnId,
        $seq: seq,
        $ts: event.ts,
        $kind: event.kind,
        $device: event.device ?? null,
        $ok: event.ok ? 1 : 0,
        $detail: event.detail ?? null,
      });
    return seq;
  }

  events(txnId: string): TxnEvent[] {
    const rows = this.db
      .query("SELECT * FROM txn_events WHERE txn_id = $id ORDER BY seq ASC")
      .all({ $id: txnId }) as EventRow[];
    return rows.map(rowToEvent);
  }

  remove(id: string): boolean {
    this.db.query("DELETE FROM txn_events WHERE txn_id = $id").run({ $id: id });
    const before = this.db.query("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    this.db.query("DELETE FROM transactions WHERE id = $id").run({ $id: id });
    const after = this.db.query("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    return after.n < before.n;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the transaction log at `path` (`:memory:` for an ephemeral
 * store). Defaults to the snapshots database so a transaction and the snapshots
 * it can be restored from live in one file.
 */
export async function openTxnStore(path: string): Promise<TxnStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteTxnStore(db);
}
