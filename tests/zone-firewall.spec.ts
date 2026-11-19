/** Zone-based firewall: a description becomes interface lists and filter rules. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { checkZoneDesign, compileZones } from "../src/core/zone-firewall";
import type { ZoneDesign } from "../src/core/zone-firewall";

const command = vi.hoisted(() => vi.fn());
const applied = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/core/runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveDeviceName: (name?: string) => name ?? "edge",
}));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: async () => "snap_1" }));
vi.mock("../src/utils/safe-mode-apply", () => ({ applyWritesSafely: applied }));
const { zoneFirewallTools } = await import("../src/tools/zone-firewall");

const design: ZoneDesign = {
  zones: [
    { name: "lan", interfaces: ["bridge"] },
    { name: "guest", interfaces: ["vlan20"] },
    { name: "wan", interfaces: ["ether1"] },
  ],
  policies: [
    { from: "lan", to: "wan", action: "accept" },
    {
      from: "guest",
      to: "wan",
      action: "accept",
      protocol: "tcp",
      ports: "80,443",
      note: "web only",
    },
    { from: "lan", to: "router", action: "accept", protocol: "tcp", ports: "22,8291" },
  ],
  protectRouter: true,
};

test("a sound design has no problems; unsafe ones are named", () => {
  expect(checkZoneDesign(design)).toEqual([]);
  const bad = checkZoneDesign({
    zones: [
      { name: "LAN", interfaces: ["bridge"] },
      { name: "guest", interfaces: ["bridge"] },
      { name: "router", interfaces: ["x"] },
      { name: "empty", interfaces: [] },
    ],
    policies: [
      { from: "guest", to: "nowhere", action: "accept" },
      { from: "guest", to: "router", action: "drop", ports: "22" },
      { from: "guest", to: "empty", action: "accept", protocol: "tcp", ports: "22; /system reset" },
    ],
    protectRouter: true,
  });
  const text = bad.join("\n");
  expect(text).toContain("Zone name 'LAN'");
  expect(text).toContain("Interface 'bridge' is in two zones");
  expect(text).toContain("'router' is the router itself");
  expect(text).toContain("Zone 'empty' has no interface");
  expect(text).toContain("unknown zone 'nowhere'");
  expect(text).toContain("ports need a protocol");
  expect(text).toContain("is not a port list");
  // No accept to the router: turning on protection would lock everyone out.
  expect(text).toContain("protect_router needs at least one accept policy to 'router'");
});

test("the plan orders lists, replies, policies, then a default drop for each zone", () => {
  const plan = compileZones(design);
  expect(plan.groups.map((g) => g.label)).toEqual([
    "zones (interface lists)",
    "traffic between zones (forward)",
    "traffic to the router (input)",
  ]);
  const [lists, forward, input] = plan.groups.map((g) => g.commands);
  expect(lists).toContain('/interface list add name=zone-guest comment="zone-fw: zone guest"');
  expect(lists).toContain(
    '/interface list member add list=zone-wan interface=ether1 comment="zone-fw: zone wan"',
  );
  expect(forward![0]).toContain("connection-state=established,related,untracked");
  expect(forward![1]).toContain("connection-state=invalid");
  expect(forward).toContain(
    '/ip firewall filter add chain=forward action=accept in-interface-list=zone-guest out-interface-list=zone-wan protocol=tcp dst-port=80,443 connection-state=new comment="zone-fw: guest to wan (web only)"',
  );
  // The default drops come last, one for each zone.
  expect(
    forward!.slice(-3).every((c) => c.includes("action=drop") && c.includes("default drop from")),
  ).toBe(true);
  expect(input).toContain(
    '/ip firewall filter add chain=input action=accept in-interface-list=zone-lan protocol=tcp dst-port=22,8291 connection-state=new comment="zone-fw: lan to router"',
  );
  expect(input!.at(-1)).toContain("default drop to router from wan");
  // Every created item can be found again.
  expect(
    plan.groups.flatMap((g) => g.commands).every((c) => c.includes('comment="zone-fw: ')),
  ).toBe(true);

  const open = compileZones({ ...design, protectRouter: false, policies: [] });
  expect(open.groups).toHaveLength(2);
  expect(open.notes.join(" ")).toContain("The router itself is not protected");
});

const ctx = { device: "edge", info() {}, error() {} };
const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const tool = zoneFirewallTools.find((t) => t.name === name)!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool.inputSchema).parse(args),
    ctx,
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};
const args = {
  zones: design.zones,
  policies: design.policies,
  protect_router: true,
};

beforeEach(() => {
  command.mockReset();
  applied.mockReset();
  applied.mockResolvedValue({
    applied: 17,
    total: 17,
    safeMode: "committed",
    committed: true,
    fellBack: false,
  });
});

test("the tool checks the router, shows a dry run, and applies only in Safe Mode", async () => {
  command.mockImplementation(async (cmd: string) =>
    cmd === "/interface print detail"
      ? ' 0 name="bridge"\n 1 name="vlan20"\n 2 name="ether1"'
      : "0",
  );
  const dry = await run("design_zone_firewall", args);
  expect(dry).toContain("DRY RUN — 19 command(s) for 3 zone(s) and 3 policy(ies)");
  expect(applied).not.toHaveBeenCalled();

  const done = await run("design_zone_firewall", { ...args, apply: true });
  expect(done).toContain("snapshot=snap_1  safe-mode=committed");
  expect(applied.mock.calls[0]![2]).toHaveLength(19);
  expect(applied.mock.calls[0]![3]).toEqual({ allowDirectFallback: false });

  // An interface the router does not have, or a design that is already there, stops it.
  command.mockImplementation(async (cmd: string) =>
    cmd === "/interface print detail" ? ' 0 name="bridge"\n 1 name="ether1"' : "2",
  );
  applied.mockClear();
  const refused = await run("design_zone_firewall", { ...args, apply: true });
  expect(refused).toContain("Interface 'vlan20' (zone 'guest') is not on this router.");
  expect(refused).toContain("A zone firewall is already on this router.");
  expect(applied).not.toHaveBeenCalled();
});

test("removing takes only tagged items, rules first, and shows a dry run", async () => {
  command.mockImplementation(async (cmd: string) => (cmd.includes("count-only") ? "3" : ""));
  expect(await run("remove_zone_firewall", {})).toContain(
    "DRY RUN — would remove 3 filter rule(s), 3 list member(s), 3 zone list(s)",
  );
  command.mockClear();
  expect(await run("remove_zone_firewall", { apply: true })).toContain("Zone firewall removed");
  const removes = command.mock.calls.map((c) => String(c[0])).filter((c) => c.includes("remove"));
  expect(removes).toEqual([
    '/ip firewall filter remove [find comment~"^zone-fw: "]',
    '/interface list member remove [find comment~"^zone-fw: "]',
    '/interface list remove [find comment~"^zone-fw: "]',
  ]);
  command.mockImplementation(async () => "0");
  expect(await run("remove_zone_firewall", { apply: true })).toBe(
    "No zone firewall is on this router.",
  );
});
