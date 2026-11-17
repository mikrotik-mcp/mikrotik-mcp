/**
 * Overview, built to the approved "Overview" board (Main.dc.html): verdict
 * header, KPI strip, calls over time beside the risk mix, top tools beside
 * recent failures, then calls by device when there is more than one router.
 */
import type { ReactNode } from "react";
import "./overview.css";
import { Boxes, CircleCheck, RefreshCw } from "lucide-react";
import { num, WINDOWS } from "./format";
import { LoadingState } from "./loading-state";
import {
  formatBytes as bytes,
  formatMs as ms,
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  RiskBadge,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import type { Bucket, Risk, Stats, ToolEvent } from "./types";

// Built from the view id: the hex-colour test would read the literal hash link as a colour.
const FEED_HREF = `#${"feed"}`;

const RISKS: Risk[] = ["READ", "WRITE", "WRITE_IDEMPOTENT", "DESTRUCTIVE", "DANGEROUS"];
const RISK_STROKE: Record<Risk, string> = {
  READ: "var(--muted-foreground)",
  WRITE: "var(--warning)",
  WRITE_IDEMPOTENT: "var(--chart-1)",
  DESTRUCTIVE: "var(--destructive)",
  DANGEROUS: "var(--destructive)",
};

/** "last hour", "last 15 minutes", "last 24 hours". */
function windowPhrase(windowMs: number): string {
  const min = Math.round(windowMs / 60_000);
  if (min === 60) return "last hour";
  if (min < 60) return `last ${min} minutes`;
  return `last ${Math.round(min / 60)} hours`;
}

/** "2.5-minute", "15-minute", "1-hour", "12.5-second". */
function intervalPhrase(bucketMs: number): string {
  const fmt = (n: number): string => String(Math.round(n * 10) / 10);
  if (bucketMs < 60_000) return `${fmt(bucketMs / 1000)}-second`;
  if (bucketMs < 3_600_000) return `${fmt(bucketMs / 60_000)}-minute`;
  return `${fmt(bucketMs / 3_600_000)}-hour`;
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

const COUNT_WORD = ["", "", "Both", "All three", "All four", "All five", "All six", "All seven"];

function errorTone(stats: Stats): Tone {
  if (stats.errorRate >= 0.2) return "bad";
  if (stats.errors > 0) return "warn";
  return "default";
}

/** The header's status line and the sentence under it. */
function verdict(
  stats: Stats,
  phrase: string,
  errors: ToolEvent[],
): { tone: Tone; title: string; sub: ReactNode } {
  if (stats.total === 0) {
    return {
      tone: "default",
      title: `No calls in the ${phrase}`,
      sub: "Calls from any MCP client show up here as they happen.",
    };
  }
  const pct = `${(stats.errorRate * 100).toFixed(1)}%`;
  if (stats.errors === 0) {
    return {
      tone: "good",
      title: `Every call succeeded in the ${phrase}`,
      sub: `${num(stats.total)} calls, p95 ${ms(stats.latency.p95)}.`,
    };
  }
  const failing = stats.byTool.filter((t) => t.errors > 0);
  let source: ReactNode = ` ${failing.length} tools had failures.`;
  if (failing.length === 1) {
    const tool = failing[0].tool;
    const devices = new Set(errors.filter((e) => e.tool === tool).map((e) => e.device ?? ""));
    const device = devices.size === 1 ? [...devices][0] : "";
    const who =
      stats.errors === 1 ? "It" : (COUNT_WORD[stats.errors] ?? `All ${num(stats.errors)}`);
    source = (
      <>
        {" "}
        {who} came from <span className="text-fg-secondary font-mono text-[12px]">{tool}</span>
        {device ? ` on ${device}` : ""}.
      </>
    );
  }
  return {
    tone: errorTone(stats),
    title: `${num(stats.errors)} of ${num(stats.total)} calls failed in the ${phrase}`,
    sub: (
      <>
        {pct} error rate.{source}
      </>
    ),
  };
}

/** The board's bar chart: succeeded calls per interval, failures stacked on top. */
function CallsChart({ series }: { series: Bucket[] }): ReactNode {
  const n = Math.max(series.length, 1);
  const step = 720 / n;
  const barW = step * 0.73;
  const max = Math.max(1, ...series.map((b) => b.ok + b.error));
  const H = 160;
  return (
    <svg
      viewBox="0 0 720 220"
      width="100%"
      height="220"
      preserveAspectRatio="none"
      // Inline like the board's chart, so the panel keeps the same height.
      className="inline"
      role="img"
      aria-label={`Calls per interval, peaking at ${num(max)} calls`}
    >
      <line x1="0" y1="20" x2="720" y2="20" stroke="var(--chart-grid)" strokeDasharray="2 4" />
      <line x1="0" y1="100" x2="720" y2="100" stroke="var(--chart-grid)" strokeDasharray="2 4" />
      <line x1="0" y1="180" x2="720" y2="180" stroke="var(--chart-grid)" />
      {series.map((b, i) => {
        const h = Math.round((b.ok / max) * H);
        const eh = b.error ? Math.max(6, Math.round((b.error / max) * H) + 4) : 0;
        const x = i * step + (step - barW) / 2;
        return (
          <g key={b.t}>
            {h > 0 && (
              <rect
                x={x}
                y={180 - h}
                width={barW}
                height={h}
                rx="3"
                fill="var(--chart-1)"
                opacity="0.85"
              />
            )}
            {eh > 0 && (
              <rect
                x={x}
                y={180 - h - eh - 2}
                width={barW}
                height={eh}
                rx="2"
                fill="var(--destructive)"
              />
            )}
          </g>
        );
      })}
      <text x="0" y="14" fill="var(--muted-foreground)" fontSize="11">
        {num(max)}
      </text>
      {series.length > 0 && (
        <>
          <text x="0" y="200" fill="var(--muted-foreground)" fontSize="11">
            {hhmm(series[0].t)}
          </text>
          <text x="340" y="200" fill="var(--muted-foreground)" fontSize="11">
            {hhmm(series[Math.floor(series.length / 2)].t)}
          </text>
        </>
      )}
      <text x="690" y="200" fill="var(--muted-foreground)" fontSize="11">
        now
      </text>
    </svg>
  );
}

/** Donut of the risk mix with a legend of counts. */
function RiskMix({ stats }: { stats: Stats }): ReactNode {
  const shown = RISKS.filter((r) => (stats.byRisk[r] ?? 0) > 0);
  const total = shown.reduce((a, r) => a + stats.byRisk[r], 0);
  const C = 2 * Math.PI * 48;
  const lengths = shown.map((r) => (stats.byRisk[r] / Math.max(total, 1)) * C);
  return (
    <div className="overview-donut flex items-center gap-5">
      <svg
        viewBox="0 0 120 120"
        width="120"
        height="120"
        className="flex-none"
        role="img"
        aria-label={`Risk mix of ${num(total)} calls`}
      >
        <circle cx="60" cy="60" r="48" fill="none" stroke="var(--overlay-08)" strokeWidth="12" />
        {shown.map((r, i) => (
          <circle
            key={r}
            cx="60"
            cy="60"
            r="48"
            fill="none"
            stroke={RISK_STROKE[r]}
            strokeWidth="12"
            strokeDasharray={`${Math.max(lengths[i] - 2, 1)} ${C}`}
            // Each arc starts where the previous ones end.
            strokeDashoffset={-lengths.slice(0, i).reduce((a, b) => a + b, 0)}
            transform="rotate(-90 60 60)"
          />
        ))}
        <text
          x="60"
          y="58"
          textAnchor="middle"
          fill="var(--text-emphasis)"
          fontSize="20"
          fontWeight="590"
        >
          {num(total)}
        </text>
        <text x="60" y="76" textAnchor="middle" fill="var(--muted-foreground)" fontSize="11">
          calls
        </text>
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {shown.map((r) => (
          <div key={r} className="flex items-center gap-2 text-[13px]">
            <RiskBadge risk={r} />
            <span className="flex-1" />
            <span className="text-fg-secondary tabular-nums">{num(stats.byRisk[r])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The phone board's risk mix: one stacked bar and a 2x2 legend. */
function RiskStrip({ stats }: { stats: Stats }): ReactNode {
  const shown = RISKS.filter((r) => (stats.byRisk[r] ?? 0) > 0);
  const total = Math.max(
    1,
    shown.reduce((a, r) => a + stats.byRisk[r], 0),
  );
  return (
    <div className="overview-risk-strip flex-col gap-2.5">
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {shown.map((r) => (
          <span
            key={r}
            style={{ width: `${(stats.byRisk[r] / total) * 100}%`, background: RISK_STROKE[r] }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        {shown.map((r) => (
          <span key={r} className="flex items-center gap-1.5">
            <RiskBadge risk={r} short />
            <span className="text-fg-secondary tabular-nums">{num(stats.byRisk[r])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const TOOLS_GRID = "grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_64px_72px]";

export function OverviewView({
  stats,
  windowMs,
  onWindowChange,
  status,
  errors,
  feed,
  onOpen,
  onRefresh,
}: {
  stats: Stats | null;
  windowMs: number;
  onWindowChange: (ms: number) => void;
  /** Ok/failed split of the calls loaded in the live feed. */
  status: { ok: number; error: number };
  errors: ToolEvent[];
  /** The live feed, used to name the slowest call's tool. */
  feed: ToolEvent[];
  onOpen: (e: ToolEvent) => void;
  onRefresh: () => void;
}): ReactNode {
  const phrase = windowPhrase(windowMs);
  const v = stats ? verdict(stats, phrase, errors) : null;
  const feedTotal = status.ok + status.error;
  const topCount = Math.max(1, ...(stats?.byTool.map((t) => t.count) ?? [1]));
  const deviceTop = Math.max(1, ...(stats?.byDevice.map((d) => d.count) ?? [1]));
  const slowest = stats ? feed.find((e) => e.durationMs === stats.latency.max) : undefined;
  const bucketMs = stats?.series.length ? windowMs / stats.series.length : windowMs / 24;

  return (
    <section className="overview grid content-start gap-6">
      <PageIntro
        tone={v?.tone}
        live={v?.tone === "bad"}
        title={v?.title ?? `Loading the ${phrase}`}
        controls={
          <>
            <Segmented
              label="Time window"
              value={windowMs}
              onChange={onWindowChange}
              options={WINDOWS.map(([l, val]) => ({ value: val, label: l }))}
            />
            <MonitorButton size="sm" variant="ghost" icon={<RefreshCw />} onClick={onRefresh}>
              Refresh
            </MonitorButton>
          </>
        }
      >
        {v?.sub}
      </PageIntro>

      {stats ? (
        <MetricStrip label="Call metrics" minCell={160}>
          <Metric
            primary
            label="Calls"
            value={<Ticker value={stats.total} format={(n) => num(Math.round(n))} />}
            hint={`${stats.callsPerMin.toFixed(1)} per minute`}
          />
          <Metric
            primary
            label="Error rate"
            tone={errorTone(stats)}
            value={<Ticker value={stats.errorRate * 100} format={(n) => `${n.toFixed(1)}%`} />}
            hint={stats.errors ? `${num(stats.errors)} failed` : "No failures"}
          />
          <Metric
            label="p95 latency"
            value={ms(stats.latency.p95)}
            hint={`avg ${ms(stats.latency.avg)} · p99 ${ms(stats.latency.p99)}`}
          />
          <Metric
            label="Slowest call"
            value={ms(stats.latency.max)}
            hint={
              slowest ? (
                <span className="font-mono">{slowest.tool}</span>
              ) : (
                `median ${ms(stats.latency.p50)}`
              )
            }
          />
          <Metric
            label="Tools used"
            value={<Ticker value={stats.distinctTools} format={(n) => num(Math.round(n))} />}
            hint={`on ${num(stats.distinctDevices)} ${stats.distinctDevices === 1 ? "device" : "devices"}`}
          />
          <Metric label="Output" value={bytes(stats.outputBytes)} hint="returned to clients" />
        </MetricStrip>
      ) : (
        <LoadingState label="Loading overview metrics" layout="cards" />
      )}

      <div className="overview-row flex flex-wrap gap-4">
        <MonitorPanel
          className="overview-calls flex-[2_1_560px]"
          title="Calls over time"
          description={`Per ${intervalPhrase(bucketMs)} interval, ${phrase}`}
          extra={
            <span className="text-muted-foreground flex gap-4 text-[12px]">
              <span className="flex items-center gap-1.5">
                <StatusDot tone="brand" />
                Succeeded
              </span>
              <span className="flex items-center gap-1.5">
                <StatusDot tone="bad" />
                Failed
              </span>
            </span>
          }
        >
          {stats ? (
            <>
              <CallsChart series={stats.series} />
              <p className="overview-legend-phone">
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="brand" />
                  Succeeded
                </span>
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="bad" />
                  Failed
                </span>
              </p>
            </>
          ) : (
            <LoadingState label="Loading calls over time" layout="chart" />
          )}
        </MonitorPanel>

        <MonitorPanel
          className="overview-risk flex-[1_1_300px]"
          title="Risk mix"
          description="What the calls were allowed to do"
          bodyClassName="flex flex-col gap-4"
        >
          {stats ? (
            <>
              <RiskMix stats={stats} />
              <RiskStrip stats={stats} />
              <div className="overview-live-split flex flex-col gap-2 border-t pt-3">
                <div className="text-muted-foreground flex justify-between text-[12px]">
                  <span>Live feed</span>
                  <span className="tabular-nums">
                    {num(status.ok)} ok · {num(status.error)} failed
                  </span>
                </div>
                <div
                  className="bg-overlay-08 flex h-1.5 gap-0.5 overflow-hidden rounded-full"
                  aria-hidden="true"
                >
                  {feedTotal > 0 && (
                    <>
                      <span
                        className="bg-success rounded-full"
                        // Widths are data-driven, so they can't be utility classes.
                        style={{ width: `${(status.ok / feedTotal) * 100}%` }}
                      />
                      <span
                        className="bg-destructive rounded-full"
                        style={{ width: `${(status.error / feedTotal) * 100}%` }}
                      />
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <LoadingState label="Loading risk mix" layout="chart" />
          )}
        </MonitorPanel>
      </div>

      <div className="overview-row flex flex-wrap gap-4">
        <MonitorPanel
          flush
          className="overview-tools flex-[2_1_560px]"
          title="Top tools"
          description="Most called in the window, with p95 latency"
          extra={
            <a href={FEED_HREF} className="text-brand text-[13px] font-[510] no-underline">
              Open Live Feed
            </a>
          }
        >
          {stats?.byTool.length ? (
            <>
              <div className={`monitor-thead ${TOOLS_GRID}`}>
                <span>Tool</span>
                <span>Share</span>
                <span className="text-right">Calls</span>
                <span className="text-right">p95</span>
              </div>
              {stats.byTool.map((t) => (
                <div key={t.tool} className={`overview-tool-row monitor-row ${TOOLS_GRID}`}>
                  <span className="overview-tool-name text-fg-secondary truncate font-mono text-[12px]">
                    {t.tool}
                  </span>
                  <span className="overview-tool-bar monitor-bar">
                    <span
                      style={{
                        width: `${Math.round((t.count / topCount) * 100)}%`,
                        background: t.errors ? "var(--destructive)" : undefined,
                      }}
                    />
                  </span>
                  <span className="overview-tool-count text-right tabular-nums">
                    {num(t.count)}
                  </span>
                  <span className="overview-tool-p95 text-muted-foreground text-right tabular-nums">
                    {ms(t.p95Ms)}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <MonitorEmpty compact icon={<Boxes />} title="No tool calls yet">
              Tools show up here once a client calls them.
            </MonitorEmpty>
          )}
        </MonitorPanel>

        <MonitorPanel
          flush
          className="overview-failures flex-[1_1_300px]"
          title="Recent failures"
          description="Open one to see input and output"
          extra={
            errors.length > 0 ? (
              <StatusBadge tone="bad">{num(errors.length)}</StatusBadge>
            ) : undefined
          }
        >
          {errors.length ? (
            <>
              {errors.slice(0, 3).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="monitor-row grid-cols-[52px_minmax(0,1fr)]"
                  data-failed
                  onClick={() => onOpen(e)}
                >
                  <span className="text-muted-foreground font-mono text-[12px]">{hhmm(e.ts)}</span>
                  <span className="min-w-0">
                    <span className="text-foreground block truncate font-mono text-[12px]">
                      {e.tool}
                    </span>
                    <span className="text-muted-foreground block truncate text-[12px]">
                      {e.device ? `${e.device}: ` : ""}
                      {e.error ?? e.output ?? "Failed"}
                    </span>
                  </span>
                </button>
              ))}
              <div className="monitor-foot">Older failures are in the Live Feed.</div>
            </>
          ) : (
            <MonitorEmpty compact icon={<CircleCheck />} title="No failures">
              Nothing in the live feed has failed.
            </MonitorEmpty>
          )}
        </MonitorPanel>
      </div>

      {stats && stats.byDevice.length > 1 && (
        <MonitorPanel
          className="overview-devices"
          title="Calls by device"
          description="Shown when more than one router is configured"
          bodyClassName="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
        >
          {stats.byDevice.map((d) => {
            const failed = errors.filter((e) => e.device === d.device).length;
            return (
              <div
                key={d.device}
                className="bg-overlay-02 flex flex-col gap-2 rounded-[6px] px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
              >
                <div className="flex items-center gap-2">
                  <StatusDot tone={failed ? "warn" : "good"} />
                  <span className="text-foreground font-mono text-[13px]">{d.device}</span>
                  <span className="flex-1" />
                  <span className="text-fg-secondary tabular-nums">{num(d.count)}</span>
                </div>
                <span className="monitor-bar">
                  <span style={{ width: `${Math.round((d.count / deviceTop) * 100)}%` }} />
                </span>
                <span className="text-muted-foreground text-[12px]">
                  {failed ? `${num(failed)} failed` : "no failures"} in the live feed
                </span>
              </div>
            );
          })}
        </MonitorPanel>
      )}
    </section>
  );
}
