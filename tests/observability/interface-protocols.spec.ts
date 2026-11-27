import { expect, test } from "vite-plus/test";
import { parseInterfaceStats } from "../../src/observability/interface-stats";
import { interfaceProtocol, protocolGroups } from "../../ui/observability/interface-protocols";

test.each([
  ["wg", "WireGuard"],
  ["wireguard", "WireGuard"],
  ["ovpn-in", "OpenVPN"],
  ["ovpn-out", "OpenVPN"],
  ["ovpn-client", "OpenVPN"],
  ["eoipv6-tunnel", "EoIP"],
  ["eoip-tunnel", "EoIP"],
  ["gre6-tunnel", "GRE"],
  ["gre-tunnel", "GRE"],
  ["ipip-tunnel", "IPIP"],
  ["ipipv6-tunnel", "IPIP"],
  ["6to4-tunnel", "6to4"],
  ["l2tp-out", "L2TP"],
  ["l2tp-ether", "L2TPv3 Ethernet"],
  ["pppoe-in", "PPPoE"],
  ["pptp-server", "PPTP"],
  ["sstp-out", "SSTP"],
  ["vxlan", "VXLAN"],
  ["vpls", "VPLS"],
  ["traffic-eng", "MPLS traffic engineering"],
  ["xfrm", "IPsec (XFRM)"],
  ["zerotier", "ZeroTier"],
])("%s is included in the %s tunnel group", (type, label) => {
  expect(interfaceProtocol(type)).toEqual({ label, tunnel: true });
});

test("all reported interfaces appear exactly once, including dynamic and unknown types", () => {
  const rows = parseInterfaceStats(
    '0 R name="wg-office" type=ether\n1 DR name="guest" type=ovpn-in\n2 X name="backup" type=ovpn-out\n3 R name="new" type=future-link',
    "",
  );
  expect(
    protocolGroups(rows).map(({ label, rows }) => [label, rows.map((row) => row.name)]),
  ).toEqual([
    ["OpenVPN", ["guest", "backup"]],
    ["Ethernet", ["wg-office"]],
    ["future-link", ["new"]],
  ]);
  expect(protocolGroups([])).toEqual([]);
  expect(interfaceProtocol("future-tunnel")).toEqual({ label: "future-tunnel", tunnel: true });
});
