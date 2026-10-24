import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { multiwanTools } from "../src/tools/multiwan";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "offline", info: vi.fn(), error: vi.fn() } as ToolContext;
const run = (name: string, args: Record<string, unknown>) =>
  multiwanTools.find((tool) => tool.name === name)!.handler(args, ctx);
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

describe("multi-WAN route plans", () => {
  it("previews ordered failover distances without router contact", async () => {
    const result = await run("setup_wan_failover", {
      primary_gateway: "192.0.2.1",
      backup_gateways: ["198.51.100.1", "203.0.113.1"],
      check: "ping",
      comment_prefix: "test",
      apply: false,
    });
    expect(result).toContain("3 command(s) would run");
    expect(result).toMatch(
      /gateway=192\.0\.2\.1 distance=1[\s\S]*gateway=198\.51\.100\.1 distance=2[\s\S]*gateway=203\.0\.113\.1 distance=3/,
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("reports partial failure and skips the route read", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: unreachable");
    const result = await run("setup_wan_failover", {
      primary_gateway: "192.0.2.1",
      backup_gateways: ["198.51.100.1", "203.0.113.1"],
      check: "arp",
      comment_prefix: "test",
      apply: true,
    });
    expect(result).toContain("Applied 1/3 commands, then FAILED");
    expect(result).toContain("Ran: /ip route add");
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("creates one ECMP route and reads default routes after success", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("route table");
    const result = await run("setup_wan_loadbalance", {
      gateways: ["192.0.2.1", "198.51.100.1"],
      check: "ping",
      comment: "ecmp",
      apply: true,
    });
    expect(command.mock.calls[0][0]).toContain("gateway=192.0.2.1,198.51.100.1");
    expect(command.mock.calls[1][0]).toBe('/ip route print where dst-address="0.0.0.0/0"');
    expect(result).toContain("route table");
  });
});
