import type { InterfaceStats } from "../../src/observability/interface-stats";

interface Protocol {
  label: string;
  tunnel: boolean;
}

// RouterOS reports runtime types (wg, ovpn-in, gre-tunnel) independently of
// the user-assigned name. Client/server and IPv4/IPv6 variants share a family.
const protocols = new Map<string, Protocol>();
function register(label: string, tunnel: boolean, ...types: string[]) {
  for (const type of types) protocols.set(type, { label, tunnel });
}

register("WireGuard", true, "wireguard", "wg");
register("OpenVPN", true, "openvpn", "ovpn");
register("L2TP", true, "l2tp");
register("L2TPv3 Ethernet", true, "l2tp-ether", "l2tpeth", "l2tpv3", "l2tpv3-ether");
register("PPTP", true, "pptp");
register("SSTP", true, "sstp");
register("PPPoE", true, "pppoe");
register("EoIP", true, "eoip", "eoip6", "eoipv6");
register("GRE", true, "gre", "gre6", "grev6");
register("IPIP", true, "ipip", "ipip6", "ipipv6");
register("6to4", true, "6to4");
register("VXLAN", true, "vxlan");
register("VPLS", true, "vpls", "vpls-bgp", "bgp-vpls", "cisco-vpls");
register("MPLS traffic engineering", true, "traffic-eng", "mpls-te");
register("IPsec (XFRM)", true, "xfrm", "ipsec");
register("ZeroTier", true, "zerotier");
register("Ethernet", false, "ether", "ethernet");
register("Wi-Fi", false, "wifi", "wlan", "wireless", "w60g", "wds", "cap");
register("Bridge", false, "bridge");
register("VLAN", false, "vlan");
register("Virtual Ethernet", false, "veth");
register("Loopback", false, "loopback", "lo");
register("Bonding", false, "bond", "bonding");
register("PPP", false, "ppp");
register("LTE", false, "lte");
register("VRRP", false, "vrrp");
register("MACVLAN", false, "macvlan");
register("MACsec", false, "macsec");

export function interfaceProtocol(type: string): Protocol {
  const raw = type.trim().toLowerCase();
  const key = raw.replace(/-(?:tunnel|in|out|server|client)$/, "");
  return protocols.get(key) ?? { label: type || "Unknown", tunnel: raw.endsWith("-tunnel") };
}

export function protocolGroups(rows: InterfaceStats[]) {
  const groups = new Map<string, Protocol & { rows: InterfaceStats[] }>();
  for (const row of rows) {
    const protocol = interfaceProtocol(row.type);
    let group = groups.get(protocol.label);
    if (!group) {
      group = { ...protocol, rows: [] };
      groups.set(protocol.label, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.tunnel) - Number(a.tunnel) || a.label.localeCompare(b.label),
  );
}
