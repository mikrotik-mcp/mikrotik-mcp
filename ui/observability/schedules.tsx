/**
 * Schedules: what the server audits on its own, and how the posture moves.
 *
 * After the Mon-Schedules board. The header says what changed since the last
 * run and shows the last five weeks, one square per day. Below: the jobs
 * (picking one scopes the charts), posture over time, regressions and the run
 * history. "New job" opens the job editor (schedules-job-editor.tsx).
 */
import { LoadingState } from "./loading-state";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailList, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import type { RowAction, TipCard, Tone as KitTone } from "./kit";
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
import {
  CalendarClock,
  Ellipsis,
  Filter,
  Loader2,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
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

/** The bar colours of the posture chart, for the tooltip swatches. */
const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--destructive)",
  high: "var(--warning)",
  medium: "var(--brand)",
  low: "var(--text-faint)",
  info: "var(--text-faint)",
};

const KIT_OUTCOME: Record<ScheduleOutcome, KitTone> = {
  ok: "ok",
  failed: "bad",
  timeout: "warn",
  skipped: "off",
};

/** Enter or Space on a focused row acts like a click. */
function onRowKey(run: () => void): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}

const runKey = (p: SchedulePoint): string => `${p.jobId}-${p.device ?? ""}-${p.at}`;

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
  const card = (i: number): TipCard => {
    const p = runs[i];
    const prev = i > 0 ? runs[i - 1] : undefined;
    const delta = prev ? p.total - prev.total : 0;
    return {
      title: stamp(p.at),
      sub: p.device ? `${p.jobId} · ${p.device}` : p.jobId,
      rows: STACK.filter((s) => (p.bySeverity[s] ?? 0) > 0).map((s) => ({
        label: capitalize(s),
        value: String(p.bySeverity[s] ?? 0),
        color: SEVERITY_COLOR[s],
      })),
      foot: prev
        ? {
            label: "Against the run before",
            value: delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta}`,
            tone: delta > 0 ? "down" : delta < 0 ? "up" : undefined,
          }
        : { label: "Findings", value: String(p.total) },
    };
  };

  return (
    <div ref={ref} className="kit-tips">
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
            <g
              key={runKey(p)}
              data-bar=""
              aria-label={`${stamp(p.at)} · ${p.jobId}${p.device ? ` · ${p.device}` : ""} · ${plural(p.total, "finding")}`}
              {...tipProps(() => card(i))}
            >
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
    return { key, at, state: day?.state ?? "none", title, total: day?.total ?? 0 };
  });
  const stateText: Record<DayState, string> = {
    none: "No run",
    clean: "Nothing new",
    more: "New or worse findings",
    failed: "A run failed",
  };
  const stateLed: Record<DayState, KitTone> = {
    none: "off",
    clean: "ok",
    more: "warn",
    failed: "bad",
  };

  return (
    <div className="glass sched-calendar">
      <div className="sched-calendar-head">
        <span className="sched-calendar-label">Last 5 weeks</span>
        <span className="sched-small">One square per day</span>
      </div>
      <div
        className="sched-days kit-tips"
        role="group"
        aria-label="Daily run results for the last 5 weeks"
      >
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
            aria-label={c.title}
            {...tipProps(() => ({
              title: dateOnly(c.at),
              sub: i === GRID_DAYS - 1 ? "today" : undefined,
              led: stateLed[c.state],
              rows: [
                { label: "Result", value: stateText[c.state] },
                ...(c.state === "none" ? [] : [{ label: "Findings", value: String(c.total) }]),
              ],
            }))}
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

/** A regression row; a click opens the finding's detail in the row drawer. */
function RegressionRow({
  item,
  open,
  onOpen,
  onScope,
}: {
  item: RegressionItem;
  open: boolean;
  onOpen: () => void;
  onScope: () => void;
}): ReactNode {
  const device = item.finding?.device ?? item.run.device;
  return (
    <RowMenu
      title={item.title}
      sub={`${item.change} · ${device} · ${item.run.jobId}`}
      onOpen={onOpen}
      cells={{
        severity: { value: item.severity ? capitalize(item.severity) : "Change" },
        finding: {
          value: item.title,
        },
        job: { value: item.run.jobId, filter: onScope },
        change: { value: item.change },
      }}
      copies={[
        ...(item.finding ? [{ label: "Finding ID", value: item.finding.id }] : []),
        { label: "Device", value: device },
      ]}
      row={item.finding ?? item.run}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${item.title}, ${item.change}`}
        aria-expanded={open}
        className="monitor-row sched-reg-grid"
        data-selected={open || undefined}
        onClick={onOpen}
        onKeyDown={onRowKey(onOpen)}
      >
        <span data-col="severity" className="min-w-0">
          <StatusBadge tone={SEVERITY_TONE[item.severity ?? ""] ?? "default"} dot={false}>
            {item.severity ? capitalize(item.severity) : "Change"}
          </StatusBadge>
        </span>
        <span data-col="finding" className="flex min-w-0 flex-col gap-px">
          <span className="p truncate">{item.title}</span>
          <span data-col="job" className="sched-mono text-muted-foreground truncate">
            {device} · {item.run.jobId}
          </span>
        </span>
        <span
          data-col="change"
          className={cn("truncate text-[12px] font-medium", CHANGE_CLASS[item.change])}
        >
          {item.change}
        </span>
        <RowMore />
      </div>
    </RowMenu>
  );
}

/** The regression's detail: what the expanded row used to show. */
function RegressionDetail({ item }: { item: RegressionItem }): ReactNode {
  return (
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
  );
}

type Picked = { t: "job" | "reg" | "run"; key: string } | null;

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
  const [picked, setPicked] = useState<Picked>(null);
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

  const jobActions = (id: string): RowAction[] => [
    {
      label: "Run now",
      icon: <Play aria-hidden="true" />,
      disabled: running !== null,
      onSelect: () => void runNow(id),
    },
    {
      label: "Remove",
      icon: <Trash2 aria-hidden="true" />,
      danger: true,
      onSelect: () => setConfirmRemove(id),
    },
  ];
  const navOver = (keys: string[]) => {
    if (!picked) return undefined;
    const at = keys.indexOf(picked.key);
    if (at < 0) return undefined;
    return {
      index: at,
      total: keys.length,
      onPrev: at > 0 ? () => setPicked({ t: picked.t, key: keys[at - 1]! }) : undefined,
      onNext:
        at < keys.length - 1 ? () => setPicked({ t: picked.t, key: keys[at + 1]! }) : undefined,
    };
  };
  const drawer = ((): ReactNode => {
    if (!picked) return null;
    const close = (): void => setPicked(null);
    if (picked.t === "job") {
      const job = jobs.find((j) => j.id === picked.key);
      if (!job) return null;
      const last = job.lastRun;
      const tone: KitTone = !job.enabled ? "off" : KIT_OUTCOME[last?.outcome ?? "skipped"];
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Job details: ${job.id}`}
          storageKey="schedules"
          rowKey={`job:${job.id}`}
          status={{
            tone,
            label: !job.enabled ? "Paused" : last ? `Last run ${last.outcome}` : "Never run",
          }}
          title={<span className="sched-mono">{job.tool}</span>}
          meta={job.cronText}
          nav={navOver(jobs.map((j) => j.id))}
          actions={
            <>
              <MonitorButton
                size="sm"
                variant="danger"
                icon={<Trash2 aria-hidden="true" />}
                onClick={() => setConfirmRemove(job.id)}
              >
                Remove
              </MonitorButton>
              <MonitorButton
                size="sm"
                icon={<Filter aria-hidden="true" />}
                aria-pressed={selected === job.id}
                onClick={() => setSelected(selected === job.id ? null : job.id)}
              >
                {selected === job.id ? "Show all" : "Scope the charts"}
              </MonitorButton>
            </>
          }
          primary={
            <MonitorButton
              size="sm"
              variant="primary"
              disabled={running !== null}
              icon={
                running === job.id ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play aria-hidden="true" />
                )
              }
              onClick={() => void runNow(job.id)}
            >
              Run now
            </MonitorButton>
          }
        >
          <DetailList
            items={[
              { label: "Job", value: job.id, mono: true },
              { label: "Tool", value: job.tool, mono: true },
              { label: "Schedule", value: job.cronText },
              { label: "Enabled", value: job.enabled ? "Yes" : "No, paused" },
              {
                label: "Next run",
                value: !job.enabled || job.nextRun === null ? "None" : relative(job.nextRun, now),
              },
              ...(last
                ? [
                    { label: "Last run", value: `${stamp(last.startedAt)} · ${last.outcome}` },
                    ...(last.error ? [{ label: "Error", value: last.error }] : []),
                  ]
                : [{ label: "Last run", value: "Never run" }]),
              { label: "Open findings", value: String(job.posture.total) },
            ]}
          />
        </RowDrawer>
      );
    }
    if (picked.t === "reg") {
      const item = changes.find((x) => x.key === picked.key);
      if (!item) return null;
      const device = item.finding?.device ?? item.run.device;
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Regression details: ${item.title}`}
          storageKey="schedules"
          rowKey={`reg:${item.key}`}
          status={{
            tone:
              item.change === "New"
                ? "bad"
                : item.change === "Worse"
                  ? "warn"
                  : item.change === "Resolved"
                    ? "ok"
                    : "off",
            label: item.change,
          }}
          title={item.title}
          meta={`${device} · ${item.run.jobId}`}
          nav={navOver(changes.map((x) => x.key))}
        >
          <RegressionDetail item={item} />
          <DetailList
            items={[
              { label: "Severity", value: item.severity ? capitalize(item.severity) : "Change" },
              { label: "Device", value: device, mono: true },
              { label: "Job", value: item.run.jobId, mono: true },
            ]}
          />
        </RowDrawer>
      );
    }
    const p = history.find((x) => runKey(x) === picked.key);
    if (!p) return null;
    return (
      <RowDrawer
        open
        onClose={close}
        label={`Run details: ${p.jobId}`}
        storageKey="schedules"
        rowKey={`run:${picked.key}`}
        status={{ tone: KIT_OUTCOME[p.outcome], label: capitalize(p.outcome) }}
        title={<span className="sched-mono">{p.jobId}</span>}
        meta={`${stamp(p.at)} · ${p.device ?? "fleet"}`}
        nav={navOver(history.map(runKey))}
      >
        <DetailList
          items={[
            { label: "Job", value: p.jobId, mono: true },
            { label: "Device", value: p.device ?? "fleet", mono: true },
            { label: "Started", value: stamp(p.at) },
            { label: "Took", value: `${(p.durationMs / 1000).toFixed(1)} s` },
            { label: "Result", value: p.outcome },
            ...(p.outcome === "ok"
              ? [
                  { label: "Findings", value: String(p.total) },
                  { label: "New", value: String(p.added) },
                  { label: "Worse", value: String(p.worsened) },
                  { label: "Resolved", value: String(p.resolved) },
                ]
              : []),
          ]}
        />
      </RowDrawer>
    );
  })();
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
                <RowMenu
                  key={job.id}
                  title={job.tool}
                  sub={meta}
                  onOpen={() => setPicked({ t: "job", key: job.id })}
                  cells={{
                    job: {
                      value: job.id,
                      filter: () => setSelected(job.id),
                      clearFilter: selected ? () => setSelected(null) : undefined,
                    },
                  }}
                  copies={[
                    { label: "Job ID", value: job.id },
                    { label: "Tool", value: job.tool },
                  ]}
                  row={job}
                  actions={jobActions(job.id)}
                >
                  <div
                    className="monitor-row sched-job-grid"
                    data-selected={isSelected || undefined}
                  >
                    <button
                      data-col="job"
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
                    <RowMore />
                  </div>
                </RowMenu>
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
                <span />
              </div>
              {changes.map((item) => (
                <RegressionRow
                  key={item.key}
                  item={item}
                  open={picked?.t === "reg" && picked.key === item.key}
                  onOpen={() => setPicked({ t: "reg", key: item.key })}
                  onScope={() => setSelected(item.run.jobId)}
                />
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
                <span />
              </div>
              {history.map((p) => {
                const bad = p.outcome === "failed" || p.outcome === "timeout";
                const key = runKey(p);
                const result = p.outcome === "ok" ? plural(p.total, "finding") : p.outcome;
                return (
                  <RowMenu
                    key={key}
                    title={p.jobId}
                    sub={`${stamp(p.at)} · ${p.device ?? "fleet"} · ${result}`}
                    onOpen={() => setPicked({ t: "run", key })}
                    cells={{
                      job: {
                        value: p.jobId,
                        filter: jobs.some((j) => j.id === p.jobId)
                          ? () => setSelected(p.jobId)
                          : undefined,
                        clearFilter: selected ? () => setSelected(null) : undefined,
                      },
                      device: { value: p.device ?? "fleet", kind: "router" },
                      started: { value: stamp(p.at), kind: "time" },
                      took: { value: `${(p.durationMs / 1000).toFixed(1)} s`, kind: "duration" },
                      result: { value: result },
                    }}
                    copies={[{ label: "Job ID", value: p.jobId }]}
                    row={p}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${p.jobId}, ${result}, ${runTime(p.at, now)}`}
                      className="monitor-row sched-run-grid"
                      data-failed={bad || undefined}
                      data-selected={(picked?.t === "run" && picked.key === key) || undefined}
                      onClick={() => setPicked({ t: "run", key })}
                      onKeyDown={onRowKey(() => setPicked({ t: "run", key }))}
                    >
                      <span data-col="job" className="sched-mono p truncate">
                        {p.jobId}
                      </span>
                      <span data-col="device" className="sched-mono text-muted-foreground truncate">
                        {p.device ?? "fleet"}
                      </span>
                      <span
                        data-col="started"
                        className="text-muted-foreground truncate"
                        title={stamp(p.at)}
                      >
                        {runTime(p.at, now)}
                      </span>
                      <span data-col="took" className="truncate tabular-nums">
                        {(p.durationMs / 1000).toFixed(1)} s
                      </span>
                      <span
                        data-col="result"
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
                          {result}
                        </span>
                      </span>
                      <RowMore />
                    </div>
                  </RowMenu>
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

      {drawer}
      {editor}
    </div>
  );
}
