import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { wirelessTools } from "../src/tools/wireless";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "wireless-uncovered", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = wirelessTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
beforeEach(() => command.mockReset());

test("list applies combined filters and reports a redacted read failure", async () => {
  command.mockImplementation(async (text) =>
    text?.includes("print detail") ? "failure: password=secret denied" : "bad command name wifi",
  );
  expect(
    await run("list_wireless_interfaces", {
      name_filter: "guest",
      disabled_only: true,
      running_only: true,
    }),
  ).toContain("Failed to list wireless interfaces");
  const issued = command.mock.calls.map(([text]) => text);
  expect(
    issued.some(
      (text) =>
        text.includes("name~guest") &&
        text.includes("disabled=yes") &&
        text.includes("running=yes"),
    ),
  ).toBe(true);
});

test("modern effective configuration failure is returned without exposing secrets", async () => {
  command
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("0 name=wifi1")
    .mockResolvedValueOnce("failure: password=secret denied");
  const result = await run("get_wireless_interface", { name: "wifi1" });
  expect(result).toContain("Failed to read effective Wi-Fi configuration");
  expect(result).not.toContain("secret");
});

test("v7 access-list stubs explain unsupported operations", async () => {
  command.mockResolvedValue("1");
  expect(await run("create_wireless_access_list")).toContain("RouterOS v7.x");
  expect(await run("list_wireless_access_list")).toContain("RouterOS v7.x");
  expect(await run("remove_wireless_access_list_entry", { entry_id: "*1" })).toContain(
    "RouterOS v7.x",
  );
});

test("update rejects a missing interface before issuing set", async () => {
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("0");
  expect(await run("update_wireless_interface", { name: "wifi9", ssid: "Guest" })).toContain(
    "not found",
  );
  expect(command.mock.calls.some(([text]) => text.includes(" set "))).toBe(false);
});
