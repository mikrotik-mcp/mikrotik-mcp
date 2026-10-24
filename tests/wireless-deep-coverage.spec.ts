import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { wirelessTools } from "../src/tools/wireless";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "wireless-deep", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = wirelessTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
const issued = () => command.mock.calls.map(([text]) => text);
beforeEach(() => command.mockReset());

test("modern detection skips empty wifi and selects populated wifiwave2", async () => {
  command
    .mockResolvedValueOnce("0")
    .mockResolvedValueOnce("2")
    .mockResolvedValueOnce("channel: 5180/80");
  expect(await run("get_wireless_interface_status", { interface: "wifi1" })).toContain(
    "channel: 5180/80",
  );
  expect(issued()).toEqual([
    "/interface wifi print count-only",
    "/interface wifiwave2 print count-only",
    "/interface wifiwave2 monitor wifi1 once",
  ]);
});

test("legacy create requires radio name and avoids a write", async () => {
  command
    .mockResolvedValueOnce("bad command name wifi")
    .mockResolvedValueOnce("bad command name wifiwave2")
    .mockResolvedValueOnce("1");
  expect(await run("create_wireless_interface", { name: "wlan2", ssid: "Guest" })).toContain(
    "radio_name is required",
  );
  expect(issued().every((text) => text.endsWith("print count-only"))).toBe(true);
});

test("legacy create uses legacy properties and verifies detail", async () => {
  command
    .mockResolvedValueOnce("bad command name wifi")
    .mockResolvedValueOnce("bad command name wifiwave2")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("0 name=wlan2 ssid=Guest");
  expect(
    await run("create_wireless_interface", {
      name: "wlan2",
      radio_name: "wlan1",
      ssid: "Guest",
      security_profile: "secure",
      hide_ssid: true,
    }),
  ).toContain("created successfully using /interface wireless");
  expect(issued()[3]).toContain("radio-name=wlan1");
  expect(issued()[3]).toContain("security-profile=secure");
  expect(issued()[3]).toContain("hide-ssid=yes");
  expect(issued()[4]).toBe('/interface wireless print detail where name="wlan2"');
});

test("detection error is redacted and no mutation follows", async () => {
  command.mockResolvedValueOnce("failure: password=secret invalid count");
  await expect(run("disable_wireless_interface", { name: "wifi1" })).rejects.toThrow(
    "Failed to detect wireless support",
  );
  expect(issued()).toEqual(["/interface wifi print count-only"]);
});

test("scan requires confirmation before probing or disconnecting", async () => {
  expect(
    await run("scan_wireless_networks", { interface: "wifi1", duration: 5, confirm: false }),
  ).toContain("explicit user approval");
  expect(command).not.toHaveBeenCalled();
});

test("modern interface detail includes effective configuration with secrets redacted", async () => {
  command
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("0 name=wifi1 ssid=Office password=secret")
    .mockResolvedValueOnce("0 name=wifi1 authentication-types=wpa2-psk passphrase=secret");
  const out = await run("get_wireless_interface", { name: "wifi1" });
  expect(out).toContain("ACTUAL CONFIGURATION");
  expect(out).toContain("authentication-types=wpa2-psk");
  expect(out).not.toContain("password=secret");
  expect(out).not.toContain("passphrase=secret");
  expect(issued()[2]).toBe("/interface wifi actual-configuration print detail where name=wifi1");
});

test("remove checks existence and does not send delete for absent interface", async () => {
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("0");
  expect(await run("remove_wireless_interface", { name: "wifi9" })).toContain("not found");
  expect(issued()).toEqual([
    "/interface wifi print count-only",
    '/interface wifi print count-only where name="wifi9"',
  ]);
});
