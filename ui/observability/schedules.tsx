/**
 * Schedules: what the server audits on its own, and how the posture moves.
 *
 *   - Jobs: each job with its schedule in plain English, the next run, the last
 *     outcome and Run now. Picking one scopes everything below it.
 *   - Posture over time: findings per run, stacked by severity. One audit says
 *     "12 findings"; a series says "critical went to zero six weeks ago".
 *   - Regressions: new, worse or fixed since the run before, one row per
 *     finding, expandable to the detail.
 *   - Last 5 weeks: one square per day, so "it got worse three weeks ago" is
 *     visible at a glance.
 *   - Run history: per run, with device, duration and outcome.
 */
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, postJson } from "./api";
import { useNow } from "./use-now";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type {
  ScheduleFinding,
  ScheduleJobRow,
  ScheduleOutcome,
  SchedulePoint,
  ScheduleRegression,
} from "./types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CalendarClock, ChevronRight, Ellipsis, Loader2, Trash2 } from "lucide-react";
import "./monitoring.css";
import "./schedules.css";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "bad",
  high: "warn",
  medium: "brand",
  low: "default",
  info: "default",
};

const OUTCOME_TONE: Record<ScheduleOutcome, Tone> = {
  ok: "good",
  failed: "bad",
  timeout: "warn",
  skipped: "default",
};

const DAY_MS = 86_400_000;
/** Bars in the posture chart; older runs drop off the left. */
const MAX_BARS = 30;
const GRID_DAYS = 35;
const HISTORY_LIMIT = 50;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "in 13 h", "5 d ago", "now". */
function relative(ms: number, now: number): string {
  const minutes = Math.round(Math.abs(ms - now) / 60_000);
  if (minutes < 1) return "now";
  const text =
    minutes < 60
      ? `${minutes} min`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / 1440)} d`;
  return ms >= now ? `in ${text}` : `${text} ago`;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dateOnly(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "yesterday", "5 days ago", "two weeks ago": how long ago the first bar was. */
function agoPhrase(ms: number, now: number): string {
  const days = Math.round((now - ms) / DAY_MS);
  if (days < 1) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks === 1) return "a week ago";
  if (weeks === 2) return "two weeks ago";
  return `${weeks} weeks ago`;
}

/** `2026-07-30` in local time: the day grid's cell key. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Bar heights for one run, bottom to top: info, low, medium, high, critical. */
const STACK = [...SEVERITIES].reverse();

/** Successful runs in time order, newest `MAX_BARS`: what the posture chart draws. */
function postureRuns(points: SchedulePoint[]): SchedulePoint[] {
  return points
    .filter((p) => p.outcome === "ok")
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_BARS);
}

/** The chart's key: one dot per severity that shows up in the bars. */
function PostureLegend({ runs }: { runs: SchedulePoint[] }): ReactNode {
  const present = SEVERITIES.filter((s) => runs.some((p) => (p.bySeverity[s] ?? 0) > 0));
  if (runs.length < 2 || present.length === 0) return null;
  return (
    <span className="sched-legend" aria-hidden="true">
      {present.map((s) => (
        <span key={s}>
          <StatusDot tone={SEVERITY_TONE[s] ?? "default"} />
          {capitalize(s)}
        </span>
      ))}
    </span>
  );
}

/**
 * Findings per run, stacked by severity with critical on top.
 *
 * Hand-drawn SVG: the series is at most a few dozen bars of five numbers.
 */
function PostureBars({ runs, scopeKey }: { runs: SchedulePoint[]; scopeKey: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(60_000);
  useStaggerIn(ref, "[data-bar]", `${scopeKey}:${runs.length}`);

  if (runs.length < 2) {
    return (
      <p className="sched-summary">
        Two runs are needed before there is a trend. The first run is the baseline.
      </p>
    );
  }

  const W = 560;
  const BASE = 150;
  const TOP = 30;
  const max = Math.max(1, ...runs.map((p) => p.total));
  const k = (BASE - TOP) / max;
  const slot = W / runs.length;
  const barW = Math.min(28, slot * 0.7);

  const first = runs[0];
  const last = runs[runs.length - 1];
  const critFrom = first.bySeverity.critical ?? 0;
  const critTo = last.bySeverity.critical ?? 0;
  const ago = agoPhrase(first.at, now);
  const trend =
    last.total < first.total
      ? `down from ${first.total} ${ago}`
      : last.total > first.total
        ? `up from ${first.total} ${ago}`
        : `the same as ${ago}`;
  const summary = `${plural(last.total, "finding")} now, ${trend}.${
    critFrom !== critTo ? ` Critical went from ${critFrom} to ${critTo}.` : ""
  }`;

  return (
    <div ref={ref}>
      <svg
        className="sched-posture-svg"
        viewBox={`0 0 ${W} 170`}
        width="100%"
        height="170"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Findings per run over the last ${runs.length} runs. ${summary}`}
      >
        <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="var(--chart-grid)" />
        <line x1="0" y1={TOP} x2={W} y2={TOP} stroke="var(--chart-grid)" strokeDasharray="2 4" />
        {runs.map((p, i) => {
          const x = i * slot + (slot - barW) / 2;
          // The bottom segment sits on the base line; each one above leaves a 2px gap.
          let top = BASE + 2;
          return (
            <g key={`${p.jobId}-${p.device ?? ""}-${p.at}`} data-bar="">
              <title>{`${stamp(p.at)} · ${p.jobId}${p.device ? ` · ${p.device}` : ""} · ${plural(p.total, "finding")}`}</title>
              {STACK.map((s) => {
                const n = p.bySeverity[s] ?? 0;
                if (n === 0) return null;
                const h = n * k;
                top = top - 2 - h;
                return (
                  <rect
                    key={s}
                    className="sched-bar"
                    data-sev={s}
                    x={x}
                    y={top}
                    width={barW}
                    height={h}
                    rx="2"
                  />
                );
              })}
            </g>
          );
        })}
        <text x="0" y={TOP - 6} fill="var(--muted-foreground)" fontSize="11">
          {max}
        </text>
      </svg>
      <p className="sched-summary sched-summary-chart">{summary}</p>
    </div>
  );
}

type DayState = "none" | "clean" | "more" | "failed";

/** One square per day for the last five weeks. */
function DayGrid({ points }: { points: SchedulePoint[] }): ReactNode {
  const now = useNow(60_000);
  const byDay = new Map<string, { state: DayState; runs: number; total: number }>();
  for (const p of points) {
    if (p.outcome === "skipped") continue;
    const key = dayKey(p.at);
    const seen = byDay.get(key) ?? { state: "clean" as DayState, runs: 0, total: 0 };
    let state = seen.state;
    if (p.outcome !== "ok") state = "failed";
    else if (state !== "failed" && p.added + p.worsened > 0) state = "more";
    byDay.set(key, {
      state,
      runs: seen.runs + 1,
      total: p.outcome === "ok" ? Math.max(seen.total, p.total) : seen.total,
    });
  }

  const cells = Array.from({ length: GRID_DAYS }, (_, i) => {
    const at = now - (GRID_DAYS - 1 - i) * DAY_MS;
    const key = dayKey(at);
    const day = byDay.get(key);
    const label = dateOnly(at);
    // No run is not the same as a clean run: an empty square means "not measured".
    const title = !day
      ? `${label}: no run`
      : day.state === "failed"
        ? `${label}: a run failed`
        : day.state === "more"
          ? `${label}: new or worse findings, ${plural(day.total, "finding")}`
          : `${label}: nothing new, ${plural(day.total, "finding")}`;
    return { key, state: day?.state ?? "none", title };
  });

  return (
    <div className="sched-calendar-body">
      <div className="sched-days" role="img" aria-label="Daily run results for the last 5 weeks">
        {cells.map((c) => (
          <span key={c.key} className="sched-day" data-state={c.state} title={c.title} />
        ))}
      </div>
      <div className="sched-legend">
        <span>
          <span className="sched-day sched-day-key" data-state="none" />
          No run
        </span>
        <span>
          <span className="sched-day sched-day-key" data-state="clean" />
          Clean
        </span>
        <span>
          <span className="sched-day sched-day-key" data-state="more" />
          More findings
        </span>
        <span>
          <span className="sched-day sched-day-key" data-state="failed" />
          Run failed
        </span>
      </div>
    </div>
  );
}

interface RegressionItem {
  key: string;
  change: "New" | "Worse" | "Fixed" | "Changed";
  severity: string | null;
  title: string;
  finding: ScheduleFinding | null;
  from?: string;
  to?: string;
  run: ScheduleRegression;
}

const CHANGE_CLASS: Record<RegressionItem["change"], string> = {
  New: "text-destructive",
  Worse: "text-warning",
  Fixed: "text-success",
  Changed: "text-muted-foreground",
};

/** One row per finding that changed, newest run first as the server sends them. */
function flattenRegressions(regressions: ScheduleRegression[]): RegressionItem[] {
  return regressions.flatMap((r) => {
    const base = `${r.jobId}-${r.device}-${r.at}`;
    const items: RegressionItem[] = [
      ...r.added.map((f) => ({
        key: `${base}-a-${f.id}`,
        change: "New" as const,
        severity: f.severity,
        title: f.title,
        finding: f,
        run: r,
      })),
      ...r.worsened.map((w) => ({
        key: `${base}-w-${w.finding.id}`,
        change: "Worse" as const,
        severity: w.finding.severity,
        title: w.finding.title,
        finding: w.finding,
        from: w.from,
        to: w.to,
        run: r,
      })),
      ...r.resolved.map((f) => ({
        key: `${base}-r-${f.id}`,
        change: "Fixed" as const,
        severity: f.severity,
        title: f.title,
        finding: f,
        run: r,
      })),
    ];
    if (items.length > 0) return items;
    return [
      {
        key: base,
        change: "Changed" as const,
        severity: null,
        title: r.summary,
        finding: null,
        run: r,
      },
    ];
  });
}

function RegressionRow({ item }: { item: RegressionItem }): ReactNode {
  const [open, setOpen] = useState(false);
  const device = item.finding?.device ?? item.run.device;
  return (
    <div className="sched-reg" data-open={open || undefined}>
      <button
        type="button"
        className="monitor-row sched-reg-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className="sched-reg-chevron" aria-hidden="true" strokeWidth={1.5} />
        <span className="sched-reg-sev">
          {item.severity ? (
            <StatusBadge tone={SEVERITY_TONE[item.severity] ?? "default"}>
              {capitalize(item.severity)}
            </StatusBadge>
          ) : (
            <StatusBadge>Change</StatusBadge>
          )}
        </span>
        <span className="sched-reg-title min-w-0">
          <span className="text-foreground block truncate">{item.title}</span>
          <span className="text-muted-foreground block truncate font-mono text-[12px]">
            {device} · {item.run.jobId}
          </span>
        </span>
        <span className={cn("sched-reg-change text-[12px] font-[510]", CHANGE_CLASS[item.change])}>
          {item.change}
        </span>
      </button>
      {open && (
        <div className="sched-reg-detail">
          {item.change === "Worse" && (
            <p>
              Went from {item.from} to {item.to}.
            </p>
          )}
          {item.finding?.detail && <p>{item.finding.detail}</p>}
          <p className="text-muted-foreground">
            {item.run.summary} · run {stamp(item.run.at)}
          </p>
        </div>
      )}
    </div>
  );
}

export function SchedulesView(): ReactNode {
  const [initialLoading, setInitialLoading] = useState(true);
  const [jobs, setJobs] = useState<ScheduleJobRow[]>([]);
  const [schedulable, setSchedulable] = useState<{ tool: string; summary: string }[]>([]);
  const [points, setPoints] = useState<SchedulePoint[]>([]);
  const [regressions, setRegressions] = useState<ScheduleRegression[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const jobsRef = useRef<HTMLDivElement>(null);

  const load = useCallback((job?: string | null): Promise<void> => {
    const q = job ? `?job=${encodeURIComponent(job)}` : "";
    return Promise.all([
      api<{
        jobs: ScheduleJobRow[];
        schedulable: { tool: string; summary: string }[];
        error?: string;
      }>("/api/schedules"),
      api<{ points: SchedulePoint[] }>(`/api/schedules/timeline${q}`),
      api<{ regressions: ScheduleRegression[] }>(`/api/schedules/regressions${q}`),
    ])
      .then(([list, timeline, regs]) => {
        setJobs(list.jobs ?? []);
        setSchedulable(list.schedulable ?? []);
        setPoints(timeline.points ?? []);
        setRegressions(regs.regressions ?? []);
        setError(list.error ?? null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setInitialLoading(false));
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
      else toast.success(`${id}: ${res.outcome}${res.notified ? ". Alert raised." : ""}`);
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

  const now = useNow();
  const totals = useMemo(() => {
    const findings = jobs.reduce((n, j) => n + j.posture.total, 0);
    const critical = jobs.reduce((n, j) => n + (j.posture.bySeverity.critical ?? 0), 0);
    const high = jobs.reduce((n, j) => n + (j.posture.bySeverity.high ?? 0), 0);
    const failing = jobs.filter((j) => j.lastRun && j.lastRun.outcome !== "ok").length;
    return { findings, critical, high, failing };
  }, [jobs]);
  const changes = useMemo(() => flattenRegressions(regressions), [regressions]);
  const history = useMemo(
    () => [...points].sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT),
    [points],
  );

  useStaggerIn(jobsRef, ".monitor-row", jobs.map((j) => j.id).join("|"));

  if (initialLoading) return <LoadingState label="Loading schedules" />;

  const count = (n: number): string => String(Math.round(n));
  const scope = selected ?? "All jobs";
  const intro = (
    <PageIntro>
      Audits that run on a timer and report only what changed since the last run.
    </PageIntro>
  );
  const errorNote = error && (
    <div className="monitor-note" data-tone="bad" role="alert">
      <span>
        <span className="font-[590]">Schedules unavailable.</span>{" "}
        <span className="text-muted-foreground">{error}</span>
      </span>
    </div>
  );
  if (jobs.length === 0) {
    return (
      <div className="sched-page">
        {intro}
        {errorNote}
        <section className="monitor-panel">
          <MonitorEmpty icon={<CalendarClock />} title="Nothing scheduled">
            <p>
              Add a job with <code>add_schedule</code>. Jobs run on their own and report only what
              changed since the last run.
            </p>
            {schedulable.length > 0 && (
              <ul className="sched-tools">
                {schedulable.map((s) => (
                  <li key={s.tool}>
                    <span className="text-foreground font-mono text-[12px]">{s.tool}</span>
                    <span>{s.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </MonitorEmpty>
        </section>
      </div>
    );
  }

  const enabled = jobs.filter((j) => j.enabled).length;
  const runs = postureRuns(points);
  const scopeTool = selected ? (jobs.find((j) => j.id === selected)?.tool ?? selected) : "All jobs";

  return (
    <div className="sched-page">
      {intro}
      {errorNote}

      <MetricStrip label="Schedule summary" minCell={180}>
        <Metric
          label="Jobs"
          value={<Ticker value={jobs.length} format={count} />}
          hint={`${enabled} enabled`}
        />
        <Metric
          label="Critical findings"
          tone={totals.critical > 0 ? "bad" : "default"}
          value={<Ticker value={totals.critical} format={count} />}
          hint={`${totals.high} high`}
        />
        <Metric
          label="Open findings"
          value={<Ticker value={totals.findings} format={count} />}
          hint="Latest run per device"
        />
        <Metric
          label="Failing jobs"
          tone={totals.failing > 0 ? "warn" : "default"}
          value={<Ticker value={totals.failing} format={count} />}
          hint={totals.failing > 0 ? "Last run did not finish" : "All last runs ok"}
        />
      </MetricStrip>

      <div className="sched-split">
        <MonitorPanel
          className="sched-jobs"
          title="Jobs"
          description="Pick one to scope the charts below"
          extra={
            selected && (
              <MonitorButton variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Show all
              </MonitorButton>
            )
          }
          flush
        >
          <div ref={jobsRef}>
            {jobs.map((job) => {
              const last = job.lastRun;
              const lastFailed = !!last && last.outcome !== "ok" && last.outcome !== "skipped";
              // Paused says only that. A failed last run takes the place of the next
              // run time, because the failure is what needs reading.
              const meta = [
                job.id !== job.tool ? job.id : null,
                job.cronText,
                !job.enabled
                  ? "paused"
                  : lastFailed
                    ? `last run ${last.outcome}${last.error ? `: ${last.error}` : ""}`
                    : job.nextRun === null
                      ? "no next run"
                      : `next ${relative(job.nextRun, now)}`,
                !job.enabled || lastFailed
                  ? null
                  : !last
                    ? "never run"
                    : `last: ${plural(job.posture.total, "finding")}`,
              ]
                .filter(Boolean)
                .join(" · ");
              const isSelected = selected === job.id;
              return (
                <div
                  key={job.id}
                  className="monitor-row sched-job-row"
                  data-selected={isSelected || undefined}
                >
                  <button
                    type="button"
                    className="sched-job-main"
                    aria-pressed={isSelected}
                    onClick={() => setSelected(isSelected ? null : job.id)}
                  >
                    <span className="flex items-center gap-2">
                      <StatusDot
                        tone={job.enabled ? OUTCOME_TONE[last?.outcome ?? "skipped"] : "default"}
                      />
                      <span className="text-foreground truncate font-mono text-[12px]">
                        {job.tool}
                      </span>
                    </span>
                    <span className="sched-meta" title={meta}>
                      {meta}
                    </span>
                  </button>
                  <span className="flex items-center gap-1">
                    <MonitorButton
                      variant="ghost"
                      size="sm"
                      disabled={running !== null}
                      icon={running === job.id ? <Loader2 className="animate-spin" /> : undefined}
                      onClick={() => void runNow(job.id)}
                    >
                      Run now
                    </MonitorButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <MonitorButton
                          variant="ghost"
                          size="sm"
                          aria-label={`More actions for ${job.id}`}
                          icon={<Ellipsis aria-hidden="true" strokeWidth={1.5} />}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setConfirmRemove(job.id)}
                        >
                          <Trash2 /> Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </div>
              );
            })}
          </div>
        </MonitorPanel>

        <MonitorPanel
          className="sched-chart"
          title="Posture over time"
          description={`${scopeTool} · findings by severity, last ${plural(runs.length, "run")}`}
          extra={<PostureLegend runs={runs} />}
        >
          <PostureBars runs={runs} scopeKey={scope} />
        </MonitorPanel>
      </div>

      <div className="sched-split">
        <MonitorPanel
          className="sched-regressions"
          title="Regressions"
          description="New or worse since the previous run"
          flush
        >
          {changes.length === 0 ? (
            <MonitorEmpty compact title="No changes">
              Nothing changed between runs. Unchanged findings stay quiet.
            </MonitorEmpty>
          ) : (
            changes.map((item) => <RegressionRow key={item.key} item={item} />)
          )}
        </MonitorPanel>

        <MonitorPanel
          className="sched-calendar"
          title="Last 5 weeks"
          description="One square per day"
        >
          <DayGrid points={points} />
        </MonitorPanel>
      </div>

      <MonitorPanel title="Run history" description={`${scope} · newest first`} flush>
        {history.length === 0 ? (
          <MonitorEmpty compact title="No runs yet">
            Runs show up here after the first one finishes.
          </MonitorEmpty>
        ) : (
          <>
            <div className="monitor-thead sched-run-row" aria-hidden="true">
              <span>Job</span>
              <span>Device</span>
              <span>Started</span>
              <span className="text-right">Took</span>
              <span>Result</span>
            </div>
            {history.map((p) => (
              <div
                key={`${p.jobId}-${p.device ?? ""}-${p.at}`}
                className="monitor-row sched-run-row"
                data-failed={p.outcome === "failed" || p.outcome === "timeout" || undefined}
              >
                <span className="sched-run-job flex min-w-0 items-center gap-2">
                  <StatusDot tone={OUTCOME_TONE[p.outcome]} />
                  <span className="text-foreground truncate font-mono text-[12px]">{p.jobId}</span>
                </span>
                <span className="sched-run-device truncate">{p.device ?? "fleet"}</span>
                <span className="sched-run-at text-muted-foreground tabular-nums">
                  {stamp(p.at)}
                </span>
                <span className="sched-run-took text-muted-foreground text-right tabular-nums">
                  {(p.durationMs / 1000).toFixed(1)} s
                </span>
                <span
                  className={cn(
                    "sched-run-result truncate text-[12px]",
                    p.outcome === "ok" ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {p.outcome === "ok"
                    ? `${plural(p.total, "finding")} · ${p.added} new, ${p.worsened} worse, ${p.resolved} fixed`
                    : capitalize(p.outcome)}
                </span>
              </div>
            ))}
            {points.length > HISTORY_LIMIT && (
              <div className="monitor-foot">
                Showing the newest {HISTORY_LIMIT} of {points.length}
              </div>
            )}
          </>
        )}
      </MonitorPanel>

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the job and its run history. You cannot undo it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmRemove) void remove(confirmRemove);
              }}
            >
              Remove job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
