/**
 * The narrative analyser, against fixture exports.
 *
 * Two properties matter more than any individual field:
 *
 * 1. **Nothing is silently dropped.** A document about an inherited router that
 *    omits the one menu nobody understood is worse than no document, because the
 *    reader believes they have the whole picture.
 * 2. **The same export always analyses identically.** `diff_explanations` is
 *    meaningless otherwise — every re-run would look like a change.
 */
import { describe, expect, test } from "vite-plus/test";
import { analyzeDevice } from "../../src/narrative/analyze";
import { inferRoles, roleSignals } from "../../src/narrative/roles";
import { parseExport } from "../../src/policy/parse";
import {
  APP_HOST,
  BORDER_CHR,
  HOME_ROUTER,
  MULTI_WAN,
  PURE_SWITCH,
  SPARSE,
  VPN_CONCENTRATOR,
  WIDE_OPEN,
  WITH_UNKNOWN_MENU,
} from "./fixtures/exports";

const roles = (text: string): ReturnType<typeof inferRoles> => inferRoles(parseExport(text));

describe("role inference", () => {
  test("a home router is an edge router first", () => {
    const report = roles(HOME_ROUTER);
    expect(report.primary?.role).toBe("edge-router");
  });

  test("a home router reports its other roles too — several at once is normal", () => {
    const report = roles(HOME_ROUTER);
    const all = [report.primary, ...report.secondary].map((r) => r?.role);
    expect(all).toContain("switch");
    expect(all).toContain("wireless-controller");
  });

  test("a pure switch is a switch, not an edge router", () => {
    const report = roles(PURE_SWITCH);
    expect(report.primary?.role).toBe("switch");
    expect(report.secondary.map((r) => r.role)).not.toContain("edge-router");
  });

  test("external ASNs make a border router; private ones do not", () => {
    const report = roles(BORDER_CHR);
    const border = [report.primary, ...report.secondary].find((r) => r?.role === "border-router");
    expect(border).toBeDefined();
    // 64496 is public, 65001 is private — only the first should be cited.
    expect(border?.signals.some((s) => /public ASNs/.test(s.signal))).toBe(true);
  });

  test("a PPP server with a pool and many WireGuard peers is a concentrator", () => {
    const report = roles(VPN_CONCENTRATOR);
    const all = [report.primary, ...report.secondary].map((r) => r?.role);
    expect(all).toContain("vpn-concentrator");
  });

  test("containers make an application host", () => {
    expect(roles(APP_HOST).primary?.role).toBe("application-host");
  });

  test("every role reports the signals that produced it", () => {
    // A wrong inference the reader can check is debuggable; one they cannot is
    // just wrong.
    const report = roles(HOME_ROUTER);
    expect(report.primary?.signals.length).toBeGreaterThan(0);
    for (const signal of report.signals) {
      expect(signal.section.startsWith("/")).toBe(true);
      expect(signal.weight).toBeGreaterThan(0);
    }
  });

  test("an empty config infers nothing rather than guessing", () => {
    const report = roles("# nothing here\n");
    expect(report.primary).toBeNull();
    expect(report.signals).toEqual([]);
  });

  test("NAT without a static default route still suggests an edge router", () => {
    // The DHCP-WAN case: the default route is learned at runtime and is simply
    // not in the export.
    const signals = roleSignals(
      parseExport("/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1\n"),
    );
    expect(signals.some((s) => s.role === "edge-router")).toBe(true);
  });
});

describe("identity", () => {
  test("reads the name, version and model from the export header", () => {
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.identity.name).toBe("home-gw");
    expect(n.identity.version).toBe("7.16.2");
    expect(n.identity.model).toBe("RB5009UG+S+");
  });

  test("survives an export with no header at all", () => {
    const n = analyzeDevice("/ip address add address=10.0.0.1/24 interface=ether1\n");
    expect(n.identity.version).toBeUndefined();
    expect(n.identity.name).toBeUndefined();
  });
});

describe("interfaces", () => {
  test("finds bridges, VLANs and their parents", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const vlan = n.interfaces.find((i) => i.name === "vlan40-guest");
    expect(vlan?.kind).toBe("vlan");
    expect(vlan?.vlanId).toBe(40);
    expect(vlan?.parent).toBe("bridge");
  });

  test("a bridge port records which bridge it is switched into", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const port = n.interfaces.find((i) => i.name === "ether2");
    expect(port?.parent).toBe("bridge");
    expect(port?.purpose).toContain("bridge");
  });

  test("interface-list membership becomes a purpose", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const wan = n.interfaces.find((i) => i.name === "ether1-wan");
    expect(wan?.lists).toContain("WAN");
    expect(wan?.purpose).toContain("upstream");
  });

  test("an interface with no address is still listed", () => {
    // The one you inherit and cannot explain is exactly the one worth naming.
    const n = analyzeDevice(SPARSE);
    const spare = n.interfaces.find((i) => i.name === "vlan100-spare");
    expect(spare).toBeDefined();
    expect(spare?.addresses).toEqual([]);
  });

  test("interfaces come out in a stable order", () => {
    const a = analyzeDevice(HOME_ROUTER).interfaces.map((i) => i.name);
    const b = analyzeDevice(HOME_ROUTER).interfaces.map((i) => i.name);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort((x, y) => x.localeCompare(y)));
  });
});

describe("subnets and DHCP", () => {
  test("pairs a subnet with the DHCP scope and pool serving it", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const lan = n.subnets.find((s) => s.cidr === "192.168.88.0/24");
    expect(lan?.routerAddress).toBe("192.168.88.1");
    expect(lan?.dhcp?.server).toBe("lan-dhcp");
    expect(lan?.dhcp?.ranges).toEqual(["192.168.88.10-192.168.88.254"]);
    expect(lan?.dhcp?.gateway).toBe("192.168.88.1");
  });

  test("a VLAN with an address but NO DHCP is reported without one", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const iot = n.subnets.find((s) => s.cidr === "198.51.100.0/24");
    expect(iot).toBeDefined();
    expect(iot?.dhcp).toBeUndefined();
  });

  test("static reservations land on the right subnet", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const lan = n.subnets.find((s) => s.cidr === "192.168.88.0/24");
    expect(lan?.reservations).toHaveLength(1);
    expect(lan?.reservations[0].comment).toBe("printer");
    // …and NOT on the guest subnet.
    expect(n.subnets.find((s) => s.cidr === "192.0.2.0/24")?.reservations).toEqual([]);
  });

  test("a VLAN subnet carries its VLAN id", () => {
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.subnets.find((s) => s.cidr === "192.0.2.0/24")?.vlanId).toBe(40);
  });
});

describe("internet path", () => {
  test("a DHCP WAN is reported as dhcp, with the NAT strategy", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const wan = n.wans.find((w) => w.interface === "ether1-wan");
    expect(wan?.addressing).toBe("dhcp");
    expect(wan?.nat).toContain("masquerade");
  });

  test("multi-WAN reports both routes with their distances and check-gateway", () => {
    const n = analyzeDevice(MULTI_WAN);
    expect(n.wans).toHaveLength(2);
    expect(n.wans.map((w) => w.distance).sort()).toEqual([1, 2]);
    expect(n.wans.every((w) => w.checkGateway === "ping")).toBe(true);
  });

  test("a switch has no internet path at all", () => {
    expect(analyzeDevice(PURE_SWITCH).wans).toEqual([]);
  });
});

describe("firewall chains", () => {
  test("a trailing catch-all drop is reported as the chain default", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const input = n.chains.find((c) => c.table === "filter" && c.chain === "input");
    expect(input?.defaultAction).toBe("drop");
  });

  test("a filter chain with no catch-all defaults to accept, as RouterOS does", () => {
    const n = analyzeDevice("/ip firewall filter add action=accept chain=input protocol=icmp\n");
    expect(n.chains.find((c) => c.chain === "input")?.defaultAction).toBe("accept");
  });

  test("each rule gets one plain sentence, in evaluation order", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const forward = n.chains.find((c) => c.table === "filter" && c.chain === "forward");
    expect(forward?.summary).toHaveLength(3);
    expect(forward?.summary[0]).toContain("established");
    expect(forward?.summary[2]).toBe("drop everything");
  });

  test("disabled rules are counted but marked", () => {
    const n = analyzeDevice(
      "/ip firewall filter add action=drop chain=input disabled=yes protocol=icmp\n",
    );
    const chain = n.chains.find((c) => c.chain === "input");
    expect(chain?.ruleCount).toBe(1);
    expect(chain?.disabledCount).toBe(1);
    expect(chain?.summary[0]).toContain("[disabled]");
  });

  test("NAT and mangle chains are described too", () => {
    const n = analyzeDevice(MULTI_WAN);
    expect(n.chains.some((c) => c.table === "nat" && c.chain === "srcnat")).toBe(true);
    expect(n.chains.some((c) => c.table === "nat" && c.chain === "dstnat")).toBe(true);
  });
});

describe("exposure — the section people actually read", () => {
  test("an unrestricted management service is high or critical", () => {
    const n = analyzeDevice(WIDE_OPEN);
    const telnet = n.exposure.find((e) => e.what === "telnet");
    expect(telnet?.severity).toBe("critical");
    expect(telnet?.from).toBe("anyone");
  });

  test("an address-restricted service drops to low", () => {
    const n = analyzeDevice(HOME_ROUTER);
    const www = n.exposure.find((e) => e.what === "www");
    expect(www?.from).toBe("192.168.88.0/24");
    expect(www?.severity).toBe("low");
  });

  test("a disabled service is not exposure", () => {
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.exposure.some((e) => e.what === "telnet")).toBe(false);
    expect(n.exposure.some((e) => e.what === "ftp")).toBe(false);
  });

  test("a port forward is exposure, and names the internal target", () => {
    const n = analyzeDevice(MULTI_WAN);
    const forward = n.exposure.find((e) => e.kind === "dst-nat");
    expect(forward?.what).toContain("192.168.88.20");
    expect(forward?.what).toContain("HTTPS");
  });

  test("an input accept from the WAN is exposure even with no service behind it", () => {
    const n = analyzeDevice(WIDE_OPEN);
    const accept = n.exposure.find((e) => e.kind === "firewall-accept");
    expect(accept).toBeDefined();
    expect(accept?.severity).toBe("critical");
  });

  test("an established/related accept is NOT exposure", () => {
    // Every sane firewall starts with one; flagging it would drown the section.
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.exposure.some((e) => e.kind === "firewall-accept")).toBe(false);
  });

  test("worst first", () => {
    const n = analyzeDevice(WIDE_OPEN);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    const severities = n.exposure.map((e) => rank[e.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });
});

describe("tunnels", () => {
  test("WireGuard peers and the subnets they carry", () => {
    const n = analyzeDevice(VPN_CONCENTRATOR);
    const wg = n.tunnels.find((t) => t.name === "wg-hub");
    expect(wg?.kind).toBe("wireguard");
    expect(wg?.peers).toHaveLength(3);
    expect(wg?.subnets).toContain("10.20.0.2/32");
  });

  test("a peer with no endpoint is described as dialling in", () => {
    const n = analyzeDevice(VPN_CONCENTRATOR);
    const wg = n.tunnels.find((t) => t.name === "wg-hub");
    expect(wg?.peers.some((p) => p.includes("dials in"))).toBe(true);
  });

  test("a device with no tunnels reports none", () => {
    expect(analyzeDevice(PURE_SWITCH).tunnels).toEqual([]);
  });
});

describe("unknowns — never silently dropped", () => {
  test("an unmodelled menu is reported, with the line to go and look at", () => {
    const n = analyzeDevice(WITH_UNKNOWN_MENU);
    const sections = n.unknowns.map((u) => u.section);
    expect(sections).toContain("/queue/tree");
    expect(sections).toContain("/tool/netwatch");
    expect(n.unknowns.every((u) => u.line > 0)).toBe(true);
  });

  test("a well-understood config reports no unknowns", () => {
    expect(analyzeDevice(HOME_ROUTER).unknowns).toEqual([]);
  });

  test("unparsed lines surface as unknowns too", () => {
    const n = analyzeDevice("/ip address add address=10.0.0.1/24 interface=ether1\n!!! garbage\n");
    expect(n.stats.unparsedLines + n.unknowns.length).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  test("the same export analyses byte-identically", () => {
    // diff_explanations is meaningless otherwise: every re-run would look like
    // a change.
    for (const fixture of [HOME_ROUTER, PURE_SWITCH, BORDER_CHR, VPN_CONCENTRATOR, MULTI_WAN]) {
      expect(JSON.stringify(analyzeDevice(fixture))).toBe(JSON.stringify(analyzeDevice(fixture)));
    }
  });

  test("the analysis carries no clock or device unless the caller stamps one", () => {
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.generatedAt).toBeUndefined();
    expect(n.device).toBeUndefined();
    expect(analyzeDevice(HOME_ROUTER, "edge").device).toBe("edge");
  });

  test("stats describe how much of the export was understood", () => {
    const n = analyzeDevice(HOME_ROUTER);
    expect(n.stats.recordCount).toBeGreaterThan(20);
    expect(n.stats.unparsedLines).toBe(0);
  });
});
