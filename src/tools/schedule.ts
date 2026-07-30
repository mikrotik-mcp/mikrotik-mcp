/**
 * Scheduled audits — run the existing auditors on a timer, keep every result,
 * and report the DELTA against the previous run.
 *
 * These five tools are the operator's face on `src/schedule/`. The design point
 * worth repeating: an audit that reports 40 findings every night is muted by
 * week two, so what these surface is what CHANGED — new, worsened, resolved —
 * and the unchanged findings stay visible in the timeline and silent everywhere
 * else.
 *
 * Only READ tools can be scheduled, enforced by the runner against the catalog's
 * own risk annotation; `add_schedule` refuses early so the operator finds out at
 * definition time rather than at 03:00.
 */
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { auditAdapter, schedulableTools } from "../schedule/audits";
import {
  JobSchema,
  describeCron,
  describeDiff,
  diffFindings,
  isValidCron,
  nextRun,
  severityCounts,
  worstSeverity,
} from "../schedule/model";
import type { AuditFinding } from "../schedule/model";
import { armJob, forgetJob, nextRunOf, runJob } from "../schedule/runner";
import { liveExecutor, primeRiskIndex, runnerOptions } from "../schedule/session";
import { scheduleStore } from "../schedule/store";
import type { ScheduleJob, ScheduleRun } from "../schedule/store";

/** `2026-07-30 03:00` — local time, since a cron expression is local too. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relative(ms: number, now: number): string {
  const delta = Math.abs(ms - now);
  const minutes = Math.round(delta / 60_000);
  const text =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.round(minutes / 60)}h`
        : `${Math.round(minutes / 1440)}d`;
  return ms >= now ? `in ${text}` : `${text} ago`;
}

function severityLine(findings: AuditFinding[]): string {
  const counts = severityCounts(findings);
  const parts = Object.entries(counts).map(([sev, n]) => `${n} ${sev}`);
  return parts.length > 0 ? parts.join(", ") : "clean";
}

/** The newest run per device for a job — what "current posture" means. */
function latestPerDevice(runs: ScheduleRun[]): Map<string, ScheduleRun> {
  const latest = new Map<string, ScheduleRun>();
  for (const run of runs) {
    const key = run.device ?? "(fleet)";
    const seen = latest.get(key);
    if (!seen || run.startedAt > seen.startedAt) latest.set(key, run);
  }
  return latest;
}

const supportedList = (): string =>
  schedulableTools()
    .map((a) => `  ${a.tool} — ${a.summary}`)
    .join("\n");

export const scheduleTools: ToolModule = [
  defineTool({
    name: "list_schedules",
    title: "List Scheduled Audits",
    annotations: READ,
    noDevice: true,
    description:
      "Lists every scheduled audit job with its cron in plain English, next run, last outcome and " +
      "the current finding counts by severity. Use this to see what the server is watching on its " +
      "own — these jobs run without anyone asking, and their value is the run-over-run comparison, " +
      "not any single report. Shows which auditors can be scheduled when there are no jobs yet.",
    inputSchema: {
      job_id: z.string().optional().describe("Only this job."),
    },
    async handler(a) {
      const store = await scheduleStore();
      const jobs = store.listJobs().filter((j) => !a.job_id || j.id === a.job_id);
      if (jobs.length === 0) {
        return a.job_id
          ? `No scheduled audit called '${a.job_id}'.`
          : `No scheduled audits configured.\n\nAuditors that can be scheduled:\n${supportedList()}\n\n` +
              'Add one with add_schedule, e.g. cron "0 3 * * *" (every day at 03:00).';
      }

      const now = Date.now();
      const lines: string[] = [];
      for (const job of jobs) {
        const runs = store.runs(job.id, 200);
        const latest = latestPerDevice(runs);
        const findings = [...latest.values()].flatMap((r) => r.findings);
        const lastRun = runs[0];
        const next = nextRunOf(job.id) ?? nextRun(job.cron, now);

        lines.push(
          `${job.enabled ? "●" : "○"} ${job.id} — ${job.tool}`,
          `   ${describeCron(job.cron)}${job.enabled ? "" : " (disabled)"}`,
          `   devices: ${job.devices === "all" ? "all" : job.devices.join(", ")}`,
          `   next run: ${next === null ? "never" : `${stamp(next)} (${relative(next, now)})`}`,
          lastRun
            ? `   last run: ${stamp(lastRun.startedAt)} (${relative(lastRun.startedAt, now)}) — ${lastRun.outcome}${
                lastRun.error ? `: ${lastRun.error}` : ""
              }`
            : "   last run: never",
          `   posture: ${severityLine(findings)}${
            findings.length > 0 ? ` · worst ${worstSeverity(findings)}` : ""
          }`,
          "",
        );
      }
      return lines.join("\n").trimEnd();
    },
  }),

  defineTool({
    name: "add_schedule",
    title: "Add a Scheduled Audit",
    annotations: WRITE,
    noDevice: true,
    description:
      "Schedules an audit to run on its own and report only what changed since the previous run. " +
      "Only READ auditors can be scheduled — this is enforced, not advisory: an unattended loop " +
      "that can write to a router is a footgun, so schedule the audit and wire the alert to a human " +
      "instead. Cron is the restricted 5-field form (minute hour day-of-month month day-of-week) " +
      `with *, ranges, lists and step syntax.\n\nSchedulable auditors:\n${supportedList()}`,
    inputSchema: {
      id: z.string().describe("Job id, e.g. 'nightly-security'. Letters, digits and hyphens."),
      cron: z.string().describe('5-field cron, e.g. "0 3 * * *" for every day at 03:00.'),
      tool: z.string().describe("Auditor to run — one of the schedulable tools listed above."),
      devices: z
        .union([z.literal("all"), z.array(z.string())])
        .optional()
        .describe("Device names, or 'all' (the default) for every configured device."),
      notify_on: z
        .array(z.enum(["new", "worsened", "resolved", "improved"]))
        .optional()
        .describe("Which deltas raise an alert. Default: new + worsened."),
      retain_days: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long run history is kept. Default 90."),
    },
    async handler(a) {
      if (!isValidCron(a.cron)) {
        return `'${a.cron}' is not a valid 5-field cron expression. Example: "0 3 * * *" (every day at 03:00).`;
      }
      const adapter = auditAdapter(a.tool);
      if (!adapter) {
        return (
          `'${a.tool}' cannot be scheduled — there is no audit adapter for it, so a run would ` +
          `produce no findings to compare.\n\nSchedulable auditors:\n${supportedList()}`
        );
      }
      // Belt and braces: the runner refuses non-READ tools at fire time, but a
      // job that can never run should not be storable in the first place.
      await primeRiskIndex();
      const risk = liveExecutor().riskOf(a.tool);
      if (risk !== "READ") {
        return `Refused: '${a.tool}' is annotated ${risk}. Only READ tools may be scheduled.`;
      }

      const parsed = JobSchema.safeParse({
        id: a.id,
        cron: a.cron,
        tool: a.tool,
        devices: a.devices,
        notifyOn: a.notify_on,
        retainDays: a.retain_days,
      });
      if (!parsed.success) {
        return `Invalid job: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`;
      }

      const store = await scheduleStore();
      const replacing = store.getJob(parsed.data.id) !== null;
      const job: ScheduleJob = { ...parsed.data, createdAt: Date.now() };
      store.saveJob(job);
      const next = armJob(job, Date.now());

      return (
        `${replacing ? "Replaced" : "Scheduled"} '${job.id}': ${job.tool}, ${describeCron(job.cron)}.\n` +
        `Devices: ${job.devices === "all" ? "all" : job.devices.join(", ")}. ` +
        `Notifies on: ${job.notifyOn.join(", ")}.\n` +
        `Next run: ${next === null ? "never (the cron matches no date)" : stamp(next)}.\n` +
        "The first run establishes the baseline; comparisons start with the second."
      );
    },
  }),

  defineTool({
    name: "remove_schedule",
    title: "Remove a Scheduled Audit",
    annotations: DESTRUCTIVE,
    noDevice: true,
    description:
      "Removes a scheduled audit and its run history. The history is the timeline — deleting it " +
      "discards the record of how the posture changed over time, which cannot be rebuilt. To stop " +
      "a job while keeping its history, add_schedule the same id with a cron that suits you, or " +
      "disable it from the dashboard.",
    inputSchema: {
      id: z.string().describe("The job id to remove."),
    },
    async handler(a) {
      const store = await scheduleStore();
      const job = store.getJob(a.id);
      if (!job) return `No scheduled audit called '${a.id}'.`;
      const runCount = store.runs(a.id, 10_000).length;
      store.removeJob(a.id);
      forgetJob(a.id);
      return `Removed '${a.id}' (${job.tool}) and ${runCount} run(s) of history.`;
    },
  }),

  defineTool({
    name: "run_schedule_now",
    title: "Run a Scheduled Audit Now",
    annotations: READ,
    noDevice: true,
    description:
      "Runs a scheduled audit immediately, off-schedule, and reports what changed against each " +
      "device's previous successful run. Read-only — it runs the same READ auditor the schedule " +
      "would. Use it after a change to check you did not make something worse, without waiting for " +
      "the next window. Does not shift the schedule.",
    inputSchema: {
      id: z.string().describe("The job id to run."),
    },
    async handler(a, ctx) {
      const store = await scheduleStore();
      const job = store.getJob(a.id);
      if (!job) return `No scheduled audit called '${a.id}'.`;

      await primeRiskIndex();
      ctx.info(`Running scheduled audit '${job.id}' (${job.tool}) off-schedule`);
      const result = await runJob(job, liveExecutor(), runnerOptions());

      if (result.outcome === "skipped") {
        return `'${job.id}' is already running; not started again. Check back with list_schedules.`;
      }
      if (result.error) return `'${job.id}' did not run: ${result.error}`;

      const lines = [`${job.id} — ${job.tool}, ${result.perDevice.length} device(s)`];
      for (const d of result.perDevice) {
        if (d.outcome !== "ok") {
          lines.push(`  ✗ ${d.device}: ${d.outcome}${d.error ? ` — ${d.error}` : ""}`);
          continue;
        }
        const diff = d.diff;
        const changed = diff
          ? diff.added.length + diff.worsened.length + diff.resolved.length + diff.improved.length
          : 0;
        lines.push(`  ${changed > 0 ? "▲" : "·"} ${d.device}: ${diff ? describeDiff(diff) : "—"}`);
        for (const f of diff?.added ?? []) lines.push(`      new: [${f.severity}] ${f.title}`);
        for (const w of diff?.worsened ?? []) {
          lines.push(`      worse: [${w.from} → ${w.to}] ${w.finding.title}`);
        }
        for (const f of diff?.resolved ?? []) lines.push(`      fixed: ${f.title}`);
      }
      if (!result.notified) {
        lines.push("", "Nothing crossed this job's notify thresholds — no alert was raised.");
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "get_audit_timeline",
    title: "Audit Timeline",
    annotations: READ,
    noDevice: true,
    description:
      "Findings over time for a job (optionally one device): each run with its severity counts and " +
      "the new/worsened/resolved deltas, newest first, plus the change between the two most recent " +
      "runs in detail. This is how you answer 'when did this start getting worse' — the single run " +
      "an auditor prints cannot.",
    inputSchema: {
      job_id: z.string().describe("Which job's history to show."),
      device: z.string().optional().describe("Restrict to one device."),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(200)
        .default(20)
        .describe("How many runs to show. Default 20."),
    },
    async handler(a) {
      const store = await scheduleStore();
      const job = store.getJob(a.job_id);
      if (!job) return `No scheduled audit called '${a.job_id}'.`;

      const runs = store
        .runs(a.job_id, 500)
        .filter((r) => !a.device || r.device === a.device)
        .slice(0, a.limit);
      if (runs.length === 0) {
        return `'${a.job_id}' has not run yet${a.device ? ` on '${a.device}'` : ""}.`;
      }

      const now = Date.now();
      const lines = [
        `${job.id} — ${job.tool}${a.device ? ` on ${a.device}` : ""}, ${runs.length} run(s)`,
        "",
      ];
      for (const run of runs) {
        const delta =
          run.added + run.worsened + run.resolved > 0
            ? ` · +${run.added} new, ${run.worsened} worse, ${run.resolved} fixed`
            : "";
        lines.push(
          `${stamp(run.startedAt)} (${relative(run.startedAt, now)}) ${run.device ?? "fleet"} — ` +
            `${run.outcome}${run.outcome === "ok" ? `: ${severityLine(run.findings)}` : ""}${delta}` +
            `${run.error ? ` — ${run.error}` : ""}`,
        );
      }

      // The most recent transition in full: two successful runs on the same
      // device, which is the comparison the alert was (or was not) raised on.
      const ok = runs.filter((r) => r.outcome === "ok" && (!a.device || r.device === a.device));
      const [current, previous] = a.device
        ? ok
        : ok.filter((r) => r.device === ok[0]?.device).slice(0, 2);
      if (current && previous) {
        const diff = diffFindings(previous.findings, current.findings);
        lines.push(
          "",
          `Latest change on ${current.device ?? "fleet"}: ${describeDiff(diff)}`,
          ...diff.added.map((f) => `  new: [${f.severity}] ${f.title}`),
          ...diff.worsened.map((w) => `  worse: [${w.from} → ${w.to}] ${w.finding.title}`),
          ...diff.resolved.map((f) => `  fixed: ${f.title}`),
        );
      }
      return lines.join("\n");
    },
  }),
];
