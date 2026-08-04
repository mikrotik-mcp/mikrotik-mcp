/**
 * Unit tests for the tunnel MTU / MSS / keepalive black-hole detection in the
 * pure root-cause engine. No device I/O.
 */
import { describe, expect, test } from "vite-plus/test";
import { analyzeRootCause, analyzeTunnelMtu } from "../../src/core/root-cause";
import type {
  DiagnosticData,
  FirewallRuleSnapshot,
  InterfaceSnapshot,
  WireguardPeerSnapshot,
} from "../../src/core/root-cause";

function iface(over: Partial<InterfaceSnapshot> & { name: string }): InterfaceSnapshot {
  return {
    type: "ether",
    running: true,
    disabled: false,
    txBytes: 0,
    rxBytes: 0,
    txErrors: 0,
    rxErrors: 0,
    linkDowns: 0,
    mtu: 1500,
    ...over,
  };
}

function mangle(over: Partial<FirewallRuleSnapshot>): FirewallRuleSnapshot {
  return {
    index: 0,
    chain: "forward",
    action: "change-mss",
    bytes: 0,
    packets: 0,
    disabled: false,
    ...over,
  };
}

function peer(over: Partial<WireguardPeerSnapshot>): WireguardPeerSnapshot {
  return {
    interface: "wg0",
    publicKey: "AAAABBBBCCCCDDDD",
    persistentKeepalive: 25,
    disabled: false,
    ...over,
  };
}

function data(over: Partial<DiagnosticData> = {}): DiagnosticData {
  return {
    target: "10.0.0.1",
    interfaces: [],
    routeCount: 5,
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
    cpuLoad: 5,
    memoryUsedPct: 30,
    uptime: "1d",
    rosVersion: "7.15",
    relevantLogs: [],
    tunnelInterfaces: [],
    mangleRules: [],
    wireguardPeers: [],
    pppProfilesMissingMssClamp: [],
    ...over,
  };
}

const wg = iface({ name: "wg-site", type: "wg", mtu: 1420 });
const gre = iface({ name: "gre-b", type: "gre-tunnel", mtu: 1500, actualMtu: 1476 });

describe("analyzeTunnelMtu — MSS clamp coverage", () => {
  test("a running tunnel with no clamp anywhere is flagged", () => {
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [wg] }));
    expect(r.unclamped.map((t) => t.name)).toEqual(["wg-site"]);
    expect(r.evidence.some((e) => e.summary.includes("no TCP MSS clamp"))).toBe(true);
  });

  test("a forward-chain change-mss rule covers every tunnel", () => {
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [wg, gre], mangleRules: [mangle({})] }));
    expect(r.unclamped).toEqual([]);
  });

  test("a disabled clamp rule does not count as coverage", () => {
    const r = analyzeTunnelMtu(
      data({ tunnelInterfaces: [wg], mangleRules: [mangle({ disabled: true })] }),
    );
    expect(r.unclamped).toHaveLength(1);
  });

  test("a clamp rule stranded in prerouting is reported, not counted", () => {
    const r = analyzeTunnelMtu(
      data({ tunnelInterfaces: [wg], mangleRules: [mangle({ chain: "prerouting" })] }),
    );
    expect(r.unclamped).toHaveLength(1);
    expect(r.evidence.some((e) => e.summary.includes("only in chain 'prerouting'"))).toBe(true);
  });

  test("clamp-tcp-mss on the interface covers that tunnel alone", () => {
    const clamped = iface({ ...gre, name: "gre-a", clampTcpMss: true });
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [clamped, wg] }));
    expect(r.unclamped.map((t) => t.name)).toEqual(["wg-site"]);
  });

  test("PPP tunnels are covered when every PPP profile clamps", () => {
    const l2tp = iface({ name: "l2tp-in1", type: "l2tp-in", mtu: 1400 });
    expect(analyzeTunnelMtu(data({ tunnelInterfaces: [l2tp] })).unclamped).toEqual([]);
    const missing = analyzeTunnelMtu(
      data({ tunnelInterfaces: [l2tp], pppProfilesMissingMssClamp: ["default"] }),
    );
    expect(missing.unclamped).toHaveLength(1);
    expect(missing.evidence.some((e) => e.summary.includes("without change-tcp-mss"))).toBe(true);
  });

  test("disabled tunnels are ignored", () => {
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [iface({ ...wg, disabled: true })] }));
    expect(r.unclamped).toEqual([]);
  });
});

describe("analyzeTunnelMtu — MTU budget", () => {
  test("RouterOS defaults sit inside their budget", () => {
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [wg, gre], mangleRules: [mangle({})] }));
    expect(r.oversizedMtu).toEqual([]);
    expect(r.evidence.some((e) => e.severity === "ok")).toBe(true);
  });

  test("a tunnel left at 1500 is flagged with its budget", () => {
    const bad = iface({ name: "wg-bad", type: "wg", mtu: 1500 });
    const r = analyzeTunnelMtu(data({ tunnelInterfaces: [bad] }));
    expect(r.oversizedMtu).toHaveLength(1);
    expect(r.oversizedMtu[0].budget).toBe(1440);
  });

  test("actual-mtu wins over the configured mtu", () => {
    // `mtu=auto` parses to the 1500 fallback; actual-mtu is the truth.
    const auto = iface({ name: "gre-auto", type: "gre-tunnel", mtu: 1500, actualMtu: 1476 });
    expect(analyzeTunnelMtu(data({ tunnelInterfaces: [auto] })).oversizedMtu).toEqual([]);
  });

  test("a PPPoE WAN shrinks the budget by 8 bytes", () => {
    const edge = iface({ name: "gre-edge", type: "gre-tunnel", mtu: 1476 });
    const plain = analyzeTunnelMtu(data({ tunnelInterfaces: [edge] }));
    expect(plain.oversizedMtu).toEqual([]);

    const pppoe = analyzeTunnelMtu(
      data({
        tunnelInterfaces: [edge],
        interfaces: [iface({ name: "pppoe-out1", type: "pppoe-out" })],
      }),
    );
    expect(pppoe.oversizedMtu).toHaveLength(1);
    expect(pppoe.oversizedMtu[0].budget).toBe(1468);
  });
});

describe("analyzeTunnelMtu — WireGuard keepalive", () => {
  test("peers with keepalive off are flagged, disabled ones are not", () => {
    const r = analyzeTunnelMtu(
      data({
        wireguardPeers: [
          peer({ persistentKeepalive: 0 }),
          peer({ publicKey: "ZZZZ", persistentKeepalive: 0, disabled: true }),
          peer({ publicKey: "YYYY" }),
        ],
      }),
    );
    expect(r.keepaliveOff).toHaveLength(1);
  });
});

describe("analyzeRootCause — MTU/MSS correlation", () => {
  const broken = data({
    ping: { sent: 5, received: 5, lossPct: 0 },
    tunnelInterfaces: [iface({ name: "wg-site", type: "wg", mtu: 1500 })],
  });

  test("a reachable-but-unclamped tunnel produces a high-confidence root cause", () => {
    const rc = analyzeRootCause(broken).rootCauses.find(
      (c) => c.cause === "MTU/MSS black hole on tunnel",
    );
    expect(rc).toBeDefined();
    expect(rc?.confidence).toBe("high");
    expect(rc?.fixes.some((f) => f.includes("new-mss=clamp-to-pmtu"))).toBe(true);
    expect(rc?.fixes.some((f) => f.includes("mtu=1440"))).toBe(true);
  });

  test("a healthy tunnel produces no MTU root cause", () => {
    const ok = data({
      ping: { sent: 5, received: 5, lossPct: 0 },
      tunnelInterfaces: [wg],
      mangleRules: [mangle({})],
    });
    expect(
      analyzeRootCause(ok).rootCauses.some((c) => c.cause === "MTU/MSS black hole on tunnel"),
    ).toBe(false);
  });

  test("keepalive-off peers produce their own root cause with a fix", () => {
    const rc = analyzeRootCause(
      data({ wireguardPeers: [peer({ persistentKeepalive: 0 })] }),
    ).rootCauses.find((c) => c.cause.startsWith("WireGuard peer unreachable"));
    expect(rc?.fixes[0]).toContain("persistent-keepalive=25s");
  });
});
