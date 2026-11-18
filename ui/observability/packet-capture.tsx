/**
 * Packets view: live TZSP capture, decoded as it arrives. Layout follows the
 * approved Packets board: header with the capture state, four KPIs, protocol
 * mix and top talkers on the left, the decoded stream on the right.
 */
import "./monitoring.css";
import "./packets.css";
import { useEffect, useRef, useState } from "react";
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
import { DetailList, RowDrawer, RowMenu, RowMore, arrive, tipProps } from "./kit";
import { toast } from "./toast-action";
import type { CapturePayload, PacketSummary } from "./types";

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

/** One packet's identity across polls: the list keeps the newest 150, so indexes shift. */
const packetKey = (p: PacketSummary): string =>
  `${p.ts}|${p.len}|${p.src ?? ""}|${p.dst ?? ""}|${p.info}`;

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
  const [opened, setOpened] = useState<PacketSummary | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

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

  // Rows that arrived since the last poll slide in; the first load does not.
  useEffect(() => {
    const keys = (data?.packets ?? []).map(packetKey);
    const before = seen.current;
    seen.current = new Set(keys);
    if (!before || !list.current) return;
    for (const row of list.current.querySelectorAll<HTMLElement>("[data-pk]"))
      if (!before.has(row.dataset.pk!)) arrive(row);
  }, [data]);
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
            <div className="pkt-protocols kit-tips">
              <Donut
                size={148}
                stroke={14}
                label="Packets by protocol"
                center={num(protoTotal)}
                sub="packets"
                noun="packets"
                parts={protocols.map(([p, n]) => ({ label: p, value: n, tone: proto(p).tone }))}
              />
              {protocols.map(([p, n]) => (
                <div
                  key={p}
                  className="pkt-bar-row"
                  style={protoStyle(p)}
                  {...tipProps(() => ({
                    title: p,
                    rows: [
                      {
                        label: "Packets",
                        value: `${num(n)} of ${num(protoTotal)}`,
                        color: proto(p).color,
                      },
                      {
                        label: "Share",
                        value: `${Math.round((n / Math.max(1, protoTotal)) * 100)}%`,
                      },
                    ],
                  }))}
                >
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
            <span />
          </div>
          {packets.length === 0 ? (
            <p className="pkt-waiting">Waiting for packets…</p>
          ) : (
            <div ref={list} className="pkt-list">
              {packets.map((p, i) => {
                const name = p.protocol ?? p.ethType;
                const open = (): void => setOpened(p);
                return (
                  <RowMenu
                    key={`${p.ts}-${i}`}
                    title={`${name} · ${p.len} bytes`}
                    sub={stamp(p.ts)}
                    onOpen={open}
                    cells={{
                      time: { value: stamp(p.ts), kind: "time" },
                      proto: { value: name },
                      len: { value: String(p.len) },
                      info: { value: p.info },
                    }}
                    copies={[
                      ...(p.src ? [{ label: "Source", value: p.src }] : []),
                      ...(p.dst ? [{ label: "Destination", value: p.dst }] : []),
                      { label: "Summary", value: p.info, hint: "" },
                    ]}
                    row={p}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${name}, ${p.len} bytes, ${stamp(p.ts)}`}
                      data-pk={packetKey(p)}
                      data-selected={(opened && packetKey(opened) === packetKey(p)) || undefined}
                      className="pkt-cols pkt-line"
                      style={protoStyle(p.protocol)}
                      onClick={open}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") {
                          ev.preventDefault();
                          open();
                        }
                      }}
                    >
                      <span data-col="time">{stamp(p.ts)}</span>
                      <span data-col="proto">{name}</span>
                      <span data-col="len" className="pkt-right">
                        {p.len}
                      </span>
                      <span data-col="info">{p.info}</span>
                      <RowMore />
                    </div>
                  </RowMenu>
                );
              })}
            </div>
          )}
          <div className="monitor-foot">
            <StatusDot tone={stats.running ? "good" : "default"} pulse={stats.running} />
            Newest first · last 150 packets · refreshes every 1.5 s
          </div>
        </MonitorPanel>
      </div>
      {opened && (
        <PacketDrawer
          packet={opened}
          packets={packets}
          onPick={setOpened}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}

/** One decoded packet. The list keeps moving, so the drawer holds the packet it opened. */
function PacketDrawer({
  packet: p,
  packets,
  onPick,
  onClose,
}: {
  packet: PacketSummary;
  packets: PacketSummary[];
  onPick: (p: PacketSummary) => void;
  onClose: () => void;
}): ReactNode {
  const key = packetKey(p);
  const index = packets.findIndex((x) => packetKey(x) === key);
  const name = p.protocol ?? p.ethType;
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Packet details: ${name}`}
      storageKey="packets"
      rowKey={key}
      nav={
        index >= 0
          ? {
              index,
              total: packets.length,
              onPrev: index > 0 ? () => onPick(packets[index - 1]!) : undefined,
              onNext: index < packets.length - 1 ? () => onPick(packets[index + 1]!) : undefined,
            }
          : undefined
      }
      title={p.info}
      meta={`${stamp(p.ts)} · ${name} · ${p.len} bytes`}
    >
      <DetailList
        items={[
          { label: "Time", value: stamp(p.ts), mono: true },
          {
            label: "Protocol",
            value: <span style={{ color: proto(p.protocol).color }}>{name}</span>,
            mono: true,
          },
          { label: "EtherType", value: p.ethType, mono: true },
          ...(p.src ? [{ label: "Source", value: p.src, mono: true }] : []),
          ...(p.dst ? [{ label: "Destination", value: p.dst, mono: true }] : []),
          { label: "Length", value: `${p.len} bytes`, mono: true },
          { label: "Summary", value: p.info, mono: true },
        ]}
      />
      {index < 0 && (
        <MonitorNote>This packet is no longer in the last 150 the page keeps.</MonitorNote>
      )}
    </RowDrawer>
  );
}
