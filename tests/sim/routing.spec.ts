/**
 * The device model and the routing decision — the half of the simulator that
 * decides where a packet goes before any firewall rule is consulted.
 *
 * The cases that matter are the ones where being subtly wrong produces a
 * confident wrong answer: connected routes (derived, not exported), longest
 * prefix beating a better distance, ECMP being a hash rather than a choice, and
 * a discard route being a verdict rather than a route.
 */
import { describe, expect, test } from "vite-plus/test";
import { addressList, buildModel, inInterfaceList } from "../../src/sim/model";
import { interfaceForAddress, isLocalAddress, selectRoute } from "../../src/sim/routing";
import { matchAddress, matchPort, parseCidr, parseIp } from "../../src/sim/ip";

const EXPORT = `# 2026-07-30 10:00:00 by RouterOS 7.14.3
/interface bridge
add name=bridge
/interface list
add name=LAN
add name=WAN
/interface list member
add interface=bridge list=LAN
add interface=ether1 list=WAN
/ip address
add address=192.168.88.1/24 interface=bridge network=192.168.88.0
add address=10.10.0.1/30 interface=wg-site-b network=10.10.0.0
/ip firewall address-list
add address=192.168.88.0/24 list=trusted
add address=10.0.0.0/8 list=trusted
add address=203.0.113.7 list=blocked
/ip route
add dst-address=0.0.0.0/0 gateway=192.168.1.1 distance=1
add dst-address=0.0.0.0/0 gateway=192.168.2.1 distance=10
add dst-address=10.20.0.0/16 gateway=10.10.0.2
add dst-address=198.51.100.0/24 blackhole distance=250
`;

const MODEL = buildModel(EXPORT);

describe("model building", () => {
  test("derives connected routes from /ip address", () => {
    const connected = MODEL.routes.filter((r) => r.kind === "connected");
    expect(connected.map((r) => r.dst.text)).toEqual(["192.168.88.0/24", "10.10.0.0/30"]);
    // Connected routes sit at distance 0, as the device places them.
    expect(connected.every((r) => r.distance === 0)).toBe(true);
  });

  test("reads static routes with their distance and table", () => {
    const statics = MODEL.routes.filter((r) => r.kind === "static");
    expect(statics).toHaveLength(3);
    expect(statics.every((r) => r.table === "main")).toBe(true);
    expect(statics.find((r) => r.gateway === "192.168.2.1")?.distance).toBe(10);
  });

  test("recognises a v7 bare `blackhole` keyword as a discard route", () => {
    const bh = MODEL.routes.find((r) => r.dst.text === "198.51.100.0/24");
    expect(bh?.kind).toBe("blackhole");
  });

  test("collects address lists and interface lists", () => {
    expect(addressList(MODEL, "trusted")).toHaveLength(2);
    expect(addressList(MODEL, "nope")).toBeUndefined();
    expect(inInterfaceList(MODEL, "LAN", "bridge")).toBe(true);
    expect(inInterfaceList(MODEL, "LAN", "ether1")).toBe(false);
    // An unknown list is undefined, NOT false — the caller must be able to tell
    // "not a member" from "there is no such list".
    expect(inInterfaceList(MODEL, "GUEST", "bridge")).toBeUndefined();
  });

  test("an IPv6 address is recorded as unmodelled, not silently dropped", () => {
    const model = buildModel(`/ip address\nadd address=2001:db8::1/64 interface=bridge`);
    expect(model.unmodelled.map((u) => u.what)).toContain("IPv6 address");
  });

  test("a raw-table rule is recorded as unmodelled — it runs before everything modelled", () => {
    const model = buildModel(
      `/ip firewall raw\nadd action=drop chain=prerouting src-address=1.2.3.4`,
    );
    expect(model.unmodelled[0]).toMatchObject({ what: "raw table rule" });
  });
});

describe("route selection", () => {
  test("a LAN destination takes the connected route, not the default gateway", () => {
    const decision = selectRoute(MODEL, "192.168.88.50");
    expect(decision.outcome).toBe("routed");
    expect(decision.route?.kind).toBe("connected");
    expect(decision.outInterface).toBe("bridge");
  });

  test("an internet destination takes the default route", () => {
    const decision = selectRoute(MODEL, "8.8.8.8");
    expect(decision.outcome).toBe("routed");
    expect(decision.route?.dst.text).toBe("0.0.0.0/0");
    expect(decision.gateway).toBe("192.168.1.1");
  });

  test("distance breaks a tie between equal prefixes", () => {
    // Two default routes; distance 1 wins over distance 10.
    expect(selectRoute(MODEL, "1.1.1.1").gateway).toBe("192.168.1.1");
  });

  test("longest prefix wins even when the shorter route has a better distance", () => {
    const model = buildModel(`/ip route
add dst-address=0.0.0.0/0 gateway=10.0.0.1 distance=1
add dst-address=8.8.8.0/24 gateway=10.0.0.2 distance=200`);
    const decision = selectRoute(model, "8.8.8.8");
    expect(decision.route?.dst.text).toBe("8.8.8.0/24");
    expect(decision.gateway).toBe("10.0.0.2");
  });

  test("a more specific route beats the connected network", () => {
    const model = buildModel(`/ip address
add address=192.168.88.1/24 interface=bridge
/ip route
add dst-address=192.168.88.128/25 gateway=192.168.88.9`);
    expect(selectRoute(model, "192.168.88.200").route?.dst.text).toBe("192.168.88.128/25");
    expect(selectRoute(model, "192.168.88.10").route?.kind).toBe("connected");
  });

  test("equal prefix AND equal distance is ECMP — reported, never guessed", () => {
    const model = buildModel(`/ip route
add dst-address=0.0.0.0/0 gateway=10.0.0.1 distance=1
add dst-address=0.0.0.0/0 gateway=10.0.0.2 distance=1`);
    const decision = selectRoute(model, "8.8.8.8");
    expect(decision.outcome).toBe("ecmp");
    expect(decision.candidates).toHaveLength(2);
    expect(decision.reason).toContain("hash");
    // Crucially, it does NOT pick one.
    expect(decision.route).toBeUndefined();
  });

  test("a blackhole route is a discard verdict, not a next-hop", () => {
    const decision = selectRoute(MODEL, "198.51.100.5");
    expect(decision.outcome).toBe("discard");
    expect(decision.reason).toContain("blackhole");
  });

  test("no matching route is an explicit no-route outcome", () => {
    const model = buildModel(`/ip address\nadd address=192.168.88.1/24 interface=bridge`);
    const decision = selectRoute(model, "8.8.8.8");
    expect(decision.outcome).toBe("no-route");
    expect(decision.reason).toContain("no route to 8.8.8.8");
  });

  test("a disabled route is not eligible", () => {
    const model = buildModel(`/ip route
add dst-address=0.0.0.0/0 gateway=10.0.0.1 distance=1 disabled=yes
add dst-address=0.0.0.0/0 gateway=10.0.0.2 distance=5`);
    expect(selectRoute(model, "8.8.8.8").gateway).toBe("10.0.0.2");
  });

  test("a routing mark selects an alternate table", () => {
    const model = buildModel(`/ip address
add address=192.168.88.1/24 interface=bridge
/ip route
add dst-address=0.0.0.0/0 gateway=192.168.88.2 distance=1
add dst-address=0.0.0.0/0 gateway=192.168.88.3 routing-table=VPN`);
    expect(selectRoute(model, "8.8.8.8").gateway).toBe("192.168.88.2");
    expect(selectRoute(model, "8.8.8.8", "VPN").gateway).toBe("192.168.88.3");
  });

  test("a table that exists but has no matching route says which table", () => {
    const model = buildModel(`/ip route\nadd dst-address=0.0.0.0/0 gateway=10.0.0.1`);
    const decision = selectRoute(model, "8.8.8.8", "VPN");
    expect(decision.outcome).toBe("no-route");
    expect(decision.reason).toContain("VPN");
    expect(decision.reason).toContain("main table has routes");
  });

  test("the egress interface resolves through the connected network of the gateway", () => {
    // 10.10.0.2 is inside the wg-site-b /30, so that is the egress.
    expect(selectRoute(MODEL, "10.20.5.5").outInterface).toBe("wg-site-b");
  });

  test("a gateway on no connected network is reported rather than guessed", () => {
    const model = buildModel(`/ip route\nadd dst-address=0.0.0.0/0 gateway=203.0.113.9`);
    const decision = selectRoute(model, "8.8.8.8");
    expect(decision.outInterface).toBeUndefined();
    expect(decision.reason).toContain("does not follow");
  });

  test("check-gateway is surfaced, because the export cannot say if the route is live", () => {
    const model = buildModel(
      `/ip route\nadd dst-address=0.0.0.0/0 gateway=10.0.0.1 check-gateway=ping`,
    );
    expect(selectRoute(model, "8.8.8.8").reason).toContain("check-gateway=ping");
  });

  test("an ECMP gateway list is recorded as unmodelled at build time", () => {
    const model = buildModel(`/ip route\nadd dst-address=0.0.0.0/0 gateway=10.0.0.1,10.0.0.2`);
    expect(model.unmodelled.map((u) => u.what)).toContain("ECMP gateway");
  });

  test("an IPv6 destination is refused rather than coerced", () => {
    const decision = selectRoute(MODEL, "2001:db8::1");
    expect(decision.outcome).toBe("no-route");
    expect(decision.reason).toContain("IPv4 only");
  });
});

describe("locality", () => {
  test("recognises the router's own addresses", () => {
    expect(isLocalAddress(MODEL, "192.168.88.1")).toBe(true);
    expect(isLocalAddress(MODEL, "192.168.88.50")).toBe(false);
  });

  test("maps a source address to the interface it should arrive on", () => {
    expect(interfaceForAddress(MODEL, "192.168.88.50")).toBe("bridge");
    expect(interfaceForAddress(MODEL, "8.8.8.8")).toBeUndefined();
  });
});

describe("address and port matchers", () => {
  test("matches a single address, a CIDR and a range", () => {
    const ip = parseIp("192.168.88.50") ?? 0;
    expect(matchAddress(ip, "192.168.88.50")).toBe(true);
    expect(matchAddress(ip, "192.168.88.0/24")).toBe(true);
    expect(matchAddress(ip, "192.168.88.40-192.168.88.60")).toBe(true);
    expect(matchAddress(ip, "192.168.89.0/24")).toBe(false);
  });

  test("returns null for a matcher it cannot understand, so it is not a silent false", () => {
    const ip = parseIp("192.168.88.50") ?? 0;
    expect(matchAddress(ip, "2001:db8::/32")).toBeNull();
    expect(matchAddress(ip, "example.com")).toBeNull();
  });

  test("port matchers cover single, list and range forms", () => {
    expect(matchPort(443, "443")).toBe(true);
    expect(matchPort(443, "80,443")).toBe(true);
    expect(matchPort(8080, "1000-9000")).toBe(true);
    expect(matchPort(22, "80,443")).toBe(false);
    expect(matchPort(undefined, "443")).toBe(false);
    expect(matchPort(443, "https")).toBeNull();
  });

  test("/0 and /32 are handled without shift overflow", () => {
    expect(parseCidr("0.0.0.0/0")?.network).toBe(0);
    expect(matchAddress(parseIp("8.8.8.8") ?? 0, "0.0.0.0/0")).toBe(true);
    expect(matchAddress(parseIp("8.8.8.8") ?? 0, "8.8.8.8/32")).toBe(true);
  });
});
