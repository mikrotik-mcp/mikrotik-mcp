import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { buildPolicyCommands, parentalControlsTools } from "../src/tools/parental-controls";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "offline", info: vi.fn(), error: vi.fn() } as ToolContext;
const run = (name: string, args: Record<string, unknown>) =>
  parentalControlsTools.find((tool) => tool.name === name)!.handler(args, ctx);
const input = {
  name: "kids",
  list: "children",
  addresses: ["192.0.2.5"],
  block_start: "22:00",
  block_end: "07:00",
  block_domains: ["example.test"],
};
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

describe("parental control plans and execution", () => {
  it("builds tagged target, initially disabled rule, daily toggles, and sinkhole", () => {
    const groups = buildPolicyCommands({
      name: "kids",
      list: "children",
      addresses: ["192.0.2.5"],
      blockStart: "22:00",
      blockEnd: "07:00",
      blockDomains: ["example.test"],
    });
    expect(groups.map((group) => group.label)).toEqual([
      "Target devices",
      "Scheduled internet cut-off",
      "Content blocking (DNS sinkhole)",
    ]);
    expect(groups.flatMap((group) => group.commands)).toHaveLength(5);
    expect(groups[1].commands[0]).toContain("disabled=yes");
    expect(groups[1].commands[1]).toContain("start-time=22:00");
    expect(groups[1].commands[2]).toContain("start-time=07:00");
    expect(groups[2].commands[0]).toContain("address=0.0.0.0");
  });

  it("previews every command without executing", async () => {
    const result = await run("set_time_policy", { ...input, apply: false });
    expect(result).toContain("5 command(s)");
    expect(result).toContain("# Content blocking (DNS sinkhole)");
    expect(command).not.toHaveBeenCalled();
  });

  it("applies in order and stops at the first error with an accurate count", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
    expect(await run("set_time_policy", { ...input, apply: true })).toContain(
      "Installed 1/5, then FAILED",
    );
    expect(command).toHaveBeenCalledTimes(2);
    command.mockReset().mockResolvedValue("");
    expect(await run("set_time_policy", { ...input, apply: true })).toContain(
      "1 domain(s) sinkholed",
    );
    expect(command).toHaveBeenCalledTimes(5);
  });

  it("removes tagged resources in order and names a partial failure", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: busy");
    expect(await run("remove_time_policy", { name: "kids" })).toContain(
      "Failed removing firewall rule: failure: busy (cleared: schedulers)",
    );
    expect(command.mock.calls.map(([text]) => text)).toEqual([
      '/system scheduler remove [find comment="parental-kids"]',
      '/ip firewall filter remove [find comment="parental-kids"]',
    ]);
  });
});
