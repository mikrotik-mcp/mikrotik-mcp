/** Durable, device-scoped workspace records. Never store transport credentials here. */
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";

export interface WorkspaceRecord {
  id: string;
  device: string;
  updatedAt: number;
}
export class OperationsStore {
  constructor(readonly db: Database) {
    db.run("PRAGMA busy_timeout = 3000");
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace_records (kind TEXT, id TEXT, device TEXT, updated INTEGER, body TEXT, PRIMARY KEY(kind,id))",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS workspace_device ON workspace_records(kind,device,updated DESC)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace_locks (device TEXT PRIMARY KEY, owner TEXT NOT NULL)",
    );
  }
  get<T extends WorkspaceRecord>(kind: string, id: string, device: string): T | undefined {
    const row = this.db
      .query("SELECT body FROM workspace_records WHERE kind=? AND id=? AND device=?")
      .get(kind, id, device) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  list<T extends WorkspaceRecord>(kind: string, device: string, limit = 100): T[] {
    return (
      this.db
        .query(
          "SELECT body FROM workspace_records WHERE kind=? AND device=? ORDER BY updated DESC LIMIT ?",
        )
        .all(kind, device, Math.min(500, limit)) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  put(kind: string, record: WorkspaceRecord): void {
    this.db
      .query(
        "INSERT INTO workspace_records VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET updated=excluded.updated,body=excluded.body WHERE device=excluded.device",
      )
      .run(kind, record.id, record.device, record.updatedAt, JSON.stringify(record));
  }
  delete(kind: string, id: string, device: string): void {
    this.db
      .query("DELETE FROM workspace_records WHERE kind=? AND id=? AND device=?")
      .run(kind, id, device);
  }
  prune(kind: string, device: string, before: number): void {
    this.db
      .query("DELETE FROM workspace_records WHERE kind=? AND device=? AND updated<?")
      .run(kind, device, before);
  }
  /** No time-based takeover: an interrupted write must be reconciled, not blindly replayed. */
  lock(device: string, owner: string): void {
    const result = this.db
      .query("INSERT OR IGNORE INTO workspace_locks VALUES (?,?)")
      .run(device, owner);
    if (!result.changes)
      throw new Error(
        "Another workspace operation holds this router. An interrupted operation requires reconciliation before retrying.",
      );
  }
  unlock(device: string, owner: string): void {
    this.db.query("DELETE FROM workspace_locks WHERE device=? AND owner=?").run(device, owner);
  }
}
let pending: Promise<OperationsStore> | undefined;
export function operationsStore(): Promise<OperationsStore> {
  pending ??= (async () => {
    const path = join(dirname(DEFAULT_SNAPSHOT_DB), "operations.db");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    db.run("PRAGMA journal_mode = WAL");
    return new OperationsStore(db);
  })().catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
