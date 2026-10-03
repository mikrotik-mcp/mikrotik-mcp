import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  configureFlight,
  getFlight,
  sampleFlight,
  recordFlightTool,
  freezeIncident,
  exportIncident,
} from "../src/flight-recorder/service";
import type { FlightRecord } from "../src/flight-recorder/model";
import type { ToolEvent } from "../src/observability/event";
const mock = vi.hoisted(() => ({
  records: new Map<string, FlightRecord>(),
  commands: [] as string[],
  denied: false,
  failure: false,
  safe: false,
}));
vi.mock("../src/core/runtime", () => ({
  resolveDeviceName: (d: string) => {
    if (!["lab", "other"].includes(d)) throw new Error("unknown router");
    return d;
  },
  getConfig: () => ({ devices: { lab: {} } }),
}));
vi.mock("../src/core/scoped-access", () => ({
  assertDeviceAccess: () => {
    if (mock.denied) throw new Error("denied");
  },
}));
vi.mock("../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_k: string, _id: string, d: string) => structuredClone(mock.records.get(d)),
    put: (_k: string, r: FlightRecord) => mock.records.set(r.device, structuredClone(r)),
    lock: () => {},
    unlock: () => {},
  }),
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => ({ isActive: mock.safe }) }));
vi.mock("../src/observability/recorder", () => ({
  subscribe: () => () => {},
  isRecording: () => true,
}));
vi.mock("../src/home/read", () => ({
  rows: async () => [{ name: "wan", running: "yes" }],
  checkedRead: async (cmd: string) => {
    mock.commands.push(cmd);
    if (mock.failure) throw new Error("timeout");
    return cmd.includes("/log")
      ? '{"time":"12:00:00","topics":["system","info"],"message":"password=secret changed"}'
      : "cpu-load: 12\ntotal-memory: 100MiB\nfree-memory: 50MiB";
  },
}));
const ctx = { device: "lab", info: () => {}, error: () => {} };
beforeEach(() => {
  mock.records.clear();
  mock.commands = [];
  mock.denied = false;
  mock.failure = false;
  mock.safe = false;
});
test("enable is local and sampling persists bounded metadata, never raw logs", async () => {
  await configureFlight({ enabled: true }, ctx);
  expect(mock.commands).toHaveLength(0);
  await sampleFlight("lab");
  const r = (await getFlight(ctx)).recorder;
  expect(r.samples[0].cpu).toBe(12);
  expect(r.samples[0].reachable).toBe(true);
  expect(r.events).toHaveLength(1);
  expect(JSON.stringify(r)).not.toContain("password=secret");
  await sampleFlight("lab");
  expect((await getFlight(ctx)).recorder.samples).toHaveLength(1);
});
test("unknown router, denied access and Safe Mode never issue sampling commands", async () => {
  await expect(sampleFlight("ghost")).rejects.toThrow();
  mock.denied = true;
  await expect(sampleFlight("lab")).rejects.toThrow();
  mock.denied = false;
  await configureFlight({ enabled: true }, ctx);
  mock.safe = true;
  await sampleFlight("lab");
  expect(mock.commands).toHaveLength(0);
  expect((await getFlight(ctx)).recorder.samples[0].reachable).toBeNull();
});
test("a failed management read is preserved as a failed read, not zero metrics", async () => {
  await configureFlight({ enabled: true }, ctx);
  mock.failure = true;
  await sampleFlight("lab");
  const s = (await getFlight(ctx)).recorder.samples[0];
  expect(s.cpu).toBeUndefined();
  expect(s.reachable).toBe(false);
  expect(s.gaps.join()).toContain("outage is not established");
});
test("tool metadata and incidents remain scoped with no tool arguments retained", async () => {
  await configureFlight({ enabled: true }, ctx);
  await recordFlightTool({
    id: "1",
    device: "lab",
    tool: "update_route",
    risk: "WRITE",
    isError: false,
    input: "password",
    output: "secret",
  } as ToolEvent);
  await freezeIncident("test", ctx);
  const r = (await getFlight(ctx)).recorder;
  expect(r.events[0].source).toBe("mcp");
  expect(JSON.stringify(r)).not.toMatch(/password|secret/);
  expect((await exportIncident(r.incidents[0].id, ctx)).incident.title).toBe("test");
  await expect(exportIncident(r.incidents[0].id, { ...ctx, device: "other" })).rejects.toThrow(
    /not found/,
  );
  await configureFlight({ enabled: false }, ctx);
  await recordFlightTool({
    id: "2",
    device: "lab",
    tool: "update_route",
    risk: "WRITE",
  } as ToolEvent);
  expect((await getFlight(ctx)).recorder.events).toHaveLength(1);
});
