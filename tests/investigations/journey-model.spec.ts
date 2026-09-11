import { expect, test } from "vite-plus/test";
import type { CaseEvidence, Investigation } from "../../src/investigations/model";
import { journeyModel } from "../../ui/observability/investigation-journey-model";

const evidence = (
  source: string,
  rows: Record<string, string>[],
  device = "edge",
): CaseEvidence => ({
  source,
  rows,
  device,
  id: source + device,
  state: "observed",
  truncated: false,
  startedAt: 1,
  finishedAt: 2,
  summary: "Fixture",
});
function fixture(extra: CaseEvidence[] = []): Investigation {
  return {
    id: "fixture",
    device: "edge",
    devices: ["edge"],
    client: "192.0.2.10",
    target: "example.com",
    service: "service",
    createdAt: 1,
    finishedAt: 2,
    clientOutcome: "unverified",
    nextTests: [],
    evidence: [
      evidence("arp", [{ interface: "bridge" }]),
      evidence("bridge-host", [{ "on-interface": "wifi", bridge: "bridge" }]),
      evidence("interfaces", [
        { name: "office", type: "wg" },
        { name: "wan", type: "ether" },
      ]),
      ...extra,
    ],
  };
}
test("preserves physical wifi and logical bridge as distinct steps", () => {
  const m = journeyModel(fixture(), "", "main");
  expect(m.physical).toEqual(["wifi"]);
  expect(m.logical).toEqual(["bridge"]);
});
test("hostname alone never ranks the default route or guesses DNS", () => {
  const m = journeyModel(
    fixture([
      evidence("routes", [{ "dst-address": "0.0.0.0/0", gateway: "office", distance: "1" }]),
    ]),
    "example.com",
    "main",
  );
  expect(m.destinationValid).toBe(false);
  expect(m.best).toEqual([]);
  expect(m.routes[0].interfaces).toEqual(["office"]);
});
test("ranks longest prefix then distance in only the assumed table", () => {
  const c = fixture([
    evidence("routes", [
      { "dst-address": "0.0.0.0/0", gateway: "wan", distance: "1" },
      { "dst-address": "198.51.100.0/24", gateway: "office", distance: "5" },
      { "dst-address": "198.51.100.0/24", gateway: "wan", distance: "10" },
      { "dst-address": "198.51.100.10/32", gateway: "wan", distance: "1", "routing-table": "VPN" },
    ]),
  ]);
  expect(journeyModel(c, "198.51.100.10", "main").best.map((r) => r.row.gateway)).toEqual([
    "office",
  ]);
  expect(journeyModel(c, "198.51.100.10", "VPN").best.map((r) => r.row.gateway)).toEqual(["wan"]);
});
test("equal-ranked paths stay plural and unknown runtime availability stays unknown", () => {
  const m = journeyModel(
    fixture([
      evidence("routes", [
        { "dst-address": "0.0.0.0/0", gateway: "wan", distance: "1" },
        { "dst-address": "0.0.0.0/0", gateway: "office", distance: "1" },
        { "dst-address": "198.51.100.10/32", gateway: "wan", distance: "1", flags: "XI" },
      ]),
    ]),
    "198.51.100.10",
    "main",
  );
  expect(m.best).toHaveLength(2);
  expect(m.best.every((r) => r.availability === "unknown")).toBe(true);
});
test("maps an IP gateway by local connected subnet without claiming an explicit exit", () => {
  const m = journeyModel(
    fixture([
      evidence("ip-addresses", [{ address: "10.0.0.1/30", interface: "office" }]),
      evidence("routes", [{ "dst-address": "0.0.0.0/0", gateway: "10.0.0.2", distance: "1" }]),
    ]),
    "198.51.100.10",
    "main",
  );
  expect(m.best[0].interfaces).toEqual(["office"]);
  expect(m.best[0].resolution).toBe("subnet");
  expect(m.best[0].tunnelNames).toEqual(["office"]);
});
test("prefers explicit immediate-gw over configured recursive gateway", () => {
  const m = journeyModel(
    fixture([
      evidence("routes", [
        {
          "dst-address": "0.0.0.0/0",
          gateway: "10.0.0.2",
          "immediate-gw": "10.1.0.2%office",
          distance: "1",
        },
      ]),
    ]),
    "198.51.100.10",
    "main",
  );
  expect(m.best[0].resolution).toBe("explicit");
  expect(m.best[0].interfaces).toEqual(["office"]);
});
test("does not invent gateway mapping from another router or ambiguous/truncated addresses", () => {
  const route = evidence("routes", [
    { "dst-address": "0.0.0.0/0", gateway: "10.0.0.2", distance: "1" },
  ]);
  const addresses = evidence("ip-addresses", [{ address: "10.0.0.1/30", interface: "office" }]);
  for (const source of [
    { ...addresses, device: "other" },
    { ...addresses, truncated: true },
    { ...addresses, rows: [...addresses.rows, { address: "10.0.0.1/30", interface: "wan" }] },
  ]) {
    const m = journeyModel(fixture([route, source]), "198.51.100.10", "main");
    expect(m.best[0].resolution).toBe("unknown");
    expect(m.best[0].interfaces).toEqual([]);
  }
});
test("withholds ranking for truncated, malformed or incomplete route metadata", () => {
  const r = evidence("routes", [{ "dst-address": "0.0.0.0/0", gateway: "office", distance: "1" }]);
  for (const source of [
    { ...r, truncated: true },
    { ...r, rows: [{ ...r.rows[0], distance: "" }] },
    { ...r, rows: [...r.rows, { "dst-address": "10.0.0.0/24/99", distance: "1" }] },
  ])
    expect(journeyModel(fixture([source]), "198.51.100.10", "main").best).toEqual([]);
});
test("does not treat a missing route as observed drop or captured policy as evaluated", () => {
  const m = journeyModel(
    fixture([evidence("mangle", [{ action: "mark-routing", "new-routing-mark": "VPN" }])]),
    "198.51.100.10",
    "main",
  );
  expect(m.best).toEqual([]);
  expect(m.policySources[0].captured).toBe(true);
  expect(m.policySources[1].captured).toBe(false);
});
