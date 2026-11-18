/**
 * Schedules: what the server audits on its own, and how the posture moves.
 *
 * After the Mon-Schedules board. The header says what changed since the last
 * run and shows the last five weeks, one square per day. Below: the jobs
 * (picking one scopes the charts), posture over time, regressions and the run
 * history. "New job" opens the job editor (schedules-job-editor.tsx).
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
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import { ScheduleJobEditor, runTime } from "./schedules-job-editor";
import type {
  DevicesPayload,
  ScheduleFinding,
  ScheduleJobRow,
  ScheduleOutcome,
  SchedulePoint,
  ScheduleRegression,
} from "./types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CalendarClock, Ellipsis, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
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

/** "today", "yesterday", "on Monday" (this week), else "on Nov 6". */
function dayWord(ms: number, now: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return "today";
  if (d.toDateString() === new Date(now - DAY_MS).toDateString()) return "yesterday";
  if (now - ms < 6 * DAY_MS) return `on ${d.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${dateOnly(ms)}`;
}

/** `2026-07-30` in local time: the day grid's cell key. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Bar segments bottom to top: info, low, medium, high, critical. */
const STACK = [...SEVERITIES].reverse();

/** Successful runs in time order, newest `MAX_BARS`: what the posture chart draws. */
function postureRuns(points: SchedulePoint[]): SchedulePoint[] {
  return points
    .filter((p) => p.outcome === "ok")
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_BARS);
}

/** The chart's key: each severity with its count in the newest run. */
function PostureLegend({ runs }: { runs: SchedulePoint[] }): ReactNode {
  if (runs.length < 2) return null;
  const last = runs[runs.length - 1];
  const shown = SEVERITIES.filter((s) => s !== "info" || (last.bySeverity.info ?? 0) > 0);
  return (
    <span className="monitor-legend" aria-label="Findings in the newest run">
      {shown.map((s) => (
        <span key={s}>
          <i className="sched-sev-key" data-sev={s} />
          {s} {last.bySeverity[s] ?? 0}
        </span>
      ))}
    </span>
  );
}

/**
 * Findings per run, stacked by severity with critical on top. Hand-drawn SVG:
 * the series is at most a few dozen bars of five numbers.
 */
function PostureBars({ runs, scopeKey }: { runs: SchedulePoint[]; scopeKey: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(60_000);
  useStaggerIn(ref, "[data-bar]", `${scopeKey}:${runs.length}`);

  if (runs.length < 2) {
    return (
      <p className="monitor-hint">
        Two runs are needed before there is a trend. The first run is the baseline.
      </p>
    );
  }

  const W = 640;
  const H = 200;
  const GAP = 8;
  const n = runs.length;
  const bw = (W - GAP * (n - 1)) / n;
  const max = Math.max(1, ...runs.map((p) => p.total));
  const first = runs[0];
  const last = runs[n - 1];
  const summary = `${plural(last.total, "finding")} now, ${plural(first.total, "finding")} on ${dateOnly(first.at)}.`;
  const today = new Date(now).toDateString();
  // Five dates along the axis, first to newest.
  const ticks = [...new Set([0, 1, 2, 3, 4].map((i) => Math.round((i * (n - 1)) / 4)))].map((i) =>
    new Date(runs[i].at).toDateString() === today ? "today" : dateOnly(runs[i].at),
  );

  return (
    <div ref={ref}>
      <svg
        className="sched-posture-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Findings per run over the last ${n} runs. ${summary}`}
      >
        {[1, 2, 3].map((i) => (
          <line
            key={i}
            x1="0"
            x2={W}
            y1={(H * i) / 4}
            y2={(H * i) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {runs.map((p, i) => {
          const x = i * (bw + GAP);
          let y = H;
          return (
            <g key={`${p.jobId}-${p.device ?? ""}-${p.at}`} data-bar="">
              <title>{`${stamp(p.at)} · ${p.jobId}${p.device ? ` · ${p.device}` : ""} · ${plural(p.total, "finding")}`}</title>
              {STACK.map((s) => {
                const v = p.bySeverity[s] ?? 0;
                if (v === 0) return null;
                const bh = (v / max) * (H - 12);
                y -= bh;
                return (
                  <rect
                    key={s}
                    className="sched-bar"
                    data-sev={s}
                    x={x}
                    y={y + 1}
                    width={bw}
                    height={Math.max(bh - 2, 1)}
                    rx="3"
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="sched-axis" aria-hidden="true">
        {ticks.map((t, i) => (
          <span key={`${t}-${i}`}>{t}</span>
        ))}
      </div>
    </div>
  );
}

type DayState = "none" | "clean" | "more" | "failed";

/** One square per day for the last five weeks; today has a ring. */
function DayGrid({ points }: { points: SchedulePoint[] }): ReactNode {
  const now = useNow(60_000);
  const byDay = new Map<string, { state: DayState; total: number }>();
  for (const p of points) {
    if (p.outcome === "skipped") continue;
    const key = dayKey(p.at);
    const seen = byDay.get(key) ?? { state: "clean" as DayState, total: 0 };
    let state = seen.state;
    if (p.outcome !== "ok") state = "failed";
    else if (state !== "failed" && p.added + p.worsened > 0) state = "more";
    byDay.set(key, {
      state,
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
    return { key, at, state: day?.state ?? "none", title };
  });

  return (
    <div className="glass sched-calendar">
      <div className="sched-calendar-head">
        <span className="sched-calendar-label">Last 5 weeks</span>
        <span className="sched-small">One square per day</span>
      </div>
      <div className="sched-days" role="img" aria-label="Daily run results for the last 5 weeks">
        {cells.slice(0, 7).map((c) => (
          <span key={`h-${c.key}`} className="sched-weekday">
            {new Date(c.at).toLocaleDateString(undefined, { weekday: "short" })}
          </span>
        ))}
        {cells.map((c, i) => (
          <i
            key={c.key}
            className="sched-day"
            data-state={c.state}
            data-today={i === GRID_DAYS - 1 || undefined}
            title={c.title}
          />
        ))}
      </div>
      <div className="monitor-legend sched-calendar-legend">
        <span>
          <i data-state="clean" />
          Ran
        </span>
        <span>
          <i data-state="more" />
          More findings
        </span>
        <span>
          <i data-state="failed" />
          Failed
        </span>
        <span>
          <i data-state="none" />
          No run
        </span>
      </div>
    </div>
  );
}

interface RegressionItem {
  key: string;
  change: "New" | "Worse" | "Resolved" | "Changed";
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
  Resolved: "text-success",
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
        change: "Resolved" as const,
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

/** A regression row; a click opens the finding's detail under it. */
function RegressionRow({ item }: { item: RegressionItem }): ReactNode {
  const [open, setOpen] = useState(false);
  const device = item.finding?.device ?? item.run.device;
  return (
    <div className="sched-reg" data-open={open || undefined}>
      <button
        type="button"
        className="monitor-row sched-reg-grid"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0">
          <StatusBadge tone={SEVERITY_TONE[item.severity ?? ""] ?? "default"} dot={false}>
            {item.severity ? capitalize(item.severity) : "Change"}
          </StatusBadge>
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="p truncate">{item.title}</span>
          <span className="sched-mono text-muted-foreground truncate">
            {device} · {item.run.jobId}
          </span>
        </span>
        <span className={cn("truncate text-[12px] font-medium", CHANGE_CLASS[item.change])}>
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
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

  // Device names for the job editor; only once it opens.
  useEffect(() => {
    if (!editorOpen || devices.length > 0) return;
    api<DevicesPayload>("/api/devices")
      .then((res) => setDevices(res.devices.map((d) => d.name)))
      .catch(() => {
        /* "All devices" still works without the list */
      });
  }, [editorOpen, devices.length]);

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

  /** Regressions from each job and device's newest run: "since the last run". */
  const fresh = useMemo(() => {
    const newest = new Map<string, number>();
    for (const p of points) {
      const k = `${p.jobId}\u0000${p.device ?? ""}`;
      if (p.at > (newest.get(k) ?? 0)) newest.set(k, p.at);
    }
    return regressions.filter(
      (r) =>
        newest.get(`${r.jobId}\u0000${r.device}`) === r.at &&
        r.added.length + r.worsened.length > 0,
    );
  }, [points, regressions]);

  useStaggerIn(jobsRef, ".monitor-row", jobs.map((j) => j.id).join("|"));

  if (initialLoading) return <LoadingState label="Loading schedules" />;

  const eyebrow = "Schedules · audits on a timer";
  const newJob = (
    <MonitorButton
      variant="primary"
      icon={<Plus aria-hidden="true" />}
      onClick={() => setEditorOpen(true)}
    >
      New job
    </MonitorButton>
  );
  const editor = (
    <ScheduleJobEditor
      open={editorOpen}
      onOpenChange={setEditorOpen}
      auditors={schedulable}
      devices={devices}
      onSaved={() => {
        setSelected(null);
        void load(null);
      }}
    />
  );
  const count = (n: number): string => String(Math.round(n));
  const errorNote = error && (
    <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
      <b>Schedules unavailable.</b> {error}
    </MonitorNote>
  );
  const toolOf = (jobId: string): string => jobs.find((j) => j.id === jobId)?.tool ?? jobId;

  if (jobs.length === 0) {
    return (
      <div className="sched-page">
        <PageIntro
          eyebrow={eyebrow}
          verdict="Nothing scheduled yet."
          lead="Audits that run on a timer and report only what changed."
          actions={newJob}
        />
        {errorNote}
        <section className="monitor-panel">
          <MonitorEmpty
            icon={<CalendarClock />}
            title="Nothing scheduled"
            action={
              <MonitorButton icon={<Plus aria-hidden="true" />} onClick={() => setEditorOpen(true)}>
                New job
              </MonitorButton>
            }
          >
            <p>Jobs run on their own and report only what changed since the last run.</p>
            {schedulable.length > 0 && (
              <ul className="sched-tools">
                {schedulable.map((s) => (
                  <li key={s.tool}>
                    <span className="sched-mono text-foreground">{s.tool}</span>
                    <span>{s.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </MonitorEmpty>
        </section>
        {editor}
      </div>
    );
  }

  const enabled = jobs.filter((j) => j.enabled).length;
  const runs = postureRuns(points);
  const scope = selected ?? "All jobs";
  const scopeTool = selected ? toolOf(selected) : "All jobs";

  // The verdict: what is new or worse since each job's last run, else a failed run.
  const added = fresh.reduce((n, r) => n + r.added.length, 0);
  const worse = fresh.reduce((n, r) => n + r.worsened.length, 0);
  const freshDevices = [...new Set(fresh.map((r) => r.device))];
  const failingJobs = jobs.filter(
    (j) => j.lastRun && j.lastRun.outcome !== "ok" && j.lastRun.outcome !== "skipped",
  );
  const where =
    freshDevices.length === 1 ? `on ${freshDevices[0]}` : `on ${freshDevices.length} devices`;
  const verdict =
    added + worse > 0 ? (
      <>
        <em>
          {added > 0 && worse > 0
            ? plural(added + worse, "new or worse finding")
            : added > 0
              ? plural(added, "new finding")
              : plural(worse, "worse finding")}
        </em>{" "}
        {where} since the last run.
      </>
    ) : failingJobs.length > 0 ? (
      <>
        <em>
          {failingJobs[0].id}{" "}
          {failingJobs[0].lastRun?.outcome === "timeout" ? "timed out" : "failed"}
        </em>{" "}
        on its last run.
      </>
    ) : (
      <>
        <span className="s">Nothing new</span> since the last run.
      </>
    );
  // Jobs whose newest run brought new or worse findings: their LED turns amber.
  const freshJobs = new Set(fresh.map((r) => r.jobId));
  const firstAdded = fresh.find((r) => r.added.length > 0);
  const lead = (
    <>
      Audits that run on a timer and report only what changed.
      {firstAdded && (
        <>
          {" "}
          <span className="mono">{toolOf(firstAdded.jobId)}</span> found:{" "}
          {firstAdded.added[0].title}.
        </>
      )}
      {failingJobs.slice(0, 1).map((j) => (
        <span key={j.id}>
          {" "}
          <span className="mono">{j.tool}</span>{" "}
          {j.lastRun?.outcome === "timeout" ? "timed out" : "failed"}{" "}
          {dayWord(j.lastRun?.startedAt ?? now, now)}.
        </span>
      ))}
    </>
  );

  return (
    <div className="sched-page">
      <PageIntro
        eyebrow={eyebrow}
        verdict={verdict}
        lead={lead}
        actions={newJob}
        aside={<DayGrid points={points} />}
      />
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
          title="Jobs"
          description="Pick one to scope the charts"
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
                  className="monitor-row sched-job-grid"
                  data-selected={isSelected || undefined}
                >
                  <button
                    type="button"
                    className="sched-job-main"
                    aria-pressed={isSelected}
                    onClick={() => setSelected(isSelected ? null : job.id)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusDot
                        tone={
                          !job.enabled
                            ? "default"
                            : last?.outcome === "ok" && freshJobs.has(job.id)
                              ? "warn"
                              : OUTCOME_TONE[last?.outcome ?? "skipped"]
                        }
                      />
                      <span className="sched-mono p truncate">{job.tool}</span>
                    </span>
                    <span
                      className={cn(
                        "sched-meta truncate",
                        lastFailed && job.enabled ? "text-destructive" : "text-muted-foreground",
                      )}
                      title={meta}
                    >
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
                        <button
                          type="button"
                          className="monitor-icon-btn"
                          aria-label={`More actions for ${job.id}`}
                        >
                          <Ellipsis aria-hidden="true" />
                        </button>
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
          title="Posture over time"
          description={`${scopeTool} · findings by severity, last ${plural(runs.length, "run")}`}
          extra={<PostureLegend runs={runs} />}
        >
          <PostureBars runs={runs} scopeKey={scope} />
        </MonitorPanel>
      </div>

      <div className="sched-split">
        <MonitorPanel title="Regressions" description="New or worse since the previous run" flush>
          {changes.length === 0 ? (
            <MonitorEmpty compact title="No changes">
              Nothing changed between runs. Unchanged findings stay quiet.
            </MonitorEmpty>
          ) : (
            <>
              <div className="monitor-thead sched-reg-grid" aria-hidden="true">
                <span>Severity</span>
                <span>Finding</span>
                <span>Change</span>
              </div>
              {changes.map((item) => (
                <RegressionRow key={item.key} item={item} />
              ))}
            </>
          )}
        </MonitorPanel>

        <MonitorPanel title="Run history" description="Newest first" flush>
          {history.length === 0 ? (
            <MonitorEmpty compact title="No runs yet">
              Runs show up here after the first one finishes.
            </MonitorEmpty>
          ) : (
            <>
              <div className="monitor-thead sched-run-grid" aria-hidden="true">
                <span>Job</span>
                <span>Device</span>
                <span>Started</span>
                <span>Took</span>
                <span>Result</span>
              </div>
              {history.map((p) => {
                const bad = p.outcome === "failed" || p.outcome === "timeout";
                return (
                  <div
                    key={`${p.jobId}-${p.device ?? ""}-${p.at}`}
                    className="monitor-row sched-run-grid"
                    data-failed={bad || undefined}
                  >
                    <span className="sched-mono p truncate">{p.jobId}</span>
                    <span className="sched-mono text-muted-foreground truncate">
                      {p.device ?? "fleet"}
                    </span>
                    <span className="text-muted-foreground truncate" title={stamp(p.at)}>
                      {runTime(p.at, now)}
                    </span>
                    <span className="truncate tabular-nums">
                      {(p.durationMs / 1000).toFixed(1)} s
                    </span>
                    <span
                      className="flex min-w-0 items-center gap-1.5"
                      title={
                        p.outcome === "ok"
                          ? `${p.added} new, ${p.worsened} worse, ${p.resolved} resolved`
                          : undefined
                      }
                    >
                      <StatusDot tone={OUTCOME_TONE[p.outcome]} />
                      <span
                        className={cn("truncate", bad ? "text-destructive" : "text-fg-secondary")}
                      >
                        {p.outcome === "ok" ? plural(p.total, "finding") : p.outcome}
                      </span>
                    </span>
                  </div>
                );
              })}
              {points.length > HISTORY_LIMIT && (
                <div className="monitor-foot">
                  Showing the newest {HISTORY_LIMIT} of {points.length}
                </div>
              )}
            </>
          )}
        </MonitorPanel>
      </div>

      <MonitorDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        confirm
        title={`Remove ${confirmRemove ?? ""}?`}
        description="This deletes the job and its run history. You cannot undo it."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton variant="ghost" onClick={() => setConfirmRemove(null)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => {
                if (confirmRemove) void remove(confirmRemove);
                setConfirmRemove(null);
              }}
            >
              Remove job
            </MonitorButton>
          </>
        }
      >
        {null}
      </MonitorDialog>

      {editor}
    </div>
  );
}
