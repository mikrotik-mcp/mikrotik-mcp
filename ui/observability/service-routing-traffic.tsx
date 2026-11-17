import { useEffect, useState } from "react";
import { api } from "./api";
import type { RoutingPolicy } from "../../src/service-routing/model";
import { routingRate } from "../../src/service-routing/traffic-model";
import type { RoutingRate, RoutingTraffic } from "../../src/service-routing/traffic-model";
import { MonitorButton, MonitorPanel, formatBytes } from "./monitoring-ui";

/** Exact binary units; kept for the full-precision tooltip. */
export function formatRoutingBytes(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const n = Number(value);
  if (n < 1024) return `${n} B`;
  const index = Math.min(6, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** index).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"][index]}`;
}
function formatCount(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const n = Number(value);
  if (n < 1000) return String(n);
  const [d, unit] = n >= 1e9 ? [1e9, "G"] : n >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  return `${(n / d).toFixed(1).replace(/\.0$/, "")} ${unit}`;
}
function formatRate(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} Mbps`;
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
          detail: "Counters are temporarily unavailable. Retrying every 5 s.",
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
  const x = (at: number) => (((at - end + 300_000) / 300_000) * 640).toFixed(1);
  const y = (bps: number) => (140 - (bps / Math.max(1, peak)) * 120).toFixed(1);
  const path = points
    .map((p, index) =>
      p.bps === null
        ? ""
        : `${index > 0 && points[index - 1].bps !== null ? "L" : "M"}${x(p.at)},${y(p.bps)}`,
    )
    .join(" ");
  const status = paused
    ? "Counter reads pause while a routing change is open."
    : sample?.state === "unavailable"
      ? sample.detail
      : undefined;
  return (
    <MonitorPanel
      className="flex-[2_1_520px]"
      aria-label="Policy traffic"
      title="Traffic matched by this route"
      description={`Client → service · ${policy.family === "ipv6" ? "IPv6" : "IPv4"} · ${policy.activeTable ?? policy.primary} · counted every 5 s`}
      extra={
        <MonitorButton
          size="sm"
          disabled={paused || policy.state !== "active"}
          onClick={() => setRetry((r) => r + 1)}
        >
          Refresh counters
        </MonitorButton>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <dl className="m-0 grid grid-cols-3 gap-3">
        {[
          [
            "Matched bytes",
            ready && sample.bytes && /^\d+$/.test(sample.bytes)
              ? formatBytes(Number(sample.bytes))
              : "—",
            ready ? formatRoutingBytes(sample.bytes) : undefined,
          ],
          ["Matched packets", ready ? formatCount(sample.packets) : "—", undefined],
          ["Current rate", ready ? formatRate(points.at(-1)?.bps) : "—", undefined],
        ].map(([label, value, title]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="monitor-label truncate">{label}</dt>
            <dd
              className="m-0 truncate text-[20px] font-[590] text-emphasis tabular-nums max-sm:text-[16px]"
              title={title}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="relative">
        <svg
          viewBox="0 0 640 160"
          width="100%"
          height="160"
          preserveAspectRatio="none"
          role="img"
          aria-label="Matched traffic rate over the last 5 minutes"
          className="block"
        >
          <g
            stroke="var(--chart-grid)"
            strokeDasharray="2 4"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          >
            {[20, 80, 140].map((gy) => (
              <line key={gy} x1="0" y1={gy} x2="640" y2={gy} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
          <path
            d={path}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {!rates.length && (
          <span className="absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">
            {policy.state !== "active"
              ? "Counters start after a verified apply"
              : sample?.state === "unavailable"
                ? "Waiting for router counters"
                : "Waiting for two live samples"}
          </span>
        )}
      </div>
      <div className="flex justify-between gap-2 text-[12px] text-muted-foreground">
        <span>5 minutes ago</span>
        <span>Peak {formatRate(rates.length ? peak : null)}</span>
        <span>Latest sample</span>
      </div>
      {(status || points.at(-1)?.reset) && (
        <p role="status" className="text-[12px] text-warning">
          {points.at(-1)?.reset
            ? "The router reset its counters. A new rate baseline is being collected."
            : status}
        </p>
      )}
      <p className="text-[12px] text-muted-foreground">
        Totals count from the router's last counter reset. Only client-to-service traffic is
        counted, not the replies.
      </p>
    </MonitorPanel>
  );
}
