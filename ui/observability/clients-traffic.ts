import type { BulkTrafficPayload } from "../../src/tools/connected-devices";

export interface IpTraffic {
  rxRate: number;
  txRate: number;
  rxBytes: number;
  txBytes: number;
  downloadLimit: string;
  uploadLimit: string;
  history: { rx: number; tx: number }[];
}

export interface BulkTraffic {
  map: Map<string, IpTraffic>;
  source: BulkTrafficPayload["source"];
  note?: string;
  limits: BulkTrafficPayload["limits"];
}

export const MINI_SAMPLES = 30;
export const EMPTY_TRAFFIC: BulkTraffic = { map: new Map(), source: "none", limits: {} };

/** Preserve observed idle counters; never turn missing/error samples into measured zeroes. */
export function applyTrafficSample(old: BulkTraffic, sample: BulkTrafficPayload): BulkTraffic {
  const next = new Map<string, IpTraffic>();
  for (const [ip, h] of Object.entries(sample.hosts)) {
    const previous = old.source === sample.source ? old.map.get(ip) : undefined;
    const limit = sample.limits[ip];
    next.set(ip, {
      ...h,
      downloadLimit: limit?.download ?? "",
      uploadLimit: limit?.upload ?? "",
      history: [...(previous?.history ?? []), { rx: h.rxRate, tx: h.txRate }].slice(-MINI_SAMPLES),
    });
  }
  return { map: next, source: sample.source, note: sample.note, limits: sample.limits };
}
