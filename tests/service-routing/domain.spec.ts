import { describe, it, expect } from "vite-plus/test";
import { routingDomain, wildcardRegexp, domainMatches } from "../../src/service-routing/domain";
import { routingInput, planCommands, fingerprint, ownerTag } from "../../src/service-routing/model";
import type { RoutingPolicy, RoutingFacts, Row } from "../../src/service-routing/model";
import { parseRecords } from "../../src/core/routeros-parse";

const p: RoutingPolicy = {
  ...routingInput.parse({
    name: "Wildcard",
    domain: "*.example.com",
    dnsLearningConfirmed: true,
    family: "ipv4",
    sources: ["10.0.0.0/24"],
    tables: ["warp"],
    primary: "warp",
  }),
  id: "cdd5432f-72cb-44e4-b70e-0fc27505bf62",
  device: "lab",
  host: "*.example.com",
  updatedAt: 0,
  state: "draft",
  samples: [],
  history: [],
};
const facts: RoutingFacts = {
  tables: [{ name: "warp", fib: "yes" }],
  routes: [
    { "routing-table": "warp", "dst-address": "0.0.0.0/0", active: "yes", gateway: "192.0.2.1" },
  ],
  mangle: [],
  filters: [],
  vrfs: [],
  addresses: [],
  dns: [],
  version: "7.24.2 (stable)",
  dnsRemoteRequests: true,
};
describe("domain routing", () => {
  it("normalizes domains but rejects URLs, IPs, injection and arbitrary patterns", () => {
    expect(routingDomain.parse("  API.Example.com ")).toBe("api.example.com");
    for (const bad of [
      "*",
      "*.com",
      "foo.*.com",
      "example.*",
      "https://example.com",
      "x.com/path",
      "x.com:443",
      "a.com;:put hacked",
      "127.0.0.1",
      "::1",
      "a..com",
      "-a.com",
      "a-.com",
      "a.com.",
      `${"a".repeat(64)}.com`,
    ])
      expect(routingDomain.safeParse(bad).success, bad).toBe(false);
  });
  it("anchors wildcard at label boundaries and excludes the apex", () => {
    const re = new RegExp(wildcardRegexp("*.example.com"));
    for (const host of ["a.example.com", "a.b.example.com"]) {
      expect(re.test(host)).toBe(true);
      expect(domainMatches(p.host, host)).toBe(true);
    }
    for (const host of ["example.com", "badexample.com", "a.example.com.evil", "a.exampleXcom"]) {
      expect(re.test(host)).toBe(false);
      expect(domainMatches(p.host, host)).toBe(false);
    }
    expect(domainMatches("example.com", "other.example.com")).toBe(false);
  });
  it("allows manual domains without probe approvals but requires wildcard acknowledgement", () => {
    expect(
      routingInput.safeParse({ ...p, domain: "api.example.com", dnsLearningConfirmed: false })
        .success,
    ).toBe(true);
    expect(routingInput.safeParse({ ...p, dnsLearningConfirmed: false }).success).toBe(false);
    expect(routingInput.safeParse({ ...p, domain: undefined }).success).toBe(false);
  });
  it("plans an owned FWD learner, never a literal wildcard address or DNS exposure", () => {
    const commands = planCommands(p, "warp", facts);
    const dns = commands.find((c) => c.startsWith("/ip dns static add"))!;
    expect(parseRecords(`0 ${dns}`).rows[0]).toMatchObject({
      regexp: wildcardRegexp(p.host),
      type: "FWD",
      comment: ownerTag(p.id),
      "address-list": `${ownerTag(p.id)}-dst`,
    });
    expect(commands.join("\n")).not.toMatch(
      /address=\*|allow-remote-requests|dns set|redirect|cache flush|forward-to=/,
    );
    expect(commands.join("\n")).toContain("src-address-list=");
  });
  it("fails closed on missing DNS, unsupported version or overlapping static entries", () => {
    expect(() => planCommands(p, "warp", { ...facts, dnsRemoteRequests: false })).toThrow(/DNS/);
    for (const version of ["6.49.18", "7.16.2", "7.17rc2", "", "unknown"])
      expect(() => planCommands(p, "warp", { ...facts, version })).toThrow(/7.17/);
    for (const entry of [
      { name: "example.com" },
      { name: "a.example.com" },
      { regexp: ".*" },
      { name: "com", "match-subdomain": "yes" },
    ] as Row[])
      expect(() => planCommands(p, "warp", { ...facts, dns: [entry] })).toThrow(/overlap/);
    expect(() =>
      planCommands(p, "warp", { ...facts, dns: [{ name: "unrelated.com" }] }),
    ).not.toThrow();
  });
  it("verifies DNS ownership and allows learning churn without invalidating preview", () => {
    const commands = planCommands(p, "warp", facts);
    const snapshot = {
      ...facts,
      dns: commands
        .filter((c) => c.startsWith("/ip dns static"))
        .map((c) => parseRecords(`0 ${c}`).rows[0]),
      mangle: commands
        .filter((c) => c.startsWith("/ip firewall mangle"))
        .map((c) => parseRecords(`0 ${c}`).rows[0]),
      addresses: commands
        .filter((c) => c.startsWith("/ip firewall address-list"))
        .map((c) => parseRecords(`0 ${c}`).rows[0]),
    };
    const active = { ...p, state: "active" as const, activeTable: "warp" };
    expect(planCommands(active, "warp", snapshot)).toHaveLength(1);
    expect(() =>
      planCommands(active, "warp", { ...snapshot, dns: [{ ...snapshot.dns[0], regexp: ".*" }] }),
    ).toThrow(/DNS learning scope/);
    expect(fingerprint(snapshot)).toBe(
      fingerprint({
        ...snapshot,
        addresses: [
          ...snapshot.addresses,
          { list: `${ownerTag(p.id)}-dst`, dynamic: "yes", address: "192.0.2.3" },
        ],
      }),
    );
    expect(fingerprint(snapshot)).not.toBe(
      fingerprint({
        ...snapshot,
        addresses: [
          ...snapshot.addresses,
          { list: `${ownerTag(p.id)}-src`, dynamic: "yes", address: "192.0.2.3" },
        ],
      }),
    );
  });
  it("requires explicit precedence for existing routes and never permits FastTrack", () => {
    const other = {
      ...facts,
      mangle: [{ chain: "prerouting", action: "mark-routing", comment: "administrator" }],
    };
    expect(() => planCommands(p, "warp", other)).toThrow(/conflict/);
    const allowed = { ...p, precedence: "before-existing" as const };
    expect(planCommands(allowed, "warp", other).at(-1)).toContain("place-before=0");
    expect(() =>
      planCommands(allowed, "warp", { ...other, filters: [{ action: "fasttrack-connection" }] }),
    ).toThrow(/FastTrack/);
  });
  it("uses only IPv6 mangle for an IPv6 policy and removes exact-owned DNS plus its learned lists", () => {
    const ipv6 = { ...p, family: "ipv6" as const, sources: ["fd00::/64"] };
    const commands = planCommands(ipv6, "warp", {
      ...facts,
      routes: [{ ...facts.routes[0], "dst-address": "::/0" }],
    });
    expect(commands.some((c) => c.startsWith("/ipv6 firewall mangle"))).toBe(true);
    expect(commands.some((c) => c.startsWith("/ip firewall"))).toBe(false);
    const remove = planCommands(p, "warp", facts, true).join("\n");
    expect(remove).toContain(`/ip dns static remove [find where comment=${ownerTag(p.id)}]`);
    expect(remove).not.toContain("[find dynamic=no]");
  });
});
