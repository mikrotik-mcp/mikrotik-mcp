import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
import {
  bandwidthAccess,
  preflightBandwidth,
  validateBandwidthJob,
} from "../../src/bandwidth/service";
import { BandwidthJobSchema } from "../../src/bandwidth/model";
import { executeMikrotikCommand, executeMikrotikJson } from "../../src/core/connector";
vi.mock("../../src/core/connector", () => ({
  executeMikrotikCommand: vi.fn(),
  executeMikrotikJson: vi.fn(),
}));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({ isActive: false, requiresRecovery: false }),
}));
const config = () =>
  MikrotikConfigSchema.parse({
    devices: {
      a: { host: "192.0.2.1" },
      b: { host: "192.0.2.2", username: "test", password: "never-persist-this" },
    },
    defaultDevice: "a",
  });
const input = {
  ...BandwidthJobSchema.parse({
    id: "wg",
    name: "wg",
    source: "a",
    destination: "b",
    sourceInterface: "wg0",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
  }),
  nextRunAt: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(config());
  vi.mocked(executeMikrotikJson).mockImplementation(async (cmd, ctx) => ({
    format: "detail",
    columns: [],
    rows: cmd.startsWith("/ip address")
      ? [{ address: ctx.device === "a" ? "10.0.0.1/24" : "10.0.0.2/24", interface: "wg0" }]
      : cmd.startsWith("/interface")
        ? [{ name: "wg0", running: "true" }]
        : [{ active: "true", "dst-address": "10.0.0.2/32", gateway: "wg0" }],
  }));
  vi.mocked(executeMikrotikCommand).mockResolvedValue("enabled: yes\nauthenticate: yes");
});
test("preflight validates addressing, running interface, route, server and credentials using reads only", async () => {
  const result = await preflightBandwidth(validateBandwidthJob(input));
  expect(result.ready).toBe(true);
  expect(JSON.stringify(result)).not.toContain("never-persist-this");
  expect(result.warning).toContain("not bindings");
  for (const [cmd] of [
    ...vi.mocked(executeMikrotikJson).mock.calls,
    ...vi.mocked(executeMikrotikCommand).mock.calls,
  ])
    expect(cmd).toMatch(/ print(?: |$)/);
  expect(executeMikrotikCommand).toHaveBeenCalledWith(
    "/tool bandwidth-server print",
    expect.objectContaining({ device: "b" }),
  );
});
test("server truth values support both SSH and REST formatter output", async () => {
  vi.mocked(executeMikrotikCommand).mockResolvedValue("enabled: true\nauthenticate: true");
  expect((await preflightBandwidth(input)).ready).toBe(true);
  vi.mocked(executeMikrotikCommand).mockResolvedValue("enabled: no\nauthenticate: yes");
  expect((await preflightBandwidth(input)).ready).toBe(false);
});
test("disabled/missing/passwordless and transport states fail closed", async () => {
  const cfg = config();
  cfg.devices.b.password = "";
  cfg.devices.a.api = false;
  setConfig(cfg);
  expect((await preflightBandwidth(input)).checks.find((c) => c.name === "transport")?.ok).toBe(
    true,
  );
  expect((await preflightBandwidth(input)).ready).toBe(false);
  cfg.devices.a.api = true;
  setConfig(cfg);
  expect((await preflightBandwidth(input)).checks.find((c) => c.name === "transport")?.ok).toBe(
    false,
  );
  vi.mocked(executeMikrotikJson).mockRejectedValue(new Error("secret raw command"));
  const result = await preflightBandwidth(input);
  expect(result.ready).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret raw command");
});
test("canonical identities, unknown routers, invalid source and read-only authorization are enforced", () => {
  expect(() => validateBandwidthJob({ ...input, destination: "a" })).toThrow();
  expect(() => validateBandwidthJob({ ...input, destination: "unknown" })).toThrow();
  expect(() => validateBandwidthJob({ ...input, sourceAddress: "127.0.0.1" })).toThrow();
  const cfg = config();
  cfg.readOnly = true;
  setConfig(cfg);
  expect(() => bandwidthAccess(input, true)).toThrow();
  expect(() => bandwidthAccess(input, false)).not.toThrow();
});
