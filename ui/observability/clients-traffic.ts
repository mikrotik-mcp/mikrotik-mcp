import type { BulkTrafficPayload, HostTraffic } from "../../src/tools/connected-devices";

export interface TrafficPoint {
  ts: number;
  rx: number;
  tx: number;
}

export interface IpTraffic extends HostTraffic {
  downloadLimit: string;
  uploadLimit: string;
  history: TrafficPoint[];
}

export interface BulkTraffic {
  ts?: number;
  map: Map<string, IpTraffic>;
  source: BulkTrafficPayload["source"];
  note?: string;
  limits: BulkTrafficPayload["limits"];
}

export const MINI_SAMPLES = 30;
export const EMPTY_TRAFFIC: BulkTraffic = { map: new Map(), source: "none", limits: {} };

/** Preserve observed idle counters; never turn missing/error samples into measured zeroes. */
export function applyTrafficSample(old: BulkTraffic, sample: BulkTrafficPayload): BulkTraffic {
  if (!Number.isFinite(sample.ts) || (old.ts != null && sample.ts <= old.ts)) return old;
  const next = new Map<string, IpTraffic>();
  for (const [ip, h] of Object.entries(sample.hosts)) {
    const previous = old.source === sample.source ? old.map.get(ip) : undefined;
    const limit = sample.limits[ip];
    next.set(ip, {
      ...h,
      downloadLimit: limit?.download ?? "",
      uploadLimit: limit?.upload ?? "",
      history:
        h.rxRate != null &&
        h.txRate != null &&
        Number.isFinite(h.rxRate) &&
        Number.isFinite(h.txRate) &&
        h.rxRate >= 0 &&
        h.txRate >= 0
          ? [...(previous?.history ?? []), { ts: sample.ts, rx: h.rxRate, tx: h.txRate }].slice(
              -MINI_SAMPLES,
            )
          : [],
    });
  }
  return {
    ts: sample.ts,
    map: next,
    source: sample.source,
    note: sample.note,
    limits: sample.limits,
  };
}

/** The plot spans the observed time range, not an assumed timer/sample count. */
export function trafficX(
  history: TrafficPoint[],
  index: number,
  width: number,
  pad: number,
): number {
  const start = history[0]?.ts ?? 0;
  const end = history.at(-1)?.ts ?? start;
  const fraction = end > start ? ((history[index]?.ts ?? start) - start) / (end - start) : 1;
  return pad + fraction * (width - 2 * pad);
}
