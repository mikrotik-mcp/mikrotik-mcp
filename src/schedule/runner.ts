/**
 * The scheduled-audit runner.
 *
 * Jobs run on the MCP HOST, not on the router — several of the auditors they
 * call are fleet-wide or host-side (drift, policy), and RouterOS's own
 * `/system/scheduler` could not invoke them at all. Confusing the two would be a
 * real design error, so this is a host-side loop with an explicit tick.
 *
 * Four disciplines, each with a reason:
 *
 * - **READ tools only, enforced in code.** An autonomous loop that can write to a
 *   router unattended is a footgun; the check reads the tool's own risk
 *   annotation rather than trusting a list.
 * - **Skip if the previous run has not finished.** Never queue a job behind
 *   itself: a slow fleet audit would otherwise pile up until the host falls over.
 * - **No backfill.** A host asleep for six hours runs once at wake, not six
 *   times, and the miss is recorded.
 * - **Bounded concurrency and jitter.** Fifty devices starting in the same second
 *   is a thundering herd of SSH sessions on hardware that has four CPUs.
 */
import { emitAlertEvent } from "../alerts/engine";
import { logger } from "../logger";
import { describeDiff, diffFindings, nextRun, shouldNotify } from "./model";
import type { AuditFinding, FindingDiff } from "./model";
import { persistRun, scheduleStore } from "./store";
import type { RunOutcome, ScheduleJob } from "./store";

/** How a job actually runs, injected so the whole loop is testable offline. */
export interface AuditExecutor {
  /** The tool's risk annotation, used to refuse anything above READ. */
  riskOf(
    tool: string,
  ): "READ" | "WRITE" | "WRITE_IDEMPOTENT" | "DESTRUCTIVE" | "DANGEROUS" | "UNKNOWN";
  /** Resolve `devices: "all"` to concrete names. */
  resolveDevices(spec: string[] | "all"): string[];
  /** Run the auditor against one device and return its findings. */
  audit(tool: string, device: string, args?: Record<string, unknown>): Promise<AuditFinding[]>;
}

export interface RunnerOptions {
  /** Concurrent device audits. Default 4 — a fleet sweep must not be a herd. */
  concurrency?: number;
  /** Per-job wall-clock budget. Default 10 minutes. */
  timeoutMs?: number;
  /** Up to this many ms of random start delay per device. */
  jitterMs?: number;
  /** Injected clock, so tests need no real time. */
  now?: () => number;
  /** Injected sleep, so tests need no real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export interface JobResult {
  jobId: string;
  outcome: RunOutcome;
  /** Per device, what changed since that device's last successful run. */
  perDevice: { device: string; outcome: RunOutcome; diff?: FindingDiff; error?: string }[];
  notified: boolean;
  error?: string;
}

const DEFAULTS = {
  concurrency: 4,
  timeoutMs: 10 * 60_000,
  jitterMs: 3_000,
};

/** Jobs currently executing, so a slow run is skipped rather than doubled up. */
const running = new Set<string>();

/**
 * A distinct value for "the budget ran out", so a timeout is never confused
 * with a device that failed fast — they mean different things to the operator
 * reading the run history.
 */
const TIMED_OUT = Symbol("timed-out");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Run one job now.
 *
 * Returns a per-device result set rather than a single verdict: on a fleet, one
 * unreachable router must not invalidate the other forty-nine.
 */
export async function runJob(
  job: ScheduleJob,
  executor: AuditExecutor,
  options: RunnerOptions = {},
): Promise<JobResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const jitterMs = options.jitterMs ?? DEFAULTS.jitterMs;

  // A job whose previous run has not finished is SKIPPED, never queued behind
  // itself — that is how a slow audit turns into an unbounded backlog.
  if (running.has(job.id)) {
    logger.warn(`schedule '${job.id}' is still running; skipping this occurrence`);
    return { jobId: job.id, outcome: "skipped", perDevice: [], notified: false };
  }

  // READ-only, enforced against the tool's own annotation rather than a list
  // someone has to remember to update.
  const risk = executor.riskOf(job.tool);
  if (risk !== "READ") {
    const error =
      risk === "UNKNOWN"
        ? `tool '${job.tool}' is not in the catalog`
        : `tool '${job.tool}' is annotated ${risk}; only READ tools may be scheduled`;
    logger.error(`schedule '${job.id}': ${error}`);
    return { jobId: job.id, outcome: "failed", perDevice: [], notified: false, error };
  }

  running.add(job.id);
  const startedAt = now();
  const devices = executor.resolveDevices(job.devices);
  const perDevice: JobResult["perDevice"] = [];
  let notified = false;

  try {
    const store = await scheduleStore().catch(() => null);

    const auditOne = async (device: string, index: number): Promise<void> => {
      // Stagger: spread the starts so a fleet does not open N SSH sessions in
      // the same millisecond.
      if (jitterMs > 0) await sleep((index % concurrency) * Math.floor(jitterMs / concurrency));

      /** One device went wrong; the other forty-nine carry on. */
      const fail = async (outcome: RunOutcome, error: string): Promise<void> => {
        perDevice.push({ device, outcome, error });
        await persistRun({
          jobId: job.id,
          startedAt,
          finishedAt: now(),
          outcome,
          device,
          findings: [],
          added: 0,
          worsened: 0,
          resolved: 0,
          error,
        });
      };

      let findings: AuditFinding[] | typeof TIMED_OUT;
      try {
        findings = await withTimeout(executor.audit(job.tool, device, job.args), timeoutMs);
      } catch (e) {
        await fail("failed", e instanceof Error ? e.message : String(e));
        return;
      }
      if (findings === TIMED_OUT) {
        await fail("timeout", `timed out after ${timeoutMs}ms`);
        return;
      }

      // Compare against this DEVICE's last successful run — a failed run is
      // never the baseline, or one SSH timeout makes the next run report the
      // whole device as new.
      const previous = store?.lastSuccessful(job.id, device)?.findings ?? [];
      const diff = diffFindings(previous, findings);

      await persistRun({
        jobId: job.id,
        startedAt,
        finishedAt: now(),
        outcome: "ok",
        device,
        findings,
        added: diff.added.length,
        worsened: diff.worsened.length,
        resolved: diff.resolved.length,
      });
      perDevice.push({ device, outcome: "ok", diff });

      if (shouldNotify(diff, job.notifyOn)) {
        notified = true;
        // Into task 07's bus rather than a second notification path.
        emitAlertEvent({
          kind: "audit",
          device,
          tool: job.tool,
          isError: diff.added.length > 0 || diff.worsened.length > 0,
          detail: `${job.id} on ${device}: ${describeDiff(diff)}`,
        });
      }
    };

    // Bounded concurrency: a simple worker pool over the device list.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, devices.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= devices.length) return;
        await auditOne(devices[index], index);
      }
    });
    await Promise.all(workers);
  } finally {
    running.delete(job.id);
  }

  const failed = perDevice.filter((d) => d.outcome !== "ok");
  return {
    jobId: job.id,
    // A partial failure is still a failure to report, but the successful devices
    // kept their comparison — that is why the outcome is per device too.
    outcome: failed.length === perDevice.length && perDevice.length > 0 ? "failed" : "ok",
    perDevice,
    notified,
  };
}

/** In-memory next-run bookkeeping. Rebuilt from the job list on start. */
const schedule = new Map<string, number>();

/**
 * Advance the scheduler to `now`, running whatever is due.
 *
 * **Missed runs are not backfilled.** If the host slept through six occurrences,
 * the job runs ONCE and the next fire time is computed from now — six identical
 * audits back to back would just be six times the load for one answer.
 */
export async function tick(
  jobs: ScheduleJob[],
  executor: AuditExecutor,
  options: RunnerOptions = {},
): Promise<JobResult[]> {
  const now = (options.now ?? Date.now)();
  const results: JobResult[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;

    const due = schedule.get(job.id);
    if (due === undefined) {
      // First sight of this job: arm it, do not run it immediately. A server
      // restart should not trigger every nightly audit at once.
      const next = nextRun(job.cron, now);
      if (next !== null) schedule.set(job.id, next);
      continue;
    }
    if (due > now) continue;

    const missed = countMissed(job.cron, due, now);
    if (missed > 1) {
      logger.warn(
        `schedule '${job.id}' missed ${missed - 1} occurrence(s) (host asleep or busy); running once`,
      );
    }
    const next = nextRun(job.cron, now);
    if (next !== null) schedule.set(job.id, next);
    else schedule.delete(job.id);

    results.push(await runJob(job, executor, options));
  }
  return results;
}

/** How many occurrences fell between `from` and `now` — for the miss log. */
function countMissed(cron: string, from: number, now: number): number {
  let count = 0;
  let cursor = from;
  // Bounded: a very frequent cron over a long sleep must not spin forever.
  while (count < 1000) {
    const next = nextRun(cron, cursor);
    if (next === null || next > now) break;
    count++;
    cursor = next;
  }
  return count + 1;
}

/** Arm a job's next run (used when a job is added or changed). */
export function armJob(job: ScheduleJob, from: number): number | null {
  const next = nextRun(job.cron, from);
  if (next === null) schedule.delete(job.id);
  else schedule.set(job.id, next);
  return next;
}

export function nextRunOf(jobId: string): number | undefined {
  return schedule.get(jobId);
}

export function forgetJob(jobId: string): void {
  schedule.delete(jobId);
}

/** Exposed for tests: is this job considered in-flight? */
export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

/** Exposed for tests: reset all in-memory scheduling state. */
export function resetScheduler(): void {
  schedule.clear();
  running.clear();
}
