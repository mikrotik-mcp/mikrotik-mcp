import { beforeEach, expect, test, vi } from "vite-plus/test";
import { threatFeedTools } from "../src/tools/threat-feed";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown>) {
  const tool = threatFeedTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});
const feed = {
  name: "deny",
  url: "https://feed.example/deny.rsc",
  address_list: "bad-hosts",
  interval: "30m",
  drop: true,
  apply: false,
};

test("preview includes script, scheduler, and optional raw rule without executing", async () => {
  const preview = await call("subscribe_threat_feed", feed);
  expect(preview).toContain("DRY RUN");
  expect(preview).toContain("3 command(s)");
  expect(preview).toContain("src-address-list=bad-hosts");
  expect(command).not.toHaveBeenCalled();
  expect(await call("subscribe_threat_feed", { ...feed, drop: false })).toContain("2 command(s)");
});

test("subscription runs ordered steps and triggers first fetch after all installs", async () => {
  expect(await call("subscribe_threat_feed", { ...feed, apply: true })).toContain(
    "initial fetch was triggered",
  );
  const steps = command.mock.calls.map(([text]) => text);
  expect(steps).toHaveLength(4);
  expect(steps[0]).toContain("/system script add");
  expect(steps[1]).toContain("/system scheduler add");
  expect(steps[2]).toContain("/ip firewall raw add");
  expect(steps[3]).toBe("/system script run threat-feed-deny");
});

test("failed installation stops before later changes or initial fetch", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: invalid interval");
  expect(await call("subscribe_threat_feed", { ...feed, apply: true })).toContain(
    "Installed 1/3, then FAILED",
  );
  expect(command).toHaveBeenCalledTimes(2);
});

test("removal stops at the failed step and reports already removed components", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
  expect(await call("remove_threat_feed", { name: "deny" })).toContain(
    "Failed removing script: failure: denied (removed: scheduler)",
  );
  expect(command).toHaveBeenCalledTimes(2);
  command.mockReset().mockResolvedValue("");
  expect(await call("remove_threat_feed", { name: "deny" })).toContain(
    "Address-list entries were left in place",
  );
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    '/system scheduler remove [find name="threat-feed-deny"]',
    '/system script remove [find name="threat-feed-deny"]',
    '/ip firewall raw remove [find comment~"threat-feed: drop deny"]',
  ]);
});
