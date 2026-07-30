/**
 * Schedule persistence — job definitions, run history and the findings of each
 * run.
 *
 * The findings are the point: a run's value is not its own output but its
 * comparison with the previous one, so every run's finding set is kept and the
 * diff is computed against what is stored, not against something held in memory
 * that a restart would lose.
 *
 * Shares `events.db` (no new file) and imports `bun:sqlite` **dynamically**, so
 * the Node/Vitest import graph never loads the driver.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_DASHBOARD_DB } from "../config";
import { logger } from "../logger";
import type { AuditFinding, NotifyOn } from "./model";

export interface ScheduleJob {
  id: string;
  cron: string;
  /** MCP tool to run. Must be READ-annotated — enforced by the runner. */
  tool: string;
  /** Devices to run against: `all`, a list, or a tag selector. */
  devices: string[] | "all";
  notifyOn: NotifyOn[];
  /** Extra arguments passed to the tool. */
  args?: Record<string, unknown>;
  enabled: boolean;
  /** How long run history is kept, in days. */
  retainDays: number;
  createdAt: number;
}

export type RunOutcome = "ok" | "failed" | "skipped" | "timeout";

export interface ScheduleRun {
  id: number;
  jobId: string;
  startedAt: number;
  finishedAt: number;
  outcome: RunOutcome;
  device?: string;
  findings: AuditFinding[];
  /** New/worsened/resolved counts, so the timeline needs no recomputation. */
  added: number;
  worsened: number;
  resolved: number;
  error?: string;
}

export interface ScheduleStore {
  saveJob(job: ScheduleJob): void;
  listJobs(): ScheduleJob[];
  getJob(id: string): ScheduleJob | null;
  removeJob(id: string): boolean;

  recordRun(run: Omit<ScheduleRun, "id">): number;
  /** Runs for a job, newest first. */
  runs(jobId?: string, limit?: number): ScheduleRun[];
  /** The most recent successful run for a (job, device) — what a diff compares to. */
  lastSuccessful(jobId: string, device?: string): ScheduleRun | null;
  prune(now: number): number;
  close(): void;
}

interface JobRow {
  id: string;
  cron: string;
  tool: string;
  devices: string;
  notify_on: string;
  args: string | null;
  enabled: number;
  retain_days: number;
  created_at: number;
}

interface RunRow {
  id: number;
  job_id: string;
  started_at: number;
  finished_at: number;
  outcome: string;
  device: string | null;
  findings: string;
  added: number;
  worsened: number;
  resolved: number;
  error: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schedule_jobs (
     id          TEXT PRIMARY KEY,
     cron        TEXT NOT NULL,
     tool        TEXT NOT NULL,
     devices     TEXT NOT NULL,
     notify_on   TEXT NOT NULL,
     args        TEXT,
     enabled     INTEGER NOT NULL,
     retain_days INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS schedule_runs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id      TEXT NOT NULL,
     started_at  INTEGER NOT NULL,
     finished_at INTEGER NOT NULL,
     outcome     TEXT NOT NULL,
     device      TEXT,
     findings    TEXT NOT NULL,
     added       INTEGER NOT NULL,
     worsened    INTEGER NOT NULL,
     resolved    INTEGER NOT NULL,
     error       TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_schedule_runs_job ON schedule_runs(job_id, started_at)",
];

function rowToJob(r: JobRow): ScheduleJob {
  const devices = JSON.parse(r.devices) as string[] | "all";
  return {
    id: r.id,
    cron: r.cron,
    tool: r.tool,
    devices,
    notifyOn: JSON.parse(r.notify_on) as NotifyOn[],
    args: r.args ? (JSON.parse(r.args) as Record<string, unknown>) : undefined,
    enabled: r.enabled === 1,
    retainDays: r.retain_days,
    createdAt: r.created_at,
  };
}

function rowToRun(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.outcome as RunOutcome,
    device: r.device ?? undefined,
    findings: JSON.parse(r.findings) as AuditFinding[],
    added: r.added,
    worsened: r.worsened,
    resolved: r.resolved,
    error: r.error ?? undefined,
  };
}

class SqliteScheduleStore implements ScheduleStore {
  constructor(private readonly db: Database) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA) db.run(stmt);
  }

  saveJob(job: ScheduleJob): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO schedule_jobs
         (id, cron, tool, devices, notify_on, args, enabled, retain_days, created_at)
         VALUES ($id,$cron,$tool,$devices,$notify,$args,$enabled,$retain,$created)`,
      )
      .run({
        $id: job.id,
        $cron: job.cron,
        $tool: job.tool,
        $devices: JSON.stringify(job.devices),
        $notify: JSON.stringify(job.notifyOn),
        $args: job.args ? JSON.stringify(job.args) : null,
        $enabled: job.enabled ? 1 : 0,
        $retain: job.retainDays,
        $created: job.createdAt,
      });
  }

  listJobs(): ScheduleJob[] {
    return (this.db.query("SELECT * FROM schedule_jobs ORDER BY id").all() as JobRow[]).map(
      rowToJob,
    );
  }

  getJob(id: string): ScheduleJob | null {
    const row = this.db.query("SELECT * FROM schedule_jobs WHERE id = $id").get({ $id: id }) as
      | JobRow
      | undefined;
    return row ? rowToJob(row) : null;
  }

  removeJob(id: string): boolean {
    const before = (this.db.query("SELECT COUNT(*) AS n FROM schedule_jobs").get() as { n: number })
      .n;
    this.db.query("DELETE FROM schedule_jobs WHERE id = $id").run({ $id: id });
    this.db.query("DELETE FROM schedule_runs WHERE job_id = $id").run({ $id: id });
    const after = (this.db.query("SELECT COUNT(*) AS n FROM schedule_jobs").get() as { n: number })
      .n;
    return after < before;
  }

  recordRun(run: Omit<ScheduleRun, "id">): number {
    this.db
      .query(
        `INSERT INTO schedule_runs
         (job_id, started_at, finished_at, outcome, device, findings, added, worsened, resolved, error)
         VALUES ($job,$started,$finished,$outcome,$device,$findings,$added,$worsened,$resolved,$error)`,
      )
      .run({
        $job: run.jobId,
        $started: run.startedAt,
        $finished: run.finishedAt,
        $outcome: run.outcome,
        $device: run.device ?? null,
        $findings: JSON.stringify(run.findings),
        $added: run.added,
        $worsened: run.worsened,
        $resolved: run.resolved,
        $error: run.error ?? null,
      });
    const row = this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    return row.id;
  }

  runs(jobId?: string, limit = 100): ScheduleRun[] {
    const rows = jobId
      ? (this.db
          .query(
            "SELECT * FROM schedule_runs WHERE job_id = $job ORDER BY started_at DESC LIMIT $limit",
          )
          .all({ $job: jobId, $limit: limit }) as RunRow[])
      : (this.db
          .query("SELECT * FROM schedule_runs ORDER BY started_at DESC LIMIT $limit")
          .all({ $limit: limit }) as RunRow[]);
    return rows.map(rowToRun);
  }

  lastSuccessful(jobId: string, device?: string): ScheduleRun | null {
    // A failed run has no trustworthy finding set, so it must not become the
    // baseline — otherwise one SSH timeout makes the next run report the whole
    // fleet as "new".
    const row = device
      ? (this.db
          .query(
            `SELECT * FROM schedule_runs WHERE job_id = $job AND device = $device AND outcome = 'ok'
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get({ $job: jobId, $device: device }) as RunRow | undefined)
      : (this.db
          .query(
            `SELECT * FROM schedule_runs WHERE job_id = $job AND outcome = 'ok'
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get({ $job: jobId }) as RunRow | undefined);
    return row ? rowToRun(row) : null;
  }

  prune(now: number): number {
    let removed = 0;
    for (const job of this.listJobs()) {
      const cutoff = now - job.retainDays * 86_400_000;
      const before = (
        this.db
          .query("SELECT COUNT(*) AS n FROM schedule_runs WHERE job_id = $job")
          .get({ $job: job.id }) as { n: number }
      ).n;
      this.db
        .query("DELETE FROM schedule_runs WHERE job_id = $job AND started_at < $cutoff")
        .run({ $job: job.id, $cutoff: cutoff });
      const after = (
        this.db
          .query("SELECT COUNT(*) AS n FROM schedule_runs WHERE job_id = $job")
          .get({ $job: job.id }) as { n: number }
      ).n;
      removed += before - after;
    }
    return removed;
  }

  close(): void {
    this.db.close();
  }
}

export async function openScheduleStore(path: string): Promise<ScheduleStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  return new SqliteScheduleStore(new Database(path, { create: true }));
}

let storePromise: Promise<ScheduleStore> | null = null;

export function scheduleStore(): Promise<ScheduleStore> {
  storePromise ??= openScheduleStore(DEFAULT_DASHBOARD_DB);
  return storePromise;
}

let writeFailureLogged = false;

/** Best-effort persistence — a schedule must not fail because history could not be written. */
export async function persistRun(run: Omit<ScheduleRun, "id">): Promise<void> {
  try {
    (await scheduleStore()).recordRun(run);
  } catch (e) {
    // Once per process: a store that cannot open fails identically for every
    // device of every run, and a fleet sweep would otherwise print the same
    // line fifty times per night.
    if (writeFailureLogged) return;
    writeFailureLogged = true;
    logger.error(
      `schedule run history unavailable; runs will not be diffable: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
