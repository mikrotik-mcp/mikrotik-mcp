import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { systemConfigTools } from "../src/tools/system-config";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = systemConfigTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown system tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("0 name=fixture enabled=yes");
});

test.each([
  ["list_system_console", "/system console print", "No system console entries"],
  ["list_leds", "/system leds print", "No LEDs"],
  ["get_leds_settings", "/system leds settings print", "No LED settings"],
  ["get_license", "/system license print", "No license information"],
  ["get_note", "/system note print", "No system note"],
  ["get_ntp_server", "/system ntp server print", "No NTP server information"],
  ["get_watchdog", "/system watchdog print", "No watchdog information"],
  ["list_special_login", "/system special-login print", "No special-login entries"],
] as const)("%s reads the right menu and reports absent data", async (name, menu, emptyMessage) => {
  expect(await call(name)).toContain("fixture");
  expect(execute).toHaveBeenLastCalledWith(menu, ctx);
  execute.mockResolvedValueOnce("");
  expect(await call(name)).toContain(emptyMessage);
});

test.each([
  ["get_license", "License info not available"],
  ["get_ntp_server", "NTP server is not available"],
  ["get_regulatory", "No wireless regulatory/country information"],
  ["list_special_login", "Special login is not available"],
] as const)("%s explains unsupported hardware/version", async (name, expected) => {
  execute.mockResolvedValueOnce("bad command name");
  expect(await call(name)).toContain(expected);
});

test("serial-port filter and lookup use the requested name", async () => {
  expect(await call("list_ports", { name_filter: "serial" })).toContain("SERIAL PORTS");
  expect(execute.mock.calls[0]?.[0]).toContain('name~"serial"');
  expect(await call("get_port", { name: "serial0" })).toContain("SERIAL PORT DETAILS");
  expect(execute.mock.calls[1]?.[0]).toContain('name="serial0"');
  execute.mockResolvedValueOnce("");
  expect(await call("get_port", { name: "missing" })).toContain("not found");
});

test.each([
  [
    "set_leds_settings",
    { all_leds_off: "after-1h" },
    "/system leds settings set",
    "LED settings updated",
  ],
  [
    "set_note",
    { note: "Maintenance", show_at_login: true },
    "/system note set",
    "System note updated",
  ],
  [
    "set_ntp_server",
    { enabled: true, broadcast: false, use_local_clock: true, local_clock_stratum: 4 },
    "/system ntp server set",
    "NTP server updated",
  ],
  [
    "set_port",
    { name: "serial0", baud_rate: "115200", data_bits: 8, parity: "none" },
    "/port set",
    "Serial port updated",
  ],
  [
    "set_watchdog",
    { watchdog_timer: true, watch_address: "192.0.2.1", ping_timeout: "1m" },
    "/system watchdog set",
    "Watchdog updated",
  ],
] as const)(
  "%s is a no-op without settings and confirms a successful update",
  async (name, args, menu, success) => {
    const emptyArgs = name === "set_port" ? { name: "serial0" } : {};
    expect(await call(name, emptyArgs)).toContain("No updates specified");
    expect(execute).not.toHaveBeenCalled();
    expect(await call(name, args)).toContain(success);
    expect(execute.mock.calls[0]?.[0]).toContain(menu);
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockReset();
    execute.mockResolvedValueOnce("failure: denied");
    expect(await call(name, args)).toContain("Failed to set");
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

test("password rotation never exposes either credential in replies or logging", async () => {
  const oldPassword = "secret-old";
  const newPassword = "secret-new";
  expect(
    await call("change_password", { old_password: oldPassword, new_password: newPassword }),
  ).toBe("Password changed successfully.");
  expect(execute.mock.calls[0]?.[0]).toContain("old-password=secret-old");
  expect(execute.mock.calls[0]?.[0]).toContain("confirm-new-password=secret-new");
  execute.mockResolvedValueOnce("failure: secret-old rejected");
  const failure = await call("change_password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
  expect(failure).toContain("Failed to change password");
  expect(failure).not.toContain(oldPassword);
  expect(failure).not.toContain(newPassword);
  expect(ctx.info).not.toHaveBeenCalledWith(expect.stringContaining(oldPassword));
});

test("factory reset never sends a command without explicit confirmation", async () => {
  expect(await call("reset_configuration", { confirm: false })).toContain("Reset not confirmed");
  expect(execute).not.toHaveBeenCalled();
  expect(
    await call("reset_configuration", {
      confirm: true,
      keep_users: true,
      no_defaults: true,
      skip_backup: false,
      caps_mode: true,
      run_after_reset: "restore.rsc",
    }),
  ).toContain("Reset command sent");
  const issued = String(execute.mock.calls[0]?.[0]);
  expect(issued).toContain("/system reset-configuration");
  expect(issued).toContain("keep-users");
  expect(issued).toContain("run-after-reset=restore.rsc");
});
