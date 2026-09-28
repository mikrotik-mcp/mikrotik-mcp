import { describe, expect, test } from "vite-plus/test";
import { runInput, summarizeRun, compareRuns } from "../../src/client-check/model";
import type { CheckRun } from "../../src/client-check/model";

const run: CheckRun = {
  id: "one",
  label: "Wi-Fi",
  path: "wifi",
  receivedAt: 10,
  peerAddress: "192.0.2.10",
  endpoint: "https://test.example",
  family: "IPv4",
  idleMs: [10, 14, 12, 18, 16],
  loadedMs: [25, 30, 35],
  download: { bytes: 1000000, ms: 1000 },
  upload: { bytes: 100000, ms: 1000 },
  errors: [],
};
describe("client evidence", () => {
  test("calculates measured rates, jitter and loaded latency; unknown is not zero", () => {
    expect(summarizeRun(run)).toEqual({
      idleMs: 14,
      loadedMs: 30,
      addedLatencyMs: 16,
      downloadMbps: 8,
      uploadMbps: 0.8,
      jitterMs: 3,
      complete: true,
    });
    expect(summarizeRun({ ...run, download: null }).downloadMbps).toBeNull();
    expect(summarizeRun({ ...run, loadedMs: [] }).complete).toBe(false);
    expect(
      compareRuns(run, { ...run, id: "two", endpoint: "https://other.example" }).comparable,
    ).toBe(false);
    expect(compareRuns(run, { ...run, id: "two", path: "vpn" }).comparable).toBe(true);
  });
  test("limits browser supplied data and invitation lifetime", () => {
    const { id: _, receivedAt: __, peerAddress: ___, endpoint: ____, family: _____, ...data } = run;
    expect(runInput.safeParse(data).success).toBe(true);
    expect(runInput.safeParse({ ...data, idleMs: [Infinity] }).success).toBe(false);
    expect(runInput.safeParse({ ...data, download: { bytes: 32e6, ms: 1000 } }).success).toBe(
      false,
    );
  });
});
