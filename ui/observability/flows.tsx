/**
 * Flows view: traffic analytics from collected NetFlow/IPFIX, after the
 * Mon-Flows board.
 *
 * The header answers "is the collector hearing my routers": the port, who is
 * sending and who went quiet, with a radar of the exporters. The collector
 * numbers sit in the same strip as the traffic numbers because an empty flow
 * page and an idle link look the same; templates pending is the number that
 * tells them apart.
 */
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, Radio, TriangleAlert } from "lucide-react";
import { api } from "./api";
import {
  Donut,
  Metric,
  MetricStrip,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { ChartTone, Tone } from "./monitoring-ui";
import { FlowLines, FlowRadar } from "./flows-graphics";
import type { RadarStatus } from "./flows-graphics";
import type { FlowConversation, FlowHealth, FlowTimelinePayload, FlowTopPayload } from "./types";
import "./flows.css";

const WINDOWS = ["5m", "15m", "1h", "6h", "24h"] as const;
type Window = (typeof WINDOWS)[number];

const DIMENSIONS = [
  { id: "source", label: "Source", plural: "sources" },
  { id: "destination", label: "Destination", plural: "destinations" },
  { id: "conversation", label: "Conversation", plural: "conversations" },
  { id: "application", label: "Application", plural: "applications" },
] as const;
type Dimension = (typeof DIMENSIONS)[number]["id"];

/** Protocol colours in share order; everything after the third is "Other". */
const PROTOCOL_TONES: ChartTone[] = ["good", "brand", "warn"];
const TONE_BG: Record<ChartTone, string> = {
  good: "bg-sig",
  brand: "bg-brand",
  warn: "bg-warning",
  bad: "bg-destructive",
  muted: "bg-faint",
};

/** "last hour" for the KPI hint and panel descriptions. */
const WINDOW_PHRASE: Record<Window, string> = {
  "5m": "last 5 minutes",
  "15m": "last 15 minutes",
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
};

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** The unit a byte count reads best in, and its divisor. */
function byteUnit(n: number): { unit: string; div: number } {
  let unit = 0;
  while (n >= 1024 ** (unit + 1) && unit < BYTE_UNITS.length - 1) unit++;
  return { unit: BYTE_UNITS[unit], div: 1024 ** unit };
}
function byteNumber(value: number, div: number): string {
  const v = value / div;
  return v >= 100 || div === 1 ? String(Math.round(v)) : v.toFixed(1);
}
function humanBytes(n: number): string {
  const { unit, div } = byteUnit(n);
  return `${byteNumber(n, div)} ${unit}`;
}

const compactFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
// The boards write thousands as "96.2k"; millions stay "21.7M".
const compact = (n: number): string => compactFormat.format(Math.round(n)).replace(/K$/, "k");
/** "1.2M" as ["1.2", "M"] so the suffix can sit in a <small>. */
function compactParts(n: number): [string, string] {
  const m = /^([\d.,-]+)(\D*)$/.exec(compact(n));
  return m ? [m[1], m[2]] : [compact(n), ""];
}
const num = (n: number): string => Math.round(n).toLocaleString();
const pct = (share: number): string => `${Math.round(share * 100)}%`;
const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function since(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`;
}
const ago = (ts: number, now: number): string => `${since(ts, now)} ago`;

/** "7 minutes" for the header sentence. */
function spoken(ts: number, now: number): string {
  const unit = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return unit(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.round(m / 60);
  return h < 24 ? unit(h, "hour") : unit(Math.round(h / 24), "day");
}

function interval(ms: number): string {
  const unit = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
  if (ms >= 3_600_000) return unit(+(ms / 3_600_000).toFixed(1), "hour");
  if (ms >= 60_000) return unit(+(ms / 60_000).toFixed(1), "minute");
  return unit(Math.round(ms / 1000), "second");
}

const protocolName = (version: number): string =>
  version === 10 ? "IPFIX" : `NetFlow v${version}`;

/** "a", "a and b", "a, b and c", each name in mono. */
function nameList(names: string[]): ReactNode {
  return names.map((name, i) => (
    <span key={name}>
      {i > 0 && (i === names.length - 1 ? " and " : ", ")}
      <span className="flows-mono">{name}</span>
    </span>
  ));
}

/** A KPI number that eases to new values, with its unit in a <small>. */
function BytesValue({ value }: { value: number }): ReactNode {
  const { unit, div } = byteUnit(value);
  return (
    <>
      <Ticker value={value} format={(n) => byteNumber(n, div)} />
      <small>{unit}</small>
    </>
  );
}
function CompactValue({ value }: { value: number }): ReactNode {
  const suffix = compactParts(value)[1];
  return (
    <>
      <Ticker value={value} format={(n) => compactParts(n)[0]} />
      {suffix && <small>{suffix}</small>}
    </>
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
  // One entry per exporter name: sending if any of its streams is fresh.
  const exporters: { name: string; stale: boolean; lastSeen: number }[] = exporterHealth.length
    ? [...new Set(exporterHealth.map((e) => e.exporter))].map((name) => {
        const streams = exporterHealth.filter((e) => e.exporter === name);
        return {
          name,
          stale: streams.every((e) => e.stale),
          lastSeen: Math.max(...streams.map((e) => e.lastSeen)),
        };
      })
    : Object.keys(c?.exporters ?? {}).map((name) => ({ name, stale: false, lastSeen: 0 }));
  const sending = exporters.filter((e) => !e.stale);
  const silent = exporters.filter((e) => e.stale);
  const dim = DIMENSIONS.find((d) => d.id === dimension) ?? DIMENSIONS[0];
  const rows = top?.top ?? [];
  const maxBytes = Math.max(...rows.map((r) => r.bytes), 1);
  const rawProtocols = top?.protocols ?? [];
  // The board shows three protocols and folds the rest into "Other".
  const protocols =
    rawProtocols.length > 4
      ? [
          ...rawProtocols.slice(0, 3),
          {
            protocol: "Other",
            bytes: rawProtocols.slice(3).reduce((n, p) => n + p.bytes, 0),
            share: rawProtocols.slice(3).reduce((n, p) => n + p.share, 0),
          },
        ]
      : rawProtocols;
  const toneOf = (i: number, name: string): ChartTone =>
    name === "Other" ? "muted" : (PROTOCOL_TONES[i] ?? "muted");
  const timeline = line?.buckets.length ? line : null;
  const bucketTotals =
    timeline?.buckets.map((b) => ({
      ts: b.ts,
      bytes: [...timeline.keys, "other"].reduce((n, k) => n + (b.series[k] ?? 0), 0),
    })) ?? [];
  const peak = bucketTotals.length
    ? bucketTotals.reduce((a, b) => (b.bytes > a.bytes ? b : a))
    : undefined;
  const hasTraffic = !!totals && totals.flows > 0;
  const trafficUnit = byteUnit(totals?.bytes ?? 0);

  // Bytes over time: the top two keys stacked, the first one on top.
  const lineKeys = timeline?.keys.slice(0, 2) ?? [];
  const series = !timeline
    ? []
    : lineKeys.length === 2
      ? [
          timeline.buckets.map((b) => (b.series[lineKeys[0]] ?? 0) + (b.series[lineKeys[1]] ?? 0)),
          timeline.buckets.map((b) => b.series[lineKeys[1]] ?? 0),
        ]
      : lineKeys.length === 1
        ? [timeline.buckets.map((b) => b.series[lineKeys[0]] ?? 0)]
        : [bucketTotals.map((t) => t.bytes)];
  const axis = timeline
    ? Array.from({ length: 7 }, (_, i) => {
        const ts = timeline.window.from + ((timeline.window.to - timeline.window.from) * i) / 6;
        return i === 6 && now - timeline.window.to < 60_000 ? "now" : hhmm(ts);
      })
    : [];

  const windowControl = (
    <>
      <Segmented
        label="Time window"
        value={window}
        onChange={setWindow}
        options={WINDOWS.map((w) => ({ value: w, label: w }))}
      />
      <span className="text-[12px] text-muted-foreground">
        Add a router with{" "}
        <span className="flows-mono text-fg-secondary">add_traffic_flow_target</span>
      </span>
    </>
  );

  const verdict = running ? (
    <>
      Listening on UDP {c?.port}.{" "}
      {sending.length ? (
        <>
          <span className="s">
            {sending.length === 1 ? "1 exporter" : `${sending.length} exporters`}
          </span>{" "}
          sending.
        </>
      ) : (
        "No exporters sending."
      )}
    </>
  ) : health ? (
    "Collector stopped."
  ) : (
    "Collector status unknown."
  );

  const lead = !health ? (
    "Could not read the collector."
  ) : !running ? (
    "Nothing new is being collected."
  ) : !exporters.length ? (
    "No exporters yet. Point a router at this host with add_traffic_flow_target."
  ) : (
    <>
      {sending.length > 0 && (
        <>
          {nameList(sending.map((e) => e.name))} {sending.length === 1 ? "sends" : "send"} flow
          records to this host.
        </>
      )}
      {silent.map((e) => (
        <span key={e.name}>
          {" "}
          <span className="flows-mono">{e.name}</span> has been silent for {spoken(e.lastSeen, now)}
          .
        </span>
      ))}
    </>
  );

  const radarStatus = (stale: boolean): RadarStatus => (!running ? "faint" : stale ? "warn" : "ok");

  return (
    <section className="flows-page">
      <PageIntro
        eyebrow="Flow collector · NetFlow v9 and IPFIX"
        verdict={verdict}
        lead={lead}
        actions={windowControl}
        aside={
          health ? (
            <div className="glass flows-radar-box">
              <FlowRadar
                hub={String(c?.port ?? "")}
                nodes={exporters.map((e) => ({ label: e.name, status: radarStatus(e.stale) }))}
              />
            </div>
          ) : undefined
        }
      />

      {error && (
        <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
          {error}
        </MonitorNote>
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
          <MetricStrip label="Flow metrics" minCell={120}>
            <Metric
              label="Traffic"
              value={totals ? <BytesValue value={totals.bytes} /> : "—"}
              hint={`in the ${WINDOW_PHRASE[window]}`}
            />
            <Metric
              label="Flows"
              value={totals ? <CompactValue value={totals.flows} /> : "—"}
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
              value={c ? <CompactValue value={c.packets} /> : "—"}
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
              value={
                health?.store ? (
                  <>
                    {compactParts(health.store.rawRows)[0]}
                    {compactParts(health.store.rawRows)[1] && (
                      <small>{compactParts(health.store.rawRows)[1]}</small>
                    )}
                  </>
                ) : (
                  "—"
                )
              }
              hint={health?.store ? `${compact(health.store.rollupRows)} rollups` : "no store"}
            />
          </MetricStrip>

          {!!c?.storageDropped && (
            <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
              {num(c.storageDropped)} decoded records could not be saved. Check free disk space and
              the server logs; totals are incomplete.
            </MonitorNote>
          )}
          {!!c && c.templatesPending > 0 && (
            <MonitorNote tone="warn" icon={<Clock aria-hidden="true" />}>
              {c.templatesPending === 1
                ? "1 data set is waiting for its template."
                : `${num(c.templatesPending)} data sets are waiting for their template.`}{" "}
              v9 and IPFIX exporters send their field layout every few minutes, so these flows
              appear after the next refresh.
            </MonitorNote>
          )}
          {c?.lastError && (
            <MonitorNote>
              Last collector error: <code className="font-mono">{c.lastError}</code>
            </MonitorNote>
          )}

          <MonitorPanel
            title="Bytes over time"
            description={
              timeline && peak
                ? `${
                    lineKeys.length
                      ? `Top ${dim.plural} stacked, one point per`
                      : "All traffic, one point per"
                  } ${interval(timeline.bucketMs)}. Peak ${humanBytes(peak.bytes)} at ${hhmm(
                    peak.ts,
                  )}.`
                : `${WINDOW_PHRASE[window][0].toUpperCase()}${WINDOW_PHRASE[window].slice(1)}`
            }
            extra={
              lineKeys.length > 0 && (
                <span className="monitor-legend">
                  {lineKeys.map((k, i) => (
                    <span key={k}>
                      <i className={i === 0 ? "bg-sig" : "bg-brand"} />
                      <span className="flows-mono">{k}</span>
                    </span>
                  ))}
                </span>
              )
            }
          >
            {timeline ? (
              <FlowLines
                series={series}
                labels={axis}
                hits={bucketTotals.map((t) => `${hhmm(t.ts)} · ${humanBytes(t.bytes)}`)}
                drawKey={loadedKey}
                label={`Bytes per ${interval(timeline.bucketMs)}${
                  peak ? `, peaking at ${humanBytes(peak.bytes)} at ${hhmm(peak.ts)}` : ""
                }`}
              />
            ) : (
              <MonitorEmpty compact title="No traffic in this window" />
            )}
          </MonitorPanel>

          <div className="flows-columns">
            <MonitorPanel
              title="Top talkers"
              description={`By ${dim.label.toLowerCase()}, in the ${WINDOW_PHRASE[window]}, share of bytes`}
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
                  <>
                    <div className="monitor-thead flows-talker-grid">
                      <span>{dim.label}</span>
                      <span>Share of bytes</span>
                      <span>Bytes</span>
                      <span>Share</span>
                    </div>
                    {rows.map((r) => (
                      <div key={r.key} className="monitor-row flows-talker-grid">
                        <span
                          className="p flows-mono truncate"
                          title={`${r.key} · ${num(r.flows)} flows · ${compact(r.packets)} packets`}
                        >
                          {r.key}
                        </span>
                        <span className="monitor-bar flows-bar">
                          <span
                            data-tone="good"
                            style={{ width: `${(r.bytes / maxBytes) * 100}%` }}
                          />
                        </span>
                        <span className="truncate tabular-nums">{humanBytes(r.bytes)}</span>
                        <span className="truncate text-muted-foreground tabular-nums">
                          {pct(r.share)}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </MonitorPanel>

            <div className="flows-side">
              <MonitorPanel title="Protocols" description="Share of bytes">
                {protocols.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No traffic in this window.</p>
                ) : (
                  <div className="flows-protocols">
                    <Donut
                      size={132}
                      stroke={14}
                      label="Share of bytes by protocol"
                      center={byteNumber(totals?.bytes ?? 0, trafficUnit.div)}
                      sub={trafficUnit.unit}
                      parts={protocols.map((p, i) => ({
                        value: p.bytes,
                        tone: toneOf(i, p.protocol),
                        label: p.protocol,
                      }))}
                    />
                    <ul className="flows-legend">
                      {protocols.map((p, i) => (
                        <li key={p.protocol} title={humanBytes(p.bytes)}>
                          <i className={TONE_BG[toneOf(i, p.protocol)]} />
                          <span className="text-fg-secondary">
                            {p.protocol === "Other" ? p.protocol : p.protocol.toUpperCase()}
                          </span>
                          <span className="flex-1" />
                          <span className="text-fg-secondary tabular-nums">{pct(p.share)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </MonitorPanel>

              <MonitorPanel title="Exporters" description="Routers sending flow records" flush>
                {exporterHealth.length || Object.keys(c?.exporters ?? {}).length ? (
                  <div className="monitor-thead flows-exporter-grid">
                    <span>Router</span>
                    <span>Status</span>
                  </div>
                ) : null}
                {exporterHealth.length ? (
                  exporterHealth.map((e, i) => {
                    const tone: Tone = !running ? "default" : e.stale ? "warn" : "good";
                    return (
                      <div
                        key={`${e.exporter}/${e.version}/${e.domain}`}
                        className="monitor-row flows-exporter-grid"
                      >
                        <span className="flows-exporter-name">
                          <StatusDot tone={tone} />
                          <span className="p flows-mono truncate">{e.exporter}</span>
                        </span>
                        <span className="flows-exporter-status">
                          <span
                            className={
                              tone === "warn"
                                ? "truncate text-warning"
                                : "truncate text-fg-secondary"
                            }
                          >
                            {!running ? "Stopped · " : e.stale ? "Silent over 5 min · " : ""}
                            {protocolName(e.version)} · {i === 0 ? "last packet " : ""}
                            {ago(e.lastSeen, now)}
                          </span>
                          <span className="truncate text-muted-foreground">
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
                        </span>
                      </div>
                    );
                  })
                ) : Object.keys(c?.exporters ?? {}).length ? (
                  Object.entries(c?.exporters ?? {}).map(([addr, packets]) => (
                    <div key={addr} className="monitor-row flows-exporter-grid">
                      <span className="flows-exporter-name">
                        <StatusDot tone={running ? "good" : "default"} />
                        <span className="p flows-mono truncate">{addr}</span>
                      </span>
                      <span className="flows-exporter-status">
                        <span className="truncate text-fg-secondary">{num(packets)} packets</span>
                      </span>
                    </div>
                  ))
                ) : (
                  <MonitorEmpty compact title="No exporters yet">
                    Point a router at this host with <code>add_traffic_flow_target</code>.
                  </MonitorEmpty>
                )}
              </MonitorPanel>
            </div>
          </div>

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
                  <span>Bytes</span>
                </div>
                {talks.map((t) => (
                  <div key={`${t.src}-${t.dst}`} className="monitor-row flows-conv-grid">
                    <span className="p flows-mono truncate" title={t.src}>
                      {t.src}
                    </span>
                    <span className="truncate text-success">
                      <ChevronRight className="flows-arrow" strokeWidth={1.6} aria-label="to" />
                    </span>
                    <span className="flows-mono truncate" title={t.dst}>
                      {t.dst}
                    </span>
                    <span
                      className="flows-mono truncate text-muted-foreground"
                      title={t.applications.join(", ")}
                    >
                      {t.applications[0] ?? "—"}
                    </span>
                    <span className="truncate tabular-nums">{humanBytes(t.bytes)}</span>
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
