import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import {
  buildGuards,
  fetchLog,
  policyFromConfig,
  resolveTargets,
  sweep,
} from "../src/attack/session";

const mocks = vi.hoisted(() => ({ command: vi.fn(), status: vi.fn(), store: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/observability/health", () => ({ getDeviceStatus: mocks.status }));
vi.mock("../src/attack/store", () => ({ attackStore: mocks.store }));
const initial = getConfig();

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { alpha: { host: "192.0.2.1", port: 22 }, beta: { host: "198.51.100.2", port: 22 } },
      defaultDevice: "alpha",
    }),
  );
  mocks.status.mockReturnValue({ reachable: null });
  mocks.store.mockRejectedValue(new Error("optional store disabled"));
  mocks.command.mockResolvedValue("");
});
afterEach(() => setConfig(initial));

test("guards include router hosts and private management ranges", () => {
  const guards = buildGuards();
  expect(guards.deviceHosts).toEqual(["192.0.2.1", "198.51.100.2"]);
  expect(guards.configured).toContain("10.0.0.0/8");
  expect(policyFromConfig()).toMatchObject({ mode: getConfig().attacks.mode });
});

test("online-only skips known-offline devices but probes unknown health", () => {
  mocks.status.mockImplementation((name: string) => ({
    reachable: name === "beta" ? false : null,
  }));
  expect(resolveTargets({ onlineOnly: true })).toEqual({ targets: ["alpha"], skipped: ["beta"] });
  expect(resolveTargets({ devices: ["alpha", "beta"], onlineOnly: false })).toEqual({
    targets: ["alpha", "beta"],
    skipped: [],
  });
});

test("log fetch uses bounded RouterOS time expression and parses events", async () => {
  mocks.command.mockResolvedValue(
    "0 time=oct/24/2026 11:00:00 topics=system,info message=logged in",
  );
  await fetchLog("alpha", 7);
  expect(mocks.command.mock.calls[0][0]).toBe("/log print detail where time > ([:timestamp] - 7m)");
});

test("fleet sweep isolates one router failure and returns the other read result", async () => {
  mocks.command.mockImplementation(async (_command: string, ctx: { device: string }) => {
    if (ctx.device === "beta") throw new Error("offline");
    return "";
  });
  const result = await sweep({ devices: ["alpha", "beta"], now: 1234, respond: false });
  expect(result.devices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ device: "alpha", ok: true }),
      expect.objectContaining({ device: "beta", ok: false, error: "offline" }),
    ]),
  );
  expect(result.incidents).toEqual([]);
  expect(result.responses).toEqual([]);
});
