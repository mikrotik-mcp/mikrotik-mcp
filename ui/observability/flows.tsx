/**
 * Flows view: traffic analytics from collected NetFlow/IPFIX.
 *
 * People arrive asking "who is using my bandwidth", so the ranking comes
 * first. The collector numbers sit in the same strip as the traffic numbers
 * because an empty flow page and an idle link look the same; templates
 * pending is the number that tells them apart.
 */
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Radio } from "lucide-react";
import { api } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusDot,
  Ticker,
  useLineDraw,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import type { FlowConversation, FlowHealth, FlowTimelinePayload, FlowTopPayload } from "./types";
import "./flows.css";

const WINDOWS = ["5m", "15m", "1h", "6h", "24h"] as const;
type Window = (typeof WINDOWS)[number];

const DIMENSIONS = [
  { id: "source", label: "Source" },
  { id: "destination", label: "Destination" },
  { id: "conversation", label: "Conversation" },
  { id: "application", label: "Application" },
] as const;
type Dimension = (typeof DIMENSIONS)[number]["id"];

/** Protocol colours, in share order: bar segment and legend dot. The rest are grey. */
const PROTOCOL_TONES: { bar: string; dot: Tone }[] = [
  { bar: "var(--chart-1)", dot: "brand" },
  { bar: "var(--success)", dot: "good" },
  { bar: "var(--warning)", dot: "warn" },
];
const PROTOCOL_REST = { bar: "var(--muted-foreground)", dot: "default" as Tone };

/** "last hour" for the KPI hint and panel descriptions. */
const WINDOW_PHRASE: Record<Window, string> = {
  "5m": "last 5 minutes",
  "15m": "last 15 minutes",
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
};

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
// The boards write thousands as "96.2k"; millions stay "21.7M".
const compact = (n: number): string => compactFormat.format(Math.round(n)).replace(/K$/, "k");
const num = (n: number): string => Math.round(n).toLocaleString();
const pct = (share: number): string => `${Math.round(share * 100)}%`;
const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function interval(ms: number): string {
  const unit = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
  if (ms >= 3_600_000) return unit(+(ms / 3_600_000).toFixed(1), "hour");
  if (ms >= 60_000) return unit(+(ms / 60_000).toFixed(1), "minute");
  return unit(Math.round(ms / 1000), "second");
}

const protocolName = (version: number): string =>
  version === 10 ? "IPFIX" : `NetFlow v${version}`;

// ── Bytes over time ────────────────────────────────────────────────────────

const CHART_W = 1100;
const CHART_H = 160;
const CHART_TOP = 20;
const CHART_BASE = 140;

function BytesChart({
  data,
  drawKey,
  now,
}: {
  data: FlowTimelinePayload;
  drawKey: string;
  now: number;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLineDraw(ref, drawKey);
  const keys = [...data.keys, "other"];
  const totals = data.buckets.map((b) => ({
    ts: b.ts,
    bytes: keys.reduce((n, k) => n + (b.series[k] ?? 0), 0),
  }));
  const peak = totals.reduce((a, b) => (b.bytes > a.bytes ? b : a), totals[0]);
  const max = Math.max(peak.bytes, 1);
  const step = totals.length > 1 ? CHART_W / (totals.length - 1) : CHART_W;
  const points = (totals.length > 1 ? totals : [totals[0], totals[0]]).map((t, i) => [
    +(i * step).toFixed(1),
    +(CHART_BASE - (t.bytes / max) * (CHART_BASE - CHART_TOP)).toFixed(1),
  ]);
  const line = `M${points.map((p) => p.join(" ")).join(" L")}`;
  const area = `${line} L${CHART_W} ${CHART_BASE} L0 ${CHART_BASE} Z`;
  const mid = data.window.from + (data.window.to - data.window.from) / 2;
  const endsNow = now - data.window.to < 60_000;

  return (
    <div ref={ref}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bytes per ${interval(data.bucketMs)}, peaking at ${humanBytes(
          peak.bytes,
        )} at ${hhmm(peak.ts)}`}
        className="flows-chart"
      >
        <line x1="0" y1={CHART_TOP} x2={CHART_W} y2={CHART_TOP} className="flows-chart-peak" />
        <line x1="0" y1={CHART_BASE} x2={CHART_W} y2={CHART_BASE} className="flows-chart-base" />
        <path d={area} className="flows-chart-area" />
        <path d={line} className="flows-chart-line" data-draw="" />
        {totals.map((t, i) => (
          <rect
            key={t.ts}
            x={Math.max(0, i * step - step / 2)}
            y="0"
            width={Math.min(CHART_W, i * step + step / 2) - Math.max(0, i * step - step / 2)}
            height={CHART_H}
            className="flows-chart-hit"
          >
            <title>{`${hhmm(t.ts)} · ${humanBytes(t.bytes)}`}</title>
          </rect>
        ))}
      </svg>
      <div className="flows-chart-axis">
        <span>{hhmm(data.window.from)}</span>
        <span>{hhmm(mid)}</span>
        <span>{endsNow ? "now" : hhmm(data.window.to)}</span>
      </div>
    </div>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function FlowsView(): ReactNode {
  const [window, setWindow] = useState<Window>("1h");
  const [dimension, setDimension] = useState<Dimension>("source");
  const [top, setTop] = useState<FlowTopPayload | null>(null);
  const [talks, setTalks] = useState<FlowConversation[]>([]);
  const [line, setLine] = useState<FlowTimelinePayload | null>(null);
  const [health, setHealth] = useState<FlowHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The window and grouping the loaded data belongs to. Motion keys off this,
  // so a poll does not replay it but a new query does.
  const [loadedKey, setLoadedKey] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const talkersRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    return Promise.all([
      api<FlowTopPayload>(`/api/flows/top?window=${window}&dimension=${dimension}`),
      api<{ conversations: FlowConversation[] }>(`/api/flows/conversations?window=${window}`),
      api<FlowTimelinePayload>(`/api/flows/timeline?window=${window}&dimension=${dimension}`),
      api<FlowHealth>("/api/flows/health"),
    ])
      .then(([topRes, convRes, lineRes, healthRes]) => {
        setTop(topRes);
        setTalks(convRes.conversations);
        setLine(lineRes);
        setHealth(healthRes);
        setError(topRes.error ?? null);
        setLoadedKey(`${window}:${dimension}`);
        setNow(Date.now());
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [window, dimension]);

  useEffect(() => {
    void load();
    // Flow data changes on the exporter's timeout (15 s inactive by default), so
    // a 10-second refresh is as live as the data can actually be.
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  useStaggerIn(talkersRef, ".monitor-row", loadedKey);

  if (!top && !error) return <LoadingState label="Loading network activity" layout="chart" />;

  const totals = top?.totals;
  const c = health?.collector;
  const running = !!c?.running;
  const exporterHealth = c?.exporterHealth ?? [];
  const exporterNames = exporterHealth.length
    ? [...new Set(exporterHealth.map((e) => e.exporter))]
    : Object.keys(c?.exporters ?? {});
  const dimLabel = DIMENSIONS.find((d) => d.id === dimension)?.label ?? "Source";
  const rows = top?.top ?? [];
  const maxBytes = Math.max(...rows.map((r) => r.bytes), 1);
  const protocols = top?.protocols ?? [];
  const lineTotals = line?.buckets.length ? line : null;
  const peak = lineTotals?.buckets
    .map((b) => ({
      ts: b.ts,
      bytes: [...lineTotals.keys, "other"].reduce((n, k) => n + (b.series[k] ?? 0), 0),
    }))
    .reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const hasTraffic = !!totals && totals.flows > 0;

  const windowControl = (
    <Segmented
      label="Time window"
      value={window}
      onChange={setWindow}
      options={WINDOWS.map((w) => ({ value: w, label: w }))}
    />
  );

  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
      {running ? (
        <PageIntro
          small
          tone="good"
          live
          title={`Listening on UDP ${c?.port}`}
          controls={windowControl}
        >
          {exporterNames.length ? (
            <>
              {exporterNames.length === 1 ? "1 exporter: " : `${exporterNames.length} exporters: `}
              {exporterNames.map((name, i) => (
                <span key={name}>
                  {i > 0 && ", "}
                  <span className="flows-mono align-top text-fg-secondary">{name}</span>
                </span>
              ))}
            </>
          ) : (
            <>
              No exporters yet. Point a router at this host with{" "}
              <code className="font-mono">add_traffic_flow_target</code>.
            </>
          )}
        </PageIntro>
      ) : (
        <PageIntro
          tone={health ? "default" : undefined}
          title={health ? "Collector stopped" : "Collector status unknown"}
          controls={windowControl}
        >
          {health ? "Nothing new is being collected." : "Could not read the collector."}
        </PageIntro>
      )}

      {error && (
        <p role="alert" className="monitor-note text-destructive" data-tone="bad">
          {error}
        </p>
      )}

      {health && !running && (
        <section className="monitor-panel">
          <MonitorEmpty icon={<Radio />} title="The flow collector is not running">
            Start it with <code>start_flow_collector</code>, then point the router at this host with{" "}
            <code>add_traffic_flow_target</code>.
          </MonitorEmpty>
        </section>
      )}

      {(running || hasTraffic) && (
        <>
          <MetricStrip label="Flow metrics" minCell={130}>
            <Metric
              label="Traffic"
              primary
              value={totals ? <Ticker value={totals.bytes} format={humanBytes} /> : "—"}
              hint={WINDOW_PHRASE[window]}
            />
            <Metric
              label="Flows"
              value={totals ? <Ticker value={totals.flows} format={compact} /> : "—"}
              hint="records"
            />
            <Metric
              label="Sources"
              value={totals ? <Ticker value={totals.sources} format={num} /> : "—"}
              hint="talking"
            />
            <Metric
              label="Destinations"
              value={totals ? <Ticker value={totals.destinations} format={num} /> : "—"}
              hint="reached"
            />
            <Metric
              label="Packets"
              value={c ? <Ticker value={c.packets} format={compact} /> : "—"}
              hint="received"
            />
            <Metric
              label="Templates"
              tone={c && c.templatesPending > 0 ? "warn" : "default"}
              value={c ? num(c.templates) : "—"}
              hint={
                !c
                  ? undefined
                  : c.templatesPending > 0
                    ? `${num(c.templatesPending)} pending`
                    : "all known"
              }
            />
            <Metric
              label="Decode errors"
              tone={c && c.decodeErrors > 0 ? "bad" : "default"}
              value={c ? num(c.decodeErrors) : "—"}
              hint={
                !c
                  ? undefined
                  : c.templatesDropped > 0
                    ? `${num(c.templatesDropped)} templates dropped`
                    : c.decodeErrors > 0
                      ? "since start"
                      : "none"
              }
            />
            <Metric
              label="Stored"
              value={health?.store ? compact(health.store.rawRows) : "—"}
              hint={health?.store ? `${compact(health.store.rollupRows)} rollups` : "no store"}
            />
          </MetricStrip>

          {!!c?.storageDropped && (
            <p role="alert" className="monitor-note text-destructive" data-tone="bad">
              {num(c.storageDropped)} decoded records could not be saved. Check free disk space and
              the server logs; totals are incomplete.
            </p>
          )}
          {!!c && c.templatesPending > 0 && (
            <p className="monitor-note" data-tone="warn">
              {num(c.templatesPending)} data sets are waiting for their template. v9 and IPFIX
              exporters send their field layout every few minutes, so these flows appear after the
              next refresh.
            </p>
          )}
          {c?.lastError && (
            <p className="monitor-note text-muted-foreground">
              Last collector error: <code className="font-mono">{c.lastError}</code>
            </p>
          )}

          <div className="flows-columns">
            <MonitorPanel
              title="Top talkers"
              description={`By ${dimLabel.toLowerCase()}, ${WINDOW_PHRASE[window]}, share of bytes`}
              className="flows-talkers"
              extra={
                <Segmented
                  label="Group by"
                  value={dimension}
                  onChange={setDimension}
                  options={DIMENSIONS.map((d) => ({ value: d.id, label: d.label }))}
                />
              }
              flush
            >
              <div ref={talkersRef}>
                {rows.length === 0 ? (
                  <MonitorEmpty compact title="No flows in this window">
                    Try a longer window, or check that an exporter is sending.
                  </MonitorEmpty>
                ) : (
                  rows.map((r, i) => (
                    <div key={r.key} className="monitor-row flows-talker-grid">
                      <span className="text-[12px] text-muted-foreground tabular-nums">
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="flows-mono block truncate text-foreground" title={r.key}>
                          {r.key}
                        </span>
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {num(r.flows)} flows · {compact(r.packets)} packets
                        </span>
                      </span>
                      <span className="monitor-bar">
                        <span style={{ width: `${(r.bytes / maxBytes) * 100}%` }} />
                      </span>
                      <span className="text-right text-fg-secondary tabular-nums">
                        {humanBytes(r.bytes)}
                      </span>
                      <span className="text-right text-[12px] text-muted-foreground tabular-nums">
                        {pct(r.share)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </MonitorPanel>

            <MonitorPanel
              title="Protocols"
              description="Share of bytes"
              className="flows-side"
              flush
            >
              <div className="flows-protocols">
                {protocols.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No traffic in this window.</p>
                ) : (
                  <>
                    <div className="flows-share" aria-hidden="true">
                      {protocols.map((p, i) => (
                        <span
                          key={p.protocol}
                          style={{
                            width: `${p.share * 100}%`,
                            background: (PROTOCOL_TONES[i] ?? PROTOCOL_REST).bar,
                          }}
                        />
                      ))}
                    </div>
                    <ul className="flows-legend">
                      {protocols.map((p, i) => (
                        <li key={p.protocol}>
                          <StatusDot tone={(PROTOCOL_TONES[i] ?? PROTOCOL_REST).dot} />
                          <span className="uppercase">{p.protocol}</span>
                          <span className="flex-1" />
                          <span className="text-fg-secondary tabular-nums">
                            {humanBytes(p.bytes)}
                          </span>
                          <span className="w-10 text-right text-muted-foreground tabular-nums">
                            {pct(p.share)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <header className="monitor-panel-head flows-subhead">
                <div className="min-w-0 flex-1">
                  <h2 className="monitor-panel-title">Exporters</h2>
                  <p className="monitor-panel-desc">Routers sending flow records</p>
                </div>
              </header>
              {exporterHealth.length ? (
                exporterHealth.map((e, i) => {
                  const tone: Tone = !running ? "default" : e.stale ? "warn" : "good";
                  return (
                    <div
                      key={`${e.exporter}/${e.version}/${e.domain}`}
                      className="monitor-row flows-exporter"
                    >
                      <span className="flows-exporter-name">
                        <StatusDot tone={tone} />
                        <span className="flows-mono truncate">{e.exporter}</span>
                      </span>
                      <span
                        className={
                          tone === "warn"
                            ? "text-[12px] font-[510] text-warning"
                            : "text-[12px] text-muted-foreground"
                        }
                      >
                        {!running ? "Stopped · " : e.stale ? "Silent over 5 min · " : ""}
                        {protocolName(e.version)} · {i === 0 ? "last packet " : ""}
                        {ago(e.lastSeen, now)}
                      </span>
                      <span className="flows-exporter-stats">
                        {[
                          `Domain ${e.domain}`,
                          `${compact(e.records)} records`,
                          e.version === 9
                            ? `${num(e.sequenceGaps)} sequence gaps`
                            : "gaps not measured",
                          ...(e.reordered ? [`${num(e.reordered)} reordered or reset`] : []),
                          ...(e.templateChanges
                            ? [`${num(e.templateChanges)} template changes`]
                            : []),
                          ...(e.pending ? [`${num(e.pending)} pending`] : []),
                          ...(e.errors ? [`${num(e.errors)} errors`] : []),
                        ].join(" · ")}
                      </span>
                    </div>
                  );
                })
              ) : Object.keys(c?.exporters ?? {}).length ? (
                Object.entries(c?.exporters ?? {}).map(([addr, packets]) => (
                  <div key={addr} className="monitor-row flows-exporter">
                    <span className="flows-exporter-name">
                      <StatusDot tone={running ? "good" : "default"} />
                      <span className="flows-mono truncate">{addr}</span>
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {num(packets)} packets
                    </span>
                  </div>
                ))
              ) : (
                <MonitorEmpty compact title="No exporters yet">
                  Point a router at this host with <code>add_traffic_flow_target</code>.
                </MonitorEmpty>
              )}
              {exporterHealth.length > 0 && (
                <p className="monitor-foot">
                  Silence does not prove an outage. Sequence gaps can include late packets; IPFIX
                  loss is not inferred.
                </p>
              )}
            </MonitorPanel>
          </div>

          <MonitorPanel
            title="Bytes over time"
            description={
              lineTotals && peak
                ? `Per ${interval(lineTotals.bucketMs)} · peak ${humanBytes(peak.bytes)} at ${hhmm(
                    peak.ts,
                  )}`
                : `${WINDOW_PHRASE[window][0].toUpperCase()}${WINDOW_PHRASE[window].slice(1)}`
            }
          >
            {lineTotals ? (
              <BytesChart data={lineTotals} drawKey={loadedKey} now={now} />
            ) : (
              <MonitorEmpty compact title="No traffic in this window" />
            )}
          </MonitorPanel>

          <MonitorPanel
            title="Busiest conversations"
            description="Source to destination pairs"
            flush
          >
            {talks.length === 0 ? (
              <MonitorEmpty compact title="Nothing recorded in this window" />
            ) : (
              <>
                <div className="monitor-thead flows-conv-grid">
                  <span>Source</span>
                  <span />
                  <span>Destination</span>
                  <span>Port</span>
                  <span className="text-right">Bytes</span>
                </div>
                {talks.map((t) => (
                  <div key={`${t.src}-${t.dst}`} className="monitor-row flows-conv-grid">
                    <span className="flows-mono truncate" title={t.src}>
                      {t.src}
                    </span>
                    <ArrowRight
                      className="flows-arrow text-muted-foreground"
                      strokeWidth={1.5}
                      aria-label="to"
                    />
                    <span className="flows-mono truncate" title={t.dst}>
                      {t.dst}
                    </span>
                    <span
                      className="flows-mono truncate text-muted-foreground"
                      title={t.applications.join(", ")}
                    >
                      {t.applications[0] ?? "—"}
                    </span>
                    <span className="text-right text-fg-secondary tabular-nums">
                      {humanBytes(t.bytes)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </MonitorPanel>
        </>
      )}
    </section>
  );
}
