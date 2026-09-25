import { expect, test } from "vite-plus/test";
import {
  applyTrafficSample,
  EMPTY_TRAFFIC,
  MINI_SAMPLES,
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
  for (let i = 0; i < 50; i++) state = applyTrafficSample(state, sample);
  const host = state.map.get("10.10.10.191");
  expect(host?.rxBytes).toBe(1234);
  expect(host?.history).toHaveLength(MINI_SAMPLES);
  expect(host?.rxRate).toBe(0);
});

test("missing/error samples do not fabricate a zero rate from old counters or limits", () => {
  const old = applyTrafficSample(EMPTY_TRAFFIC, sample);
  const missing = applyTrafficSample(old, {
    ...sample,
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
    applyTrafficSample(next, { ...active, source: "accounting" }).map.get("10.10.10.191")?.history,
  ).toHaveLength(1);
});
