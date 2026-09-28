/**
 * CAPsMAN trend persistence — Bun's native SQLite (`bun:sqlite`), imported
 * **dynamically** (exactly like {@link ./usage-store}) so the static import graph
 * stays Node-loadable and the Bun runtime module is pulled in only when the
 * dashboard is actually served. Nothing in the tool/registry/test graph imports
 * this file.
 *
 * One dataset backs the CAPsMAN trend graphs: `capsman_samples` — periodic
 * snapshots of each radio's *instantaneous* associated-client count (and its
 * current channel). Unlike the usage counters these are gauges, not cumulative
 * totals, so a "series" is just the raw points grouped per radio — the grouping
 * lives in the pure {@link summariseRadioSamples} helper so it's unit-testable
 * without a database.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

/** A radio gauge snapshot to persist (client count + current channel). */
export interface RadioSample {
  radioId: string;
  cap: string;
  band: string;
  channel?: number;
  clients: number;
}

/** One stored point in a radio's time series. */
export interface SeriesPoint {
  ts: number;
  clients: number;
  channel: number | null;
}

/** A radio's full trend: its identity + points + peak/average client load. */
export interface RadioSeries {
  radioId: string;
  cap: string;
  band: string;
  points: SeriesPoint[];
  peak: number;
  avg: number;
}

/** A flat sample row as read back from storage (before grouping). */
export interface RadioSampleRow {
  radioId: string;
  cap: string;
  band: string;
  ts: number;
  clients: number;
  channel: number | null;
}

/**
 * Group flat gauge rows into one {@link RadioSeries} per radio, each with points
 * sorted by time and its peak / rounded-average client count. Pure — no database
 * — so it's directly unit-testable. Rows may arrive in any order.
 */
export function summariseRadioSamples(rows: RadioSampleRow[]): RadioSeries[] {
  const byRadio = new Map<string, RadioSampleRow[]>();
  for (const r of rows) {
    const list = byRadio.get(r.radioId);
    if (list) list.push(r);
    else byRadio.set(r.radioId, [r]);
  }
  const series: RadioSeries[] = [];
  for (const [radioId, list] of byRadio) {
    list.sort((a, b) => a.ts - b.ts);
    const last = list[list.length - 1];
    const points = list.map((r) => ({ ts: r.ts, clients: r.clients, channel: r.channel }));
    const peak = points.reduce((m, p) => Math.max(m, p.clients), 0);
    const total = points.reduce((s, p) => s + p.clients, 0);
    series.push({
      radioId,
      cap: last.cap,
      band: last.band,
      points,
      peak,
      avg: points.length ? Math.round(total / points.length) : 0,
    });
  }
  return series.sort((a, b) => a.radioId.localeCompare(b.radioId));
}

/** Public storage interface (a SQLite implementation today; swappable in tests). */
export interface CapsmanStore {
  recordRadioSamples(device: string, ts: number, samples: RadioSample[]): void;
  /** Per-radio trend since `sinceTs`. */
  radioSeries(device: string, sinceTs: number): RadioSeries[];
  /** Drop snapshots older than `olderThanTs`. Returns rows deleted. */
  pruneSamples(olderThanTs: number): number;
  close(): void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS capsman_samples (
     device TEXT NOT NULL,
     radio_id TEXT NOT NULL,
     cap TEXT NOT NULL,
     band TEXT NOT NULL,
     ts INTEGER NOT NULL,
     clients INTEGER NOT NULL,
     channel INTEGER
   )`,
  "CREATE INDEX IF NOT EXISTS idx_capsman_radio ON capsman_samples(device, radio_id, ts)",
  "CREATE INDEX IF NOT EXISTS idx_capsman_ts ON capsman_samples(ts)",
];

class SqliteCapsmanStore implements CapsmanStore {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    // Like usage sampling, tolerate short writer contention without blocking
    // the synchronous MCP event loop for seconds; later passes retry long locks.
    db.run("PRAGMA busy_timeout = 100");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  recordRadioSamples(device: string, ts: number, samples: RadioSample[]): void {
    if (samples.length === 0) return;
    const insert = this.db.query(
      `INSERT INTO capsman_samples (device, radio_id, cap, band, ts, clients, channel)
       VALUES ($d,$r,$cap,$band,$ts,$c,$ch)`,
    );
    const tx = this.db.transaction((rows: RadioSample[]) => {
      for (const r of rows) {
        insert.run({
          $d: device,
          $r: r.radioId,
          $cap: r.cap,
          $band: r.band,
          $ts: ts,
          $c: r.clients,
          $ch: r.channel ?? null,
        });
      }
    });
    tx(samples);
  }

  radioSeries(device: string, sinceTs: number): RadioSeries[] {
    const rows = this.db
      .query(
        `SELECT radio_id AS radioId, cap, band, ts, clients, channel
         FROM capsman_samples WHERE device=$d AND ts>=$since ORDER BY ts ASC`,
      )
      .all({ $d: device, $since: sinceTs }) as RadioSampleRow[];
    return summariseRadioSamples(rows);
  }

  pruneSamples(olderThanTs: number): number {
    // Keep each cleanup's write lock bounded when multiple dashboards share this DB.
    const res = this.db
      .query(
        `DELETE FROM capsman_samples WHERE rowid IN (
           SELECT rowid FROM capsman_samples WHERE ts < $t ORDER BY ts LIMIT 5000
         )`,
      )
      .run({ $t: olderThanTs });
    return Number(res.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) the CAPsMAN trend store at `path` (`:memory:` for ephemeral). */
export async function openCapsmanStore(path: string): Promise<CapsmanStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* best-effort; opening the DB surfaces a real failure */
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteCapsmanStore(db);
}
