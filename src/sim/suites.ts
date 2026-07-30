/**
 * Saved packet suites — the firewall's regression tests.
 *
 * A suite is a set of flows that MUST work (and must not), so a config change
 * can be checked against them before it is applied. Persisted in `snapshots.db`
 * like every other store here, with `bun:sqlite` imported dynamically so the
 * Node/Vitest import graph never loads the driver.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { logger } from "../logger";
import type { SimPacket } from "./firewall";

export interface SuiteEntry {
  name: string;
  packet: SimPacket;
  expect: "accept" | "drop" | "reject";
}

export interface Suite {
  id: string;
  name: string;
  packets: SuiteEntry[];
  updated: number;
}

interface Row {
  id: string;
  name: string;
  packets: string;
  updated: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sim_suites (
     id      TEXT PRIMARY KEY,
     name    TEXT NOT NULL,
     packets TEXT NOT NULL,
     updated INTEGER NOT NULL
   )`,
];

class SqliteSuiteStore {
  constructor(private readonly db: Database) {
    db.run("PRAGMA journal_mode = WAL");
    for (const stmt of SCHEMA) db.run(stmt);
  }

  list(): Suite[] {
    const rows = this.db.query("SELECT * FROM sim_suites ORDER BY updated DESC").all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      packets: JSON.parse(r.packets) as SuiteEntry[],
      updated: r.updated,
    }));
  }

  get(id: string): Suite | null {
    const row = this.db.query("SELECT * FROM sim_suites WHERE id = $id").get({ $id: id }) as
      | Row
      | undefined;
    return row
      ? {
          id: row.id,
          name: row.name,
          packets: JSON.parse(row.packets) as SuiteEntry[],
          updated: row.updated,
        }
      : null;
  }

  save(suite: Suite): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sim_suites (id, name, packets, updated)
         VALUES ($id,$name,$packets,$updated)`,
      )
      .run({
        $id: suite.id,
        $name: suite.name,
        $packets: JSON.stringify(suite.packets),
        $updated: suite.updated,
      });
  }
}

let storePromise: Promise<SqliteSuiteStore> | null = null;

async function store(): Promise<SqliteSuiteStore> {
  storePromise ??= (async () => {
    try {
      mkdirSync(dirname(DEFAULT_SNAPSHOT_DB), { recursive: true });
    } catch {
      // best-effort
    }
    const { Database } = await import("bun:sqlite");
    return new SqliteSuiteStore(new Database(DEFAULT_SNAPSHOT_DB, { create: true }));
  })();
  return storePromise;
}

/** Saved suites, newest first. Never throws — an unreadable store is an empty list. */
export async function listSuites(): Promise<Suite[]> {
  try {
    return (await store()).list();
  } catch (e) {
    logger.error(`sim suite read failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

export async function getSuite(id: string): Promise<Suite | null> {
  try {
    return (await store()).get(id);
  } catch {
    return null;
  }
}

export async function saveSuite(input: {
  id?: string;
  name: string;
  packets: SuiteEntry[];
}): Promise<Suite> {
  const suite: Suite = {
    id: input.id ?? `suite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    packets: input.packets,
    updated: Date.now(),
  };
  try {
    (await store()).save(suite);
  } catch (e) {
    logger.error(`sim suite write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return suite;
}
