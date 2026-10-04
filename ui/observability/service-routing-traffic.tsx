import { useEffect, useState } from "react";
import { Activity, RefreshCw, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "./api";
import type { RoutingPolicy } from "../../src/service-routing/model";
import { routingRate } from "../../src/service-routing/traffic-model";
import type { RoutingRate, RoutingTraffic } from "../../src/service-routing/traffic-model";
import "./service-routing-domain.css";

export function formatRoutingBytes(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const n = Number(value);
  if (n < 1024) return `${n} B`;
  const index = Math.min(6, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** index).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"][index]}`;
}
function formatRate(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} Mbps`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kbps`;
  return `${Math.round(value)} bps`;
}
/** The keyed parent resets baselines on router, policy, state or applied-route changes. */
export function RoutingTrafficPanel({
  policy,
  paused = false,
}: {
  policy: RoutingPolicy;
  paused?: boolean;
}) {
  const [sample, setSample] = useState<RoutingTraffic>();
  const [points, setPoints] = useState<RoutingRate[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (policy.state !== "active" || paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let previous: RoutingTraffic | undefined;
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        previous = undefined;
        timer = setTimeout(() => void poll(), 5000);
        return;
      }
      let next: RoutingTraffic;
      try {
        next = await api<RoutingTraffic>(
          `/api/service-routing/traffic?device=${encodeURIComponent(policy.device)}&id=${encodeURIComponent(policy.id)}`,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        );
        if (next.policyId !== policy.id || next.device !== policy.device)
          throw new Error("Counter scope mismatch");
      } catch {
        next = {
          policyId: policy.id,
          device: policy.device,
          at: Date.now(),
          state: "unavailable",
          detail:
            "Counters are temporarily unavailable. Check device connectivity; retrying automatically.",
        };
      }
      if (controller.signal.aborted) return;
      if (!previous || next.at > previous.at) {
        const point = routingRate(previous, next);
        setSample(next);
        setPoints((old) =>
          [...old.filter((p) => p.at < next.at && next.at - p.at <= 300_000), point].slice(-61),
        );
        previous = next;
      }
      timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [policy.id, policy.device, policy.state, paused, retry]);
  const ready = sample?.state === "ready" && !paused;
  const rates = points.filter((p) => p.bps !== null);
  const end = points.at(-1)?.at ?? 0;
  const peak = Math.max(0, ...rates.map((p) => p.bps!));
  const path = points
    .map((p, index) => {
      if (p.bps === null) return "";
      return `${index > 0 && points[index - 1].bps !== null ? "L" : "M"}${(((p.at - end + 300_000) / 300_000) * 600).toFixed(1)},${(104 - (p.bps / Math.max(1, peak)) * 96).toFixed(1)}`;
    })
    .join(" ");
  return (
    <section className="route-traffic ops-panel" aria-label="Policy traffic">
      <header className="route-traffic__header">
        <div>
          <span className="route-traffic__eyebrow">
            <Activity size={15} /> RULE COUNTERS
          </span>
          <h3>Traffic matched by this route</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={paused || policy.state !== "active"}
          onClick={() => setRetry((r) => r + 1)}
        >
          <RefreshCw size={14} />
          Refresh counters
        </Button>
      </header>
      <p className="ops-meta">
        <ArrowUpRight size={14} className="inline" /> Client → service ·{" "}
        {policy.family.toUpperCase()} · {policy.activeTable ?? policy.primary}
      </p>
      <dl className="route-traffic__metrics">
        <div>
          <dt>Matched bytes</dt>
          <dd title={ready ? sample.bytes : undefined}>
            {ready ? formatRoutingBytes(sample.bytes) : "—"}
          </dd>
        </div>
        <div>
          <dt>Matched packets</dt>
          <dd>{ready && sample.packets ? BigInt(sample.packets).toLocaleString() : "—"}</dd>
        </div>
        <div>
          <dt>Current rate</dt>
          <dd>{ready ? formatRate(points.at(-1)?.bps) : "—"}</dd>
        </div>
      </dl>
      <div className="route-traffic__chart">
        <svg
          viewBox="0 0 600 112"
          preserveAspectRatio="none"
          role="img"
          aria-label="Matched client-to-service bitrate, last five minutes"
        >
          {[8, 56, 104].map((y) => (
            <path key={y} d={`M0 ${y}H600`} className="route-traffic__grid" />
          ))}
          <path d={path} className="route-traffic__line" />
          {points
            .filter((p, index) => p.bps !== null && (index === 0 || points[index - 1].bps === null))
            .map((p) => (
              <circle
                key={p.at}
                cx={((p.at - end + 300_000) / 300_000) * 600}
                cy={104 - (p.bps! / Math.max(1, peak)) * 96}
                r={2}
                fill="var(--primary)"
              />
            ))}
        </svg>
        {!rates.length && (
          <span>
            {policy.state !== "active"
              ? "Counters start after a verified apply"
              : sample?.state === "unavailable"
                ? "Waiting for verified router counters"
                : "Waiting for two live samples"}
          </span>
        )}
      </div>
      <div className="route-traffic__axis">
        <span>5 minutes ago</span>
        <span>Peak {formatRate(rates.length ? peak : null)}</span>
        <span>Latest sample</span>
      </div>
      <p role="status" className="ops-meta">
        {paused
          ? "Counter reads paused while a routing operation is open."
          : (sample?.detail ?? "Read-only counter polling; no reset or router changes.")}
      </p>
      {points.at(-1)?.reset && (
        <p role="status" className="route-traffic__reset">
          Router counters reset. A new rate baseline is being collected.
        </p>
      )}
      <small className="ops-meta">
        Totals are since the router's last counter reset, not the chart window. Return/download
        traffic is excluded. {sample && `Last read ${new Date(sample.at).toLocaleTimeString()} · `}
        Refreshes about every 5 seconds while visible.
      </small>
    </section>
  );
}
