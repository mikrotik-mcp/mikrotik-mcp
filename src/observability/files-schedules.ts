/**
 * Scheduled collection for the dashboard Files page: at an interval, copy the
 * files of a router folder that match a pattern into the backup vault of this
 * host, and keep only the newest ones.
 *
 * A job reads routers and writes this host only, so a read-only server runs it.
 * Jobs are kept in one JSON file beside the dashboard database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FileJob {
  id: string;
  /** Router names; empty means every configured router. */
  devices: string[];
  dir: string;
  /** A regular expression for the file names (no case). */
  pattern: string;
  everyMs: number;
  /** Collected files to keep for each router; 0 keeps all. */
  keep: number;
  /** When it runs next, in milliseconds. */
  next: number;
  last?: { at: number; ok: boolean; note: string };
  /** Vault names this job wrote, oldest first, for each router. */
  collected: Record<string, string[]>;
}

export const MIN_EVERY_MS = 60 * 60 * 1000;
export const MAX_JOBS = 20;

let file: string | undefined;
let jobs: FileJob[] = [];

/** Where the jobs are kept; `undefined` keeps them in memory only. */
export function setJobsFile(path: string | undefined): void {
  file = path;
  jobs = [];
  if (!path || !existsSync(path)) return;
  try {
    jobs = JSON.parse(readFileSync(path, "utf8")) as FileJob[];
  } catch {
    jobs = [];
  }
}

function save(): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(jobs, null, 2));
  } catch {
    /* the jobs still run from memory */
  }
}

export const listJobs = (): FileJob[] => jobs;

/** Add a job. Throws a plain message when the input is not valid. */
export function addJob(
  input: { devices?: unknown; dir: string; pattern?: unknown; everyMs?: unknown; keep?: unknown },
  now = Date.now(),
): FileJob {
  if (jobs.length >= MAX_JOBS) throw new Error(`There can be ${MAX_JOBS} scheduled jobs at most.`);
  const pattern =
    typeof input.pattern === "string" && input.pattern ? input.pattern : "\\.(backup|rsc)$";
  try {
    // eslint-disable-next-line no-new -- only to validate the pattern
    new RegExp(pattern);
  } catch {
    throw new Error("The pattern is not a valid regular expression.");
  }
  const everyMs = Math.floor(Number(input.everyMs));
  if (!Number.isFinite(everyMs) || everyMs < MIN_EVERY_MS)
    throw new Error("The interval must be one hour or longer.");
  const job: FileJob = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    devices: (Array.isArray(input.devices) ? input.devices : []).filter(
      (name): name is string => typeof name === "string" && name !== "",
    ),
    dir: input.dir,
    pattern,
    everyMs,
    keep: Math.min(Math.max(Math.floor(Number(input.keep)) || 0, 0), 365),
    next: now + everyMs,
    collected: {},
  };
  jobs = [...jobs, job];
  save();
  return job;
}

export function removeJob(id: string): boolean {
  const before = jobs.length;
  jobs = jobs.filter((job) => job.id !== id);
  save();
  return jobs.length < before;
}

/** What one router gave: the vault names written now. */
export type Collect = (device: string, dir: string, pattern: RegExp) => Promise<string[]>;

/**
 * Run one job on its routers. `drop` removes a vault file that is over the
 * job's `keep`. A router that fails does not stop the others.
 */
export async function runJob(
  job: FileJob,
  routers: string[],
  collect: Collect,
  drop: (name: string) => void,
  now = Date.now(),
): Promise<void> {
  const pattern = new RegExp(job.pattern, "i");
  const notes: string[] = [];
  let ok = true;
  for (const device of job.devices.length ? job.devices : routers) {
    try {
      const names = await collect(device, job.dir, pattern);
      const all = [...(job.collected[device] ?? []), ...names];
      const extra = job.keep > 0 ? all.splice(0, Math.max(all.length - job.keep, 0)) : [];
      for (const name of extra) drop(name);
      job.collected[device] = all;
      notes.push(`${device}: ${names.length} new`);
    } catch (error) {
      ok = false;
      notes.push(`${device}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  job.last = { at: now, ok, note: notes.join(" · ") };
  job.next = now + job.everyMs;
  save();
}

/** Run every job whose time has come. Returns how many ran. */
export async function runDueJobs(
  routers: string[],
  collect: Collect,
  drop: (name: string) => void,
  now = Date.now(),
): Promise<number> {
  let ran = 0;
  for (const job of jobs) {
    if (job.next > now) continue;
    await runJob(job, routers, collect, drop, now);
    ran += 1;
  }
  return ran;
}
