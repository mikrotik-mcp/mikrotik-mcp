/**
 * Dashboard sub-router for scheduled audits.
 *
 *   GET    /api/schedules              jobs + next run + last outcome + posture
 *   POST   /api/schedules              add or replace a job
 *   DELETE /api/schedules/:id          remove a job and its history
 *   POST   /api/schedules/:id/run      run now, off-schedule
 *   GET    /api/schedules/timeline     runs over time (?job, ?device, ?days)
 *   GET    /api/schedules/regressions  what changed, newest first
 *
 * The timeline is the point of the page: a single audit report is a snapshot,
 * and the question people actually have — "when did this start getting worse" —
 * can only be answered by the series.
 */
import { logger } from "../logger";
import { auditAdapter, schedulableTools } from "../schedule/audits";
import {
  JobSchema,
  describeCron,
  describeDiff,
  diffFindings,
  nextRun,
  severityCounts,
  worstSeverity,
} from "../schedule/model";
import { armJob, forgetJob, nextRunOf, runJob } from "../schedule/runner";
import { liveExecutor, primeRiskIndex, runnerOptions } from "../schedule/session";
import { scheduleStore } from "../schedule/store";
import type { ScheduleJob, ScheduleRun } from "../schedule/store";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** The newest run per device, which is what "current posture" means. */
function latestPerDevice(runs: ScheduleRun[]): ScheduleRun[] {
  const latest = new Map<string, ScheduleRun>();
  for (const run of runs) {
    if (run.outcome !== "ok") continue;
    const key = run.device ?? "(fleet)";
    const seen = latest.get(key);
    if (!seen || run.startedAt > seen.startedAt) latest.set(key, run);
  }
  return [...latest.values()];
}

function jobRow(job: ScheduleJob, runs: ScheduleRun[], now: number): Record<string, unknown> {
  const current = latestPerDevice(runs);
  const findings = current.flatMap((r) => r.findings);
  return {
    ...job,
    cronText: describeCron(job.cron),
    nextRun: nextRunOf(job.id) ?? nextRun(job.cron, now),
    lastRun: runs[0]
      ? {
          startedAt: runs[0].startedAt,
          finishedAt: runs[0].finishedAt,
          outcome: runs[0].outcome,
          device: runs[0].device,
          error: runs[0].error,
        }
      : null,
    // Every device's most recent successful run, summed — the headline number.
    posture: {
      total: findings.length,
      worst: worstSeverity(findings) ?? null,
      bySeverity: severityCounts(findings),
      devices: current.length,
    },
    runCount: runs.length,
  };
}

/**
 * Per-run deltas for the regression feed.
 *
 * The counts are recomputed from the stored finding sets rather than read from
 * the run's own `added`/`worsened` columns: those were computed against the
 * baseline at the time, and the feed needs the diff between the two runs it is
 * actually showing.
 */
function regressionsFor(runs: ScheduleRun[], jobId: string): Record<string, unknown>[] {
  const byDevice = new Map<string, ScheduleRun[]>();
  for (const run of runs) {
    if (run.outcome !== "ok") continue;
    const key = run.device ?? "(fleet)";
    const list = byDevice.get(key);
    if (list) list.push(run);
    else byDevice.set(key, [run]);
  }

  const out: Record<string, unknown>[] = [];
  for (const [device, list] of byDevice) {
    // `runs` arrives newest-first, so [i+1] is the previous run.
    for (let i = 0; i < list.length - 1; i++) {
      const diff = diffFindings(list[i + 1].findings, list[i].findings);
      if (diff.added.length + diff.worsened.length + diff.resolved.length === 0) continue;
      out.push({
        jobId,
        device,
        at: list[i].startedAt,
        summary: describeDiff(diff),
        added: diff.added,
        worsened: diff.worsened,
        resolved: diff.resolved,
      });
    }
  }
  return out.sort((a, b) => (b.at as number) - (a.at as number));
}

export async function scheduleRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/schedules")) return null;

  let store;
  try {
    store = await scheduleStore();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), jobs: [] }, 503);
  }

  const now = Date.now();

  if (p === "/api/schedules" && req.method === "GET") {
    const jobs = store.listJobs().map((job) => jobRow(job, store.runs(job.id, 500), now));
    return json({
      jobs,
      schedulable: schedulableTools().map((a) => ({ tool: a.tool, summary: a.summary })),
    });
  }

  if (p === "/api/schedules" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "invalid JSON body" }, 400);

    const parsed = JobSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    }
    if (!auditAdapter(parsed.data.tool)) {
      return json({ error: `'${parsed.data.tool}' is not a schedulable auditor` }, 400);
    }
    // The same refusal the tool makes — the dashboard must not be a way around
    // the READ-only rule.
    await primeRiskIndex();
    const risk = liveExecutor().riskOf(parsed.data.tool);
    if (risk !== "READ") {
      return json(
        { error: `'${parsed.data.tool}' is annotated ${risk}; only READ may be scheduled` },
        400,
      );
    }

    const existing = store.getJob(parsed.data.id);
    const job: ScheduleJob = { ...parsed.data, createdAt: existing?.createdAt ?? now };
    store.saveJob(job);
    if (job.enabled) armJob(job, now);
    else forgetJob(job.id);
    return json({ job: jobRow(job, store.runs(job.id, 500), now), replaced: existing !== null });
  }

  if (p === "/api/schedules/timeline" && req.method === "GET") {
    const jobId = url.searchParams.get("job") ?? undefined;
    const device = url.searchParams.get("device") ?? undefined;
    const days = Number(url.searchParams.get("days") ?? 30);
    const since = now - days * 86_400_000;
    const runs = store
      .runs(jobId, 2000)
      .filter((r) => r.startedAt >= since && (!device || r.device === device));
    return json({
      // The series the posture chart plots: one point per run, stacked by
      // severity. Findings themselves are omitted — a month of full finding
      // sets is megabytes the chart never reads.
      points: runs
        .map((r) => ({
          at: r.startedAt,
          jobId: r.jobId,
          device: r.device,
          outcome: r.outcome,
          total: r.findings.length,
          bySeverity: severityCounts(r.findings),
          added: r.added,
          worsened: r.worsened,
          resolved: r.resolved,
          durationMs: r.finishedAt - r.startedAt,
        }))
        .sort((a, b) => a.at - b.at),
    });
  }

  if (p === "/api/schedules/regressions" && req.method === "GET") {
    const jobId = url.searchParams.get("job") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const jobs = jobId ? [jobId] : store.listJobs().map((j) => j.id);
    const items = jobs
      .flatMap((id) => regressionsFor(store.runs(id, 500), id))
      .sort((a, b) => (b.at as number) - (a.at as number))
      .slice(0, limit);
    return json({ regressions: items });
  }

  const parts = p.slice("/api/schedules/".length).split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(parts[0]);
  const verb = parts[1];

  if (!verb && req.method === "DELETE") {
    const job = store.getJob(id);
    if (!job) return json({ error: `no schedule '${id}'` }, 404);
    const runCount = store.runs(id, 10_000).length;
    store.removeJob(id);
    forgetJob(id);
    return json({ removed: id, runsDiscarded: runCount });
  }

  if (verb === "run" && req.method === "POST") {
    const job = store.getJob(id);
    if (!job) return json({ error: `no schedule '${id}'` }, 404);
    await primeRiskIndex();
    logger.info(`schedule '${id}' run requested from the dashboard`);
    const result = await runJob(job, liveExecutor(), runnerOptions());
    return json({
      ...result,
      job: jobRow(job, store.runs(id, 500), Date.now()),
    });
  }

  if (!verb && req.method === "GET") {
    const job = store.getJob(id);
    if (!job) return json({ error: `no schedule '${id}'` }, 404);
    const runs = store.runs(id, 500);
    return json({ job: jobRow(job, runs, now), runs, regressions: regressionsFor(runs, id) });
  }

  return json({ error: "not found" }, 404);
}
