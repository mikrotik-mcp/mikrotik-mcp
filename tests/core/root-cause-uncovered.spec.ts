import { describe, expect, test } from "vite-plus/test";
import { analyzeRootCause, renderDiagnosisReport } from "../../src/core/root-cause";
import type { DiagnosticData, InterfaceSnapshot } from "../../src/core/root-cause";

function iface(over: Partial<InterfaceSnapshot> = {}): InterfaceSnapshot {
  return {
    name: "ether1",
    type: "ether",
    running: true,
    disabled: false,
    txBytes: 1,
    rxBytes: 1,
    txErrors: 0,
    rxErrors: 0,
    linkDowns: 0,
    mtu: 1500,
    ...over,
  };
}

function data(over: Partial<DiagnosticData> = {}): DiagnosticData {
  return {
    target: "8.8.8.8",
    ping: { sent: 4, received: 4, lossPct: 0 },
    interfaces: [iface()],
    routeCount: 2,
    defaultRouteExists: true,
    activeRoutes: [],
    ospfNeighbors: [],
    bgpPeers: [],
    matchingFilterRules: [],
    filterRuleCount: 0,
    natRules: [],
    connectionCount: 0,
    arpEntries: [],
    dhcpLeases: [],
    dnsServers: "1.1.1.1",
    dnsAllowRemote: false,
    cpuLoad: 10,
    memoryUsedPct: 20,
    uptime: "1d",
    rosVersion: "7.20",
    relevantLogs: [],
    tunnelInterfaces: [],
    mangleRules: [],
    wireguardPeers: [],
    pppProfilesMissingMssClamp: [],
    ...over,
  };
}

describe("root-cause uncovered diagnostic paths", () => {
  test("a live flapping interface correlates with intermittent loss", () => {
    const report = analyzeRootCause(
      data({
        ping: { sent: 4, received: 2, lossPct: 50 },
        interfaces: [iface({ linkDowns: 8, lastLinkDownTime: "12:00" })],
      }),
    );
    expect(report.allEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.stringContaining("is flapping"),
          detail: "Last down: 12:00",
        }),
      ]),
    );
    expect(report.rootCauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: "Interface link flapping", confidence: "medium" }),
      ]),
    );
  });

  test("multiple failed OSPF neighbors and BGP peers retain routing evidence", () => {
    const report = analyzeRootCause(
      data({
        ospfNeighbors: [
          { id: "a", address: "192.0.2.1", state: "Init", interface: "ether1" },
          { id: "b", address: "192.0.2.2", state: "Down", interface: "ether1" },
        ],
        bgpPeers: [{ id: "peer", address: "198.51.100.1", state: "Idle", interface: "ether1" }],
      }),
    );
    expect(report.rootCauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: "OSPF adjacency failure", confidence: "high" }),
        expect.objectContaining({ cause: "BGP session failure", confidence: "high" }),
      ]),
    );
    expect(report.allEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.stringContaining("OSPF neighbor a"),
          severity: "critical",
        }),
        expect.objectContaining({
          summary: expect.stringContaining("BGP peer 198.51.100.1"),
          severity: "critical",
        }),
      ]),
    );
  });

  test("CPU and memory exhaustion yields a combined cause and renders fixes", () => {
    const report = analyzeRootCause(data({ cpuLoad: 95, memoryUsedPct: 96 }));
    expect(report.rootCauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: "CPU and memory exhaustion", confidence: "low" }),
      ]),
    );
    const rendered = renderDiagnosisReport(report, "edge");
    expect(rendered).toContain("CPU and memory exhaustion");
    expect(rendered).toContain("/system resource print");
  });
});
