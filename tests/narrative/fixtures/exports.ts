/**
 * Fixture exports for the narrative analyser.
 *
 * TypeScript strings rather than `.rsc` files for the same reason as
 * `tests/sim/fixtures/configs.ts`: the test runner's tsconfig has no Node types,
 * so a fixture loaded with `node:fs` or a `?raw` import only works under one
 * runner and rots under the other.
 *
 * Every address here is documentation-range (RFC 5737 / RFC 1918). None of these
 * is anyone's real network.
 */

/** A typical home router: edge + wireless + switch all at once. */
export const HOME_ROUTER = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
# model = RB5009UG+S+
/interface bridge add name=bridge protocol-mode=none
/interface ethernet set [ find default-name=ether1 ] comment="uplink to fibre ONT" name=ether1-wan
/interface vlan add interface=bridge name=vlan40-guest vlan-id=40
/interface vlan add interface=bridge name=vlan50-iot vlan-id=50
/interface wireless set [ find default-name=wlan1 ] name=wlan1 ssid=home
/interface list add name=LAN
/interface list add name=WAN
/interface bridge port add bridge=bridge interface=ether2
/interface bridge port add bridge=bridge interface=ether3
/interface bridge port add bridge=bridge interface=ether4
/interface list member add interface=bridge list=LAN
/interface list member add interface=vlan40-guest list=LAN
/interface list member add interface=ether1-wan list=WAN
/ip pool add name=lan-pool ranges=192.168.88.10-192.168.88.254
/ip pool add name=guest-pool ranges=192.0.2.10-192.0.2.100
/ip dhcp-server add address-pool=lan-pool interface=bridge name=lan-dhcp
/ip dhcp-server add address-pool=guest-pool interface=vlan40-guest name=guest-dhcp
/ip address add address=192.168.88.1/24 interface=bridge network=192.168.88.0
/ip address add address=192.0.2.1/24 interface=vlan40-guest network=192.0.2.0
/ip address add address=198.51.100.1/24 interface=vlan50-iot network=198.51.100.0
/ip dhcp-client add interface=ether1-wan
/ip dhcp-server lease add address=192.168.88.50 comment="printer" mac-address=AA:BB:CC:DD:EE:01
/ip dhcp-server network add address=192.168.88.0/24 dns-server=192.168.88.1 gateway=192.168.88.1
/ip firewall filter add action=accept chain=input connection-state=established,related
/ip firewall filter add action=accept chain=input in-interface-list=LAN
/ip firewall filter add action=drop chain=input
/ip firewall filter add action=accept chain=forward connection-state=established,related
/ip firewall filter add action=accept chain=forward in-interface-list=LAN out-interface-list=WAN
/ip firewall filter add action=drop chain=forward
/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set www address=192.168.88.0/24
/ip service set ssh port=2222
/system identity set name=home-gw
`;

/** A pure layer-2 switch: bridge ports, no routing, no NAT. */
export const PURE_SWITCH = `# jul/30/2026 03:00:00 by RouterOS 7.15.3
/interface bridge add name=bridge vlan-filtering=yes
/interface bridge port add bridge=bridge interface=ether1 pvid=10
/interface bridge port add bridge=bridge interface=ether2 pvid=10
/interface bridge port add bridge=bridge interface=ether3 pvid=20
/interface bridge port add bridge=bridge interface=ether4 pvid=20
/interface bridge port add bridge=bridge interface=ether5
/interface bridge vlan add bridge=bridge tagged=bridge,ether5 vlan-ids=10
/interface bridge vlan add bridge=bridge tagged=bridge,ether5 vlan-ids=20
/ip address add address=192.168.88.2/24 interface=bridge network=192.168.88.0
/system identity set name=access-sw-01
`;

/** A CHR with external BGP peers — a border router. */
export const BORDER_CHR = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/interface bridge add name=lo
/ip address add address=203.0.113.1/32 interface=lo network=203.0.113.1
/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0
/ip route add distance=1 dst-address=0.0.0.0/0 gateway=198.51.100.1
/routing bgp connection add as=64500 name=upstream-a remote.address=198.51.100.1 remote.as=64496
/routing bgp connection add as=64500 name=peer-internal remote.address=10.0.0.2 remote.as=65001
/routing ospf instance add name=core router-id=203.0.113.1
/ip firewall filter add action=accept chain=input protocol=tcp dst-port=179 src-address=198.51.100.1
/ip firewall filter add action=drop chain=input
/system identity set name=border-01
`;

/** A VPN concentrator: PPP server, pool, secrets, many WireGuard peers. */
export const VPN_CONCENTRATOR = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/interface wireguard add listen-port=51820 mtu=1420 name=wg-hub
/interface wireguard peers add allowed-address=10.20.0.2/32 interface=wg-hub name=laptop
/interface wireguard peers add allowed-address=10.20.0.3/32 interface=wg-hub name=phone
/interface wireguard peers add allowed-address=10.20.0.4/32 endpoint-address=203.0.113.77 interface=wg-hub name=branch
/interface l2tp-server server set enabled=yes use-ipsec=required
/ip pool add name=vpn-pool ranges=10.30.0.10-10.30.0.200
/ppp profile add local-address=10.30.0.1 name=vpn remote-address=vpn-pool
/ppp secret add name=alice profile=vpn service=l2tp
/ppp secret add name=bob profile=vpn service=l2tp
/ip address add address=10.20.0.1/24 interface=wg-hub network=10.20.0.0
/ip address add address=203.0.113.10/24 interface=ether1 network=203.0.113.0
/ip route add dst-address=0.0.0.0/0 gateway=203.0.113.1
/ip firewall filter add action=accept chain=input dst-port=51820 protocol=udp
/ip firewall filter add action=accept chain=input in-interface-list=WAN protocol=udp dst-port=500,4500
/ip firewall filter add action=drop chain=input
/system identity set name=vpn-hub
`;

/** Two WANs with distances and check-gateway — failover. */
export const MULTI_WAN = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/interface list add name=WAN
/interface list member add interface=ether1 list=WAN
/interface list member add interface=ether2 list=WAN
/ip address add address=203.0.113.2/24 interface=ether1 network=203.0.113.0
/ip address add address=198.51.100.2/24 interface=ether2 network=198.51.100.0
/ip address add address=192.168.88.1/24 interface=bridge network=192.168.88.0
/ip route add check-gateway=ping distance=1 dst-address=0.0.0.0/0 gateway=203.0.113.1
/ip route add check-gateway=ping distance=2 dst-address=0.0.0.0/0 gateway=198.51.100.1
/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN
/ip firewall nat add action=dst-nat chain=dstnat dst-port=443 protocol=tcp to-addresses=192.168.88.20 to-ports=443
/system identity set name=dual-wan
`;

/** A VLAN with an address but no DHCP, and an interface with no address at all. */
export const SPARSE = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/interface bridge add name=bridge
/interface vlan add interface=bridge name=vlan99-mgmt vlan-id=99
/interface vlan add interface=bridge name=vlan100-spare vlan-id=100
/ip address add address=10.99.0.1/24 interface=vlan99-mgmt network=10.99.0.0
/system identity set name=sparse
`;

/** Contains a menu the analyser does not model — it must surface as an unknown. */
export const WITH_UNKNOWN_MENU = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/ip address add address=192.168.88.1/24 interface=bridge network=192.168.88.0
/queue tree add max-limit=100M name=upload parent=global
/queue simple add max-limit=20M/20M name=guest target=192.0.2.0/24
/tool netwatch add down-script=failover host=8.8.8.8 interval=10s
/system identity set name=has-queues
`;

/** Containers running on an attached disk — an application host. */
export const APP_HOST = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/disk set usb1 type=hardware
/interface veth add address=172.17.0.2/24 gateway=172.17.0.1 name=veth1
/container add interface=veth1 remote-image=nginx:latest root-dir=usb1/nginx
/container add interface=veth1 remote-image=pihole/pihole:latest root-dir=usb1/pihole
/ip address add address=172.17.0.1/24 interface=veth1 network=172.17.0.0
/system identity set name=app-host
`;

/** A management service open to the whole internet — the worst-case exposure. */
export const WIDE_OPEN = `# jul/30/2026 03:00:00 by RouterOS 7.16.2
/ip address add address=203.0.113.5/24 interface=ether1 network=203.0.113.0
/interface list add name=WAN
/interface list member add interface=ether1 list=WAN
/ip service set telnet port=23
/ip service set www port=80
/ip firewall filter add action=accept chain=input in-interface-list=WAN protocol=tcp dst-port=8291
/system identity set name=exposed
`;
