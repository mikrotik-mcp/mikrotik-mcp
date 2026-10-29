import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { firewallFilterTools } from "../src/tools/firewall-filter";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "filter-uncovered", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = firewallFilterTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
beforeEach(() => command.mockReset());

test("combined protocol and interface filter keeps only matching detail blocks", async () => {
  command.mockResolvedValue(
    "0 .id=*A chain=forward protocol=tcp in-interface-list=WAN action=accept\n1 .id=*B chain=forward protocol=udp out-interface-list=WAN action=drop",
  );
  const result = await run("list_filter_rules", {
    protocol_filter: "TCP",
    interface_filter: "wan",
  });
  expect(result).toContain("*A");
  expect(result).not.toContain("*B");
});

test("move reports a silent RouterOS no-op after reading order back", async () => {
  command.mockImplementation(async (text) => {
    if (text?.startsWith(":foreach")) return "*A\n*B";
    if (text?.includes("print count-only")) return "1";
    return "";
  });
  const result = await run("move_filter_rule", { rule_id: "*A", destination: 99 });
  expect(result).toContain("NO CHANGE");
  expect(command.mock.calls.some(([text]) => text?.includes(" move "))).toBe(false);
});

test("move resolves position zero to the target rule ID and verifies order", async () => {
  let moved = false;
  command.mockImplementation(async (text) => {
    if (!text) return "";
    if (text?.includes("print count-only")) return "1";
    if (text?.startsWith(":foreach")) return moved ? "*B\n*A" : "*A\n*B";
    if (text === "/ip firewall filter move *B *A") {
      moved = true;
      return "";
    }
    throw new Error(`Unexpected command: ${text}`);
  });
  expect(await run("move_filter_rule", { rule_id: "*B", destination: 0 })).toContain(
    "moved to position 0",
  );
  expect(moved).toBe(true);
});

test("basic setup reports each mocked RouterOS add result", async () => {
  command
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("*2")
    .mockResolvedValueOnce("failure: denied")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("*5");
  const result = await run("create_basic_firewall_setup");
  expect(result).toContain("Rule 1 (established/related): Created");
  expect(result).toContain("Rule 3 (ICMP): failure: denied");
  expect(command).toHaveBeenCalledTimes(5);
});
