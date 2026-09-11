import { expect, test } from "vite-plus/test";
import type { CaseEvidence, Investigation } from "../../src/investigations/model";
import {
  pingObservation,
  tunnelInventory,
} from "../../ui/observability/investigation-visual-model";

function evidence(source: string, rows: Record<string, string>[], device = "edge"): CaseEvidence {
  return {
    id: `${source}-${device}`,
    device,
    source,
    rows,
    state: "observed",
    startedAt: 1,
    finishedAt: 2,
    truncated: false,
    summary: "Evidence",
  };
}
function investigation(rows: CaseEvidence[]): Investigation {
  return {
    id: "case",
    device: "edge",
    devices: ["edge"],
    client: "192.0.2.1",
    target: "example.com",
    service: "Test",
    clientOutcome: "unverified",
    createdAt: 1,
    finishedAt: 2,
    evidence: rows,
    nextTests: [],
  };
}
test("identifies protocols by interface type, not guessed names", () => {
  const tunnels = tunnelInventory(
    investigation([
      evidence("interfaces", [
        { name: "wg-fake", type: "ether" },
        { name: "office", type: "wg" },
        { name: "transport", type: "gre-tunnel" },
      ]),
    ]),
  );
  expect(tunnels.map((t) => t.name)).toEqual(["office", "transport"]);
  expect(tunnels[0].state).toBe("unknown");
  expect(tunnels[1].encrypted).toBe(false);
});
test("only associates exact gateway interface references within the same device", () => {
  const tunnels = tunnelInventory(
    investigation([
      evidence("interfaces", [{ name: "wg1", type: "wireguard", running: "true" }]),
      evidence("routes", [
        { gateway: "wg10" },
        { gateway: "wg1" },
        { "immediate-gw": "192.0.2.1%wg1" },
        { gateway: "wg1@other" },
      ]),
      evidence("routes", [{ gateway: "wg1" }], "other"),
    ]),
  );
  expect(tunnels[0].routes).toHaveLength(2);
  expect(tunnels[0].state).toBe("running");
});
test("missing state is unknown and explicit disabled overrides running", () => {
  const tunnels = tunnelInventory(
    investigation([
      evidence("interfaces", [
        { name: "a", type: "wireguard", flags: "R" },
        { name: "b", type: "wireguard", running: "true", flags: "XR" },
        { name: "c", type: "wireguard", running: "false" },
        { name: "d", type: "wireguard" },
      ]),
    ]),
  );
  expect(tunnels.map((t) => t.state)).toEqual(["running", "disabled", "not-running", "unknown"]);
});
test("unavailable interface evidence cannot create tunnel cards", () => {
  expect(
    tunnelInventory(
      investigation([
        { ...evidence("interfaces", [{ name: "wg", type: "wireguard" }]), state: "unknown" },
      ]),
    ),
  ).toEqual([]);
});
test("ping replies, partial loss and complete loss remain router scoped", () => {
  expect(pingObservation(evidence("router-ping", [{ sent: "3", received: "3" }])).state).toBe(
    "reply",
  );
  for (const received of ["0", "1", "2"])
    expect(pingObservation(evidence("router-ping", [{ sent: "3", received }])).state).toBe("loss");
  expect(pingObservation(evidence("router-ping", [{ sent: "3", received: "0" }])).text).toContain(
    "router's perspective",
  );
});
test("malformed or absent ping counts do not produce a healthy zero", () => {
  for (const rows of [
    [],
    [{ sent: "0", received: "0" }],
    [{ sent: "3", received: "4" }],
    [{ sent: "3", received: "NaN" }],
  ])
    expect(pingObservation(evidence("router-ping", rows)).state).toBe("unknown");
  expect(pingObservation().state).toBe("unknown");
});
