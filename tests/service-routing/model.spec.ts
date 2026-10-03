import { describe, it, expect } from "vite-plus/test";
import {
  routingInput,
  planCommands,
  chooseExit,
  fingerprint,
  ownerTag,
} from "../../src/service-routing/model";
import type { RoutingPolicy, RoutingFacts, PathSample } from "../../src/service-routing/model";
import { parseRecords } from "../../src/core/routeros-parse";
import { fetchCommand } from "../../src/service-routing/service";

const policy: RoutingPolicy = {
  id: "cdd5432f-72cb-44e4-b70e-0fc27505bf62",
  device: "lab",
  updatedAt: 0,
  name: "Example",
  target: "example",
  host: "example.com",
  family: "ipv4",
  sources: ["10.0.0.0/24"],
  tables: ["main", "warp"],
  primary: "main",
  maxLatencyMs: 5000,
  failuresBeforeSwitch: 3,
  cooldownSeconds: 120,
  state: "draft",
  samples: [],
  history: [],
};
const facts: RoutingFacts = {
  tables: [
    { name: "main", fib: "yes" },
    { name: "warp", fib: "yes" },
  ],
  routes: [
    { "routing-table": "main", "dst-address": "0.0.0.0/0", active: "yes" },
    { "routing-table": "warp", "dst-address": "0.0.0.0/0", active: "yes" },
  ],
  mangle: [],
  filters: [],
  vrfs: [{ name: "main" }],
  addresses: [],
};
describe("service routing safety", () => {
  it("rejects wrong families, default source scope, duplicate/unapproved exits", () => {
    expect(routingInput.safeParse({ ...policy, sources: ["::/64"] }).success).toBe(false);
    expect(routingInput.safeParse({ ...policy, sources: ["0.0.0.0/0"] }).success).toBe(false);
    expect(routingInput.safeParse({ ...policy, primary: "other" }).success).toBe(false);
    expect(routingInput.safeParse({ ...policy, tables: ["main", "main"] }).success).toBe(false);
    expect(routingInput.safeParse(policy).success).toBe(true);
  });
  it("uses exact ownership, forwarded traffic, private exclusions and DNS-backed lists", () => {
    const commands = planCommands(policy, "main", facts).join("\n");
    expect(commands).toContain("address=example.com");
    expect(commands).toContain("src-address-list=mcp-sr-");
    expect(commands).toContain("chain=prerouting");
    expect(commands).toContain("dst-address-type=!local");
    expect(commands).toContain("dst-address=10.0.0.0/8");
    expect(commands).not.toContain("chain=input");
    expect(commands).not.toContain("chain=output");
    expect(commands).toContain(`comment=${ownerTag(policy.id)}`);
  });
  it("keeps IPv6 in its own rule namespace", () => {
    const p = { ...policy, family: "ipv6" as const, sources: ["fd10::/64"] };
    const commands = planCommands(p, "main", {
      ...facts,
      routes: [{ "routing-table": "main", "dst-address": "::/0", active: "yes" }],
    }).join("\n");
    expect(commands).toContain("/ipv6 firewall");
    expect(commands).not.toContain("/ip firewall");
    expect(commands).toContain("fc00::/7");
  });
  it("blocks missing routes, FastTrack, foreign marks and chain jumps", () => {
    expect(() => planCommands(policy, "main", { ...facts, routes: [] })).toThrow(/default route/);
    expect(() =>
      planCommands(policy, "main", { ...facts, filters: [{ action: "fasttrack-connection" }] }),
    ).toThrow(/FastTrack/);
    for (const action of ["jump", "mark-routing", "route"])
      expect(() => planCommands(policy, "main", { ...facts, mangle: [{ action }] })).toThrow(
        /conflict/,
      );
  });
  it("only changes intact owned marks and refuses scope tampering", () => {
    const mangle = planCommands(policy, "main", facts)
      .filter((c) => c.startsWith("/ip firewall mangle"))
      .map((c) => parseRecords(`0 ${c}`).rows[0]);
    const active = { ...policy, state: "active" as const, activeTable: "main" };
    const addresses = planCommands(policy, "main", facts)
      .filter((c) => c.startsWith("/ip firewall address-list"))
      .map((c) => parseRecords(`0 ${c}`).rows[0]);
    expect(planCommands(active, "warp", { ...facts, mangle, addresses })).toHaveLength(1);
    expect(() =>
      planCommands(active, "warp", {
        ...facts,
        addresses,
        mangle: mangle.map((r) =>
          r.action === "jump" ? { ...r, "src-address-list": "everyone" } : r,
        ),
      }),
    ).toThrow(/scope/);
    expect(() => planCommands(policy, "main", { ...facts, mangle, addresses })).toThrow(
      /Unexpected/,
    );
    expect(() => planCommands(active, "warp", { ...facts, mangle, addresses: [] })).toThrow(
      /scope/,
    );
  });
  it("removes only exact owned selectors and never replays uncertainty", () => {
    expect(planCommands(policy, "main", facts, true)).toHaveLength(2);
    expect(planCommands(policy, "main", facts, true).join(" ")).toContain(
      `[find where comment=${ownerTag(policy.id)}]`,
    );
    expect(() => planCommands({ ...policy, state: "uncertain" }, "main", facts, true)).toThrow(
      /Reconcile/,
    );
  });
  it("fingerprints ignore counters but bind to changed routing scope", () => {
    expect(fingerprint({ ...facts, mangle: [{ bytes: "1" }] })).toBe(
      fingerprint({ ...facts, mangle: [{ bytes: "500" }] }),
    );
    expect(fingerprint(facts)).not.toBe(
      fingerprint({ ...facts, mangle: [{ action: "mark-routing" }] }),
    );
  });
  it("pins HTTPS fetch to a VRF and validated IP with no redirects or bodies", () => {
    const command = fetchCommand("203.0.113.5", "warp", "example.com", "/health", 443);
    expect(command).toContain("203.0.113.5@warp");
    expect(command).toContain("check-certificate=yes");
    expect(command).toContain("http-max-redirect-count=0");
    expect(command).toContain("http-method=head");
    expect(command).toContain("output=none");
    expect(
      fetchCommand("203.0.113.5", "warp", "example.com", "/x\n:put hacked", 443),
    ).not.toContain("\n");
  });
});
describe("failover hysteresis", () => {
  const now = 1_000_000;
  const samples: PathSample[] = [0, 1, 2].flatMap((i) => [
    { table: "main", at: now - i * 30000, state: "fail" as const, detail: "Failed" },
    { table: "warp", at: now - i * 30000, state: "pass" as const, detail: "Passed" },
  ]);
  const active: RoutingPolicy = {
    ...policy,
    state: "active",
    activeTable: "main",
    armedUntil: now + 60000,
    samples,
  };
  it("switches only after consecutive failures plus repeated passing fallback evidence", () =>
    expect(chooseExit(active, now)).toBe("warp"));
  it("does not switch on UNKNOWN or missing evidence", () => {
    expect(
      chooseExit(
        {
          ...active,
          samples: samples.map((s) => (s.table === "main" ? { ...s, state: "unknown" } : s)),
        },
        now,
      ),
    ).toBeUndefined();
    expect(chooseExit({ ...active, samples: samples.slice(0, 2) }, now)).toBeUndefined();
  });
  it("respects cooldown, expiry, stale evidence and inactive states", () => {
    expect(chooseExit({ ...active, lastSwitchAt: now - 1000 }, now)).toBeUndefined();
    expect(chooseExit({ ...active, armedUntil: now }, now)).toBeUndefined();
    expect(chooseExit({ ...active, state: "uncertain" }, now)).toBeUndefined();
    expect(chooseExit({ ...active, armedUntil: now + 900000 }, now + 200000)).toBeUndefined();
  });
});
