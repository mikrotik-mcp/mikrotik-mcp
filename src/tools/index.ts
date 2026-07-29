/**
 * The complete tool catalog — the single source of truth for both the server
 * (which registers `allToolModules`) and the doc/schema generators (which read
 * the labels and descriptions from `moduleCatalog`). Add a module in exactly one
 * place: here.
 */
import type { ToolModule } from "../core/registry";

import { addressListTools } from "./address-list";
import { connectedDeviceTools } from "./connected-devices";
import { appViewTools } from "./app-views";
import { backupTools } from "./backup";
import { localBackupTools } from "./local-backup";
import { s3BackupTools } from "./s3-backup";
import { bridgeTools } from "./bridge";
import { certificateTools } from "./certificate";
import { certStewardTools } from "./cert-steward";
import { changePlanTools } from "./change-plan";
import { complianceAuditTools } from "./compliance-audit";
import { configDriftTools } from "./config-drift";
import { configSnapshotTools } from "./config-snapshot";
import { deviceTools } from "./devices";
import { dhcpTools } from "./dhcp";
import { hotspotBuilderTools } from "./hotspot-builder";
import { containerTools } from "./container";
import { diskTools } from "./disk";
import { rawCommandTools } from "./raw-command";
import { toolGatewayTools } from "./tool-gateway";
import { dnsTools } from "./dns";
import { parentalControlsTools } from "./parental-controls";
import { dot1xServerTools } from "./dot1x-server";
import { dot1xClientTools } from "./dot1x-client";
import { firewallAuditTools } from "./firewall-audit";
import { securityShieldTools } from "./security-shield";
import { securityHardeningTools } from "./security-hardening";
import { portScanDetectionTools } from "./port-scan-detection";
import { portKnockTools } from "./port-knock";
import { firewallFilterTools } from "./firewall-filter";
import { firewallNatTools } from "./firewall-nat";
import { firewallMangleTools } from "./firewall-mangle";
import { firmwareLifecycleTools } from "./firmware-lifecycle";
import { portForwardTools } from "./port-forward";
import { interfaceTools } from "./interfaces";
import { ipAddressTools } from "./ip-address";
import { ipPoolTools } from "./ip-pool";
import { ipServiceTools } from "./ip-service";
import { ipSshTools } from "./ip-ssh";
import { ipCloudTools } from "./ip-cloud";
import { ipDhcpClientTools } from "./ip-dhcp-client";
import { ipv6AddressTools } from "./ipv6-address";
import { ipv6DhcpClientTools } from "./ipv6-dhcp-client";
import { ipv6DhcpRelayTools } from "./ipv6-dhcp-relay";
import { ipv6DhcpServerTools } from "./ipv6-dhcp-server";
import { ipv6FirewallFilterTools } from "./ipv6-firewall-filter";
import { ipv6FirewallNatTools } from "./ipv6-firewall-nat";
import { ipv6FirewallMangleTools } from "./ipv6-firewall-mangle";
import { ipv6FirewallRawTools } from "./ipv6-firewall-raw";
import { ipv6FirewallAddressListTools } from "./ipv6-firewall-address-list";
import { ipv6NdTools } from "./ipv6-nd";
import { ipv6NeighborTools } from "./ipv6-neighbor";
import { ipv6PoolTools } from "./ipv6-pool";
import { ipv6RouteTools } from "./ipv6-route";
import { ipv6SettingsTools } from "./ipv6-settings";
import { ipsecTools } from "./ipsec";
import { l2tpTools } from "./l2tp";
import { logTools } from "./logs";
import { systemLoggingTools } from "./logging";
import { neighborTools } from "./neighbor";
import { networkToolTools } from "./network-tools";
import { sshTestTools } from "./ssh-test";
import { packetCaptureTools } from "./packet-capture";
import { bandwidthServerTools } from "./tool-bandwidth-server";
import { floodPingTools } from "./tool-flood-ping";
import { graphingTools } from "./tool-graphing";
import { ipScanTools } from "./tool-ip-scan";
import { macServerTools } from "./tool-mac-server";
import { snifferTools } from "./tool-sniffer";
import { profileTools } from "./tool-profile";
import { romonTools } from "./tool-romon";
import { smsTools } from "./tool-sms";
import { speedTestTools } from "./tool-speed-test";
import { trafficGeneratorTools } from "./tool-traffic-generator";
import { trafficMonitorTools } from "./tool-traffic-monitor";
import { bandwidthForecastTools } from "./bandwidth-forecast";
import { wolTools } from "./tool-wol";
import { openvpnTools } from "./openvpn";
import { poeTools } from "./poe";
import { pppTools } from "./ppp";
import { pptpTools } from "./pptp";
import { qosArchitectTools } from "./qos-architect";
import { queueTools } from "./queue";
import { queueInterfaceTools } from "./queue-interface";
import { aaaViewTools } from "./aaa-view";
import { radiusTools } from "./radius";
import { rootCauseTools } from "./root-cause";
import { multiwanTools } from "./multiwan";
import { routeTools } from "./routes";
import { routingBfdTools } from "./routing-bfd";
import { routingBgpTools } from "./routing-bgp";
import { routingFilterTools } from "./routing-filter";
import { routingGmpTools } from "./routing-gmp";
import { routingIdTools } from "./routing-id";
import { routingIgmpProxyTools } from "./routing-igmp-proxy";
import { routingNexthopTools } from "./routing-nexthop";
import { routingOspfTools } from "./routing-ospf";
import { routingPimsmTools } from "./routing-pimsm";
import { routingRipTools } from "./routing-rip";
import { routingRpkiTools } from "./routing-rpki";
import { routingSettingsTools } from "./routing-settings";
import { routingRuleTools } from "./routing-rule";
import { routingTableTools } from "./routing-table";
import { drDrillTools } from "./dr-drill";
import { safeModeTools } from "./safe-mode";
import { schedulerTools } from "./scheduler";
import { serverPulseTools } from "./server-pulse";
import { capabilityTools } from "./capability";
import { alertTools } from "./alerts";
import { threatFeedTools } from "./threat-feed";
import { sstpTools } from "./sstp";
import { switchSettingsTools } from "./switch-settings";
import { switchPortTools } from "./switch-port";
import { switchPortIsolationTools } from "./switch-port-isolation";
import { switchRuleTools } from "./switch-rule";
import { systemConfigTools } from "./system-config";
import { systemTools } from "./system";
import { tunnelTools } from "./tunnels";
import { userManagerTools } from "./user-manager";
import { userTools } from "./users";
import { vlanDesignerTools } from "./vlan-designer";
import { vlanTools } from "./vlan";
import { wireguardMeshTools } from "./wireguard-mesh";
import { vpnOnboardTools } from "./vpn-onboard";
import { wireguardTools } from "./wireguard";
import { wirelessTools } from "./wireless";
import { wifiOptimizerTools } from "./wifi-optimizer";
import { capsmanTools } from "./capsman";
import { memoryTools } from "./memory";

export interface ModuleInfo {
  /** Display label used in docs. */
  label: string;
  /** Anchor/slug used for doc cross-links. */
  slug: string;
  /** Functional group the module belongs to. */
  group: string;
  /** One-line scope summary. */
  description: string;
  tools: ToolModule;
}

export const moduleCatalog: ModuleInfo[] = [
  // ── Tool gateway (always-discoverable search + dispatch over the full catalog) ─
  {
    label: "Tool Gateway",
    slug: "tool-gateway",
    group: "Discovery & Meta",
    description:
      "Always-discoverable meta-tools that make the whole catalog reachable when the host can't " +
      "surface a specific tool: search by intent (`find_tools`), inspect a schema (`describe_tool`), " +
      "and run any tool by name with full validation (`invoke_tool`).",
    tools: toolGatewayTools,
  },
  {
    label: "Server Pulse",
    slug: "server-pulse",
    group: "Discovery & Meta",
    description:
      "Server self-awareness: running version, update availability, release notes, " +
      "upgrade path, and server vitals. No RouterOS device is contacted.",
    tools: serverPulseTools,
  },
  {
    label: "Device Capabilities",
    slug: "device-capabilities",
    group: "Discovery & Meta",
    description:
      "What a device can actually do: RouterOS version and channel, board and architecture, " +
      "wireless stack, enabled packages, and device-mode permissions — the facts that decide " +
      "which tools are usable on it.",
    tools: capabilityTools,
  },
  {
    label: "Alerting",
    slug: "alerting",
    group: "System & Ops",
    description:
      "Rules that watch this server and reach out when something changes — error spikes, a " +
      "device going dark, drift, a destructive call on a named router — delivered to Slack, " +
      "Discord, ntfy, a generic webhook, or the MCP client itself.",
    tools: alertTools,
  },
  // ── Universal primitive (the reliable dispatcher for any RouterOS command) ─
  {
    label: "RouterOS CLI",
    slug: "raw-command",
    group: "System & Ops",
    description:
      "Universal escape hatch — run any raw RouterOS CLI command (read or write) when a dedicated tool " +
      "isn't found (`run_routeros_command`).",
    tools: rawCommandTools,
  },
  // ── Layer 2 / interfaces ─────────────────────────────────────────────────
  {
    label: "Interfaces",
    slug: "interfaces",
    group: "Interfaces",
    description: "Generic interface listing and enable/disable (`/interface`).",
    tools: interfaceTools,
  },
  {
    label: "VLAN",
    slug: "vlan",
    group: "Interfaces",
    description: "802.1Q VLAN interfaces (`/interface vlan`).",
    tools: vlanTools,
  },
  {
    label: "VLAN Designer",
    slug: "vlan-designer",
    group: "Interfaces",
    description:
      "Stand up a complete isolated VLAN segment (interface, gateway, DHCP, internet, inter-VLAN " +
      "isolation) from one intent, with preview-before-apply.",
    tools: vlanDesignerTools,
  },
  {
    label: "Bridge",
    slug: "bridge",
    group: "Interfaces",
    description: "Bridges, ports, host table and bridge VLANs (`/interface bridge`).",
    tools: bridgeTools,
  },
  {
    label: "Wireless",
    slug: "wireless",
    group: "Interfaces",
    description: "Wireless interfaces, security profiles and access lists (legacy + wifiwave2).",
    tools: wirelessTools,
  },
  {
    label: "Wi-Fi Optimizer",
    slug: "wifi-optimizer",
    group: "Interfaces",
    description:
      "Survey RF channel usage and tune a wireless radio to the least-congested frequency, with " +
      "preview-before-apply (legacy `/interface wireless`).",
    tools: wifiOptimizerTools,
  },
  {
    label: "CAPsMAN Orchestrator",
    slug: "capsman",
    group: "Interfaces",
    description:
      "Enterprise CAPsMAN Wi-Fi control-plane audit: coverage/co-channel, weak-signal clients + " +
      "neighbor steering, resource-aware load, 802.11r fast-roaming (FT) and HA redundancy — one " +
      "severity-ranked report (read-only; steering/apply land in later phases). Supports v7 " +
      "`/interface wifi` CAPsMAN and legacy `/caps-man`.",
    tools: capsmanTools,
  },
  {
    label: "PoE",
    slug: "poe",
    group: "Interfaces",
    description: "Power-over-Ethernet status and configuration (`/interface ethernet poe`).",
    tools: poeTools,
  },
  // ── Switch chip (`/interface ethernet switch`) ───────────────────────────
  {
    label: "Switch — Settings",
    slug: "switch-settings",
    group: "Switch",
    description:
      "Hardware switch chips: mirroring, CPU flow control (`/interface ethernet switch`).",
    tools: switchSettingsTools,
  },
  {
    label: "Switch — Ports",
    slug: "switch-port",
    group: "Switch",
    description: "Per-port switch chip VLAN settings (`/interface ethernet switch port`).",
    tools: switchPortTools,
  },
  {
    label: "Switch — Port Isolation",
    slug: "switch-port-isolation",
    group: "Switch",
    description:
      "Hardware port isolation / forwarding overrides (`/interface ethernet switch port-isolation`).",
    tools: switchPortIsolationTools,
  },
  {
    label: "Switch — Rules",
    slug: "switch-rule",
    group: "Switch",
    description: "Hardware switch ACL/redirect rules (`/interface ethernet switch rule`).",
    tools: switchRuleTools,
  },
  // ── Layer 3 / addressing & routing ───────────────────────────────────────
  {
    label: "IP Addresses",
    slug: "ip-address",
    group: "Addressing & Routing",
    description: "Interface IP addressing (`/ip address`).",
    tools: ipAddressTools,
  },
  {
    label: "IP Pools",
    slug: "ip-pool",
    group: "Addressing & Routing",
    description: "Address pools for DHCP/PPP (`/ip pool`).",
    tools: ipPoolTools,
  },
  {
    label: "Routing — Static",
    slug: "routes",
    group: "Addressing & Routing",
    description: "Static routes, routing table, route checks and cache (`/ip route`).",
    tools: routeTools,
  },
  {
    label: "Multi-WAN",
    slug: "multiwan",
    group: "Addressing & Routing",
    description:
      "Resilient multi-WAN from intent: active-passive failover and ECMP load balancing with " +
      "health-checked default routes and a preview-before-apply step.",
    tools: multiwanTools,
  },
  {
    label: "DHCP",
    slug: "dhcp",
    group: "Addressing & Routing",
    description: "DHCP servers, networks and pools (`/ip dhcp-server`).",
    tools: dhcpTools,
  },
  {
    label: "DHCP Client",
    slug: "ip-dhcp-client",
    group: "Addressing & Routing",
    description:
      "IPv4 DHCP client - obtain address/gateway/DNS on an interface (`/ip dhcp-client`).",
    tools: ipDhcpClientTools,
  },
  {
    label: "Hotspot Builder",
    slug: "hotspot-builder",
    group: "Addressing & Routing",
    description:
      "Stand up a guest hotspot with a captive portal (gateway, DHCP, /ip hotspot, per-guest cap, " +
      "walled garden) and generate printable vouchers, with preview-before-apply.",
    tools: hotspotBuilderTools,
  },
  {
    label: "DNS",
    slug: "dns",
    group: "Addressing & Routing",
    description: "DNS settings, static records, cache and regexp (`/ip dns`).",
    tools: dnsTools,
  },
  {
    label: "Parental Controls",
    slug: "parental-controls",
    group: "Addressing & Routing",
    description:
      "Time-of-day internet policy per device address-list (scheduled drop) plus DNS content " +
      "sinkholes, with preview-before-apply.",
    tools: parentalControlsTools,
  },
  // ── IPv6 (`/ipv6`) ───────────────────────────────────────────────────────
  {
    label: "IPv6 Addresses",
    slug: "ipv6-address",
    group: "IPv6",
    description: "Interface IPv6 addressing (`/ipv6 address`).",
    tools: ipv6AddressTools,
  },
  {
    label: "DHCPv6 Client",
    slug: "ipv6-dhcp-client",
    group: "IPv6",
    description: "DHCPv6 client: address/prefix delegation requests (`/ipv6 dhcp-client`).",
    tools: ipv6DhcpClientTools,
  },
  {
    label: "DHCPv6 Relay",
    slug: "ipv6-dhcp-relay",
    group: "IPv6",
    description: "DHCPv6 relay: forward client requests to upstream servers (`/ipv6 dhcp-relay`).",
    tools: ipv6DhcpRelayTools,
  },
  {
    label: "DHCPv6 Server",
    slug: "ipv6-dhcp-server",
    group: "IPv6",
    description: "DHCPv6 server, static bindings and custom options (`/ipv6 dhcp-server`).",
    tools: ipv6DhcpServerTools,
  },
  {
    label: "IPv6 Firewall — Filter",
    slug: "ipv6-firewall-filter",
    group: "IPv6",
    description: "IPv6 filter rules (`/ipv6 firewall filter`).",
    tools: ipv6FirewallFilterTools,
  },
  {
    label: "IPv6 Firewall — NAT",
    slug: "ipv6-firewall-nat",
    group: "IPv6",
    description: "IPv6 NAT rules: src-nat, dst-nat, masquerade, netmap (`/ipv6 firewall nat`).",
    tools: ipv6FirewallNatTools,
  },
  {
    label: "IPv6 Firewall — Mangle",
    slug: "ipv6-firewall-mangle",
    group: "IPv6",
    description:
      "IPv6 mangle rules: connection/packet/routing marks, DSCP, hop-limit (`/ipv6 firewall mangle`).",
    tools: ipv6FirewallMangleTools,
  },
  {
    label: "IPv6 Firewall — Raw",
    slug: "ipv6-firewall-raw",
    group: "IPv6",
    description: "IPv6 raw rules: pre-conntrack accept/drop/notrack (`/ipv6 firewall raw`).",
    tools: ipv6FirewallRawTools,
  },
  {
    label: "IPv6 Firewall — Address List",
    slug: "ipv6-firewall-address-list",
    group: "IPv6",
    description: "IPv6 firewall address-lists (`/ipv6 firewall address-list`).",
    tools: ipv6FirewallAddressListTools,
  },
  {
    label: "IPv6 ND",
    slug: "ipv6-nd",
    group: "IPv6",
    description:
      "Neighbor Discovery / Router Advertisement config and advertised prefixes (`/ipv6 nd`).",
    tools: ipv6NdTools,
  },
  {
    label: "IPv6 Neighbors",
    slug: "ipv6-neighbor",
    group: "IPv6",
    description: "IPv6 neighbor cache (ND-discovered addresses), read + flush (`/ipv6 neighbor`).",
    tools: ipv6NeighborTools,
  },
  {
    label: "IPv6 Pool",
    slug: "ipv6-pool",
    group: "IPv6",
    description: "IPv6 address/prefix pools for delegation and addressing (`/ipv6 pool`).",
    tools: ipv6PoolTools,
  },
  {
    label: "IPv6 Routes",
    slug: "ipv6-route",
    group: "IPv6",
    description: "Static IPv6 routes, incl. default and blackhole/unreachable (`/ipv6 route`).",
    tools: ipv6RouteTools,
  },
  {
    label: "IPv6 Settings",
    slug: "ipv6-settings",
    group: "IPv6",
    description:
      "Global IPv6 settings: forwarding, RA/redirect acceptance, neighbor table (`/ipv6 settings`).",
    tools: ipv6SettingsTools,
  },
  // ── Dynamic routing (`/routing`) ─────────────────────────────────────────
  {
    label: "Router ID",
    slug: "routing-id",
    group: "Dynamic Routing",
    description: "Router-ID instances for OSPF/BGP (`/routing id`).",
    tools: routingIdTools,
  },
  {
    label: "Routing Settings",
    slug: "routing-settings",
    group: "Dynamic Routing",
    description:
      "Global routing settings: ECMP hash policy, VRF-as-interface (`/routing settings`).",
    tools: routingSettingsTools,
  },
  {
    label: "Routing Tables",
    slug: "routing-table",
    group: "Dynamic Routing",
    description: "Named routing tables / FIBs (`/routing table`).",
    tools: routingTableTools,
  },
  {
    label: "Routing Rules",
    slug: "routing-rule",
    group: "Dynamic Routing",
    description:
      "Policy routing rules selecting a table by src/dst/interface/mark (`/routing rule`).",
    tools: routingRuleTools,
  },
  {
    label: "Next-hops",
    slug: "routing-nexthop",
    group: "Dynamic Routing",
    description: "Resolved recursive next-hop table, read-only diagnostics (`/routing nexthop`).",
    tools: routingNexthopTools,
  },
  {
    label: "Routing Filters",
    slug: "routing-filter",
    group: "Dynamic Routing",
    description: "Route filter rules, select-rules and num-lists (`/routing filter`).",
    tools: routingFilterTools,
  },
  {
    label: "BFD",
    slug: "routing-bfd",
    group: "Dynamic Routing",
    description: "Bidirectional Forwarding Detection config + sessions (`/routing bfd`).",
    tools: routingBfdTools,
  },
  {
    label: "BGP",
    slug: "routing-bgp",
    group: "Dynamic Routing",
    description: "BGP connections, templates, sessions and advertisements (`/routing bgp`).",
    tools: routingBgpTools,
  },
  {
    label: "OSPF",
    slug: "routing-ospf",
    group: "Dynamic Routing",
    description:
      "OSPF instances, areas, ranges, interface-templates, neighbors and LSAs (`/routing ospf`).",
    tools: routingOspfTools,
  },
  {
    label: "RIP",
    slug: "routing-rip",
    group: "Dynamic Routing",
    description: "RIP instances, interface-templates, static + dynamic neighbors (`/routing rip`).",
    tools: routingRipTools,
  },
  {
    label: "PIM-SM",
    slug: "routing-pimsm",
    group: "Dynamic Routing",
    description:
      "PIM Sparse-Mode instances, interface-templates, RPs and neighbors (`/routing pimsm`).",
    tools: routingPimsmTools,
  },
  {
    label: "IGMP Proxy",
    slug: "routing-igmp-proxy",
    group: "Dynamic Routing",
    description: "IGMP proxy settings, interfaces and forwarding cache (`/routing igmp-proxy`).",
    tools: routingIgmpProxyTools,
  },
  {
    label: "GMP",
    slug: "routing-gmp",
    group: "Dynamic Routing",
    description:
      "Group Management Protocol (IGMP/MLD) interfaces and memberships (`/routing gmp`).",
    tools: routingGmpTools,
  },
  {
    label: "RPKI",
    slug: "routing-rpki",
    group: "Dynamic Routing",
    description: "RPKI validator sessions for BGP origin validation (`/routing rpki`).",
    tools: routingRpkiTools,
  },
  // ── Security ─────────────────────────────────────────────────────────────
  {
    label: "Firewall — Filter",
    slug: "firewall-filter",
    group: "Security",
    description: "Filter rules and a guided basic setup (`/ip firewall filter`).",
    tools: firewallFilterTools,
  },
  {
    label: "Firewall — NAT",
    slug: "firewall-nat",
    group: "Security",
    description: "NAT rules: src/dst-nat, masquerade, redirect (`/ip firewall nat`).",
    tools: firewallNatTools,
  },
  {
    label: "Firewall — Mangle",
    slug: "firewall-mangle",
    group: "Security",
    description:
      "Mangle rules: connection/packet/routing marks, DSCP, TTL, MSS (`/ip firewall mangle`).",
    tools: firewallMangleTools,
  },
  {
    label: "Port Forward",
    slug: "port-forward",
    group: "Security",
    description:
      "Smart port-forward wizard: dst-nat + forward accept + hairpin NAT in one call, with " +
      "preview-before-apply.",
    tools: portForwardTools,
  },
  {
    label: "Address Lists",
    slug: "address-list",
    group: "Security",
    description: "Firewall address-lists (`/ip firewall address-list`).",
    tools: addressListTools,
  },
  {
    label: "Connected Devices",
    slug: "connected-devices",
    group: "Security",
    description:
      "Manage devices on the network: unified list (DHCP lease + ARP), live traffic, " +
      "block/allow by MAC, pin/change IP, and labels.",
    tools: connectedDeviceTools,
  },
  {
    label: "Firewall — Audit",
    slug: "firewall-audit",
    group: "Security",
    description:
      "Plain-language firewall audit: shadowed/unreachable rules, broad accepts, missing " +
      "default-drop, duplicates and dead rules, with a risk score (`firewall_audit`).",
    tools: firewallAuditTools,
  },
  {
    label: "Security Shield",
    slug: "security-shield",
    group: "Security",
    description:
      "Harden the firewall against DDoS, SSH/Winbox brute-force, port scans, floods and spoofing " +
      "from a chosen preset/toggles, with anti-lockout, Safe-Mode apply and preview-before-apply.",
    tools: securityShieldTools,
  },
  {
    label: "Security Hardening",
    slug: "security-hardening",
    group: "Security",
    description:
      "Granular audit+remediate pairs per risk category (firewall default-deny, address-list " +
      "enforcement, kernel IP hardening, IPv6 baseline, SSH, IP service exposure, connection-tracking " +
      "helpers, management-plane, account hygiene, certificate CRL, network segmentation, DNS resolver) " +
      "plus an orchestrator (`run_security_hardening_audit` / `apply_security_hardening_fixes`) — every " +
      "audit is read-only, every fix defaults to dry-run and snapshots + Safe-Modes before writing.",
    tools: securityHardeningTools,
  },
  {
    label: "Port-Scan Detection",
    slug: "port-scan-detection",
    group: "Security",
    description:
      "Detect (never block) six port-scan signatures (psd, Nmap FIN/NULL/Xmas, SYN/FIN, SYN/RST) by " +
      "tagging the source into an address list, inside a trust-excluding `detect-portscan` jump-gate — " +
      "with a mandatory explicit signature selection, pre-flight trust-list validation, snapshot and " +
      "Safe-Mode apply (`list_port_scan_detection_signatures`, `add_port_scan_detection_rules`).",
    tools: portScanDetectionTools,
  },
  {
    label: "Port Knock",
    slug: "port-knock",
    group: "Security",
    description:
      "Hide management services behind a secret port-knock sequence (staged address-list ladder), " +
      "with preview-before-apply.",
    tools: portKnockTools,
  },
  {
    label: "Certificates",
    slug: "certificate",
    group: "Security",
    description: "X.509 certificate management (`/certificate`).",
    tools: certificateTools,
  },
  {
    label: "Certificate Steward",
    slug: "cert-steward",
    group: "Security",
    description:
      "Certificate lifecycle helpers: a one-call expiry audit and Let's Encrypt issuance/renewal " +
      "via RouterOS's ACME client — so a TLS cert never silently lapses.",
    tools: certStewardTools,
  },
  {
    label: "Compliance Auditor",
    slug: "compliance-audit",
    group: "Security",
    description:
      "Comprehensive device security posture audit — SSH, services, firewall, users, DNS, " +
      "certificates, network services, system hardening, VPN — scored A+ through F with " +
      "per-check pass/fail/warn and fix commands.",
    tools: complianceAuditTools,
  },
  {
    label: "IP Services",
    slug: "ip-service",
    group: "Security",
    description: "Management service ports — ssh/www/api/telnet (`/ip service`).",
    tools: ipServiceTools,
  },
  {
    label: "SSH Server",
    slug: "ip-ssh",
    group: "Security",
    description:
      "SSH server settings (`/ip ssh`) — TCP forwarding (jump-host/ProxyJump), crypto strength, " +
      "password-vs-key policy, host-key regenerate/import/export.",
    tools: ipSshTools,
  },
  {
    label: "IP Cloud (DDNS)",
    slug: "ip-cloud",
    group: "Addressing & Routing",
    description:
      "RouterOS cloud DDNS — stable <serial>.sn.mynetname.net name that tracks the WAN IP, with " +
      "force-update and advanced options (`/ip cloud`).",
    tools: ipCloudTools,
  },
  {
    label: "802.1X — Server",
    slug: "dot1x-server",
    group: "Security",
    description:
      "802.1X authenticator: port-based access control via RADIUS (`/interface dot1x server`).",
    tools: dot1xServerTools,
  },
  {
    label: "802.1X — Client",
    slug: "dot1x-client",
    group: "Security",
    description:
      "802.1X supplicant: authenticate the device to an upstream port (`/interface dot1x client`).",
    tools: dot1xClientTools,
  },
  // ── VPN / tunneling ──────────────────────────────────────────────────────
  {
    label: "WireGuard",
    slug: "wireguard",
    group: "VPN & Tunneling",
    description: "WireGuard interfaces, peers and client-config generation.",
    tools: wireguardTools,
  },
  {
    label: "WireGuard Mesh",
    slug: "wireguard-mesh",
    group: "VPN & Tunneling",
    description:
      "Stand up a full-mesh or hub-spoke WireGuard VPN across several devices in one call — auto " +
      "key distribution, mesh addressing and peer wiring, with a preview-before-build step.",
    tools: wireguardMeshTools,
  },
  {
    label: "VPN Onboarding",
    slug: "vpn-onboard",
    group: "VPN & Tunneling",
    description:
      "Onboard a WireGuard remote user in one step: generate the client keypair, add the peer, and " +
      "return a ready-to-import client config; plus a revoke action.",
    tools: vpnOnboardTools,
  },
  {
    label: "IPsec",
    slug: "ipsec",
    group: "VPN & Tunneling",
    description:
      "IPsec IKEv1/IKEv2: profiles, peers, identities, proposals, policies, SAs (`/ip ipsec`).",
    tools: ipsecTools,
  },
  {
    label: "PPP",
    slug: "ppp",
    group: "VPN & Tunneling",
    description: "Shared PPP backend: profiles, secrets, active sessions (`/ppp`).",
    tools: pppTools,
  },
  {
    label: "L2TP",
    slug: "l2tp",
    group: "VPN & Tunneling",
    description: "L2TP server + clients, incl. L2TP/IPsec (`/interface l2tp-*`).",
    tools: l2tpTools,
  },
  {
    label: "PPTP",
    slug: "pptp",
    group: "VPN & Tunneling",
    description: "PPTP server + clients (legacy) (`/interface pptp-*`).",
    tools: pptpTools,
  },
  {
    label: "SSTP",
    slug: "sstp",
    group: "VPN & Tunneling",
    description: "SSTP (TLS) server + clients (`/interface sstp-*`).",
    tools: sstpTools,
  },
  {
    label: "OpenVPN",
    slug: "openvpn",
    group: "VPN & Tunneling",
    description:
      "OpenVPN servers — legacy single + RouterOS 7.17 multi-server — and clients (`/interface ovpn-*`).",
    tools: openvpnTools,
  },
  {
    label: "Tunnels",
    slug: "tunnels",
    group: "VPN & Tunneling",
    description: "GRE, IPIP, EoIP and VXLAN tunnels (`/interface gre|ipip|eoip|vxlan`).",
    tools: tunnelTools,
  },
  // ── AAA (RADIUS / User Manager) ───────────────────────────────────────────
  {
    label: "RADIUS",
    slug: "radius",
    group: "AAA",
    description: "RADIUS client servers, incoming CoA, counters (`/radius`).",
    tools: radiusTools,
  },
  {
    label: "User Manager",
    slug: "user-manager",
    group: "AAA",
    description:
      "Built-in RADIUS server: users, profiles, routers (NAS), limitations, sessions (`/user-manager`).",
    tools: userManagerTools,
  },
  {
    label: "RADIUS & UM Dashboard",
    slug: "aaa-dashboard",
    group: "AAA",
    description:
      "Interactive MCP App dashboard to manage RADIUS + User Manager (servers, users, profiles, " +
      "limitations, NAS, assignments, sessions, settings) with full add/edit/remove.",
    tools: aaaViewTools,
  },
  // ── QoS ──────────────────────────────────────────────────────────────────
  {
    label: "Queues / QoS",
    slug: "queue",
    group: "QoS",
    description: "Queue types, queue trees and simple queues (`/queue`).",
    tools: queueTools,
  },
  {
    label: "QoS Architect",
    slug: "qos-architect",
    group: "QoS",
    description:
      "Build a traffic-shaping policy from structured classes in one call, with a preview-before-apply " +
      "dry run (`/queue simple`).",
    tools: qosArchitectTools,
  },
  {
    label: "Queues — Interface",
    slug: "queue-interface",
    group: "QoS",
    description: "Per-interface queue-type assignment (`/queue interface`).",
    tools: queueInterfaceTools,
  },
  // ── System / operations ──────────────────────────────────────────────────
  {
    label: "Devices",
    slug: "devices",
    group: "System & Ops",
    description:
      "List the configured MikroTik devices the AI can target via the `device` argument.",
    tools: deviceTools,
  },
  {
    label: "System",
    slug: "system",
    group: "System & Ops",
    description: "Identity, resources, health, clock/NTP, packages, reboot/shutdown.",
    tools: systemTools,
  },
  {
    label: "System Config",
    slug: "system-config",
    group: "System & Ops",
    description:
      "Console, LEDs, license, note, NTP server, password, ports, regulatory, reset, special-login, watchdog.",
    tools: systemConfigTools,
  },
  {
    label: "Firmware Lifecycle",
    slug: "firmware-lifecycle",
    group: "System & Ops",
    description:
      "Zero-touch RouterOS upgrade pipeline: discover available releases, compare versions, " +
      "stage packages, capture pre-upgrade health snapshots, execute upgrades with optional " +
      "maintenance-window scheduling, and verify post-upgrade health — with automatic " +
      "RouterOS fallback on failure.",
    tools: firmwareLifecycleTools,
  },
  {
    label: "Network Tools",
    slug: "network-tools",
    group: "System & Ops",
    description: "ping, traceroute, bandwidth-test, DNS resolve, netwatch (`/tool`).",
    tools: networkToolTools,
  },
  {
    label: "Root-Cause Analyzer",
    slug: "root-cause",
    group: "System & Ops",
    description:
      "Intelligent root-cause diagnosis: autonomously investigates across connectivity, " +
      "interfaces, routing (BGP/OSPF), firewall, NAT, ARP/DHCP, DNS, system resources, " +
      "logs, and VPN — correlates evidence into ranked hypotheses with fix commands.",
    tools: rootCauseTools,
  },
  {
    label: "SSH Connectivity Tests",
    slug: "ssh-test",
    group: "System & Ops",
    description:
      "Test SSH from the MCP host to a configured device or any host, and outbound SSH from a device " +
      "(`test_ssh_to_device` / `test_ssh_to_host` / `test_ssh_from_device`).",
    tools: sshTestTools,
  },
  {
    label: "Neighbors / MNDP",
    slug: "neighbor",
    group: "System & Ops",
    description:
      "Discovered Layer-2 neighbours and discovery settings — the data behind the topology map " +
      "(`/ip neighbor`, MNDP/CDP/LLDP).",
    tools: neighborTools,
  },
  // ── Tools (`/tool`) ──────────────────────────────────────────────────────
  {
    label: "Btest Server",
    slug: "tool-bandwidth-server",
    group: "Tools",
    description: "Bandwidth-test server settings and sessions (`/tool bandwidth-server`).",
    tools: bandwidthServerTools,
  },
  {
    label: "Flood Ping",
    slug: "tool-flood-ping",
    group: "Tools",
    description: "ICMP flood ping with summary statistics (`/tool flood-ping`).",
    tools: floodPingTools,
  },
  {
    label: "Graphing",
    slug: "tool-graphing",
    group: "Tools",
    description: "Interface/queue/resource graphing rules (`/tool graphing`).",
    tools: graphingTools,
  },
  {
    label: "IP Scan",
    slug: "tool-ip-scan",
    group: "Tools",
    description: "Discover live hosts on a range or interface (`/tool ip-scan`).",
    tools: ipScanTools,
  },
  {
    label: "MAC Server",
    slug: "tool-mac-server",
    group: "Tools",
    description: "MAC-Telnet/MAC-Winbox/MAC-ping servers and sessions (`/tool mac-server`).",
    tools: macServerTools,
  },
  {
    label: "Packet Sniffer",
    slug: "tool-sniffer",
    group: "Tools",
    description:
      "Packet capture: settings, start/stop/save, captured hosts/protocols/packets (`/tool sniffer`).",
    tools: snifferTools,
  },
  {
    label: "Packet Capture Studio",
    slug: "packet-capture",
    group: "Tools",
    description:
      "Live TZSP capture: stream mirrored packets to this host, decode them in the dashboard, add " +
      "per-flow mirrors, and export pcap (`/tool sniffer` streaming + `sniff-tzsp`).",
    tools: packetCaptureTools,
  },
  {
    label: "Profile",
    slug: "tool-profile",
    group: "Tools",
    description: "CPU usage profiler by subsystem (`/tool profile`).",
    tools: profileTools,
  },
  {
    label: "RoMON",
    slug: "tool-romon",
    group: "Tools",
    description: "Router Management Overlay Network settings and ports (`/tool romon`).",
    tools: romonTools,
  },
  {
    label: "SMS",
    slug: "tool-sms",
    group: "Tools",
    description: "Send/receive SMS over an LTE modem (`/tool sms`).",
    tools: smsTools,
  },
  {
    label: "Speed Test",
    slug: "tool-speed-test",
    group: "Tools",
    description: "Latency/throughput test to another RouterOS (`/tool speed-test`).",
    tools: speedTestTools,
  },
  {
    label: "Traffic Generator",
    slug: "tool-traffic-generator",
    group: "Tools",
    description: "Synthetic traffic: ports, streams and run control (`/tool traffic-generator`).",
    tools: trafficGeneratorTools,
  },
  {
    label: "Traffic Monitor",
    slug: "tool-traffic-monitor",
    group: "Tools",
    description:
      "Run scripts when interface traffic crosses a threshold (`/tool traffic-monitor`).",
    tools: trafficMonitorTools,
  },
  {
    label: "Bandwidth Forecast",
    slug: "bandwidth-forecast",
    group: "Tools",
    description:
      "Sample an interface's throughput and project when it will saturate at an assumed growth rate " +
      "(capacity planning).",
    tools: bandwidthForecastTools,
  },
  {
    label: "Wake-on-LAN",
    slug: "tool-wol",
    group: "Tools",
    description: "Send Wake-on-LAN magic packets (`/tool wol`).",
    tools: wolTools,
  },
  {
    label: "Scheduler / Scripts",
    slug: "scheduler",
    group: "System & Ops",
    description: "Scheduled jobs and scripts (`/system scheduler`, `/system script`).",
    tools: schedulerTools,
  },
  {
    label: "Threat Feed",
    slug: "threat-feed",
    group: "Security",
    description:
      "Subscribe to external threat-intel IP feeds: a scheduled fetch+import into a dynamic firewall " +
      "address-list with an optional raw drop — a self-updating blocklist.",
    tools: threatFeedTools,
  },
  {
    label: "Users",
    slug: "users",
    group: "System & Ops",
    description: "Users, groups, active sessions and SSH keys (`/user`).",
    tools: userTools,
  },
  {
    label: "Logs",
    slug: "logs",
    group: "System & Ops",
    description: "Log retrieval, search, statistics and export (`/log`).",
    tools: logTools,
  },
  {
    label: "Logging Config",
    slug: "logging",
    group: "System & Ops",
    description: "Logging rules + actions: where each topic is logged (`/system logging`).",
    tools: systemLoggingTools,
  },
  {
    label: "Backup",
    slug: "backup",
    group: "System & Ops",
    description: "Binary backups, text exports, file transfer and restore.",
    tools: backupTools,
  },
  {
    label: "Config Snapshots",
    slug: "config-snapshot",
    group: "System & Ops",
    description:
      "Capture point-in-time `/export` snapshots locally and time-travel diff any two (or against " +
      "the live device) to see exactly what changed.",
    tools: configSnapshotTools,
  },
  {
    label: "Config Drift Guardian",
    slug: "config-drift",
    group: "System & Ops",
    description:
      "Golden-config baselines with drift detection, change attribution via system logs, " +
      "and Safe Mode reconciliation.",
    tools: configDriftTools,
  },
  {
    label: "S3 Backup",
    slug: "s3-backup",
    group: "System & Ops",
    description:
      "Optional: ship device backups/exports to S3-compatible storage, organised per device (`/tool fetch` + Bun S3).",
    tools: s3BackupTools,
  },
  {
    label: "Local Backups",
    slug: "local-backup",
    group: "System & Ops",
    description:
      "A local backup vault on the MCP server's own filesystem: create timestamped `/export` `.rsc` " +
      "backups, list/read/rename/delete them, and restore one onto a device via Safe Mode.",
    tools: localBackupTools,
  },
  {
    label: "Disk",
    slug: "disk",
    group: "System & Ops",
    description:
      "Storage management (`/disk`): list/get disks, format (filesystem/partition/encryption), label & " +
      "state, RAID/rsync/RAM virtual disks, SMB/NFS sharing, and eject.",
    tools: diskTools,
  },
  {
    label: "Containers",
    slug: "container",
    group: "System & Ops",
    description:
      "OCI container subsystem (`/container`): lifecycle (add/start/stop/remove/set), global config " +
      "(registry/tmpdir/RAM), named env lists, and volume mounts.",
    tools: containerTools,
  },
  {
    label: "Safe Mode",
    slug: "safe-mode",
    group: "System & Ops",
    description: "Transactional config window with auto-revert (Ctrl+X session).",
    tools: safeModeTools,
  },
  {
    label: "DR Drill",
    slug: "dr-drill",
    group: "System & Ops",
    description:
      "Chaos engineering: rehearse a failure in Safe Mode (disable a WAN/tunnel/route), verify the " +
      "backup path with a ping, then auto-revert — proving failover works.",
    tools: drDrillTools,
  },
  {
    label: "Change Plan",
    slug: "change-plan",
    group: "System & Ops",
    description:
      "Terraform-style dry-run: preview intended commands (risk, lock-out, safe order) and apply " +
      "them under Safe Mode with the exact `/export` diff (`plan_changes`, `apply_plan`).",
    tools: changePlanTools,
  },
  // ── Memory ─────────────────────────────────────────────────────────────
  {
    label: "Knowledge Graph",
    slug: "memory",
    group: "Memory",
    description:
      "Persistent knowledge-graph memory — entities, relations and observations that survive " +
      "across sessions. Create, search and manage structured knowledge the AI can reference.",
    tools: memoryTools,
  },
  // ── Interactive views (MCP Apps) ─────────────────────────────────────────
  {
    label: "Apps — Dashboards",
    slug: "app-views",
    group: "MCP Apps",
    description:
      "Tools that render interactive UI views inline (MCP Apps): the device dashboard, " +
      "the interfaces overview and the firewall-rules table. Every read tool (list_*/get_*) " +
      "additionally renders in the generic records viewer.",
    tools: appViewTools,
  },
];

export const allToolModules: ToolModule[] = moduleCatalog.map((m) => m.tools);

/**
 * Module slugs that survive an allow-list (`enabledModules`) so the tool gateway
 * — the search + dispatch backbone that makes the rest of the catalog reachable
 * — is always present even in a tightly scoped deployment. An explicit
 * `disabledModules`/`disabledGroups` opt-out still removes them.
 */
export const ALWAYS_ON_MODULES = new Set(["tool-gateway", "memory", "server-pulse"]);

/** Shape of the tool-surface filter (mirrors `ToolFilter` in config.ts). */
export interface ToolModuleFilter {
  enabledModules?: string[];
  disabledModules?: string[];
  enabledGroups?: string[];
  disabledGroups?: string[];
}

/**
 * Select which modules register, given a {@link ToolModuleFilter}. Pure and
 * order-preserving so it's trivially unit-testable.
 *
 * Rules (case-insensitive on slug and group):
 *   • If any allow-list (`enabledModules`/`enabledGroups`) is non-empty, a module
 *     must match it (by slug OR group) to survive — everything unmatched drops.
 *   • The deny-lists are then subtracted and WIN: a module whose slug is in
 *     `disabledModules` or whose group is in `disabledGroups` is excluded even if
 *     it was allowed.
 *   • {@link ALWAYS_ON_MODULES} (the tool gateway) bypass the allow-list gate so
 *     discovery never breaks when a deployment scopes down — but an EXPLICIT
 *     `disabledModules`/`disabledGroups` entry still removes them (opt-out wins).
 *   • Empty everywhere → the full catalog (the default, zero behaviour change).
 */
export function selectToolModules(
  filter: ToolModuleFilter = {},
  catalog: ModuleInfo[] = moduleCatalog,
): ToolModule[] {
  const lc = (xs?: string[]): Set<string> => new Set((xs ?? []).map((s) => s.toLowerCase()));
  const enabledModules = lc(filter.enabledModules);
  const disabledModules = lc(filter.disabledModules);
  const enabledGroups = lc(filter.enabledGroups);
  const disabledGroups = lc(filter.disabledGroups);
  const hasAllow = enabledModules.size > 0 || enabledGroups.size > 0;

  return catalog
    .filter((m) => {
      const slug = m.slug.toLowerCase();
      const group = m.group.toLowerCase();
      if (disabledModules.has(slug) || disabledGroups.has(group)) return false;
      // The tool gateway is the discovery safety net — keep it even under an
      // allow-list that forgot it, so `find_tools`/`invoke_tool` always work.
      if (ALWAYS_ON_MODULES.has(slug)) return true;
      if (hasAllow && !(enabledModules.has(slug) || enabledGroups.has(group))) return false;
      return true;
    })
    .map((m) => m.tools);
}
