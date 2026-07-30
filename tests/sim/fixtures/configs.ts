/**
 * Fixtures for the fidelity regressions — anonymised reproductions of config
 * structures found on REAL RouterOS 7 devices during `docs/tasks/08` Phase 4.
 *
 * They live as TypeScript strings rather than `.rsc` files so a spec needs
 * neither `node:fs` nor a bundler text-import: the test runner's tsconfig has no
 * Node types, and a fixture that only loads under one runner is a fixture that
 * will rot.
 *
 * The real exports are deliberately NOT in this repository — they are the
 * user's live network topology. What is preserved here is the SHAPE that caught
 * a bug, not their config.
 */

export const VPS_ON_LINK = `# Structure taken from a real hosted RouterOS VPS (addresses anonymised).
#
# The interesting part is the \`/ip address\` line: a /32 public address whose
# gateway lives in a completely different range and is declared on-link via
# \`network=\`. A model that only looks at the address's own subnet cannot resolve
# that gateway to an interface — which is exactly what happened before the
# fidelity pass.
/interface wireguard add listen-port=20820 mtu=1432 name=wg-to-home
/ip address add address=203.0.113.33 interface=ether1 network=10.0.0.1
/ip address add address=10.64.60.1/30 interface=wg-to-home network=10.64.60.0
/ip dhcp-client add interface=ether1 name=client1
/ip firewall mangle add action=change-mss chain=forward new-mss=1392 out-interface=wg-to-home protocol=tcp tcp-flags=syn
/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1
/ip route add dst-address=0.0.0.0/0 gateway=10.0.0.1
`;

export const HOME_DHCP_WAN = `# Structure taken from a real home router (addresses anonymised).
#
# Three things here that a synthetic fixture would not have thought of:
#   1. the WAN default route is learned by DHCP and is therefore ABSENT from the
#      export, though the device routes on it perfectly well;
#   2. policy routing: mangle marks traffic and a separate table carries the
#      0.0.0.0/1 + 128.0.0.0/1 pair, with \`check-gateway=ping\`;
#   3. the first forward rule matches on \`connection-nat-state\`.
/interface bridge add name=bridge
/interface list add name=LAN
/interface list add name=WAN
/interface list member add interface=bridge list=LAN
/interface list member add interface=ether1 list=WAN
/ip address add address=10.10.10.1/24 interface=bridge network=10.10.10.0
/ip address add address=10.61.60.1/30 interface=wg-to-relay network=10.61.60.0
/ip dhcp-client add interface=ether1 name=wan-dhcp
/ip firewall address-list add address=10.10.10.0/24 list=vpn-relay-src
/ip firewall mangle add action=mark-routing chain=prerouting new-routing-mark=VPN src-address-list=vpn-relay-src
/ip firewall filter add action=accept chain=forward connection-state=established,related
/ip firewall filter add action=accept chain=forward in-interface-list=LAN
/ip firewall filter add action=drop chain=forward
/ip route add check-gateway=ping dst-address=0.0.0.0/1 gateway=10.61.60.2 routing-table=VPN
/ip route add check-gateway=ping dst-address=128.0.0.0/1 gateway=10.61.60.2 routing-table=VPN
`;
