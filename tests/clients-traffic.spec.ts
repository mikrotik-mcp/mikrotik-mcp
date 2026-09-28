import { expect, test } from "vite-plus/test";
import {
  applyTrafficSample,
  EMPTY_TRAFFIC,
  MINI_SAMPLES,
  trafficX,
} from "../ui/observability/clients-traffic";
import type { BulkTrafficPayload } from "../src/tools/connected-devices";

const sample: BulkTrafficPayload = {
  ts: 1,
  source: "kid-control",
  limits: {},
  hosts: { "10.10.10.191": { rxRate: 0, txRate: 0, rxBytes: 1234, txBytes: 567 } },
};

test("observed idle clients retain counters and a bounded zero-rate chart", () => {
  let state = EMPTY_TRAFFIC;
  for (let i = 0; i < 50; i++) state = applyTrafficSample(state, { ...sample, ts: i + 1 });
  const host = state.map.get("10.10.10.191");
  expect(host?.rxBytes).toBe(1234);
  expect(host?.history).toHaveLength(MINI_SAMPLES);
  expect(host?.rxRate).toBe(0);
});

test("missing/error samples do not fabricate a zero rate from old counters or limits", () => {
  const old = applyTrafficSample(EMPTY_TRAFFIC, sample);
  const missing = applyTrafficSample(old, {
    ...sample,
    ts: 2,
    hosts: {},
    limits: {
      "10.10.10.191": { download: "10M", upload: "2M" },
    },
    source: "none",
    note: "SSH unavailable",
  });
  expect(missing.map.size).toBe(0);
  expect(missing.note).toBe("SSH unavailable");
  expect(missing.limits["10.10.10.191"]?.download).toBe("10M");
});

test("fresh samples update rates and a source change starts a new history", () => {
  const old = applyTrafficSample(EMPTY_TRAFFIC, sample);
  const active = {
    ...sample,
    ts: 2,
    hosts: {
      "10.10.10.191": {
        rxRate: 8_000_000,
        txRate: 1000,
        rxBytes: 1_001_234,
        txBytes: 692,
      },
    },
  };
  const next = applyTrafficSample(old, active);
  expect(next.map.get("10.10.10.191")?.history).toHaveLength(2);
  expect(next.map.get("10.10.10.191")?.rxRate).toBe(8_000_000);
  expect(
    applyTrafficSample(next, { ...active, ts: 3, source: "accounting" }).map.get("10.10.10.191")
      ?.history,
  ).toHaveLength(1);
});

test("duplicate/replayed and out-of-order samples cannot rewrite the chart", () => {
  const latest = applyTrafficSample(EMPTY_TRAFFIC, { ...sample, ts: 3000 });
  expect(applyTrafficSample(latest, { ...sample, ts: 3000 })).toBe(latest);
  expect(applyTrafficSample(latest, { ...sample, ts: 2000 })).toBe(latest);
});

test("both charts span their actual sample times, including irregular polling gaps", () => {
  const history = [1000, 2000, 5000].map((ts) => ({ ts, rx: 0, tx: 0 }));
  expect(history.map((_, i) => trafficX(history, i, 520, 8))).toEqual([8, 134, 512]);
  expect(history.map((_, i) => trafficX(history, i, 80, 1))).toEqual([1, 20.5, 79]);
});

test("missing rate keeps byte totals but breaks history instead of drawing a zero", () => {
  const old = applyTrafficSample(EMPTY_TRAFFIC, sample);
  const next = applyTrafficSample(old, {
    ...sample,
    ts: 2,
    hosts: {
      "10.10.10.191": { rxBytes: 1234, txBytes: 567, rxRate: null, txRate: null },
    },
  });
  expect(next.map.get("10.10.10.191")?.history).toEqual([]);
  expect(next.map.get("10.10.10.191")?.rxRate).toBeNull();
  expect(next.map.get("10.10.10.191")?.rxBytes).toBe(1234);
});
