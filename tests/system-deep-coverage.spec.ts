import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { systemTools } from "../src/tools/system";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));
const ctx: ToolContext = { device: "offline", info: vi.fn(), error: vi.fn() };

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = systemTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("name=offline");
});

test.each([
  ["get_system_identity", "/system identity print", "No system identity found."],
  ["get_system_resources", "/system resource print", "No system resources found."],
  ["get_system_health", "/system health print", "No system health sensors available"],
  ["get_routerboard", "/system routerboard print", "No RouterBOARD information found."],
  ["get_system_clock", "/system clock print", "No system clock information found."],
  ["get_ntp_client", "/system ntp client print", "No NTP client information found."],
  ["get_installed_packages", "/system package print", "No installed packages found."],
  [
    "check_for_updates",
    "/system package update check-for-updates once",
    "No update information returned.",
  ],
  ["get_system_history", "/system history print", "No system history found."],
] as const)("%s reports data and empty output", async (name, command, empty) => {
  expect(await call(name)).toContain("name=offline");
  expect(execute).toHaveBeenLastCalledWith(command, ctx);
  execute.mockResolvedValueOnce("  ");
  expect(await call(name)).toContain(empty);
});

test.each([
  [
    "set_system_identity",
    { name: "Office Router" },
    "/system identity set",
    "/system identity print",
    "system identity",
  ],
  [
    "set_system_clock",
    { date: "jun/19/2026", time_zone_autodetect: false },
    "/system clock set",
    "/system clock print",
    "system clock",
  ],
  [
    "set_ntp_client",
    { enabled: false, servers: "time.example", mode: "unicast", vrf: "main" },
    "/system ntp client set",
    "/system ntp client print",
    "NTP client",
  ],
] as const)(
  "%s writes then verifies, but skips verification on failure",
  async (name, args, prefix, read, label) => {
    expect(((await call(name, args)) as string).toLowerCase()).toContain(
      `${label.toLowerCase()} updated successfully`,
    );
    expect(String(execute.mock.calls[0]?.[0])).toContain(prefix);
    expect(execute.mock.calls[1]?.[0]).toBe(read);
    execute.mockClear();
    execute.mockResolvedValueOnce("failure: denied");
    expect(await call(name, args)).toContain(`Failed to set ${label}`);
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

test("clock with no settings is a no-op; false autodetect is an explicit setting", async () => {
  expect(await call("set_system_clock")).toBe("No clock settings specified.");
  expect(execute).not.toHaveBeenCalled();
  await call("set_system_clock", { time_zone_autodetect: false });
  expect(execute.mock.calls[0]?.[0]).toContain("time-zone-autodetect=no");
});

test.each([
  ["reboot_system", "/system reboot", "Reboot"],
  ["shutdown_system", "/system shutdown", "Shutdown"],
] as const)(
  "%s requires confirmation before sending its lifecycle command",
  async (name, command, label) => {
    expect(await call(name, { confirm: false })).toContain(`${label} not confirmed`);
    expect(execute).not.toHaveBeenCalled();
    expect(await call(name, { confirm: true })).toContain(`${label} command sent`);
    expect(execute).toHaveBeenCalledExactlyOnceWith(command, ctx);
  },
);

test("lifecycle and NTP schemas reject invalid inputs", () => {
  const schema = (name: string) =>
    z.object(systemTools.find((tool) => tool.name === name)!.inputSchema);
  expect(schema("reboot_system").safeParse({ confirm: "true" }).success).toBe(false);
  expect(schema("set_ntp_client").safeParse({ mode: "invalid" }).success).toBe(false);
});
