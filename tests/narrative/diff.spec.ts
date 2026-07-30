/**
 * Consequence-level diffing.
 *
 * The reason this exists: `diff_config_snapshots` shows that a rule moved. What
 * a reviewer needs to know is that the forward chain stopped dropping. Every
 * case here is a change whose line diff looks unremarkable and whose consequence
 * does not.
 */
import { describe, expect, test } from "vite-plus/test";
import { analyzeDevice } from "../../src/narrative/analyze";
import { diffNarratives, renderDiff } from "../../src/narrative/diff";
import { HOME_ROUTER, MULTI_WAN, PURE_SWITCH, VPN_CONCENTRATOR } from "./fixtures/exports";

const diff = (before: string, after: string): ReturnType<typeof diffNarratives> =>
  diffNarratives(analyzeDevice(before), analyzeDevice(after));

describe("no change", () => {
  test("the same config twice is identical", () => {
    const d = diff(HOME_ROUTER, HOME_ROUTER);
    expect(d.identical).toBe(true);
    expect(d.changes).toEqual([]);
  });

  test("and says so without claiming the exports are byte-identical", () => {
    // They may well differ in ways this analysis does not model; claiming
    // otherwise would be a lie the reader acts on.
    const md = renderDiff(diff(HOME_ROUTER, HOME_ROUTER));
    expect(md).toContain("Nothing this analysis covers is different");
    expect(md).toContain("diff_config_snapshots");
  });
});

describe("firewall posture — the change a line diff hides", () => {
  test("losing the catch-all drop is CRITICAL, not a moved rule", () => {
    const after = HOME_ROUTER.replace("/ip firewall filter add action=drop chain=forward\n", "");
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("no longer ends in a drop"));
    expect(change).toBeDefined();
    expect(change?.severity).toBe("critical");
    expect(change?.impact).toBe("security");
    // …and it sorts to the top, because that is the one to read first.
    expect(d.changes[0].severity).toBe("critical");
  });

  test("gaining a default drop is reported as a tightening, not an alarm", () => {
    const before = HOME_ROUTER.replace("/ip firewall filter add action=drop chain=forward\n", "");
    const d = diff(before, HOME_ROUTER);
    const change = d.changes.find((c) => c.summary.includes("now has a catch-all"));
    expect(change?.severity).toBe("medium");
  });

  test("a chain disappearing entirely is called out", () => {
    const after = HOME_ROUTER.split("\n")
      .filter((l) => !l.includes("chain=forward"))
      .join("\n");
    const d = diff(HOME_ROUTER, after);
    expect(d.changes.some((c) => c.summary.includes("`forward` chain in `filter` is gone"))).toBe(
      true,
    );
  });

  test("a rule count change is noted with the posture that still applies", () => {
    const after = HOME_ROUTER.replace(
      "/ip firewall filter add action=drop chain=forward\n",
      "/ip firewall filter add action=accept chain=forward protocol=icmp\n/ip firewall filter add action=drop chain=forward\n",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("gained 1 rule"));
    expect(change?.detail).toContain("still dropped");
  });
});

describe("exposure", () => {
  test("a new port forward is reported with what it reaches", () => {
    const after = HOME_ROUTER.replace(
      "/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN\n",
      "/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN\n" +
        "/ip firewall nat add action=dst-nat chain=dstnat dst-port=3389 protocol=tcp to-addresses=192.168.88.7\n",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find(
      (c) => c.impact === "security" && c.summary.includes("forwarded"),
    );
    expect(change?.summary).toContain("192.168.88.7");
    expect(change?.summary).toContain("RDP");
  });

  test("removing an exposure is good news, ranked low", () => {
    const after = HOME_ROUTER.replace("/ip service set ssh port=2222\n", "");
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("no longer reachable"));
    expect(change?.severity).toBe("low");
  });

  test("a service losing its address restriction is CRITICAL", () => {
    const after = HOME_ROUTER.replace(
      "/ip service set www address=192.168.88.0/24\n",
      "/ip service set www port=80\n",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("lost its address restriction"));
    expect(change?.severity).toBe("critical");
  });

  test("enabling a management service is a security change", () => {
    const after = HOME_ROUTER.replace(
      "/ip service set telnet disabled=yes\n",
      "/ip service set telnet port=23\n",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("telnet service was enabled"));
    expect(change?.impact).toBe("security");
    expect(change?.severity).toBe("high");
  });
});

describe("addressing", () => {
  test("a new VLAN says whether it can reach the internet", () => {
    // The blueprint's own example sentence.
    const after = HOME_ROUTER.replace(
      "/ip dhcp-client add interface=ether1-wan\n",
      "/ip dhcp-client add interface=ether1-wan\n" +
        "/ip address add address=203.0.113.1/24 interface=vlan40-guest network=203.0.113.0\n",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("203.0.113.0/24 was added"));
    expect(change?.summary).toContain("can reach the internet");
    expect(change?.impact).toBe("connectivity");
  });

  test("a subnet disappearing is reported as unreachability, not a deleted line", () => {
    const after = HOME_ROUTER.replace(
      "/ip address add address=198.51.100.1/24 interface=vlan50-iot network=198.51.100.0\n",
      "",
    );
    const d = diff(HOME_ROUTER, after);
    const change = d.changes.find((c) => c.summary.includes("198.51.100.0/24"));
    expect(change?.summary).toContain("unreachable");
    expect(change?.severity).toBe("high");
  });

  test("losing DHCP on a subnet is high; gaining it is low", () => {
    const noDhcp = HOME_ROUTER.replace(
      "/ip dhcp-server add address-pool=lan-pool interface=bridge name=lan-dhcp\n",
      "",
    );
    expect(
      diff(HOME_ROUTER, noDhcp).changes.find((c) => c.summary.includes("lost its DHCP server"))
        ?.severity,
    ).toBe("high");
    expect(
      diff(noDhcp, HOME_ROUTER).changes.find((c) => c.summary.includes("now has a DHCP server"))
        ?.severity,
    ).toBe("low");
  });
});

describe("internet path", () => {
  test("losing the health check means failover stops working", () => {
    const after = MULTI_WAN.replace(/check-gateway=ping /g, "");
    const d = diff(MULTI_WAN, after);
    const change = d.changes.find((c) => c.summary.includes("no longer health-checked"));
    expect(change?.summary).toContain("will not fail over");
    expect(change?.severity).toBe("high");
  });

  test("a distance change is a priority change", () => {
    const after = MULTI_WAN.replace("distance=2", "distance=3");
    expect(diff(MULTI_WAN, after).changes.some((c) => c.summary.includes("changed priority"))).toBe(
      true,
    );
  });

  test("losing NAT on an upstream is high, and says traffic is untranslated", () => {
    const after = MULTI_WAN.replace(
      "/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN\n",
      "",
    );
    const d = diff(MULTI_WAN, after);
    const change = d.changes.find((c) => c.summary.includes("NAT on"));
    expect(change?.severity).toBe("high");
    expect(change?.detail).toContain("no longer translated");
  });
});

describe("tunnels", () => {
  test("a removed tunnel says what it costs", () => {
    const after = VPN_CONCENTRATOR.split("\n")
      .filter((l) => !l.startsWith("/interface wireguard"))
      .join("\n");
    const d = diff(VPN_CONCENTRATOR, after);
    const change = d.changes.find((c) => c.summary.includes("wg-hub` was removed"));
    expect(change?.summary).toContain("cut off");
  });

  test("a peer count change is reported", () => {
    const after = VPN_CONCENTRATOR.replace(
      "/interface wireguard peers add allowed-address=10.20.0.3/32 interface=wg-hub name=phone\n",
      "",
    );
    expect(
      diff(VPN_CONCENTRATOR, after).changes.some((c) => c.summary.includes("lost 1 peer")),
    ).toBe(true);
  });
});

describe("role and rendering", () => {
  test("a device that changed purpose says so", () => {
    const d = diff(PURE_SWITCH, HOME_ROUTER);
    expect(d.changes.some((c) => c.summary.includes("now looks like a Edge router"))).toBe(true);
  });

  test("a version bump is cosmetic, and sorts last", () => {
    const after = HOME_ROUTER.replace("RouterOS 7.16.2", "RouterOS 7.17");
    const d = diff(HOME_ROUTER, after);
    expect(d.changes[d.changes.length - 1].impact).toBe("cosmetic");
  });

  test("the rendered diff leads with the count and ends pointing at the line diff", () => {
    const after = HOME_ROUTER.replace("/ip firewall filter add action=drop chain=forward\n", "");
    const md = renderDiff(diff(HOME_ROUTER, after));
    expect(md).toContain("# What changed");
    expect(md).toContain("change(s) worth knowing about");
    expect(md).toContain("diff_config_snapshots");
  });

  test("diffing is deterministic", () => {
    const after = HOME_ROUTER.replace("/ip firewall filter add action=drop chain=forward\n", "");
    expect(renderDiff(diff(HOME_ROUTER, after))).toBe(renderDiff(diff(HOME_ROUTER, after)));
  });
});
