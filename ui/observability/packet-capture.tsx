import { LoadingState } from "./loading-state";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Download, Square } from "lucide-react";
import { api, postJson, withToken } from "./api";
import { bytes, clock, num } from "./format";
import { Button, Dot } from "./geist";
import { toast } from "./toast-action";
import type { CapturePayload } from "./types";

// ── Packet Capture Studio ────────────────────────────────────────────────────
// Protocol categories get distinct data-series colours from the chart palette.
const PROTO_COLOR: Record<string, string> = {
  TCP: "var(--chart-1)",
  UDP: "var(--chart-2)",
  ICMP: "var(--chart-3)",
  ICMPv6: "var(--chart-3)",
  ARP: "var(--chart-4)",
  IPv6: "var(--chart-5)",
};
const protoColor = (p: string | undefined): string =>
  (p && PROTO_COLOR[p]) || "var(--muted-foreground)";

/** Live packet capture: protocol mix, top talkers, a scrolling packet list, pcap export. */
export function PacketCapture(): ReactNode {
  const [data, setData] = useState<CapturePayload | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = (): void =>
      void api<CapturePayload>("/api/capture/packets?limit=150")
        .then((value) => {
          setData(value);
          setError(false);
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
    return <p role="alert">Packet capture is unavailable. Retrying automatically.</p>;
  if (!stats || (!stats.running && stats.packets === 0)) {
    return (
      <div className="text-muted-foreground text-[13px] leading-relaxed">
        No capture running. Start one with the{" "}
        <code className="text-brand font-mono">start_packet_capture</code> tool — point the device's
        TZSP stream at this host — and decoded packets stream in here live.
      </div>
    );
  }

  const maxProto = Math.max(1, ...Object.values(stats.protocols));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Dot
          color={stats.running ? "var(--success)" : "var(--muted-foreground)"}
          pulse={stats.running}
        />
        <b>{stats.running ? "capturing" : "stopped"}</b>
        <span className="text-muted-foreground text-[11px]">UDP {stats.port}</span>
        <span className="text-muted-foreground text-[11px]">
          {num(stats.packets)} pkts · {bytes(stats.bytes)}
        </span>
        <span className="flex-1" />
        <a
          className="bg-card hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs whitespace-nowrap"
          href={withToken("/api/capture/pcap")}
          download="capture.pcap"
        >
          <Download className="size-3.5" /> pcap
        </a>
        <Button
          type="error"
          ghost
          size="sm"
          icon={<Square className="size-3.5" />}
          onClick={() => void stop()}
          disabled={busy || !stats.running}
        >
          Stop
        </Button>
      </div>
      <div className="grid grid-cols-[220px_1fr] gap-3 max-[720px]:grid-cols-1">
        <div className="flex flex-col gap-[5px]">
          <div className="text-muted-foreground text-[11px] tracking-[0.05em] uppercase">
            Protocols
          </div>
          {Object.entries(stats.protocols).map(([p, n]) => (
            <div
              className="grid grid-cols-[52px_1fr_34px] items-center gap-1.5 font-mono text-[11px]"
              key={p}
            >
              <span style={{ color: protoColor(p) }}>{p}</span>
              <span className="bg-muted h-2 overflow-hidden rounded-full">
                <i
                  className="block h-full rounded-full"
                  style={{ width: `${(n / maxProto) * 100}%`, background: protoColor(p) }}
                />
              </span>
              <span className="text-muted-foreground text-right">{n}</span>
            </div>
          ))}
          <div className="text-muted-foreground mt-3 text-[11px] tracking-[0.05em] uppercase">
            Top talkers
          </div>
          {stats.topTalkers.length === 0 && (
            <div className="text-muted-foreground text-[11px]">—</div>
          )}
          {stats.topTalkers.map((t) => (
            <div
              className="text-muted-foreground flex justify-between font-mono text-[11px] [&>b]:text-foreground"
              key={t.addr}
            >
              <span>{t.addr}</span>
              <b>{t.count}</b>
            </div>
          ))}
        </div>
        <div className="bg-background h-[360px] overflow-y-auto rounded-md border font-mono text-[11px]/[1.6]">
          {packets.length === 0 ? (
            <div className="text-muted-foreground p-2.5 text-[11px]">waiting for packets…</div>
          ) : (
            packets.map((p, i) => (
              <div
                className="grid grid-cols-[90px_64px_48px_1fr] gap-2 overflow-hidden px-2.5 py-px whitespace-nowrap odd:bg-card/40"
                key={i}
              >
                <span className="text-muted-foreground">{clock(p.ts)}</span>
                <span className="font-semibold" style={{ color: protoColor(p.protocol) }}>
                  {p.protocol ?? p.ethType}
                </span>
                <span className="text-muted-foreground text-right">{p.len}</span>
                <span className="text-foreground overflow-hidden text-ellipsis">{p.info}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
