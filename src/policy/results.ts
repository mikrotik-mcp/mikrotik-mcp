/**
 * Policy result history — one row per check, so the compliance score has a
 * trend rather than just a number.
 *
 * A score with no history says "we are at 82%". A score with history says "we
 * were at 96% last week", which is the version someone acts on. Findings are
 * stored alongside so a past run can be re-read without re-running it against a
 * device that has since changed.
 *
 * Shares `snapshots.db` (no new file) and imports `bun:sqlite` **dynamically**,
 * like every other store here, so the Node/Vitest import graph never loads the
 * driver.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { logger } from "../logger";
import type { Finding, PolicyReport } from "./evaluate";
import type { Severity } from "./schema";

export interface PolicyResultRow {
  id: number;
  device: string;
  ts: number;
  score: number;
  passed: number;
  failed: number;
  notApplicable: number;
  bySeverity: Record<Severity, number>;
  findings: Finding[];
}

export interface PolicyResultStore {
  insert(report: PolicyReport): void;
  /** Newest first; all devices when `device` is undefined. */
  list(device?: string, limit?: number): PolicyResultRow[];
  close(): void;
}

interface Row {
  id: number;
  device: string;
  ts: number;
  score: number;
  passed: number;
  failed: number;
  not_applicable: number;
  by_severity: string;
  findings: string;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS policy_results (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     device         TEXT NOT NULL,
     ts             INTEGER NOT NULL,
     score          INTEGER NOT NULL,
     passed         INTEGER NOT NULL,
     failed         INTEGER NOT NULL,
     not_applicable INTEGER NOT NULL,
     by_severity    TEXT NOT NULL,
     findings       TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_policy_results_device_ts ON policy_results(device, ts)",
];

class SqlitePolicyResultStore implements PolicyResultStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  insert(report: PolicyReport): void {
    this.db
      .query(
        `INSERT INTO policy_results
         (device, ts, score, passed, failed, not_applicable, by_severity, findings)
         VALUES ($device,$ts,$score,$passed,$failed,$na,$bySeverity,$findings)`,
      )
      .run({
        $device: report.device ?? "(snapshot)",
        $ts: report.ts ?? Date.now(),
        $score: report.summary.score,
        $passed: report.summary.passed,
        $failed: report.summary.failed,
        $na: report.summary.notApplicable,
        $bySeverity: JSON.stringify(report.summary.bySeverity),
        // Only failures are worth keeping: a passing rule's finding says nothing
        // a re-run would not say, and storing them all turns a fleet sweep into
        // megabytes of "still fine".
        $findings: JSON.stringify(report.findings.filter((f) => f.status === "fail")),
      });
  }

  list(device?: string, limit = 50): PolicyResultRow[] {
    const rows = device
      ? (this.db
          .query(
            "SELECT * FROM policy_results WHERE device = $device ORDER BY ts DESC LIMIT $limit",
          )
          .all({ $device: device, $limit: limit }) as Row[])
      : (this.db
          .query("SELECT * FROM policy_results ORDER BY ts DESC LIMIT $limit")
          .all({ $limit: limit }) as Row[]);

    return rows.map((r) => ({
      id: r.id,
      device: r.device,
      ts: r.ts,
      score: r.score,
      passed: r.passed,
      failed: r.failed,
      notApplicable: r.not_applicable,
      bySeverity: JSON.parse(r.by_severity) as Record<Severity, number>,
      findings: JSON.parse(r.findings) as Finding[],
    }));
  }

  close(): void {
    this.db.close();
  }
}

export async function openPolicyResultStore(path: string): Promise<PolicyResultStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqlitePolicyResultStore(db);
}

let storePromise: Promise<PolicyResultStore> | null = null;

function store(): Promise<PolicyResultStore> {
  storePromise ??= openPolicyResultStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Persist one report. Never throws — a check must not fail on its own history. */
export async function recordPolicyResult(report: PolicyReport): Promise<void> {
  try {
    (await store()).insert(report);
  } catch (e) {
    logger.error(`policy result write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stored results, newest first. */
export async function policyResults(device?: string, limit = 50): Promise<PolicyResultRow[]> {
  return (await store()).list(device, limit);
}
