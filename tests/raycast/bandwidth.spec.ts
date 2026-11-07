import { expect, test } from "vite-plus/test";
import {
  cell,
  comparisonRuns,
  summarizeRuns,
  mbps,
  measurement,
  validateJob,
} from "../../raycast/src/lib/bandwidth";
import type { BandwidthRun, JobInput } from "../../raycast/src/lib/bandwidth";

const job: JobInput = {
  id: "tunnel",
  name: "Tunnel",
  source: "a",
  destination: "b",
  sourceInterface: "wg0",
  sourceAddress: "10.0.0.1",
  destinationAddress: "10.0.0.2",
  protocol: "tcp",
  direction: "both",
  durationSeconds: 5,
  intervalSeconds: 300,
  localTxBps: 1,
  remoteTxBps: 1e9,
  localUdpTxSize: 1500,
  remoteUdpTxSize: 1500,
  randomData: false,
  connectionCount: 1,
  reportIntervalSeconds: 1,
  enabled: false,
};
test("bounded tunnel settings accept endpoints and reject invalid input", () => {
  expect(() => validateJob(job)).not.toThrow();
  expect(() =>
    validateJob({
      ...job,
      durationSeconds: 60,
      intervalSeconds: 604800,
      protocol: "udp",
      direction: "receive",
    }),
  ).not.toThrow();
  for (const patch of [
    { durationSeconds: 4 },
    { durationSeconds: 61 },
    { intervalSeconds: 299 },
    { intervalSeconds: 604801 },
    { localTxBps: 0 },
    { remoteTxBps: 1e11 + 1 },
    { localTxBps: 1.5 },
    { durationSeconds: Number.NaN },
    { destinationAddress: "10.0.0.999" },
    { destinationAddress: "10.0.0.2/24" },
    { sourceAddress: "localhost" },
    { sourceInterface: " " },
    { name: " " },
    { connectionCount: 256 },
    { localUdpTxSize: 27 },
    { reportIntervalSeconds: Infinity },
    { reportIntervalSeconds: 0.019 },
    { reportIntervalSeconds: 5.001 },
    { reportIntervalSeconds: 0.0205 },
  ]) {
    expect(() => validateJob({ ...job, ...patch })).toThrow();
  }
});
test("missing, failed and unfinished throughput never becomes a zero sample", () => {
  for (const status of ["running", "failed", "interrupted"] as const)
    expect(measurement({ status, txBps: 100 } as BandwidthRun, "txBps")).toBeNull();
  for (const txBps of [null, Number.NaN, Infinity, -1])
    expect(measurement({ status: "ok", txBps } as BandwidthRun, "txBps")).toBeNull();
  expect(measurement({ status: "ok", txBps: 0 } as BandwidthRun, "txBps")).toBe(0);
  expect(measurement({ status: "ok", txBps: 2500000 } as BandwidthRun, "txBps")).toBe(2.5);
  expect(mbps(null)).toBe("—");
  expect(mbps(2500000)).toBe("2.50");
});
test("history cells cannot introduce extra table rows or markdown images", () => {
  expect(cell("a|b\nc![x](<url>)")).toBe("a\\|b c!\\[x\\](\\<url\\>)");
});

test("100Gbps and millisecond reporting boundaries are accepted", () => {
  for (const reportIntervalSeconds of [0.02, 0.021, 1.001, 5])
    expect(() =>
      validateJob({
        ...job,
        localTxBps: 1e11,
        remoteTxBps: 1e11,
        reportIntervalSeconds,
      }),
    ).not.toThrow();
});
test("comparison filters selected jobs and inclusive time boundaries", () => {
  const run = (id: string, startedAt: number) =>
    ({ job: { ...job, id }, startedAt }) as BandwidthRun;
  const runs = [run("a", 30), run("b", 20), run("a", 10), run("a", 20)];
  expect(comparisonRuns(runs, ["a"], 10, 20).map((r) => r.startedAt)).toEqual([10, 20]);
  expect(comparisonRuns(runs, [], 0, Infinity)).toEqual([]);
  expect(runs[0].startedAt).toBe(30);
});
test("summary counts statuses and independent successful directions", () => {
  const runs = [
    { status: "ok", txBps: 0, rxBps: null },
    { status: "ok", txBps: 4000000, rxBps: 6000000 },
    { status: "ok", txBps: Number.NaN, rxBps: -1 },
    { status: "failed", txBps: 99000000, rxBps: 99000000 },
    { status: "interrupted", txBps: null, rxBps: null },
    { status: "running", txBps: null, rxBps: null },
  ] as BandwidthRun[];
  expect(summarizeRuns(runs)).toEqual({
    success: 3,
    failed: 1,
    interrupted: 1,
    running: 1,
    tx: { count: 2, min: 0, mean: 2, max: 4 },
    rx: { count: 1, min: 6, mean: 6, max: 6 },
  });
  expect(summarizeRuns([]).tx).toBeNull();
});
