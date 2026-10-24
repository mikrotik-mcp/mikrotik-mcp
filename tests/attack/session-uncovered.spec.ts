import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { startAttackDetection, stopAttackDetection, sweep } from "../../src/attack/session";

const rig = vi.hoisted(() => ({
  command: vi.fn(async () => ""),
  scan: vi.fn(async () => ["203.0.113.9"]),
  detect: vi.fn((_input: unknown) => ({ signals: [], unavailable: [] })),
  correlate: vi.fn(() => [] as unknown[]),
  decide: vi.fn((): Record<string, unknown> => ({ kind: "none" })),
  plan: vi.fn(() => false),
  execute: vi.fn(async () => [{ device: "edge", ok: true, detail: "added" }]),
  alert: vi.fn(),
  store: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: rig.command }));
vi.mock("../../src/attack/execute", () => ({ readScanList: rig.scan, executePlan: rig.execute }));
vi.mock("../../src/attack/detectors", () => ({
  DEFAULT_DETECTOR_CONFIG: {},
  runDetectors: rig.detect,
}));
vi.mock("../../src/attack/correlate", () => ({
  correlate: rig.correlate,
  mergeIncident: (_old: unknown, fresh: unknown) => fresh,
}));
vi.mock("../../src/attack/respond", () => ({ decide: rig.decide, isPlan: rig.plan }));
vi.mock("../../src/attack/store", () => ({ attackStore: rig.store }));
vi.mock("../../src/alerts/engine", () => ({ emitAlertEvent: rig.alert }));
vi.mock("../../src/logger", () => ({
  logger: { warn: rig.warn, error: rig.error, info: rig.info },
}));

const original = getConfig();
const incident = {
  id: "atk-1",
  devices: ["edge"],
  confidence: "high",
  stage: "active",
  severity: "high",
  narrative: "repeated failed logins",
};
const response = {
  incidentId: "atk-1",
  action: "block",
  source: "203.0.113.9",
  devices: ["edge"],
  timeout: "1h",
  list: "attackers",
  reason: "failed logins",
};
let records: { action: string; ok: boolean; error?: string }[];
beforeEach(() => {
  vi.clearAllMocks();
  records = [];
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "edge",
      attacks: { enabled: true, mode: "respond", readScanList: true },
    }),
  );
  rig.command.mockResolvedValue("");
  rig.scan.mockResolvedValue(["203.0.113.9"]);
  rig.detect.mockReturnValue({ signals: [], unavailable: [] });
  rig.correlate.mockReturnValue([]);
  rig.plan.mockReturnValue(false);
  rig.execute.mockResolvedValue([{ device: "edge", ok: true, detail: "added" }]);
  rig.store.mockResolvedValue({
    recordBaselineSource: vi.fn(),
    baselineFor: vi.fn(() => []),
    getIncident: vi.fn(() => null),
    saveIncident: vi.fn(),
    countRecentBlocks: vi.fn(() => 0),
    recordResponse: (item: { action: string; ok: boolean; error?: string }) => records.push(item),
  });
});
afterEach(() => {
  stopAttackDetection();
  setConfig(original);
  vi.useRealTimers();
});

test("a store-backed sweep reads scan evidence and isolates failed device reads", async () => {
  rig.command.mockRejectedValueOnce(new Error("SSH timed out"));
  const first = await sweep({ devices: ["edge"], respond: false });
  expect(first.devices).toMatchObject([{ device: "edge", ok: false, error: "SSH timed out" }]);
  expect(first.responses).toEqual([]);
  const second = await sweep({ devices: ["edge"], respond: false });
  expect(second.devices).toMatchObject([{ device: "edge", ok: true }]);
  expect(rig.scan).toHaveBeenCalledOnce();
  expect(rig.detect.mock.calls[0][0]).toMatchObject({ scanList: ["203.0.113.9"] });
});

test("new incidents alert and successful response is recorded", async () => {
  rig.correlate.mockReturnValue([incident]);
  rig.plan.mockReturnValue(true);
  rig.decide.mockReturnValue(response);
  const result = await sweep({ devices: [], now: 1000 });
  expect(result.incidents).toHaveLength(1);
  expect(result.responses).toMatchObject([{ action: "block", detail: "edge: added" }]);
  expect(rig.alert).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "attack", isError: true }),
  );
  expect(records).toMatchObject([{ action: "block", ok: true }]);
});

test("escalation needs no device write; a failed block records its error", async () => {
  rig.correlate.mockReturnValue([incident]);
  rig.plan.mockReturnValue(true);
  rig.decide.mockReturnValue({ ...response, action: "escalate" });
  expect((await sweep({ devices: [] })).responses).toMatchObject([{ action: "escalate" }]);
  expect(rig.execute).not.toHaveBeenCalled();
  rig.decide.mockReturnValue(response);
  rig.execute.mockResolvedValue([{ device: "edge", ok: false, detail: "permission denied" }]);
  expect((await sweep({ devices: [] })).responses).toMatchObject([
    { detail: "edge: permission denied" },
  ]);
  expect(records).toMatchObject([{ ok: false, error: "permission denied" }]);
});

test("timer starts once and stops cleanly", () => {
  vi.useFakeTimers();
  startAttackDetection();
  startAttackDetection();
  expect(rig.info).toHaveBeenCalledOnce();
  stopAttackDetection();
  stopAttackDetection();
});
