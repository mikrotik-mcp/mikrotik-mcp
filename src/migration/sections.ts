/** Deliberately explicit grammar: unsupported semantics are review items, never replayed scripts. */
export const MIGRATION_SECTIONS = {
  "/interface/bridge":
    "name protocol-mode vlan-filtering pvid frame-types ingress-filtering mtu ageing-time priority",
  "/interface/vlan": "name interface vlan-id mtu use-service-tag",
  "/interface/list": "name",
  "/interface/list/member": "interface list",
  "/interface/bridge/port":
    "bridge interface pvid frame-types ingress-filtering hw horizon path-cost internal-path-cost edge point-to-point",
  "/ip/pool": "name ranges",
  "/ip/address": "address interface network",
  "/ip/dhcp-server/network": "address gateway dns-server domain ntp-server netmask",
  "/ip/dhcp-server": "name interface address-pool lease-time authoritative",
  "/ip/dhcp-server/lease": "address mac-address server client-id always-broadcast",
  "/routing/table": "name fib",
  "/ip/route": "dst-address gateway distance routing-table scope target-scope check-gateway",
  "/ip/firewall/address-list": "address list timeout",
  "/ip/firewall/filter":
    "chain action protocol src-address dst-address src-port dst-port connection-state connection-nat-state in-interface out-interface in-interface-list out-interface-list src-address-list dst-address-list icmp-options tcp-flags log log-prefix",
  "/ip/firewall/nat":
    "chain action protocol src-address dst-address src-port dst-port in-interface out-interface in-interface-list out-interface-list src-address-list dst-address-list to-addresses to-ports",
} as const;
export type MigrationSection = keyof typeof MIGRATION_SECTIONS;
