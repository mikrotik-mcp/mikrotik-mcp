/**
 * Schedules view — what the server watches on its own, and how the posture is
 * trending.
 *
 *   • **Job board** — each job as a card: cron in plain English, next run
 *     countdown, last outcome, Run now. Plain English removes a whole class of
 *     misconfiguration, because nobody misreads "every day at 03:00".
 *   • **Posture timeline** — findings over time, stacked by severity. This is the
 *     centrepiece: a single audit says "12 findings", a series says "critical
 *     went to zero six weeks ago", and only the second one is motivating.
 *   • **Regression feed** — new / worsened / resolved since the run before,
 *     expandable to the finding.
 *   • **Heat calendar** — one cell per day, coloured by finding count. Instantly
 *     shows "it started getting worse three weeks ago".
 *   • **Run history** — per run, with duration, device and failures.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { toast } from "./toast-action";
import type { ScheduleJobRow, SchedulePoint, ScheduleRegression, ScheduleOutcome } from "./types";
import { cn } from "@/lib/utils";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

const SEVERITY_TYPE: Record<string, GeistType> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "secondary",
  info: "secondary",
};

/** Stacked-area fills, worst on the bottom so the eye lands on it first. */
const SEVERITY_FILL: Record<string, string> = {
  critical: "var(--color-red-500, #ef4444)",
  high: "var(--color-orange-500, #f97316)",
  medium: "var(--color-amber-500, #f59e0b)",
  low: "var(--color-sky-500, #0ea5e9)",
  info: "var(--color-slate-400, #94a3b8)",
};

const OUTCOME_DOT: Record<ScheduleOutcome, GeistType> = {
  ok: "success",
  failed: "error",
  timeout: "warning",
  skipped: "secondary",
};

const DAY_MS = 86_400_000;

function relative(ms: number, now: number): string {
  const delta = Math.abs(ms - now);
  const minutes = Math.round(delta / 60_000);
  const text =
    minutes < 1
      ? "now"
      : minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.round(minutes / 60)}h`
          : `${Math.round(minutes / 1440)}d`;
  if (text === "now") return "now";
  return ms >= now ? `in ${text}` : `${text} ago`;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `2026-07-30` in local time — the heat calendar's cell key. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Findings over time, stacked by severity.
 *
 * Hand-drawn SVG rather than a chart library: the series is a few hundred points
 * of five numbers, and the interesting part (severity stacking with the worst at
 * the bottom) is three lines of arithmetic.
 */
function PostureTimeline({ points }: { points: SchedulePoint[] }): ReactNode {
  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Two runs are needed before there is a trend. The first run is the baseline.
      </p>
    );
  }

  const w = 720;
  const h = 160;
  const max = Math.max(1, ...points.map((p) => p.total));
  const step = w / (points.length - 1);
  const x = (i: number): number => i * step;
  const y = (v: number): number => h - (v / max) * h;

  // Cumulative stacking, worst severity first so it sits on the baseline.
  let below = points.map(() => 0);
  const layers = SEVERITIES.map((severity) => {
    const top = points.map((p, i) => below[i] + (p.bySeverity[severity] ?? 0));
    // Top edge left→right, then this layer's floor right→left, closed.
    const area = [
      ...top.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`),
      ...[...below].reverse().map((v, i) => `L${x(points.length - 1 - i)},${y(v)}`),
      "Z",
    ].join(" ");
    below = top;
    return { severity, area };
  }).reverse();

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full" preserveAspectRatio="none">
          {layers.map((l) => (
            <path key={l.severity} d={l.area} fill={SEVERITY_FILL[l.severity]} opacity={0.75} />
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          {stamp(points[0].at)} → {stamp(points[points.length - 1].at)}
        </span>
        <span className="ml-auto flex gap-3">
          {SEVERITIES.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: SEVERITY_FILL[s] }}
              />
              {s}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** GitHub-style grid: one cell per day, coloured by that day's worst run. */
function HeatCalendar({
  points,
  days = 90,
}: {
  points: SchedulePoint[];
  days?: number;
}): ReactNode {
  const now = Date.now();
  const byDay = new Map<string, { total: number; failed: boolean }>();
  for (const p of points) {
    const key = dayKey(p.at);
    const seen = byDay.get(key);
    const total = p.outcome === "ok" ? p.total : (seen?.total ?? 0);
    byDay.set(key, {
      total: Math.max(seen?.total ?? 0, total),
      failed: (seen?.failed ?? false) || p.outcome !== "ok",
    });
  }

  const max = Math.max(1, ...[...byDay.values()].map((v) => v.total));
  const cells = Array.from({ length: days }, (_, i) => {
    const at = now - (days - 1 - i) * DAY_MS;
    const key = dayKey(at);
    return { key, at, data: byDay.get(key) };
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-[3px]">
        {cells.map((c) => {
          // No run that day is deliberately different from a clean run: an empty
          // cell means "not measured", which is not the same as "nothing wrong".
          const title = c.data
            ? `${c.key}: ${c.data.total} finding(s)${c.data.failed ? " · a run failed" : ""}`
            : `${c.key}: no run`;
          const intensity = c.data ? 0.2 + 0.8 * (c.data.total / max) : 0;
          return (
            <span
              key={c.key}
              title={title}
              className={cn(
                "h-3 w-3 rounded-[2px]",
                !c.data && "bg-muted/40",
                c.data?.failed && "ring-1 ring-red-500",
              )}
              style={c.data ? { background: SEVERITY_FILL.high, opacity: intensity } : undefined}
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {days} days · empty means no run that day, which is not the same as a clean one
      </p>
    </div>
  );
}

function RegressionRow({ item }: { item: ScheduleRegression }): ReactNode {
  const [open, setOpen] = useState(false);
  const worsening = item.added.length + item.worsened.length > 0;
  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 text-left"
      >
        <Dot type={worsening ? "error" : "success"} />
        <span className="font-mono text-xs">{item.jobId}</span>
        <span className="text-sm font-medium">{item.device}</span>
        <span className="flex-1 truncate text-sm text-muted-foreground">{item.summary}</span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">{stamp(item.at)}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 pl-6 text-sm">
          {item.added.map((f) => (
            <li key={`a-${f.id}`} className="flex items-center gap-2">
              <Badge type={SEVERITY_TYPE[f.severity] ?? "secondary"}>new</Badge>
              <span>{f.title}</span>
              {f.detail && <span className="text-xs text-muted-foreground">— {f.detail}</span>}
            </li>
          ))}
          {item.worsened.map((w) => (
            <li key={`w-${w.finding.id}`} className="flex items-center gap-2">
              <Badge type="warning">
                {w.from} → {w.to}
              </Badge>
              <span>{w.finding.title}</span>
            </li>
          ))}
          {item.resolved.map((f) => (
            <li key={`r-${f.id}`} className="flex items-center gap-2">
              <Badge type="success">fixed</Badge>
              <span className="text-muted-foreground">{f.title}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function SchedulesView(): ReactNode {
  const [jobs, setJobs] = useState<ScheduleJobRow[]>([]);
  const [schedulable, setSchedulable] = useState<{ tool: string; summary: string }[]>([]);
  const [points, setPoints] = useState<SchedulePoint[]>([]);
  const [regressions, setRegressions] = useState<ScheduleRegression[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (job?: string | null): Promise<void> => {
    try {
      const q = job ? `?job=${encodeURIComponent(job)}` : "";
      const [list, timeline, regs] = await Promise.all([
        api<{
          jobs: ScheduleJobRow[];
          schedulable: { tool: string; summary: string }[];
          error?: string;
        }>("/api/schedules"),
        api<{ points: SchedulePoint[] }>(`/api/schedules/timeline${q}`),
        api<{ regressions: ScheduleRegression[] }>(`/api/schedules/regressions${q}`),
      ]);
      setJobs(list.jobs ?? []);
      setSchedulable(list.schedulable ?? []);
      setPoints(timeline.points ?? []);
      setRegressions(regs.regressions ?? []);
      setError(list.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(selected);
  }, [load, selected]);

  const runNow = async (id: string): Promise<void> => {
    setRunning(id);
    try {
      const res = await postJson<{ outcome: string; notified: boolean; error?: string }>(
        `/api/schedules/${encodeURIComponent(id)}/run`,
        {},
      );
      if (res.error) toast.error(res.error);
      else toast.success(`${id}: ${res.outcome}${res.notified ? " — alert raised" : ""}`);
      await load(selected);
    } catch (e) {
      toast.error(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Removed ${id} and its history`);
      if (selected === id) setSelected(null);
      await load(null);
    } catch (e) {
      toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const now = Date.now();
  const totals = useMemo(() => {
    const findings = jobs.reduce((n, j) => n + j.posture.total, 0);
    const critical = jobs.reduce((n, j) => n + (j.posture.bySeverity.critical ?? 0), 0);
    const failing = jobs.filter((j) => j.lastRun && j.lastRun.outcome !== "ok").length;
    return { findings, critical, failing };
  }, [jobs]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          k="Jobs"
          v={String(jobs.length)}
          sub={`${jobs.filter((j) => j.enabled).length} enabled`}
        />
        <StatCard
          k="Critical"
          v={String(totals.critical)}
          cls={totals.critical > 0 ? "text-red-500" : "text-emerald-500"}
          sub="open findings"
        />
        <StatCard k="Open findings" v={String(totals.findings)} sub="latest run per device" />
        <StatCard
          k="Failing jobs"
          v={String(totals.failing)}
          cls={totals.failing > 0 ? "text-amber-500" : undefined}
          sub="last run not ok"
        />
      </div>

      {error && (
        <Panel title="Schedules unavailable">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </Panel>
      )}

      <Panel
        title="Jobs"
        extra={
          selected && (
            <Button size="sm" type="secondary" onClick={() => setSelected(null)}>
              Show all
            </Button>
          )
        }
      >
        {jobs.length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Nothing scheduled. Add one with <span className="font-mono">add_schedule</span> —
              these run on their own and report only what changed since the previous run.
            </p>
            <ul className="space-y-1">
              {schedulable.map((s) => (
                <li key={s.tool}>
                  <span className="font-mono text-xs">{s.tool}</span> — {s.summary}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 py-3",
                  selected === job.id && "bg-muted/30",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => setSelected(selected === job.id ? null : job.id)}
                >
                  <Dot
                    type={
                      job.enabled ? OUTCOME_DOT[job.lastRun?.outcome ?? "skipped"] : "secondary"
                    }
                  />
                  <span className="w-44 truncate font-medium">{job.id}</span>
                  <span className="w-56 truncate text-sm text-muted-foreground">
                    {job.cronText}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{job.tool}</span>
                </button>
                <span className="text-xs text-muted-foreground">
                  next {job.nextRun === null ? "never" : relative(job.nextRun, now)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {job.lastRun ? `last ${relative(job.lastRun.startedAt, now)}` : "never run"}
                </span>
                <span className="flex gap-1">
                  {SEVERITIES.filter((s) => (job.posture.bySeverity[s] ?? 0) > 0).map((s) => (
                    <Badge key={s} type={SEVERITY_TYPE[s]}>
                      {job.posture.bySeverity[s]} {s}
                    </Badge>
                  ))}
                  {job.posture.total === 0 && job.lastRun?.outcome === "ok" && (
                    <Badge type="success">clean</Badge>
                  )}
                </span>
                <Button size="sm" loading={running === job.id} onClick={() => void runNow(job.id)}>
                  Run now
                </Button>
                <Button size="sm" type="error" onClick={() => void remove(job.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Posture timeline"
        extra={
          <span className="text-xs text-muted-foreground">
            {selected ?? "all jobs"} · findings by severity
          </span>
        }
      >
        <PostureTimeline points={points} />
      </Panel>

      <Panel
        title="Regressions"
        extra={<span className="text-xs text-muted-foreground">newest first</span>}
      >
        {regressions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has changed between runs. That is the good outcome — unchanged findings stay
            silent by design.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {regressions.map((r) => (
              <RegressionRow key={`${r.jobId}-${r.device}-${r.at}`} item={r} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Heat calendar">
        <HeatCalendar points={points} />
      </Panel>

      <Panel title="Run history">
        {points.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {[...points]
              .sort((a, b) => b.at - a.at)
              .slice(0, 50)
              .map((p) => (
                <li
                  key={`${p.jobId}-${p.device ?? ""}-${p.at}`}
                  className="flex items-center gap-3 py-2"
                >
                  <Dot type={OUTCOME_DOT[p.outcome]} />
                  <span className="w-40 truncate font-mono text-xs">{p.jobId}</span>
                  <span className="w-32 truncate">{p.device ?? "fleet"}</span>
                  <span className="text-muted-foreground">{stamp(p.at)}</span>
                  <span className="text-xs text-muted-foreground">
                    {(p.durationMs / 1000).toFixed(1)}s
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {p.outcome === "ok"
                      ? `${p.total} finding(s) · +${p.added} new, ${p.worsened} worse, ${p.resolved} fixed`
                      : p.outcome}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
