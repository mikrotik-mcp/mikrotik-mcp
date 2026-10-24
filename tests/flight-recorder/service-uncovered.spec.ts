import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { FlightRecord } from "../../src/flight-recorder/model";
import {
  configureFlight,
  flightTick,
  getFlight,
  recordFlightTool,
  sampleFlight,
  startFlightRecorder,
  stopFlightRecorder,
} from "../../src/flight-recorder/service";
import type { ToolEvent } from "../../src/observability/event";

const state = vi.hoisted(() => ({
  records: new Map<string, FlightRecord>(),
  commands: [] as string[],
  log: "",
  interfaces: [] as Record<string, string>[],
  readFailure: false,
  interfaceFailure: false,
}));
vi.mock("../../src/core/runtime", () => ({
  resolveDeviceName: (device: string) => device,
  getConfig: () => ({ devices: { lab: {} } }),
}));
vi.mock("../../src/core/scoped-access", () => ({ assertDeviceAccess: () => {} }));
vi.mock("../../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_kind: string, _id: string, device: string) => structuredClone(state.records.get(device)),
    put: (_kind: string, record: FlightRecord) =>
      state.records.set(record.device, structuredClone(record)),
    lock: () => {},
    unlock: () => {},
  }),
}));
vi.mock("../../src/ssh/safe-mode", () => ({ getSafeModeManager: () => ({ isActive: false }) }));
vi.mock("../../src/observability/recorder", () => ({
  subscribe: () => () => {},
  isRecording: () => true,
}));
vi.mock("../../src/home/read", () => ({
  rows: async () => {
    if (state.interfaceFailure) throw new Error("inventory unavailable");
    return state.interfaces;
  },
  checkedRead: async (command: string) => {
    state.commands.push(command);
    if (state.readFailure) throw new Error("offline");
    return command.includes("/log")
      ? state.log
      : "cpu-load: 18\ntotal-memory: 100MiB\nfree-memory: 25MiB";
  },
}));
const ctx = { device: "lab", info() {}, error() {} };
beforeEach(() => {
  state.records.clear();
  state.commands = [];
  state.interfaces = [];
  state.log = "";
  state.readFailure = false;
  state.interfaceFailure = false;
});
afterEach(() => {
  stopFlightRecorder();
});

test("records bounded interface metrics and notes a capped inventory", async () => {
  state.interfaces = Array.from({ length: 65 }, (_, i) => ({
    name: `ether${i}`,
    running: "yes",
    "rx-byte": "123",
    "tx-byte": "not-a-number",
  }));
  state.interfaces[0].disabled = "yes";
  await configureFlight({ enabled: true }, ctx);
  await sampleFlight("lab");
  const sample = (await getFlight(ctx)).recorder.samples[0];
  expect(sample.memory).toBe(75);
  expect(sample.interfaces).toHaveLength(64);
  expect(sample.interfaces[0].rx).toBe(123);
  expect(sample.interfaces[0].tx).toBeUndefined();
  expect(sample.gaps.join()).toContain("capped at 64");
});

test("malformed log data and failed interface inventory are explicit gaps", async () => {
  state.interfaceFailure = true;
  state.log = "not JSON";
  await configureFlight({ enabled: true }, ctx);
  await sampleFlight("lab");
  const gaps = (await getFlight(ctx)).recorder.samples[0].gaps.join(" ");
  expect(gaps).toContain("Interface state unavailable");
  expect(gaps).toContain("Router log collection unavailable");
});

test("tool events attach to an open incident and disabled records are trimmed by the tick", async () => {
  await configureFlight({ enabled: true }, ctx);
  await sampleFlight("lab");
  await recordFlightTool({
    id: "write",
    device: "lab",
    tool: "set_route",
    risk: "WRITE",
    isError: true,
  } as ToolEvent);
  expect((await getFlight(ctx)).recorder.events).toHaveLength(1);
  await configureFlight({ enabled: false }, ctx);
  const before = state.records.get("lab")!;
  before.updatedAt = Date.now() - 120_000;
  state.records.set("lab", before);
  await flightTick();
  expect(state.records.get("lab")?.updatedAt).toBeGreaterThan(before.updatedAt);
  startFlightRecorder();
  startFlightRecorder();
  stopFlightRecorder();
});
