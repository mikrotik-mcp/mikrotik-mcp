import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { ThroughputChart } from "./bandwidth-chart";
import type { ThroughputPoint } from "./bandwidth-chart";
import { MonitorPanel, Segmented, formatBytes } from "./monitoring-ui";

export interface Peer {
  id: string;
  user: string;
  interface: string;
  address: string;
  expires: string | null;
  expired: boolean;
  disabled: boolean;
  managed: boolean;
  lastHandshake: string | null;
  handshakeAt: number | null;
  rx: number | null;
  tx: number | null;
}
export interface TrafficSample {
  observedAt: number;
  peers: Peer[];
}
export const trafficBytes = (v: number | null) => (v === null ? "—" : formatBytes(v));

// Only compare identical sets of peers across consecutive observations. Joining or
// resetting a counter must not appear as a burst or a negative transfer rate.
export function ratePoint(previous: TrafficSample, next: TrafficSample): ThroughputPoint {
  const seconds = (next.observedAt - previous.observedAt) / 1000;
  const before = new Map(previous.peers.map((p) => [p.id, p]));
  const rate = (key: "rx" | "tx") => {
    if (seconds <= 0 || seconds > 45 || before.size !== next.peers.length || !next.peers.length)
      return null;
    let bytes = 0;
    for (const p of next.peers) {
      const old = before.get(p.id)?.[key],
        value = p[key];
      if (old == null || value == null || value < old) return null;
      bytes += value - old;
    }
    return (bytes * 8) / seconds / 1_000_000;
  };
  return { at: next.observedAt, rx: rate("rx"), tx: rate("tx"), failed: false };
}

export function WireguardTraffic({ peers, points }: { peers: Peer[]; points: ThroughputPoint[] }) {
  const [mode, setMode] = useState<"peers" | "live">("peers");
  const sum = (key: "tx" | "rx") =>
    peers.some((p) => p[key] == null) ? null : peers.reduce((n, p) => n + p[key]!, 0);
  const rx = sum("rx"),
    tx = sum("tx"),
    total = rx === null || tx === null ? null : rx + tx;
  const ranked = peers
    .flatMap((p) => (p.rx === null || p.tx === null ? [] : [{ ...p, size: p.rx + p.tx }]))
    .sort((a, b) => b.size - a.size)
    .slice(0, 4);
  const peak = ranked[0]?.size || 1;
  return (
    <div className="wgu-analytics">
      <section className="wgu-total">
        <h2>Data transferred</h2>
        <strong>{trafficBytes(total)}</strong>
        <div className="wgu-split" aria-hidden="true">
          {total != null && total > 0 && (
            <>
              <i style={{ width: `${(rx! / total) * 100}%` }} />
              <i style={{ width: `${(tx! / total) * 100}%` }} />
            </>
          )}
        </div>
        <div className="wgu-direction">
          <span>
            <ArrowDownLeft /> Received <b>{trafficBytes(rx)}</b>
          </span>
          <span>
            <ArrowUpRight /> Sent <b>{trafficBytes(tx)}</b>
          </span>
        </div>
        <small>Router counters since their last reset</small>
      </section>
      <MonitorPanel
        title={mode === "peers" ? "Traffic by peer" : "Live throughput"}
        extra={
          <Segmented
            label="Traffic chart"
            value={mode}
            onChange={setMode}
            options={[
              { value: "peers", label: "Top peers" },
              { value: "live", label: "Live rate" },
            ]}
          />
        }
      >
        {mode === "peers" ? (
          ranked.length ? (
            <ol className="wgu-rank">
              {ranked.map((p) => (
                <li key={p.id}>
                  <span>{p.user}</span>
                  <b>{formatBytes(p.size)}</b>
                  <div aria-hidden="true">
                    <i style={{ width: `${(p.rx! / peak) * 100}%` }} />
                    <i style={{ width: `${(p.tx! / peak) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="wgu-muted">No peer counters available.</p>
          )
        ) : points.some((p) => p.rx !== null || p.tx !== null) ? (
          <ThroughputChart
            points={points}
            from={points[0].at}
            to={points.at(-1)!.at}
            labels={[points[0], points.at(-1)!].map((p) => new Date(p.at).toLocaleTimeString())}
            drawKey="wireguard"
            sampleLabel="Sample"
          />
        ) : (
          <p className="wgu-muted">
            Collecting live rates from consecutive counter readings, every 15 seconds while this
            page is open.
          </p>
        )}
      </MonitorPanel>
    </div>
  );
}
