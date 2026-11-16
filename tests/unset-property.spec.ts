/**
 * `update_*` tools can UNSET a property (RouterOS `!prop`), not only set one.
 * Offline: the connector is mocked and only the issued commands are checked.
 */
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { Cmd, unsetFragments } from "../src/core/routeros";
import { unsetProperties } from "../src/core/schema";
import { allToolModules } from "../src/tools/index";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({
  executeMikrotikCommand: command,
  executeMikrotikJson: vi.fn(),
}));

const ctx: ToolContext = { device: "unset", info: vi.fn(), error: vi.fn() };
const tools = allToolModules.flat();
const issued = () => command.mock.calls.map(([text]) => text);
function run(name: string, args: Record<string, unknown>) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  command.mockReset();
  // Existence checks answer "1 item"; every other command succeeds silently.
  command.mockImplementation(async (text) => (text.includes("count-only") ? "1" : ""));
});

describe("unsetFragments / Cmd.unset", () => {
  test("builds `!prop` and accepts snake_case", () => {
    expect(unsetFragments(["dst-address", "src_address_list"])).toEqual([
      "!dst-address",
      "!src-address-list",
    ]);
    expect(new Cmd("/ip firewall filter set *1").unset(["dst_address"]).build()).toBe(
      "/ip firewall filter set *1 !dst-address",
    );
    expect(new Cmd("/x set *1").unset(undefined).build()).toBe("/x set *1");
  });

  test.each(["a=b", "x y", "a;/system reset-configuration", "", "[find]", 'a"b'])(
    "rejects %j instead of sending it to the device",
    (name) => {
      expect(() => unsetFragments([name])).toThrow("Invalid property name");
      expect(z.object({ unset: unsetProperties }).safeParse({ unset: [name] }).success).toBe(false);
    },
  );
});

describe("update_* tools", () => {
  test("update_filter_rule unsets a matcher without setting anything", async () => {
    const out = await run("update_filter_rule", { rule_id: "*1", unset: ["dst_address"] });
    const set = issued().find((text) => text.startsWith("/ip firewall filter set"));
    expect(set).toMatch(/^\/ip firewall filter set \S+ !dst-address$/);
    expect(out).not.toContain("No updates specified");
  });

  test("update_filter_rule can set one property and unset another in one call", async () => {
    await run("update_filter_rule", { rule_id: "*1", dst_port: "8080", unset: ["dst-address"] });
    const set = issued().find((text) => text.startsWith("/ip firewall filter set"));
    expect(set).toContain("!dst-address");
    expect(set).toContain("dst-port=8080");
  });

  test("a Cmd-built tool (update_simple_queue) appends the unset fragment", async () => {
    await run("update_simple_queue", { name: "q1", unset: ["burst-limit"] });
    expect(issued().some((text) => /\/queue simple set .* !burst-limit$/.test(text))).toBe(true);
  });

  test("every RouterOS item update tool exposes `unset`", () => {
    // Not RouterOS items, or single-instance settings menus where `!prop` does
    // not apply. Adding an update tool? It must take `unset` or be listed here.
    const exempt = new Set([
      "update_alert_rule",
      "update_mcp_settings",
      "update_device_mode_features",
      "update_bgp_instance_med_comparison",
      "update_container",
      "update_user",
      "update_user_group",
      "update_ipv6_settings",
      "update_routing_settings",
      "update_igmp_proxy_settings",
      "update_bandwidth_server",
      "update_mac_server",
      "update_mac_winbox",
      "update_mac_ping",
      "update_romon",
      "update_sms_settings",
      "update_sniffer_settings",
      "update_web_proxy",
    ]);
    const missing = tools
      .filter((tool) => tool.name.startsWith("update_") && !exempt.has(tool.name))
      .filter((tool) => !("unset" in (tool.inputSchema ?? {})))
      .map((tool) => tool.name);
    expect(missing).toEqual([]);
  });
});
