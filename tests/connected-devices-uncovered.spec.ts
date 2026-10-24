import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import {
  connectedDeviceTools,
  devicesView,
  sampleAllTraffic,
} from "../src/tools/connected-devices";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "connected-uncovered", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = connectedDeviceTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
beforeEach(() => command.mockReset());

test("filtered inventory exposes counts and selects the matching blocked static lease", async () => {
  command.mockImplementation(async (text) =>
    text?.includes("lease print detail")
      ? "0 address=10.0.0.7 mac-address=AA:BB:CC:DD:EE:FF host-name=Phone dynamic=no status=bound block-access=yes comment=Mine\n1 address=10.0.0.8 mac-address=11:22:33:44:55:66 host-name=Guest dynamic=yes status=bound"
      : "",
  );
  const result = await run("list_connected_devices", {
    status_filter: "bound",
    static_only: true,
    blocked_only: true,
    name_filter: "mine",
  });
  expect(result).toMatchObject({
    structuredContent: { counts: { total: 1, blocked: 1, static: 1 } },
  });
  expect(result).toMatchObject({ text: expect.stringContaining("[BLOCKED]") });
  expect(devicesView([])).toMatchObject({ counts: { total: 0, blocked: 0, static: 0 } });
});

test("device detail reports absent records and traffic wrapper returns chart payload", async () => {
  command.mockResolvedValue("");
  expect(await run("get_connected_device")).toBe("Provide a device mac or ip.");
  expect(await run("get_connected_device", { ip: "10.0.0.7" })).toBe(
    "Device not found in the DHCP lease or ARP table.",
  );
  const traffic = await run("get_device_traffic", { ip: "10.0.0.7" });
  expect(traffic).toMatchObject({
    structuredContent: { __mikrotikView: "device-traffic", source: "none" },
  });
});

test("v6 accounting snapshot accumulates bytes across samples", async () => {
  command.mockImplementation(async (text) => {
    if (text === "/ip accounting print") return "enabled: yes";
    if (text === "/ip accounting snapshot print")
      return "0 src-address=10.0.0.7 dst-address=198.51.100.1 bytes=100";
    return "";
  });
  const first = await sampleAllTraffic(ctx);
  const second = await sampleAllTraffic(ctx);
  expect(first.source).toBe("accounting");
  expect(second.hosts["10.0.0.7"]?.txBytes).toBeGreaterThan(first.hosts["10.0.0.7"]?.txBytes ?? 0);
  expect(command.mock.calls.map(([text]) => text)).toContain("/ip accounting snapshot take");
});
