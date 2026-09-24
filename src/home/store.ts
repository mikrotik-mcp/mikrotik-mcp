import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import type { HomeClient, PolicyPlan } from "./model";

/** Separate device namespaces; names and people remain local, not DHCP comments. */
export class HomeStore {
  constructor(private db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS home_clients (device TEXT NOT NULL, mac TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(device,mac))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS home_plans (id TEXT PRIMARY KEY, device TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS home_one_active_client ON home_plans(device, json_extract(body,'$.input.mac')) WHERE json_extract(body,'$.status') IN ('applying','scheduled','active','uncertain')",
    );
  }
  clients(device: string): HomeClient[] {
    return (
      this.db.query("SELECT body FROM home_clients WHERE device=?").all(device) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  }
  saveClient(device: string, client: HomeClient): void {
    this.db
      .query(
        "INSERT INTO home_clients VALUES (?,?,?) ON CONFLICT(device,mac) DO UPDATE SET body=excluded.body",
      )
      .run(device, client.mac, JSON.stringify(client));
  }
  savePlan(plan: PolicyPlan): void {
    this.db
      .query(
        "INSERT INTO home_plans VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(plan.id, plan.device, plan.createdAt, JSON.stringify(plan));
  }
  plan(id: string, device: string): PolicyPlan | undefined {
    const row = this.db
      .query("SELECT body FROM home_plans WHERE id=? AND device=?")
      .get(id, device) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  claim(plan: PolicyPlan): void {
    const result = this.db
      .query(
        "UPDATE home_plans SET body=? WHERE id=? AND device=? AND json_extract(body,'$.status')='preview' AND json_extract(body,'$.previewExpiresAt')>=?",
      )
      .run(JSON.stringify(plan), plan.id, plan.device, Date.now());
    if (result.changes !== 1)
      throw new Error("Preview expired or was already claimed by another process.");
  }
  unresolved(device: string): PolicyPlan[] {
    return (
      this.db
        .query(
          "SELECT body FROM home_plans WHERE device=? AND json_extract(body,'$.status') IN ('applying','scheduled','active','uncertain')",
        )
        .all(device) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  plans(device: string): PolicyPlan[] {
    const recent = (
      this.db
        .query("SELECT body FROM home_plans WHERE device=? ORDER BY created DESC LIMIT 200")
        .all(device) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
    // Preview churn must never hide an unresolved policy's Undo control.
    return [
      ...new Map(
        [...recent, ...this.unresolved(device)].map((p: PolicyPlan) => [p.id, p]),
      ).values(),
    ].sort((a, b) => b.createdAt - a.createdAt);
  }
}
let pending: Promise<HomeStore> | undefined;
export function homeStore(): Promise<HomeStore> {
  return (pending ??= (async () => {
    mkdirSync(dirname(DEFAULT_SNAPSHOT_DB), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(DEFAULT_SNAPSHOT_DB, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    return new HomeStore(db);
  })().catch((e) => {
    pending = undefined;
    throw e;
  }));
}
