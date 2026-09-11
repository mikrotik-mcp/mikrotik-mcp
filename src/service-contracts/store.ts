/** Contract definitions are immutable; runs form a separate history for review and gates. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import type { ContractRun, ServiceContract } from "./model";

export class ContractStore {
  constructor(private readonly db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS service_contracts (id TEXT PRIMARY KEY, device TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS service_contract_runs (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, started_at INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS service_contract_runs_time ON service_contract_runs(contract_id,started_at DESC)",
    );
  }
  save(value: ServiceContract): void {
    this.db
      .query("INSERT INTO service_contracts VALUES (?,?,?,?)")
      .run(value.id, value.device, value.createdAt, JSON.stringify(value));
  }
  get(id: string): ServiceContract | undefined {
    const row = this.db.query("SELECT body FROM service_contracts WHERE id = ?").get(id) as {
      body: string;
    } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  list(device: string): ServiceContract[] {
    return (
      this.db
        .query(
          "SELECT body FROM service_contracts WHERE device = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all(device) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  record(value: ContractRun): void {
    this.db
      .query("INSERT INTO service_contract_runs VALUES (?,?,?,?)")
      .run(value.id, value.contractId, value.startedAt, JSON.stringify(value));
  }
  history(id: string): ContractRun[] {
    return (
      this.db
        .query(
          "SELECT body FROM service_contract_runs WHERE contract_id = ? ORDER BY started_at DESC LIMIT 100",
        )
        .all(id) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
}
let pending: Promise<ContractStore> | undefined;
export function contractStore(): Promise<ContractStore> {
  pending ??= (async () => {
    mkdirSync(dirname(DEFAULT_SNAPSHOT_DB), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(DEFAULT_SNAPSHOT_DB, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    return new ContractStore(db);
  })().catch((e) => {
    pending = undefined;
    throw e;
  });
  return pending;
}
