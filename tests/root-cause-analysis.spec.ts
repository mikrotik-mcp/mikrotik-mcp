import { describe, expect, test } from "vite-plus/test";
import type { DiagnosticData, InterfaceSnapshot } from "../src/core/root-cause";
import { analyzeRootCause, analyzeTunnelMtu, renderDiagnosisReport } from "../src/core/root-cause";

function iface(overrides: Partial<InterfaceSnapshot> = {}): InterfaceSnapshot {
  return {
    name: "ether1",
    type: "ether",
    running: true,
    disabled: false,
    txBytes: 1000,
    rxBytes: 1000,
    txErrors: 0,
    rxErrors: 0,
    linkDowns: 0,
    mtu: 1500,
    ...overrides,
  };
}

function diagnostic(overrides: Partial<DiagnosticData> = {}): DiagnosticData {
  return {
    target: "8.8.8.8",
    ping: { sent: 4, received: 4, lossPct: 0, avgRtt: 15 },
    interfaces: [iface()],
    routeCount: 2,
    defaultRouteExists: true,
    activeRoutes: [
      { dst: "0.0.0.0/0", gateway: "192.0.2.1", distance: 1, active: true, dynamic: false },
    ],
    ospfNeighbors: [],
    bgpPeers: [],
    matchingFilterRules: [],
    filterRuleCount: 2,
    natRules: [
      { index: 0, chain: "srcnat", action: "masquerade", bytes: 10, packets: 1, disabled: false },
    ],
    connectionCount: 2,
    arpEntries: [],
    dhcpLeases: [],
    dnsResolveResult: "8.8.8.8",
    dnsServers: "1.1.1.1",
    dnsAllowRemote: false,
    cpuLoad: 12,
    memoryUsedPct: 35,
    uptime: "3d",
    rosVersion: "7.20",
    relevantLogs: [],
    tunnelInterfaces: [],
    mangleRules: [],
    wireguardPeers: [],
    pppProfilesMissingMssClamp: [],
    ...overrides,
  };
}

describe("root-cause evidence correlation", () => {
  test("a reachable public destination does not invent a private-host ARP failure", () => {
    const result = analyzeRootCause(diagnostic());
    expect(result.allEvidence.some((e) => e.summary.includes("no DHCP lease"))).toBe(false);
    expect(result.allEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "connectivity", severity: "ok" }),
        expect.objectContaining({ dimension: "routing", severity: "ok" }),
        expect.objectContaining({ dimension: "resources", severity: "ok" }),
      ]),
    );
    expect(result.dimensionSummary.find((d) => d.dimension === "connectivity")?.status).toBe("ok");
    expect(renderDiagnosisReport(result, "edge")).toContain("8.8.8.8");
  });

  test("empty parser output is a warning rather than proof of a healthy router", () => {
    const result = analyzeRootCause(
      diagnostic({
        ping: undefined,
        interfaces: [],
        routeCount: 0,
        rosVersion: "",
        uptime: "",
        cpuLoad: 0,
        memoryUsedPct: 0,
        dnsResolveResult: undefined,
      }),
    );
    expect(result.allEvidence.map((e) => e.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Interface data unavailable"),
        expect.stringContaining("Route data unavailable"),
        expect.stringContaining("System resource data unavailable"),
      ]),
    );
    expect(result.dimensionSummary.find((d) => d.dimension === "interfaces")?.status).toBe(
      "warning",
    );
  });

  test("missing default route is high-confidence for loss but downgraded by successful ping", () => {
    const lost = diagnostic({
      defaultRouteExists: false,
      ping: { sent: 4, received: 0, lossPct: 100 },
    });
    const failure = analyzeRootCause(lost);
    expect(
      failure.rootCauses.find((c) => c.cause === "Missing default route")?.confidence,
    ).not.toBe("low");
    const success = analyzeRootCause({ ...lost, ping: { sent: 4, received: 4, lossPct: 0 } });
    const route = success.rootCauses.find((c) => c.cause === "Missing default route");
    expect(route?.confidence).toBe("low");
    expect(route?.explanation).toContain("contradicts this hypothesis");
  });

  test("interface errors, flapping, firewall drops and failed DNS retain distinct evidence", () => {
    const result = analyzeRootCause(
      diagnostic({
        ping: { sent: 4, received: 2, lossPct: 50 },
        interfaces: [iface({ running: false, txErrors: 3, linkDowns: 9, lastLinkDownTime: "now" })],
        matchingFilterRules: [
          { index: 4, chain: "forward", action: "drop", bytes: 400, packets: 4, disabled: false },
        ],
        dnsResolveResult: "",
        dnsServers: "",
        relevantLogs: [{ time: "12:00", topics: "error,firewall", message: "login failed" }],
      }),
    );
    const summaries = result.allEvidence.map((e) => e.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Partial packet loss"),
        expect.stringContaining("Interface ether1 is down"),
        expect.stringContaining("Interface ether1 has errors"),
        expect.stringContaining("actively dropping traffic"),
        expect.stringContaining("DNS resolution failed"),
        expect.stringContaining("authentication-related"),
      ]),
    );
    expect(result.dimensionSummary.find((d) => d.dimension === "interfaces")?.status).toBe(
      "critical",
    );
  });

  test("private targets without ARP/DHCP evidence are flagged; public targets are not", () => {
    const privateResult = analyzeRootCause(diagnostic({ target: "10.10.10.8" }));
    expect(
      privateResult.allEvidence.some((e) => e.summary.includes("no DHCP lease and no ARP entry")),
    ).toBe(true);
    const withArp = analyzeRootCause(
      diagnostic({
        target: "10.10.10.8",
        arpEntries: [
          {
            address: "10.10.10.8",
            macAddress: "00:11:22:33:44:55",
            interface: "bridge",
            complete: false,
            dynamic: true,
          },
        ],
      }),
    );
    expect(withArp.allEvidence.some((e) => e.summary.includes("incomplete"))).toBe(true);
  });

  test("idle server-side VPN binding differs from a failed site-to-site tunnel", () => {
    const result = analyzeRootCause(
      diagnostic({
        tunnelInterfaces: [
          iface({ name: "<ovpn-user>", type: "ovpn-in", running: false }),
          iface({ name: "wg-to-site", type: "wg", running: false, mtu: 1420 }),
        ],
      }),
    );
    expect(result.allEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "vpn",
          severity: "info",
          summary: expect.stringContaining("idle"),
        }),
        expect.objectContaining({
          dimension: "vpn",
          severity: "critical",
          summary: expect.stringContaining("wg-to-site"),
        }),
      ]),
    );
  });

  test("tunnel MTU analysis does not classify ordinary Ethernet as an encapsulated tunnel", () => {
    expect(analyzeTunnelMtu(diagnostic()).oversizedMtu).toEqual([]);
    expect(analyzeTunnelMtu(diagnostic()).unclamped).toEqual([]);
  });
});
