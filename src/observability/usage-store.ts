/**
 * Usage history persistence — Bun's native SQLite (`bun:sqlite`), imported
 * **dynamically** (exactly like {@link ./store}) so the static import graph stays
 * Node-loadable and the Bun runtime module is pulled in only when the dashboard
 * is actually served. Nothing in the tool/registry/test graph imports this file.
 *
 * Two long-lived datasets back the dashboard's usage views:
 *
 *   • `usage_samples` — periodic snapshots of each connected client's cumulative
 *     `/queue simple` counters. Kept ~3 months; per-day download/upload is the
 *     reset-aware delta between consecutive snapshots ({@link dailyUsageFromSamples}).
 *   • `vpn_sessions` — User Manager accounting sessions, ingested and de-duped by
 *     accounting id and kept FOREVER. Per-user per-day usage is the sum of session
 *     bytes; the GitHub-style heatmap is the per-day session (connection) count.
 *
 * Analytics that don't need SQL live in pure exported helpers so they stay
 * unit-testable without a database.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

/** A cumulative-counter snapshot for one client at one instant. */
export interface ClientSample {
  ts: number;
  rx: number;
  tx: number;
}
/** Per-day download (rx) / upload (tx) bytes. */
export interface DailyUsage {
  day: string; // YYYY-MM-DD (UTC)
  rx: number;
  tx: number;
}
/** Per-day count (for the contribution heatmap). */
export interface DayCount {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
}
/** One ingested User Manager accounting session. */
export interface VpnSession {
  sessionId: string;
  user: string;
  service?: string;
  nas?: string;
  started: number; // epoch ms
  rx: number;
  tx: number;
}

/** UTC `YYYY-MM-DD` for an epoch-ms instant. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Reduce cumulative-counter snapshots to per-day download/upload bytes. The
 * delta between consecutive samples is the traffic in that interval, attributed
 * to the later sample's day; a negative delta means the counter reset (queue
 * recreated, reset-counters, reboot), so the new value itself is taken as the
 * delta. Pure — no database — so it's directly unit-testable.
 */
export function dailyUsageFromSamples(samples: ClientSample[]): DailyUsage[] {
  const byDay = new Map<string, { rx: number; tx: number }>();
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dRx = cur.rx >= prev.rx ? cur.rx - prev.rx : cur.rx;
    const dTx = cur.tx >= prev.tx ? cur.tx - prev.tx : cur.tx;
    const day = dayOf(cur.ts);
    const acc = byDay.get(day) ?? { rx: 0, tx: 0 };
    acc.rx += dRx;
    acc.tx += dTx;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, rx: v.rx, tx: v.tx }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Public storage interface (a SQLite implementation today; swappable in tests). */
export interface UsageStore {
  recordClientSamples(
    device: string,
    ts: number,
    samples: { ip: string; rx: number; tx: number }[],
  ): void;
  /** Insert/refresh sessions (dedup by acct id); returns the count written. */
  upsertSessions(device: string, sessions: VpnSession[]): number;
  clientDailyUsage(device: string, ip: string, sinceTs: number): DailyUsage[];
  umUserDailyUsage(device: string, user: string, sinceTs: number): DailyUsage[];
  /** Distinct User Manager users that have any stored session. */
  umUsers(device: string): string[];
  /** Per-day connection counts since `sinceTs` (one user, or all users when null). */
  heatmap(device: string, user: string | null, sinceTs: number): DayCount[];
  /** Drop up to 5,000 expired client snapshots per pass. Sessions are never pruned. */
  pruneSamples(olderThanTs: number): number;
  close(): void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_samples (
     device TEXT NOT NULL,
     subject TEXT NOT NULL,
     ts INTEGER NOT NULL,
     rx INTEGER NOT NULL,
     tx INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_usage_sub ON usage_samples(device, subject, ts)",
  "CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_samples(ts)",
  `CREATE TABLE IF NOT EXISTS vpn_sessions (
     device TEXT NOT NULL,
     session_id TEXT NOT NULL,
     user TEXT NOT NULL,
     service TEXT,
     nas TEXT,
     started INTEGER NOT NULL,
     day TEXT NOT NULL,
     rx INTEGER NOT NULL,
     tx INTEGER NOT NULL,
     PRIMARY KEY (device, session_id)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_sess_user ON vpn_sessions(device, user, day)",
  "CREATE INDEX IF NOT EXISTS idx_sess_day ON vpn_sessions(device, day)",
];

class SqliteUsageStore implements UsageStore {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    // SQLite calls are synchronous: tolerate brief contention without blocking
    // the MCP event loop for seconds. Persistent locks retry on the next pass.
    db.run("PRAGMA busy_timeout = 100");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  recordClientSamples(
    device: string,
    ts: number,
    samples: { ip: string; rx: number; tx: number }[],
  ): void {
    if (samples.length === 0) return;
    const insert = this.db.query(
      "INSERT INTO usage_samples (device, subject, ts, rx, tx) VALUES ($d,$s,$ts,$rx,$tx)",
    );
    const tx = this.db.transaction((rows: { ip: string; rx: number; tx: number }[]) => {
      for (const r of rows) {
        insert.run({ $d: device, $s: r.ip, $ts: ts, $rx: r.rx, $tx: r.tx });
      }
    });
    tx(samples);
  }

  upsertSessions(device: string, sessions: VpnSession[]): number {
    if (sessions.length === 0) return 0;
    const stmt = this.db.query(
      `INSERT INTO vpn_sessions (device, session_id, user, service, nas, started, day, rx, tx)
       VALUES ($d,$id,$u,$svc,$nas,$st,$day,$rx,$tx)
       ON CONFLICT(device, session_id) DO UPDATE SET rx=excluded.rx, tx=excluded.tx`,
    );
    let n = 0;
    const tx = this.db.transaction((rows: VpnSession[]) => {
      for (const s of rows) {
        stmt.run({
          $d: device,
          $id: s.sessionId,
          $u: s.user,
          $svc: s.service ?? null,
          $nas: s.nas ?? null,
          $st: s.started,
          $day: dayOf(s.started),
          $rx: s.rx,
          $tx: s.tx,
        });
        n++;
      }
    });
    tx(sessions);
    return n;
  }

  clientDailyUsage(device: string, ip: string, sinceTs: number): DailyUsage[] {
    const rows = this.db
      .query(
        "SELECT ts, rx, tx FROM usage_samples WHERE device=$d AND subject=$s AND ts>=$since ORDER BY ts ASC",
      )
      .all({ $d: device, $s: ip, $since: sinceTs }) as ClientSample[];
    return dailyUsageFromSamples(rows);
  }

  umUserDailyUsage(device: string, user: string, sinceTs: number): DailyUsage[] {
    const rows = this.db
      .query(
        `SELECT day, SUM(rx) AS rx, SUM(tx) AS tx FROM vpn_sessions
         WHERE device=$d AND user=$u AND started>=$since GROUP BY day ORDER BY day ASC`,
      )
      .all({ $d: device, $u: user, $since: sinceTs }) as DailyUsage[];
    return rows.map((r) => ({ day: r.day, rx: Number(r.rx), tx: Number(r.tx) }));
  }

  umUsers(device: string): string[] {
    const rows = this.db
      .query("SELECT DISTINCT user FROM vpn_sessions WHERE device=$d ORDER BY user ASC")
      .all({ $d: device }) as { user: string }[];
    return rows.map((r) => r.user);
  }

  heatmap(device: string, user: string | null, sinceTs: number): DayCount[] {
    const sinceDay = dayOf(sinceTs);
    const rows = user
      ? (this.db
          .query(
            "SELECT day, COUNT(*) AS count FROM vpn_sessions WHERE device=$d AND user=$u AND day>=$since GROUP BY day",
          )
          .all({ $d: device, $u: user, $since: sinceDay }) as DayCount[])
      : (this.db
          .query(
            "SELECT day, COUNT(*) AS count FROM vpn_sessions WHERE device=$d AND day>=$since GROUP BY day",
          )
          .all({ $d: device, $since: sinceDay }) as DayCount[]);
    return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
  }

  pruneSamples(olderThanTs: number): number {
    // Bound each write transaction; subsequent sampling passes drain any backlog.
    const res = this.db
      .query(`DELETE FROM usage_samples WHERE rowid IN (
      SELECT rowid FROM usage_samples WHERE ts < $t ORDER BY ts LIMIT 5000
    )`)
      .run({ $t: olderThanTs });
    return Number(res.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) the usage store at `path` (`:memory:` for ephemeral). */
export async function openUsageStore(path: string): Promise<UsageStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* best-effort; opening the DB surfaces a real failure */
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  try {
    return new SqliteUsageStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
