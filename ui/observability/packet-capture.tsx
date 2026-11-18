/**
 * Packets view: live TZSP capture, decoded as it arrives. Layout follows the
 * approved Packets board: header with the capture state, four KPIs, protocol
 * mix and top talkers on the left, the decoded stream on the right.
 */
import "./monitoring.css";
import "./packets.css";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Download, Pause } from "lucide-react";
import { api, postJson, withToken } from "./api";
import { clock, num } from "./format";
import { LoadingState } from "./loading-state";
import {
  Donut,
  formatBytes,
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import type { ChartTone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type { CapturePayload } from "./types";

const EYEBROW = "Packets · live TZSP capture";

// Each protocol keeps one colour across the donut, the bars and the stream.
const PROTO: Record<string, { color: string; tone: ChartTone }> = {
  TCP: { color: "var(--sig)", tone: "good" },
  UDP: { color: "var(--brand)", tone: "brand" },
  ICMP: { color: "var(--warning)", tone: "warn" },
  ICMPv6: { color: "var(--warning)", tone: "warn" },
  ARP: { color: "var(--text-secondary)", tone: "muted" },
  IPv6: { color: "var(--destructive)", tone: "bad" },
};
const OTHER = { color: "var(--muted-foreground)", tone: "muted" as ChartTone };
const proto = (p: string | undefined) => (p && PROTO[p]) || OTHER;
const protoStyle = (p: string | undefined) => ({ "--proto": proto(p).color }) as CSSProperties;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
/** 14:06:21.412 — packets arrive faster than a second, so the stream shows milliseconds. */
const stamp = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

/** "9.4 MB" as 9.4 with the unit in <small>, the way the KPI cards write units. */
function sizeValue(n: number): ReactNode {
  const [value, unit] = formatBytes(n).split(" ");
  return (
    <>
      {value}
      <small>{unit}</small>
    </>
  );
}

/** Live packet capture: protocol mix, top talkers, the decoded stream, pcap export. */
export function PacketCapture(): ReactNode {
  const [data, setData] = useState<CapturePayload | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Packet totals from recent polls; their differences draw the KPI sparkline.
  const [totals, setTotals] = useState<number[]>([]);

  useEffect(() => {
    const load = (): void =>
      void api<CapturePayload>("/api/capture/packets?limit=150")
        .then((value) => {
          setData(value);
          setError(false);
          setTotals((old) => [...old, value.stats?.packets ?? 0].slice(-13));
        })
        .catch(() => setError(true));
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, []);

  const stats = data?.stats;
  const packets = data?.packets ?? [];
  const stop = async (): Promise<void> => {
    setBusy(true);
    const r = await postJson<{ ok?: boolean; error?: string }>("/api/capture/stop", {}).catch(
      () => null,
    );
    setBusy(false);
    if (r === null || r.ok === false || r.error) toast.error(r?.error ?? "Capture stop failed");
    else toast.success("Capture stopped");
  };

  if (!data && !error) return <LoadingState label="Loading packet capture" />;
  if (!data && error)
    return (
      <div className="pkt-page">
        <PageIntro eyebrow={EYEBROW} heading="Packet capture is unavailable." />
        <MonitorNote tone="bad" role="alert">
          The dashboard could not read the capture. Retrying automatically.
        </MonitorNote>
      </div>
    );
  if (!stats || (!stats.running && stats.packets === 0)) {
    return (
      <div className="pkt-page">
        <PageIntro eyebrow={EYEBROW} heading="No capture running." />
        <MonitorNote>
          Start one with the <code>start_packet_capture</code> tool and point the router’s TZSP
          stream at this host. Decoded packets stream in here live.
        </MonitorNote>
      </div>
    );
  }

  const protocols = Object.entries(stats.protocols).sort((a, b) => b[1] - a[1]);
  const maxProto = Math.max(1, ...protocols.map(([, n]) => n));
  const protoTotal = protocols.reduce((sum, [, n]) => sum + n, 0);
  const spark = totals.slice(1).map((n, i) => Math.max(0, n - totals[i]));
  const top = stats.topTalkers[0];
  const started = stats.startedAt != null ? clock(stats.startedAt) : null;

  return (
    <div className="pkt-page">
      <PageIntro
        eyebrow={EYEBROW}
        heading={
          <>
            {stats.running ? "Capturing on UDP " : "Capture stopped on UDP "}
            <span className="s">{stats.port}</span>.
          </>
        }
        tone={stats.running ? "good" : "default"}
        live={stats.running}
        status={
          <>
            <b>{stats.running ? "capturing" : "stopped"}</b>
            {started && (
              <>
                {" "}
                · started {started} by <span className="pkt-mono">start_packet_capture</span>
              </>
            )}
            {stats.running && " · stop it when done to free the router-side sniffer"}
          </>
        }
        actions={
          <>
            <a
              className="monitor-btn"
              data-variant="glass"
              data-size="md"
              href={withToken("/api/capture/pcap")}
              download="capture.pcap"
            >
              <Download aria-hidden="true" />
              Download pcap
            </a>
            <MonitorButton
              variant="danger"
              icon={<Pause aria-hidden="true" />}
              onClick={() => void stop()}
              disabled={busy || !stats.running}
            >
              Stop capture
            </MonitorButton>
          </>
        }
      />

      <MetricStrip label="Capture totals">
        <Metric
          label="Packets"
          value={<Ticker value={stats.packets} format={(n) => num(Math.round(n))} />}
          hint={started ? `since ${started}` : undefined}
          spark={spark.length > 1 ? spark : undefined}
        />
        <Metric label="Bytes" value={sizeValue(stats.bytes)} hint="captured so far" />
        <Metric
          label="pcap frames"
          value={<Ticker value={stats.pcapFrames} format={(n) => num(Math.round(n))} />}
          hint="ready to download"
        />
        <Metric
          label="Top talker"
          value={top ? <span className="font-mono text-[20px]">{top.addr}</span> : "—"}
          hint={top ? `${num(top.count)} packets` : undefined}
        />
      </MetricStrip>

      <div className="pkt-grid">
        <div className="pkt-side">
          <MonitorPanel title="Protocols">
            <div className="pkt-protocols">
              <Donut
                size={148}
                stroke={14}
                label="Packets by protocol"
                center={num(protoTotal)}
                sub="packets"
                parts={protocols.map(([p, n]) => ({ label: p, value: n, tone: proto(p).tone }))}
              />
              {protocols.map(([p, n]) => (
                <div key={p} className="pkt-bar-row" style={protoStyle(p)}>
                  <span className="pkt-mono" style={{ color: proto(p).color }}>
                    {p}
                  </span>
                  <span className="monitor-bar">
                    <span style={{ width: `${(n / maxProto) * 100}%` }} />
                  </span>
                  <span className="pkt-mono pkt-count">{num(n)}</span>
                </div>
              ))}
            </div>
          </MonitorPanel>
          <MonitorPanel title="Top talkers" description="Packets by address.">
            {stats.topTalkers.length === 0 ? (
              <p className="monitor-hint">No talkers yet.</p>
            ) : (
              stats.topTalkers.map((t) => (
                <div key={t.addr} className="pkt-talker">
                  <span className="pkt-mono">{t.addr}</span>
                  <span className="pkt-mono">{num(t.count)}</span>
                </div>
              ))
            )}
          </MonitorPanel>
        </div>

        <MonitorPanel
          title="Decoded packets"
          description="Headers decoded as they arrive."
          flush
          extra={
            <StatusBadge tone="brand" dot={false}>
              TZSP · /tool sniffer stream
            </StatusBadge>
          }
        >
          <div className="pkt-cols pkt-head" aria-hidden="true">
            <span>Time</span>
            <span>Proto</span>
            <span className="pkt-right">Len</span>
            <span>Summary</span>
          </div>
          {packets.length === 0 ? (
            <p className="pkt-waiting">Waiting for packets…</p>
          ) : (
            <div className="pkt-list">
              {packets.map((p, i) => (
                <div
                  key={`${p.ts}-${i}`}
                  className="pkt-cols pkt-line"
                  style={protoStyle(p.protocol)}
                >
                  <span>{stamp(p.ts)}</span>
                  <span>{p.protocol ?? p.ethType}</span>
                  <span className="pkt-right">{p.len}</span>
                  <span title={p.info}>{p.info}</span>
                </div>
              ))}
            </div>
          )}
          <div className="monitor-foot">
            <StatusDot tone={stats.running ? "good" : "default"} pulse={stats.running} />
            Newest first · last 150 packets · refreshes every 1.5 s
          </div>
        </MonitorPanel>
      </div>
    </div>
  );
}
