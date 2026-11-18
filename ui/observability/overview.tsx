/**
 * Overview, built to the approved "Mon-Overview" board: a verdict header with
 * the router map, four KPIs, calls over time beside the risk mix, then the
 * routers beside the latest calls.
 */
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import "./overview.css";
import { ChevronRight, CircleCheck, Filter, List, RefreshCw, Server } from "lucide-react";
import { num, WINDOWS } from "./format";
import { LoadingState } from "./loading-state";
import { CallsLine, RouterRadar } from "./overview-charts";
import { DetailList, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import type { TipCard, Tone as KitTone } from "./kit";
import type { RadarTone } from "./overview-charts";
import {
  Donut,
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  RiskBadge,
  Segmented,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import type { ChartTone, Tone } from "./monitoring-ui";
import type { DeviceInfo, Risk, Stats, ToolEvent } from "./types";

// Built from the view ids: the hex-colour test would read a literal hash link as a colour.
const FEED_HASH = "feed";
const DEVICES_HASH = "devices";

const RISKS: Risk[] = ["READ", "WRITE", "WRITE_IDEMPOTENT", "DESTRUCTIVE", "DANGEROUS"];
const RISK_TONE: Record<Risk, ChartTone> = {
  READ: "muted",
  WRITE: "warn",
  WRITE_IDEMPOTENT: "brand",
  DESTRUCTIVE: "bad",
  DANGEROUS: "bad",
};

const NUMBER_WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "last hour", "last 15 minutes", "last 24 hours". */
function windowPhrase(windowMs: number): string {
  const min = Math.round(windowMs / 60_000);
  if (min === 60) return "last hour";
  if (min < 60) return `last ${min} minutes`;
  return `last ${Math.round(min / 60)} hours`;
}

/** "15 minutes", "1 hour", "24 hours": the span the chart covers. */
function spanPhrase(windowMs: number): string {
  const min = Math.round(windowMs / 60_000);
  if (min < 60) return `${min} minutes`;
  const h = Math.round(min / 60);
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** "one hour", "2.5 minutes", "15 minutes", "12.5 seconds". */
function intervalPhrase(bucketMs: number): string {
  const fmt = (n: number): string => String(Math.round(n * 10) / 10);
  if (bucketMs < 60_000) return `${fmt(bucketMs / 1000)} seconds`;
  if (bucketMs < 3_600_000) return `${fmt(bucketMs / 60_000)} minutes`;
  const h = bucketMs / 3_600_000;
  return h === 1 ? "one hour" : `${fmt(h)} hours`;
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A latency as the KPI's number plus a small unit. */
function latency(msValue: number): ReactNode {
  if (msValue < 1)
    return (
      <>
        &lt;1<small>ms</small>
      </>
    );
  if (msValue < 1000)
    return (
      <>
        {Math.round(msValue)}
        <small>ms</small>
      </>
    );
  return (
    <>
      {(msValue / 1000).toFixed(1)}
      <small>s</small>
    </>
  );
}

function ago(t: number | null | undefined): string {
  if (!t) return "not checked yet";
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1
    ? "checked just now"
    : m < 60
      ? `checked ${m} min ago`
      : `checked ${Math.round(m / 60)} h ago`;
}

function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Hover card for a router's CPU or memory bar. */
function meterCard(what: "CPU" | "Memory", r: Router, pct: number | null | undefined): TipCard {
  const s = r.status;
  const rows: TipCard["rows"] = [{ label: "Used", value: `${(pct ?? 0).toFixed(1)}%` }];
  if (what === "Memory" && s.freeMemory != null && s.totalMemory)
    rows.push({ label: "Free", value: `${mb(s.freeMemory)} of ${mb(s.totalMemory)}` });
  if (what === "CPU" && s.cpuCount) rows.push({ label: "Cores", value: String(s.cpuCount) });
  return {
    title: what,
    sub: r.name,
    rows,
    foot: {
      label: ago(s.checkedAt),
      value: (pct ?? 0) >= 90 ? "over 90%" : (pct ?? 0) >= 70 ? "over 70%" : "normal",
      tone: (pct ?? 0) >= 70 ? "down" : "up",
    },
  };
}

function formatLatency(msValue: number): string {
  if (msValue < 1) return "<1 ms";
  if (msValue < 1000) return `${Math.round(msValue)} ms`;
  return `${(msValue / 1000).toFixed(1)} s`;
}

type Router = Pick<DeviceInfo, "name" | "status" | "activity">;

/** Healthy, under strain (CPU or memory at 70% or more), offline or not checked. */
function routerTone(d: Router): RadarTone {
  if (d.status.reachable === false) return "bad";
  if (d.status.reachable == null) return "unknown";
  const hot = Math.max(d.status.cpuLoad ?? 0, d.status.memUsedPct ?? 0);
  return hot >= 70 ? "warn" : "good";
}

const LED_TONE: Record<RadarTone, Tone> = {
  good: "good",
  warn: "warn",
  bad: "bad",
  unknown: "default",
};

const KIT_TONE: Record<RadarTone, KitTone> = {
  good: "ok",
  warn: "warn",
  bad: "bad",
  unknown: "off",
};

const STATE_LABEL: Record<RadarTone, string> = {
  good: "Healthy",
  warn: "Strain",
  bad: "Offline",
  unknown: "Not checked",
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

/** A bar's colour for a CPU or memory percentage. */
function loadTone(pct: number): "warn" | "bad" | undefined {
  if (pct >= 85) return "bad";
  if (pct >= 70) return "warn";
  return undefined;
}

/** The header's answer line and the sentence under it. */
function verdict(
  stats: Stats,
  phrase: string,
  errors: ToolEvent[],
  routers: string[],
): { line: ReactNode; lead: ReactNode } {
  if (stats.total === 0)
    return {
      line: `No calls in the ${phrase}.`,
      lead: "Calls from any MCP client show up here as they happen.",
    };
  const calls = `${num(stats.total)} ${stats.total === 1 ? "call" : "calls"}.`;
  if (stats.errors === 0)
    return {
      line: (
        <>
          {calls} <span className="s">None failed</span>.
        </>
      ),
      lead: `p95 latency ${formatLatency(stats.latency.p95)}, ${stats.callsPerMin.toFixed(1)} calls per minute.`,
    };
  const since = Date.now() - stats.windowMs;
  const failedDevices = new Set(
    errors.filter((e) => e.ts >= since && e.device).map((e) => e.device as string),
  );
  const onDevice = failedDevices.size === 1 ? ` on ${[...failedDevices][0]}` : "";
  const failingTools = stats.byTool.filter((t) => t.errors > 0);
  let source: ReactNode = `Failures came from ${num(failingTools.length)} tools.`;
  if (failingTools.length === 1)
    source = (
      <>
        {stats.errors === 1 ? "The failure" : "Every failure"} came from{" "}
        <span className="mono">{failingTools[0].tool}</span>.
      </>
    );
  const others = routers.filter((r) => !failedDevices.has(r)).length;
  const rest =
    failedDevices.size === 1 && others > 0
      ? ` The other ${NUMBER_WORD[others] ?? num(others)} ${others === 1 ? "router" : "routers"} answered every call.`
      : "";
  return {
    line: (
      <>
        {calls} <em>{num(stats.errors)} failed</em>
        {onDevice}.
      </>
    ),
    lead: (
      <>
        {source}
        {rest}
      </>
    ),
  };
}

const ROUTERS_GRID = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_64px_52px_26px]";
const CALLS_GRID = "grid-cols-[48px_minmax(0,1fr)_140px_26px]";

export function OverviewView({
  stats,
  windowMs,
  onWindowChange,
  errors,
  feed,
  devices,
  onOpen,
  onRefresh,
  onShowCalls,
  onOpenRouter,
}: {
  stats: Stats | null;
  windowMs: number;
  onWindowChange: (ms: number) => void;
  /** Ok/failed split of the calls loaded in the live feed. Not drawn on the board. */
  status?: { ok: number; error: number };
  errors: ToolEvent[];
  /** The live feed; the newest calls fill "Latest calls". */
  feed: ToolEvent[];
  /** Configured routers with their last health check. */
  devices?: DeviceInfo[];
  onOpen: (e: ToolEvent) => void;
  onRefresh: () => void;
  /** Opens Live Feed filtered to these calls (a chart's tooltip action). */
  onShowCalls?: (filter: { risk?: string; device?: string }) => void;
  /** Opens a router's page (a radar node's tooltip action). */
  onOpenRouter?: (name: string) => void;
}): ReactNode {
  const phrase = windowPhrase(windowMs);
  const [openRouter, setOpenRouter] = useState<string | null>(null);
  // Without the health list, fall back to the routers that took calls.
  const routers: Router[] =
    devices ??
    (stats?.byDevice ?? []).map((d) => ({
      name: d.device,
      status: { reachable: null, checkedAt: null, latencyMs: null },
      activity: { calls: d.count, errors: 0, lastSeen: 0, avgMs: 0 },
    }));
  const names = routers.map((r) => r.name);
  const v = stats ? verdict(stats, phrase, errors, names) : null;
  const callsByDevice = new Map(stats?.byDevice.map((d) => [d.device, d.count]));
  const offline = routers.filter((r) => r.status.reachable === false);
  const online = routers.filter((r) => r.status.reachable === true).length;
  const slowestTool = stats?.byTool.reduce<Stats["byTool"][number] | undefined>(
    (top, t) => (!top || t.p95Ms > top.p95Ms ? t : top),
    undefined,
  );
  const series = stats?.series ?? [];
  const bucketMs = series.length ? windowMs / series.length : windowMs / 24;
  const labelCount = Math.min(7, series.length);
  const labels = Array.from({ length: labelCount }, (_, i) => {
    const b = series[Math.round((i * (series.length - 1)) / Math.max(labelCount - 1, 1))];
    return { at: b.t, text: i === labelCount - 1 ? "now" : hhmm(b.t) };
  });
  const riskShown = stats ? RISKS.filter((r) => (stats.byRisk[r] ?? 0) > 0) : [];
  const riskTotal = riskShown.reduce((a, r) => a + (stats?.byRisk[r] ?? 0), 0);
  const latest = feed.slice(0, 5);

  return (
    <section className="overview grid content-start gap-[18px]">
      <PageIntro
        eyebrow={capital(phrase)}
        verdict={v?.line ?? `Loading the ${phrase}.`}
        lead={v?.lead}
        aside={
          <div className="glass h-[300px] overflow-hidden">
            <RouterRadar
              nodes={routers.map((r) => ({
                name: r.name,
                tone: routerTone(r),
                detail: {
                  state: STATE_LABEL[routerTone(r)],
                  rows: [
                    ...(r.status.memUsedPct != null
                      ? [{ label: "Memory", value: `${Math.round(r.status.memUsedPct)}%` }]
                      : []),
                    ...(r.status.cpuLoad != null
                      ? [{ label: "CPU", value: `${Math.round(r.status.cpuLoad)}%` }]
                      : []),
                    ...(r.activity.avgMs
                      ? [{ label: "Average call", value: formatLatency(r.activity.avgMs) }]
                      : []),
                    {
                      label: `Calls ${phrase}`,
                      value: num(callsByDevice.get(r.name) ?? r.activity.calls),
                    },
                  ],
                  onOpen: onOpenRouter ? () => onOpenRouter(r.name) : undefined,
                },
              }))}
            />
          </div>
        }
        actions={
          <>
            <Segmented
              label="Time window"
              value={windowMs}
              onChange={onWindowChange}
              options={WINDOWS.map(([l, val]) => ({ value: val, label: l }))}
            />
            {stats && stats.errors > 0 && (
              <MonitorButton
                variant="primary"
                icon={<Filter />}
                onClick={() => (location.hash = FEED_HASH)}
              >
                Open failures
              </MonitorButton>
            )}
            <MonitorButton variant="ghost" icon={<RefreshCw />} onClick={onRefresh}>
              Refresh
            </MonitorButton>
          </>
        }
      />

      {stats ? (
        <MetricStrip label="Call metrics" minCell={160} className="overview-kpis">
          <Metric
            label="Calls"
            value={<Ticker value={stats.total} format={(n) => num(Math.round(n))} />}
            hint={`${stats.callsPerMin.toFixed(1)} per minute`}
            spark={series.map((b) => b.ok + b.error)}
          />
          <Metric
            label="Failed"
            tone={stats.errors > 0 ? "bad" : "default"}
            value={<Ticker value={stats.errors} format={(n) => num(Math.round(n))} />}
            hint={`${(stats.errorRate * 100).toFixed(1)}% of calls`}
            spark={stats.errors > 0 ? series.map((b) => b.error) : undefined}
          />
          <Metric
            label="p95 latency"
            value={latency(stats.latency.p95)}
            hint={
              slowestTool ? (
                <>
                  slowest: <span className="font-mono">{slowestTool.tool}</span>
                </>
              ) : (
                `avg ${formatLatency(stats.latency.avg)}`
              )
            }
          />
          <Metric
            label="Routers online"
            tone={offline.length ? "warn" : "default"}
            value={
              devices ? (
                <>
                  {online}
                  <small>/{routers.length}</small>
                </>
              ) : (
                "—"
              )
            }
            hint={
              !devices
                ? "Not checked yet"
                : offline.length === 1
                  ? `${offline[0].name} offline at the last check`
                  : offline.length > 1
                    ? `${offline.length} offline at the last check`
                    : "All answered the last check"
            }
          />
        </MetricStrip>
      ) : (
        <LoadingState label="Loading overview metrics" layout="cards" />
      )}

      <div className="overview-row overview-row-chart">
        <MonitorPanel
          title={`Calls over ${spanPhrase(windowMs)}`}
          description={`Each point is ${intervalPhrase(bucketMs)}. Pink dots are failed calls.`}
          extra={
            <span className="monitor-legend">
              <span>
                <i className="bg-sig" />
                calls
              </span>
              <span>
                <i className="bg-destructive" />
                failed
              </span>
            </span>
          }
        >
          {stats ? (
            <CallsLine
              values={series.map((b) => b.ok + b.error)}
              failed={series.map((b) => b.error)}
              labels={labels}
              times={series.map((b) => b.t)}
              bucketMs={bucketMs}
            />
          ) : (
            <LoadingState label="Loading calls over time" layout="chart" />
          )}
        </MonitorPanel>

        <MonitorPanel title="Risk mix" description="What the calls were allowed to change.">
          {stats ? (
            <div className="overview-risk flex items-center gap-[18px]">
              <Donut
                size={132}
                stroke={14}
                label="Risk mix"
                center={num(riskTotal)}
                sub="calls"
                noun="calls"
                partAction={
                  onShowCalls
                    ? (p) => ({
                        label: "Show these calls in Live Feed",
                        onClick: () => onShowCalls({ risk: p.label }),
                      })
                    : undefined
                }
                parts={riskShown.map((r) => ({
                  value: stats.byRisk[r],
                  tone: RISK_TONE[r],
                  label: r,
                }))}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[9px] text-[13px]">
                {riskShown.map((r) => (
                  <span key={r} className="flex items-center gap-2">
                    <RiskBadge risk={r} />
                    <span className="flex-1" />
                    <span className="text-fg-secondary tabular-nums">{num(stats.byRisk[r])}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <LoadingState label="Loading risk mix" layout="chart" />
          )}
        </MonitorPanel>
      </div>

      <div className="overview-row overview-row-lists">
        <MonitorPanel
          flush
          title="Routers"
          description="CPU and memory at the last check."
          extra={
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<ChevronRight />}
              onClick={() => (location.hash = DEVICES_HASH)}
            >
              All routers
            </MonitorButton>
          }
        >
          {routers.length ? (
            <>
              <div className={`monitor-thead ${ROUTERS_GRID}`}>
                <span>Router</span>
                <span>Health</span>
                <span>Avg</span>
                <span>Calls</span>
                <span />
              </div>
              {routers.map((r) => {
                const tone = routerTone(r);
                const cpu = r.status.cpuLoad;
                const mem = r.status.memUsedPct;
                const health =
                  tone === "bad"
                    ? r.status.error
                      ? `${r.status.error} · offline`
                      : "Offline"
                    : cpu == null && mem == null
                      ? "Not checked yet"
                      : `CPU ${Math.round(cpu ?? 0)}% · memory ${Math.round(mem ?? 0)}%`;
                const avg =
                  tone === "bad" || !r.activity.avgMs ? "—" : formatLatency(r.activity.avgMs);
                const calls = num(callsByDevice.get(r.name) ?? 0);
                return (
                  <RowMenu
                    key={r.name}
                    title={r.name}
                    sub={`${STATE_LABEL[tone]} · ${ago(r.status.checkedAt)}`}
                    onOpen={() => setOpenRouter(r.name)}
                    opens={
                      onOpenRouter
                        ? [{ label: "Open router page", onSelect: () => onOpenRouter(r.name) }]
                        : undefined
                    }
                    cells={{
                      router: {
                        value: r.name,
                        kind: "router",
                        open: onOpenRouter
                          ? { label: "Open router", run: () => onOpenRouter(r.name) }
                          : undefined,
                      },
                      health: { value: health },
                      avg: { value: avg === "—" ? "" : avg, kind: "duration" },
                      calls: {
                        value: calls,
                        open: onShowCalls
                          ? {
                              label: "Show these calls in Live Feed",
                              run: () => onShowCalls({ device: r.name }),
                            }
                          : undefined,
                      },
                    }}
                    copies={[{ label: "Router name", value: r.name }]}
                    row={r}
                    actions={
                      onShowCalls
                        ? [
                            {
                              label: "Show calls in Live Feed",
                              icon: <List aria-hidden="true" />,
                              onSelect: () => onShowCalls({ device: r.name }),
                            },
                          ]
                        : undefined
                    }
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${r.name}, ${STATE_LABEL[tone].toLowerCase()}`}
                      className={`monitor-row ${ROUTERS_GRID}`}
                      data-failed={tone === "bad" || undefined}
                      data-selected={openRouter === r.name || undefined}
                      onClick={() => setOpenRouter(r.name)}
                      onKeyDown={onRowKey(() => setOpenRouter(r.name))}
                    >
                      <span data-col="router" className="flex min-w-0 items-center gap-2.5">
                        <StatusDot tone={LED_TONE[tone]} />
                        <span className="p truncate font-mono text-[12px]">{r.name}</span>
                      </span>
                      {tone === "bad" ? (
                        <span data-col="health" className="text-destructive truncate text-[12px]">
                          {health}
                        </span>
                      ) : cpu == null && mem == null ? (
                        <span
                          data-col="health"
                          className="text-muted-foreground truncate text-[12px]"
                        >
                          {health}
                        </span>
                      ) : (
                        <span data-col="health" className="monitor-meter kit-tips min-w-0">
                          <span
                            className="monitor-bar"
                            aria-label={`CPU ${cpu ?? 0}%`}
                            {...tipProps(() => meterCard("CPU", r, cpu))}
                          >
                            <span
                              data-tone={loadTone(cpu ?? 0)}
                              style={{ width: `${cpu ?? 0}%` }}
                            />
                          </span>
                          <span
                            className="monitor-bar"
                            aria-label={`Memory ${mem ?? 0}%`}
                            {...tipProps(() => meterCard("Memory", r, mem))}
                          >
                            <span
                              data-tone={loadTone(mem ?? 0)}
                              style={{ width: `${mem ?? 0}%` }}
                            />
                          </span>
                        </span>
                      )}
                      <span data-col="avg" className="truncate font-mono text-[12px]">
                        {avg}
                      </span>
                      <span data-col="calls" className="truncate tabular-nums">
                        {calls}
                      </span>
                      <RowMore />
                    </div>
                  </RowMenu>
                );
              })}
            </>
          ) : (
            <MonitorEmpty compact icon={<Server />} title="No routers yet">
              Add a router on the Devices page.
            </MonitorEmpty>
          )}
        </MonitorPanel>

        <MonitorPanel
          flush
          title="Latest calls"
          description="Streaming from the MCP server."
          extra={
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<ChevronRight />}
              onClick={() => (location.hash = FEED_HASH)}
            >
              Live Feed
            </MonitorButton>
          }
        >
          {latest.length ? (
            <>
              <div className={`monitor-thead ${CALLS_GRID}`}>
                <span>Time</span>
                <span>Tool</span>
                <span>Result</span>
                <span />
              </div>
              {latest.map((e) => (
                <RowMenu
                  key={e.id}
                  title={e.tool}
                  sub={`${hhmm(e.ts)} · ${e.device ?? "no router"} · ${formatLatency(e.durationMs)}`}
                  onOpen={() => onOpen(e)}
                  cells={{
                    time: { value: hhmm(e.ts), kind: "time" },
                    tool: { value: e.tool, kind: "tool" },
                    result: {
                      value: e.isError ? (e.error ?? "Failed") : formatLatency(e.durationMs),
                    },
                  }}
                  copies={[{ label: "Call ID", value: e.id }]}
                  row={e}
                  actions={
                    e.device && onShowCalls
                      ? [
                          {
                            label: `Show calls from ${e.device}`,
                            icon: <List aria-hidden="true" />,
                            onSelect: () => onShowCalls({ device: e.device! }),
                          },
                        ]
                      : undefined
                  }
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${e.tool}, ${e.isError ? "failed" : "ok"}, ${hhmm(e.ts)}`}
                    className={`monitor-row ${CALLS_GRID}`}
                    data-failed={e.isError || undefined}
                    onClick={() => onOpen(e)}
                    onKeyDown={onRowKey(() => onOpen(e))}
                  >
                    <span
                      data-col="time"
                      className="text-muted-foreground truncate font-mono text-[12px]"
                    >
                      {hhmm(e.ts)}
                    </span>
                    <span data-col="tool" className="p truncate font-mono text-[12px]">
                      {e.tool}
                    </span>
                    {e.isError ? (
                      <span data-col="result" className="text-destructive truncate">
                        {e.error ?? "Failed"}
                      </span>
                    ) : (
                      <span data-col="result" className="flex min-w-0 items-center gap-1.5">
                        <StatusDot tone="good" />
                        {formatLatency(e.durationMs)}
                      </span>
                    )}
                    <RowMore />
                  </div>
                </RowMenu>
              ))}
            </>
          ) : (
            <MonitorEmpty compact icon={<CircleCheck />} title="No calls yet">
              Calls show up here as they happen.
            </MonitorEmpty>
          )}
        </MonitorPanel>
      </div>
      {(() => {
        const at = routers.findIndex((x) => x.name === openRouter);
        const r = at >= 0 ? routers[at] : undefined;
        if (!r) return null;
        const tone = routerTone(r);
        const s = r.status;
        return (
          <RowDrawer
            open
            onClose={() => setOpenRouter(null)}
            label={`Router details: ${r.name}`}
            storageKey="overview-routers"
            rowKey={r.name}
            status={{ tone: KIT_TONE[tone], label: STATE_LABEL[tone] }}
            title={r.name}
            meta={capital(ago(s.checkedAt))}
            nav={{
              index: at,
              total: routers.length,
              onPrev: at > 0 ? () => setOpenRouter(routers[at - 1]!.name) : undefined,
              onNext:
                at < routers.length - 1 ? () => setOpenRouter(routers[at + 1]!.name) : undefined,
            }}
            onOpenFull={onOpenRouter ? () => onOpenRouter(r.name) : undefined}
            actions={
              onShowCalls ? (
                <MonitorButton
                  size="sm"
                  icon={<List aria-hidden="true" />}
                  onClick={() => onShowCalls({ device: r.name })}
                >
                  Show calls in Live Feed
                </MonitorButton>
              ) : undefined
            }
            primary={
              onOpenRouter ? (
                <MonitorButton
                  size="sm"
                  variant="primary"
                  icon={<ChevronRight aria-hidden="true" />}
                  onClick={() => onOpenRouter(r.name)}
                >
                  Open router
                </MonitorButton>
              ) : undefined
            }
          >
            <DetailList
              items={[
                { label: "State", value: STATE_LABEL[tone] },
                ...(s.error ? [{ label: "Error", value: s.error }] : []),
                ...(s.cpuLoad != null ? [{ label: "CPU", value: `${s.cpuLoad.toFixed(1)}%` }] : []),
                ...(s.cpuCount ? [{ label: "Cores", value: String(s.cpuCount) }] : []),
                ...(s.memUsedPct != null
                  ? [{ label: "Memory", value: `${s.memUsedPct.toFixed(1)}%` }]
                  : []),
                ...(s.freeMemory != null && s.totalMemory
                  ? [{ label: "Free memory", value: `${mb(s.freeMemory)} of ${mb(s.totalMemory)}` }]
                  : []),
                ...(s.latencyMs != null
                  ? [{ label: "Check latency", value: formatLatency(s.latencyMs), mono: true }]
                  : []),
                ...(r.activity.avgMs
                  ? [{ label: "Average call", value: formatLatency(r.activity.avgMs), mono: true }]
                  : []),
                { label: `Calls ${phrase}`, value: num(callsByDevice.get(r.name) ?? 0) },
              ]}
            />
          </RowDrawer>
        );
      })()}
    </section>
  );
}
