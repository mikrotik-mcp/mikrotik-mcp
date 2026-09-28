import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";

export type WorkspaceKind = "client-check" | "migration" | "support";
export interface WorkspaceRecord {
  id: string;
  device: string;
  createdAt: number;
  status: string;
}

/** Local workflow records, never RouterOS secrets. Claims are atomic across MCP processes. */
export class WorkspaceStore {
  constructor(private db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS operation_workspaces (kind TEXT NOT NULL,id TEXT PRIMARY KEY,device TEXT NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS workspace_device ON operation_workspaces(kind,device,created DESC)",
    );
    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS migration_inflight ON operation_workspaces(device) WHERE kind='migration' AND json_extract(body,'$.status') IN ('applying','uncertain','undoing')",
    );
  }
  save(kind: WorkspaceKind, value: WorkspaceRecord): void {
    this.db
      .query(
        "INSERT INTO operation_workspaces VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, value.id, value.device, value.createdAt, JSON.stringify(value));
  }
  get<T extends WorkspaceRecord>(kind: WorkspaceKind, id: string, device?: string): T | undefined {
    const r = this.db
      .query(
        "SELECT body FROM operation_workspaces WHERE kind=? AND id=? AND (? IS NULL OR device=?)",
      )
      .get(kind, id, device ?? null, device ?? null) as { body: string } | null;
    return r ? JSON.parse(r.body) : undefined;
  }
  list<T extends WorkspaceRecord>(kind: WorkspaceKind, device: string): T[] {
    return (
      this.db
        .query(
          "SELECT body FROM operation_workspaces WHERE kind=? AND device=? ORDER BY created DESC LIMIT 100",
        )
        .all(kind, device) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  claim(kind: WorkspaceKind, value: WorkspaceRecord, previous: string): void {
    const r = this.db
      .query(
        "UPDATE operation_workspaces SET body=? WHERE kind=? AND id=? AND device=? AND json_extract(body,'$.status')=?",
      )
      .run(JSON.stringify(value), kind, value.id, value.device, previous);
    if (r.changes !== 1)
      throw new Error(
        "This operation was already claimed. Refresh its status; do not retry a write.",
      );
  }
  /** Optimistic compare-and-swap: closing an invitation or saving another run wins over stale state. */
  replace(kind: WorkspaceKind, before: WorkspaceRecord, after: WorkspaceRecord): void {
    const r = this.db
      .query("UPDATE operation_workspaces SET body=? WHERE kind=? AND id=? AND body=?")
      .run(JSON.stringify(after), kind, before.id, JSON.stringify(before));
    if (r.changes !== 1) throw new Error("Record changed concurrently. Refresh before continuing.");
  }
  delete(kind: WorkspaceKind, id: string, device: string): void {
    this.db
      .query("DELETE FROM operation_workspaces WHERE kind=? AND id=? AND device=?")
      .run(kind, id, device);
  }
}
let pending: Promise<WorkspaceStore> | undefined;
export function workspaceStore(): Promise<WorkspaceStore> {
  return (pending ??= (async () => {
    mkdirSync(dirname(DEFAULT_SNAPSHOT_DB), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(DEFAULT_SNAPSHOT_DB, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    return new WorkspaceStore(db);
  })().catch((e) => {
    pending = undefined;
    throw e;
  }));
}
