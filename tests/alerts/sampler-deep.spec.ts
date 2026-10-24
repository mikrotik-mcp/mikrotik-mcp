/** Real sampler aggregation and absence-source behavior with local dependencies. */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AlertRuleSchema } from "../../src/alerts/model";
import { AlertEngine, setAlertEngine } from "../../src/alerts/engine";
import { computeMetricSample, lastSeen, sampleAlertsOnce } from "../../src/alerts/sampler";

const deps = vi.hoisted(() => ({
  query: vi.fn(),
  status: vi.fn(),
  config: vi.fn(),
  snapshots: vi.fn(),
}));
vi.mock("../../src/observability/recorder", () => ({
  getEventStore: () => ({ query: deps.query }),
}));
vi.mock("../../src/observability/health", () => ({ getDeviceStatus: deps.status }));
vi.mock("../../src/core/runtime", () => ({ getConfig: deps.config }));
vi.mock("../../src/snapshots/store", () => ({ openSnapshotStore: deps.snapshots }));

afterEach(() => {
  vi.clearAllMocks();
  setAlertEngine();
});

describe("alert sampler", () => {
  test("window is passed to event query and error/latency aggregates use returned events", () => {
    deps.query.mockReturnValue([
      { durationMs: 10, isError: false },
      { durationMs: 20, isError: true },
      { durationMs: 30, isError: false },
      { durationMs: 40, isError: true },
    ]);
    expect(computeMetricSample(5_000, 10_000)).toMatchObject({
      calls: 4,
      errors: 2,
      avgDurationMs: 25,
    });
    expect(computeMetricSample(5_000, 10_000).p95DurationMs).toBe(38.5);
    expect(deps.query).toHaveBeenCalledWith({ since: 5_000, limit: 10_000 });
  });

  test("empty window produces zeros and one filtered tool-call lookup returns latest timestamp", async () => {
    deps.query.mockReturnValueOnce([]).mockReturnValueOnce([{ ts: 1234 }]);
    expect(computeMetricSample(1_000, 2_000)).toEqual({
      calls: 0,
      errors: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
    });
    expect(
      await lastSeen({ absence: "tool_call", within: "5m", tool: ["ping"], device: ["edge"] }),
    ).toBe(1234);
    expect(deps.query).toHaveBeenLastCalledWith({ limit: 1, tool: "ping", device: "edge" });
  });

  test("multi-value tool filter uses conservative unfiltered latest lookup", async () => {
    deps.query.mockReturnValue([]);
    expect(
      await lastSeen({ absence: "tool_call", within: "5m", tool: ["a", "b"] }),
    ).toBeUndefined();
    expect(deps.query).toHaveBeenCalledWith({ limit: 1, tool: undefined, device: undefined });
  });

  test("device absence counts only successful probes and chooses newest", async () => {
    deps.config.mockReturnValue({ devices: { a: {}, b: {}, c: {} } });
    deps.status.mockImplementation(
      (device: string) =>
        ({
          a: { reachable: true, checkedAt: 100 },
          b: { reachable: false, checkedAt: 999 },
          c: { reachable: true, checkedAt: 200 },
        })[device],
    );
    expect(await lastSeen({ absence: "device_seen", within: "5m" })).toBe(200);
    expect(await lastSeen({ absence: "device_seen", within: "5m", device: ["b"] })).toBeUndefined();
  });

  test("one tick evaluates an installed metric rule against actual event counts", async () => {
    const fired: string[] = [];
    deps.query.mockReturnValue(
      Array.from({ length: 10 }, (_, i) => ({ durationMs: 10, isError: i < 5 })),
    );
    setAlertEngine(
      new AlertEngine({
        rules: [
          AlertRuleSchema.parse({
            id: "errors",
            when: { metric: "error_rate", window: "5m", above: 0.2, minCalls: 10 },
            channels: ["mcp"],
          }),
        ],
        channels: { mcp: {} },
        onAlert: (notification) => fired.push(notification.ruleId),
      }),
    );
    await sampleAlertsOnce(500_000);
    expect(fired).toEqual(["errors"]);
    expect(deps.query).toHaveBeenCalledWith({ since: 200_000, limit: 10_000 });
  });
});
