import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { BandwidthJob, BandwidthRun } from "./types";

interface StoredRun {
  body: string;
  expires: number;
}
export const BANDWIDTH_CONCURRENCY = 2;
const LEASE_MS = 300_000;

/** Durable jobs, measurements and leases shared by manual requests and scheduler processes. */
export class BandwidthStore {
  readonly storeId: string;
  constructor(private readonly db: Database) {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    db.run("CREATE TABLE IF NOT EXISTS bandwidth_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    db.run(
      "CREATE TABLE IF NOT EXISTS bandwidth_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS bandwidth_notifications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS bandwidth_metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.query("INSERT OR IGNORE INTO bandwidth_metadata VALUES ('storeId', ?)").run(
      crypto.randomUUID(),
    );
    this.storeId = (
      db.query("SELECT value FROM bandwidth_metadata WHERE id='storeId'").get() as { value: string }
    ).value;
  }
  /** List saved definitions without contacting any routers. */
  jobs(): BandwidthJob[] {
    return (
      this.db.query("SELECT body FROM bandwidth_jobs ORDER BY id").all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  /** Lookup one immutable run definition snapshot. */
  job(id: string): BandwidthJob | null {
    const row = this.db.query("SELECT body FROM bandwidth_jobs WHERE id=?").get(id) as {
      body: string;
    } | null;
    return row ? JSON.parse(row.body) : null;
  }
  /** Replace a definition; previous measurements retain their original settings. */
  save(job: BandwidthJob): void {
    this.db
      .query("INSERT OR REPLACE INTO bandwidth_jobs VALUES (?,?)")
      .run(job.id, JSON.stringify(job));
  }
  /** Remove only future work; never erase historical evidence or release an active lease. */
  remove(id: string): void {
    this.db.query("DELETE FROM bandwidth_jobs WHERE id=?").run(id);
  }
  /** Return bounded history, newest first. */
  runs(): BandwidthRun[] {
    return (
      this.db
        .query("SELECT body FROM bandwidth_runs ORDER BY rowid DESC LIMIT 2000")
        .all() as StoredRun[]
    ).map((r) => JSON.parse(r.body));
  }
  /** Publish a terminal outcome once, allocating a completion-order notification cursor. */
  finish(run: BandwidthRun): void {
    this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT body FROM bandwidth_runs WHERE id=?")
          .get(run.id) as StoredRun | null;
        if (!row || (JSON.parse(row.body) as BandwidthRun).status !== "running") return;
        this.db
          .query("UPDATE bandwidth_runs SET body=?, expires=0 WHERE id=?")
          .run(JSON.stringify(run), run.id);
        this.db
          .query("INSERT INTO bandwidth_notifications(body) VALUES (?)")
          .run(JSON.stringify(run));
      })
      .immediate();
  }
  /** Mark abandoned work unknown only after its bounded device execution window has passed. */
  recover(now: number): void {
    const expired = this.db
      .query("SELECT body FROM bandwidth_runs WHERE expires > 0 AND expires <= ?")
      .all(now) as StoredRun[];
    for (const row of expired)
      this.finish({
        ...JSON.parse(row.body),
        status: "interrupted",
        finishedAt: now,
        message: "Host stopped before recording completion; outcome unknown. Not retried.",
      });
  }
  /** Atomically reserve both routers and the global concurrency slot, across processes. */
  claim(run: BandwidthRun, source: string, destination: string, now: number): boolean {
    return this.db
      .transaction(() => {
        this.recover(now);
        const active = this.db
          .query("SELECT source,destination FROM bandwidth_runs WHERE expires>0")
          .all() as { source: string; destination: string }[];
        if (
          active.length >= BANDWIDTH_CONCURRENCY ||
          active.some((r) =>
            [r.source, r.destination].some((d) => d === source || d === destination),
          )
        )
          return false;
        if (run.trigger === "schedule") {
          const job = this.job(run.job.id);
          if (!job?.enabled || job.nextRunAt > now || job.nextRunAt !== run.job.nextRunAt)
            return false;
          this.save({ ...job, nextRunAt: now + job.intervalSeconds * 1000 });
        }
        this.db
          .query("INSERT INTO bandwidth_runs VALUES (?,?,?,?,?)")
          .run(run.id, JSON.stringify(run), source, destination, now + LEASE_MS);
        return true;
      })
      .immediate();
  }
  /** Keep leases while transport work is still outstanding; a timeout never unlocks early. */
  renew(id: string, now: number): void {
    this.db
      .query("UPDATE bandwidth_runs SET expires=? WHERE id=? AND expires>0")
      .run(now + LEASE_MS, id);
  }
  /** Read every completion after a durable cursor, including failures and interrupted tests. */
  notifications(
    after: number,
    limit: number,
  ): {
    storeId: string;
    events: { sequence: number; run: BandwidthRun }[];
    nextCursor: number;
    hasMore: boolean;
  } {
    const rows = this.db
      .query(
        "SELECT sequence,body FROM bandwidth_notifications WHERE sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(after, limit + 1) as { sequence: number; body: string }[];
    const events = rows
      .slice(0, limit)
      .map((row) => ({ sequence: row.sequence, run: JSON.parse(row.body) as BandwidthRun }));
    return {
      storeId: this.storeId,
      events,
      nextCursor: events.at(-1)?.sequence ?? after,
      hasMore: rows.length > limit,
    };
  }
  /** Close only after all outstanding operations have settled. */
  close(): void {
    this.db.close();
  }
}

/** Load Bun SQLite lazily so offline Vitest callers can mock the driver boundary. */
export async function openBandwidthStore(path: string): Promise<BandwidthStore> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { Database } = await import("bun:sqlite");
  return new BandwidthStore(new Database(path, { create: true }));
}
