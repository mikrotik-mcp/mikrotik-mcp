/**
 * Overview, built to the approved "Mon-Overview" board: a verdict header with
 * the router map, four KPIs, calls over time beside the risk mix, then the
 * routers beside the latest calls.
 */
import type { ReactNode } from "react";
import "./overview.css";
import { ChevronRight, CircleCheck, Filter, RefreshCw, Server } from "lucide-react";
import { num, WINDOWS } from "./format";
import { LoadingState } from "./loading-state";
import { CallsLine, RouterRadar } from "./overview-charts";
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

const ROUTERS_GRID = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_64px_52px]";
const CALLS_GRID = "grid-cols-[48px_minmax(0,1fr)_140px]";

export function OverviewView({
  stats,
  windowMs,
  onWindowChange,
  errors,
  feed,
  devices,
  onOpen,
  onRefresh,
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
}): ReactNode {
  const phrase = windowPhrase(windowMs);
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
            <RouterRadar nodes={routers.map((r) => ({ name: r.name, tone: routerTone(r) }))} />
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
              </div>
              {routers.map((r) => {
                const tone = routerTone(r);
                const cpu = r.status.cpuLoad;
                const mem = r.status.memUsedPct;
                return (
                  <div
                    key={r.name}
                    className={`monitor-row ${ROUTERS_GRID}`}
                    data-failed={tone === "bad" || undefined}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={LED_TONE[tone]} />
                      <span className="p truncate font-mono text-[12px]">{r.name}</span>
                    </span>
                    {tone === "bad" ? (
                      <span className="text-destructive truncate text-[12px]">
                        {r.status.error ? `${r.status.error} · offline` : "Offline"}
                      </span>
                    ) : cpu == null && mem == null ? (
                      <span className="text-muted-foreground truncate text-[12px]">
                        Not checked yet
                      </span>
                    ) : (
                      <span
                        className="monitor-meter min-w-0"
                        title={`CPU ${cpu ?? "?"}% · memory ${mem ?? "?"}%`}
                      >
                        <span className="monitor-bar" aria-label={`CPU ${cpu ?? 0}%`}>
                          <span data-tone={loadTone(cpu ?? 0)} style={{ width: `${cpu ?? 0}%` }} />
                        </span>
                        <span className="monitor-bar" aria-label={`Memory ${mem ?? 0}%`}>
                          <span data-tone={loadTone(mem ?? 0)} style={{ width: `${mem ?? 0}%` }} />
                        </span>
                      </span>
                    )}
                    <span className="truncate font-mono text-[12px]">
                      {tone === "bad" || !r.activity.avgMs ? "—" : formatLatency(r.activity.avgMs)}
                    </span>
                    <span className="truncate tabular-nums">
                      {num(callsByDevice.get(r.name) ?? 0)}
                    </span>
                  </div>
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
              </div>
              {latest.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`monitor-row ${CALLS_GRID}`}
                  data-failed={e.isError || undefined}
                  onClick={() => onOpen(e)}
                >
                  <span className="text-muted-foreground truncate font-mono text-[12px]">
                    {hhmm(e.ts)}
                  </span>
                  <span className="p truncate font-mono text-[12px]">{e.tool}</span>
                  {e.isError ? (
                    <span className="text-destructive truncate">{e.error ?? "Failed"}</span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StatusDot tone="good" />
                      {formatLatency(e.durationMs)}
                    </span>
                  )}
                </button>
              ))}
            </>
          ) : (
            <MonitorEmpty compact icon={<CircleCheck />} title="No calls yet">
              Calls show up here as they happen.
            </MonitorEmpty>
          )}
        </MonitorPanel>
      </div>
    </section>
  );
}
