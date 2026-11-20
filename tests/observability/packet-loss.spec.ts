import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getDeviceLoss,
  sampleLoss,
  stopLossSampler,
  summarizeLoss,
} from "../../src/observability/packet-loss";

const initial = getConfig();
beforeEach(() =>
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        edge: { host: "192.0.2.1", fallbackHosts: ["192.0.2.2"] },
        behind: { host: "192.0.2.3", jumpVia: "edge" },
        layer2: { mac: "00:11:22:33:44:55" },
        off: { host: "192.0.2.4", disabled: true },
      },
      defaultDevice: "edge",
    }),
  ),
);
afterEach(() => {
  stopLossSampler();
  setConfig(initial);
});

const at = (minute: number, second: number): number => minute * 60_000 + second * 1000;

test("a summary counts lost probes, the longest gap, answer times and each minute", () => {
  const summary = summarizeLoss([
    { ts: at(10, 0), ms: 20 },
    { ts: at(10, 5), ms: 30 },
    { ts: at(10, 10), ms: null },
    { ts: at(10, 15), ms: null },
    { ts: at(11, 0), ms: 26 },
    { ts: at(11, 5), ms: null },
  ]);
  expect(summary).toMatchObject({
    sent: 6,
    lost: 3,
    pct: 50,
    longestGapMs: 10_000,
    longestGapAt: at(10, 10),
    jitterMs: 7,
    recent: [false, false, true, true, false, true],
  });
  expect(summary.avgMs).toBeCloseTo(25.33, 1);
  expect(summary.minutes).toEqual([
    { ts: at(10, 0), sent: 4, lost: 2, pct: 50, avgMs: 25 },
    { ts: at(11, 0), sent: 2, lost: 1, pct: 50, avgMs: 26 },
  ]);
});

test("no probes give an empty summary, not a division by zero", () => {
  expect(summarizeLoss([])).toMatchObject({ sent: 0, lost: 0, pct: 0, avgMs: null, minutes: [] });
});

test("only addresses this machine can reach are probed, and each keeps its own tape", async () => {
  const asked: string[] = [];
  const probe = async (host: string): Promise<number | null> => {
    asked.push(host);
    return host === "192.0.2.1" ? null : 12;
  };
  await sampleLoss(probe);
  await sampleLoss(probe);
  expect(asked.sort()).toEqual(["192.0.2.1", "192.0.2.1", "192.0.2.2", "192.0.2.2"]);
  for (const name of ["behind", "layer2", "off"]) expect(getDeviceLoss(name)).toBeUndefined();

  // The dead primary is not the address in use: the figures follow the fallback.
  expect(getDeviceLoss("edge", "192.0.2.2")).toMatchObject({ host: "192.0.2.2", sent: 2, pct: 0 });
  expect(getDeviceLoss("edge")).toMatchObject({ host: "192.0.2.1", lost: 2, pct: 100 });
  expect(getDeviceLoss("edge")!.addresses).toEqual([
    { host: "192.0.2.1", sent: 2, lost: 2, pct: 100, recent: [true, true] },
    { host: "192.0.2.2", sent: 2, lost: 0, pct: 0, recent: [false, false] },
  ]);
});

test("a removed router or address loses its probes", async () => {
  await sampleLoss(async () => 5);
  setConfig(
    MikrotikConfigSchema.parse({ devices: { edge: { host: "192.0.2.1" } }, defaultDevice: "edge" }),
  );
  await sampleLoss(async () => 5);
  expect(getDeviceLoss("edge")!.addresses.map((a) => a.host)).toEqual(["192.0.2.1"]);
});
