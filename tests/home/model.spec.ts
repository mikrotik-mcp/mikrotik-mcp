import { describe, expect, test } from "vite-plus/test";
import {
  policyInput,
  pingSample,
  milliseconds,
  recommendPath,
  temporaryCommands,
} from "../../src/home/model";
import { buildPolicy } from "../../src/home/policies";
import type { PolicyFacts } from "../../src/home/policies";

export function facts(): PolicyFacts {
  return {
    deviceMode: { scheduler: "yes" },
    leases: [
      {
        address: "192.168.88.10",
        "mac-address": "AA:BB:CC:DD:EE:FF",
        status: "bound",
        dynamic: "no",
      },
    ],
    filters: [],
    connections: [],
    mangle: [],
    queues: [
      { name: "house", target: "192.168.88.0/24", "max-limit": "40M/180M" },
      {
        name: "laptop",
        target: "192.168.88.10/32",
        parent: "house",
        "max-limit": "40M/180M",
        priority: "8/8",
      },
    ],
    tables: [{ name: "fiber", fib: "yes" }],
    routes: [{ "routing-table": "fiber", "dst-address": "0.0.0.0/0", active: "yes" }],
    addresses: [{ address: "192.168.88.1/24" }],
    ipv6: { "disable-ipv6": "yes" },
  };
}
const id = "6f6fd83b-3f54-4395-845f-c99edbd6d3ab";
const input = policyInput.parse({ mac: "aa:bb:cc:dd:ee:ff", action: "pause" });
describe("home policy boundaries", () => {
  test("only builds owned forward rules and router-local expiry, never input drops", () => {
    const p = buildPolicy(id, input, facts());
    expect(p.commands.filter((c) => c.startsWith("/ip firewall filter add"))).toHaveLength(2);
    expect(p.commands.join("\n")).not.toContain("chain=input");
    expect(p.commands.join("\n")).toContain("timeout=30m");
    expect(p.commands.join("\n")).toContain("interval=30s");
    expect(p.commands.join("\n")).toContain("interval=0s");
    expect(p.undo.every((c) => c.includes(id))).toBe(true);
    expect(p.commands.findIndex((c) => c.startsWith("/system scheduler add"))).toBeLessThan(
      p.commands.findIndex((c) => c.startsWith("/ip firewall filter enable")),
    );
  });
  test.each([
    "dynamic",
    "duplicate",
    "unbound",
    "router",
    "fasttrack",
    "lingering-fasttrack",
    "ipv6",
    "scheduler",
    "mac-mismatch",
  ])("refuses unsafe %s targeting", (kind) => {
    const f = facts();
    if (kind === "dynamic") f.leases[0].flags = "D";
    if (kind === "duplicate") f.leases.push({ ...f.leases[0] });
    if (kind === "unbound") f.leases[0].status = "waiting";
    if (kind === "router") f.addresses[0].address = "192.168.88.10/24";
    if (kind === "fasttrack") f.filters.push({ action: "fasttrack-connection" });
    if (kind === "lingering-fasttrack") f.connections.push({ fasttrack: "yes" });
    if (kind === "ipv6") f.ipv6 = {};
    if (kind === "scheduler") f.deviceMode = { scheduler: "no" };
    if (kind === "mac-mismatch") f.leases[0]["active-mac-address"] = "11:22:33:44:55:66";
    expect(() => buildPolicy(id, input, f)).toThrow();
  });
  test("requires a real existing route and refuses conflicting policy routing", () => {
    const a = { ...input, action: "route" as const, table: "fiber" },
      f = facts();
    const plan = buildPolicy(id, a, f);
    expect(plan.commands.join("\n")).toContain("new-routing-mark=fiber");
    expect(plan.commands.join("\n")).toContain("dst-address-type=!local");
    expect(plan.commands.join("\n")).not.toContain("/ip route add");
    expect(plan.warnings.join(" ")).toContain("IPv6 remains");
    f.mangle.push({ action: "mark-routing" });
    expect(() => buildPolicy(id, a, f)).toThrow(/routing marks/);
    f.mangle = [];
    f.routes[0].active = "no";
    expect(() => buildPolicy(id, a, f)).toThrow(/active default/);
  });
  test("keeps configuration writes below the Safe Mode history budget", () => {
    const f = facts();
    f.addresses = Array.from({ length: 45 }, (_, i) => ({ address: `10.${i}.0.1/24` }));
    expect(() => buildPolicy(id, { ...input, action: "route", table: "fiber" }, f)).toThrow(
      /bounded Safe Mode/,
    );
  });
  test("meeting priority uses a finite parent queue and guards restoration", () => {
    const a = { ...input, action: "priority" as const },
      f = facts();
    const p = buildPolicy(id, a, f);
    expect(p.commands.join("\n")).toContain("priority=1/1");
    expect(p.undo[0]).toContain('priority="1/1"');
    expect(p.undo[0]).toContain("priority=8/8");
    f.queues[0]["max-limit"] = "0/0";
    expect(() => buildPolicy(id, a, f)).toThrow(/finite parent/);
  });
  test("delayed activation has a start marker and expiry wins after reboot or changed lease", () => {
    const generated = temporaryCommands(
      id,
      { ...input, startInMinutes: 60 },
      "192.168.88.10",
      ["setup"],
      ["activate"],
      ["restore"],
    );
    expect(generated.commands).not.toContain("activate");
    expect(generated.commands.join("\n")).toContain("timeout=90m");
    expect(generated.commands.join("\n")).toContain("timeout=60m");
    const timer = generated.commands.find((c) => c.startsWith("/system scheduler add"))!;
    expect(timer.indexOf("restore")).toBeLessThan(timer.indexOf("activate"));
    expect(timer).toContain("dynamic=no status=bound");
  });
  test("configuration changes invalidate fingerprints; row numbers do not", () => {
    const f = facts(),
      p = buildPolicy(id, input, f);
    f.leases[0]["#"] = "10";
    expect(buildPolicy(id, input, f).fingerprint).toBe(p.fingerprint);
    f.leases[0].address = "192.168.88.11";
    expect(buildPolicy(id, input, f).fingerprint).not.toBe(p.fingerprint);
  });
  test("rejects arbitrary scripts, unbounded duration and malformed addresses", () => {
    expect(
      policyInput.safeParse({ ...input, mac: "AA; /system reset-configuration" }).success,
    ).toBe(false);
    expect(policyInput.safeParse({ ...input, minutes: 0 }).success).toBe(false);
    expect(policyInput.safeParse({ ...input, startInMinutes: 1441 }).success).toBe(false);
  });
});
describe("path measurement integrity", () => {
  test("parses fractional/mixed RouterOS RTT without inventing missing values", () => {
    expect(milliseconds("1s2ms500us")).toBe(1002.5);
    expect(milliseconds("oops10ms")).toBeNull();
    expect(
      pingSample("fiber", "sent=5 received=4 min-rtt=1ms avg-rtt=2ms500us max-rtt=3ms"),
    ).toMatchObject({ loss: 20, latency: 2.5, spread: 2 });
    expect(pingSample("vpn", "bad command name ping").state).toBe("unknown");
    expect(pingSample("vpn", "sent=5 received=0").latency).toBeNull();
  });
  test("never recommends a failed/unknown path or infers download speed", () => {
    const good = pingSample("fiber", "sent=5 received=5 min-rtt=9ms avg-rtt=10ms max-rtt=11ms");
    const lost = pingSample("vpn", "sent=5 received=3 min-rtt=1ms avg-rtt=2ms max-rtt=3ms");
    expect(recommendPath([lost, good], "calls")).toBe("fiber");
    expect(recommendPath([good], "download")).toBeNull();
    expect(recommendPath([pingSample("unknown", "")], "gaming")).toBeNull();
  });
});
