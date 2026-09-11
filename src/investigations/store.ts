/** Durable local cases. Failed persistence must never be reported as a saved investigation. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import type { Investigation } from "./model";

export class InvestigationStore {
  constructor(private readonly db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, device TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS investigations_device_time ON investigations(device, created_at DESC)",
    );
  }
  save(value: Investigation): void {
    this.db
      .query("INSERT INTO investigations (id,device,created_at,body) VALUES (?,?,?,?)")
      .run(value.id, value.device, value.createdAt, JSON.stringify(value));
  }
  get(id: string): Investigation | undefined {
    const row = this.db.query("SELECT body FROM investigations WHERE id = ?").get(id) as {
      body: string;
    } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  list(device: string): Investigation[] {
    return (
      this.db
        .query(
          "SELECT body FROM investigations WHERE device = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all(device) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
}
let pending: Promise<InvestigationStore> | undefined;
export function investigationStore(): Promise<InvestigationStore> {
  pending ??= (async () => {
    mkdirSync(dirname(DEFAULT_SNAPSHOT_DB), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(DEFAULT_SNAPSHOT_DB, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    return new InvestigationStore(db);
  })().catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
