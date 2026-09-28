import { describe, expect, test } from "vite-plus/test";
import { runInput, summarizeRun, compareRuns } from "../../src/client-check/model";
import type { CheckRun } from "../../src/client-check/model";
import { buildMigration, migrationInput } from "../../src/migration/model";
import type { RouterInventory, MigrationInput } from "../../src/migration/model";

const run: CheckRun = {
  id: "one",
  label: "Wi-Fi",
  path: "wifi",
  receivedAt: 10,
  peerAddress: "192.0.2.10",
  endpoint: "https://test.example",
  family: "IPv4",
  idleMs: [10, 14, 12, 18, 16],
  loadedMs: [25, 30, 35],
  download: { bytes: 1000000, ms: 1000 },
  upload: { bytes: 100000, ms: 1000 },
  errors: [],
};
describe("client evidence", () => {
  test("calculates measured rates, jitter and loaded latency; unknown is not zero", () => {
    expect(summarizeRun(run)).toEqual({
      idleMs: 14,
      loadedMs: 30,
      addedLatencyMs: 16,
      downloadMbps: 8,
      uploadMbps: 0.8,
      jitterMs: 3,
      complete: true,
    });
    expect(summarizeRun({ ...run, download: null }).downloadMbps).toBeNull();
    expect(summarizeRun({ ...run, loadedMs: [] }).complete).toBe(false);
    expect(
      compareRuns(run, { ...run, id: "two", endpoint: "https://other.example" }).comparable,
    ).toBe(false);
    expect(compareRuns(run, { ...run, id: "two", path: "vpn" }).comparable).toBe(true);
  });
  test("limits browser supplied data and invitation lifetime", () => {
    const { id: _, receivedAt: __, peerAddress: ___, endpoint: ____, family: _____, ...data } = run;
    expect(runInput.safeParse(data).success).toBe(true);
    expect(runInput.safeParse({ ...data, idleMs: [Infinity] }).success).toBe(false);
    expect(runInput.safeParse({ ...data, download: { bytes: 32e6, ms: 1000 } }).success).toBe(
      false,
    );
  });
});

const source: RouterInventory = {
  version: "7.20",
  model: "old",
  architecture: "arm",
  packages: ["routeros@7.20"],
  interfaces: [{ name: "ether1", type: "ether", mac: "00:11:22:33:44:01" }],
  export:
    "/interface bridge\nadd name=lan\n/interface bridge port\nadd bridge=lan interface=ether1\n/ip address\nadd address=192.0.2.1/24 interface=lan\n/system identity\nset name=private-name",
};
const target: RouterInventory = {
  ...source,
  model: "new",
  interfaces: [
    { name: "ether8", type: "ether", mac: "00:11:22:33:44:08" },
    { name: "ether9", type: "ether", mac: "00:11:22:33:44:09" },
  ],
  export: "/system identity\nset name=replacement",
};
const input: MigrationInput = {
  source: "old",
  target: "new",
  managementInterface: "ether9",
  mapping: { ether1: "ether8" },
  sections: ["/interface/bridge", "/interface/bridge/port", "/ip/address"],
};
describe("migration planner", () => {
  test("maps dependencies in order, disables active objects and preserves manual sections", () => {
    const p = buildMigration("test", input, source, target);
    expect(p.blockers).toEqual([]);
    expect(p.items.map((i) => i.path)).toEqual(input.sections);
    expect(p.items[1].fields.interface).toBe("ether8");
    expect(p.items.every((i) => i.fields.disabled === "yes")).toBe(true);
    expect(p.items.every((i) => i.undo.includes("mcp-migrate-test"))).toBe(true);
    expect(p.manual[0].section).toBe("/system/identity");
    expect(JSON.stringify(p)).not.toContain("private-name");
  });
  test.each([
    ["version", { ...target, version: "7.21" }, input, "same RouterOS"],
    ["management", target, { ...input, mapping: { ether1: "ether9" } }, "management interface"],
    ["same router", source, input, "Distinct physical"],
    [
      "collision",
      { ...target, export: "/interface bridge\nadd name=lan" },
      input,
      "already exists",
    ],
    [
      "occupied port",
      { ...target, export: "/ip address\nadd address=198.51.100.1/24 interface=ether8" },
      input,
      "in use",
    ],
  ] as const)("blocks %s", (_label, destination, request, message) => {
    expect(buildMigration("test", request, source, destination).blockers.join(" ")).toContain(
      message,
    );
  });
  test("rejects scripts, unsupported fields, missing dependencies and excessive history", () => {
    for (const text of [
      "add name=lan arp=proxy-arp",
      "add name=$dynamic",
      "set [find] name=lan",
      "add name=lan vlan-filtering=yes",
    ]) {
      expect(
        buildMigration("test", input, { ...source, export: `/interface bridge\n${text}` }, target)
          .blockers.length,
      ).toBeGreaterThan(0);
    }
    expect(
      buildMigration(
        "test",
        { ...input, sections: ["/interface/bridge/port"] },
        source,
        target,
      ).blockers.join(" "),
    ).toContain("not included");
    const large = {
      ...source,
      export: `/interface bridge\n${Array.from({ length: 61 }, (_, i) => `add name=b${i}`).join("\n")}`,
    };
    expect(buildMigration("test", input, large, target).blockers.join(" ")).toContain("60 objects");
    expect(migrationInput.safeParse({ ...input, target: "old" }).success).toBe(false);
  });
});
