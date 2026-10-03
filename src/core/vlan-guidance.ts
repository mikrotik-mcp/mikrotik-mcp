/** Versioned, device-independent VLAN knowledge. No router I/O or memory writes. */
export const VLAN_GUIDE_URI = "mikrotik://knowledge/vlan-segmentation";
export const VLAN_GUIDE_VERSION = "2026-10-03";
export const VLAN_GUIDE_TOPICS = [
  "overview",
  "discovery",
  "layer2",
  "policy",
  "migration",
  "verification",
] as const;
export type VlanGuideTopic = (typeof VLAN_GUIDE_TOPICS)[number];

const sections: Record<VlanGuideTopic, string> = {
  overview: `## Intent and boundaries
Use this guide for homelab VLAN segmentation, guest Wi-Fi, IoT isolation and
management networks. It is reference knowledge, NOT observed device state or
authorization. Start read-only; use find_tools and describe_tool for the tools
actually exposed in this session. Never bypass read-only mode or module restrictions.

Adapt the homelab-vlan-segmentation design to the actual requirements. Illustrative
roles/IDs are Trusted 10, IoT 20, Servers 30 (only if needed), Guest 40 and Management
99. IDs are examples, not reservations or defaults to apply. Preserve working
subnets where possible; check overlap with WAN, VPN, remote sites and other VLANs.
Trusted users are not automatically administrators. Agree a source/destination/
service allow matrix, including router management, before proposing changes.

VLAN sub-interfaces alone do not provide isolation. Layer-2 membership, routed
IPv4/IPv6 policy and actual endpoint tests are separate requirements. A VPS/CHR
used only as a routed tunnel endpoint may need routes/policy, not local VLANs.
Do not extend a broadcast domain across a WAN without an explicit L2 requirement.
Segmentation is not a promise of lower latency or higher tunnel throughput.`,
  discovery: `## Read-only discovery and evidence
Resolve each router by its exact configured device name and verify identity,
RouterOS version, board, switch chip and installed Wi-Fi package. Recall constraints
separately for each device if Memory is enabled; inspect conflicts and omitted
constraints. Recalled facts may be stale. Never copy one router's addresses to another.

Discover interfaces, bridge settings/ports/VLAN table, VLAN sub-interfaces, interface
lists, IP addresses, DHCP pools/networks/leases, DNS, IPv6 addresses/prefix delegation,
ND/RA, IPv4 AND IPv6 filter/raw/NAT/mangle rules, routes/routing tables/rules,
WireGuard allowed-addresses, queues, Wi-Fi/CAPsMAN/SSID datapaths and management
services/MAC discovery. Use bounded, filtered reads; report unsupported, incomplete
or timed-out reads as unknown, never empty or safe. Do not fetch credentials.

Build a physical port map: peer device, WAN/LAN/trunk/access role, bridge, PVID,
tagged/untagged membership, link rate, hardware offload and management dependency.
Do not infer a port's role from ether1, a comment, or a link-down snapshot. Resolve
conflicting labels with the operator. Verify external switch/AP VLAN capability
and its management/native VLAN before planning a trunk. Inventory scripts, netwatch,
interface lists, NAT, policy-routing and queues that depend on the old interfaces.
Distinguish proven observations, intended policy and unverified assumptions.`,
  layer2: `## Layer 2, CPU access and Wi-Fi
For a NEW bridge, stage with vlan-filtering=no. For an existing production bridge,
do not turn filtering off to simplify a migration: that can remove isolation.
Enable VLAN filtering LAST when the VLAN table, port admission, management path,
gateway and recovery plan are ready. A bridge reset can interrupt the session.

A routed VLAN interface normally belongs on the bridge, not on a physical port
already enslaved to it. Include the bridge/CPU as tagged for VLANs terminated on
that bridge and verify effective current-tagged membership (RouterOS may create
dynamic entries). Do not expose CPU membership on VLANs that need only switching.
Creating /interface vlan does not configure /interface bridge vlan or access ports.

On access ports: one intended untagged VLAN, matching PVID, ingress-filtering and
admit-only-untagged-and-priority-tagged where supported. PVID classifies untagged
ingress; it is not a tagged-traffic allowlist. Do not combine multiple VLAN IDs in
a VLAN-table row containing access ports. On tagged-only trunks: explicit allowed
VLAN membership, ingress-filtering and admit-only-vlan-tagged. Model hybrid/native
ports explicitly; inspect dynamic VLAN 1/CPU membership for accidental access.
Never add a WAN/ONT port to a LAN bridge merely because an example uses that number.

Map each SSID to a verified VLAN at the AP as well as its uplink. Inspect wireless,
wifiwave2 or wifi and CAPsMAN local/manager forwarding. wifi-qcom and wifi-qcom-ac
are not interchangeable: qcom-ac needs the appropriate bridge/PVID design rather
than blindly copying CAPsMAN datapath vlan-id. Verify package-specific support.
Guest client isolation within one SSID/VLAN is separate from inter-VLAN firewalling.
Do not enable bridge use-ip-firewall just to filter traffic already routed by the
CPU; inspect hardware-offload support and measure the performance impact.`,
  policy: `## Dual-stack policy and remote-site dependencies
Design INPUT (to the router) and FORWARD (through the router) separately for both
IPv4 and IPv6. Limit administration to the approved management sources/VPNs; allow
only required DHCP/DNS/NTP and essential ICMP/ICMPv6 functions on client segments.
Preserve neighbor discovery, router advertisements where intended and path-MTU
discovery. Do not solve isolation by indiscriminately blocking all ICMPv6.

Evaluate first-match rule order, jumps, broad LAN/!WAN accepts, established flows,
FastTrack and existing final drops. Place exact service exceptions before segment
denies, and denies before broad accepts they must constrain. Appended drop rules
may never match. Use current stable .ids, not saved row numbers. Preserve unrelated
protections and allowlists. RFC1918-only drops miss local public IPv4, VPN/remote
networks and all IPv6; enumerate actual protected destinations. Default-deny between
zones with explicit exceptions is a design goal, not permission to rewrite a firewall.

NAT is not isolation or a routing policy. Reuse valid existing NAT; any new source
NAT must be scoped to the intended egress, never every destination. SNAT may hide
VLAN source identities from a remote router, so enforce segmentation locally unless
an explicitly designed routed/no-NAT topology preserves them. Add new subnets to
VPN allowed-addresses, return routes and remote policies only when required.

Each IPv6 SLAAC segment needs its own non-overlapping /64 from a valid routed or
delegated prefix; do not reuse one /64 on separate L2 domains. Verify upstream
reachability and return routing, not just a local address. If unavailable, report
IPv6 as unconfigured/blocked by prerequisites, not working or isolated by IPv4.

Move policy-routing/interface-list/queue/automation dependencies before retiring
legacy interfaces. FastTrack only eligible main-table traffic; policy-routed,
queued or accounted traffic needs appropriate exclusions. Moving FastTrack above
an established accept can change behavior beyond VLANs; never do it blindly.`,
  migration: `## Safe rollout and planner limits
Deliver: (1) observed topology and unknowns; (2) proposed VLAN/subnet/IPv6/SSID/port
map; (3) explicit allow/deny service matrix; (4) exact ordered per-device changes;
(5) prerequisites, rollback triggers and acceptance tests. Ask only for missing
choices that affect connectivity or policy. Do not invent interface or subnet roles.

Before writes, obtain approval for the exact scope, capture a host-side snapshot
and follow the local-backup requirements. Confirm an independent console, rescue
port or verified management path that does not depend on the bridge being changed.
Do not assume a VPN is independent: it may traverse that same bridge/uplink.
Use owned Safe Mode for suitable single-router changes; coordinated multi-router
writes should use the transaction workflow when available and suitable. Transaction
verification stages REAL changes, not an offline preview. Safe Mode is not a backup
or a guarantee for all operations; ambiguous timeouts are not permission to retry.
Preserve the old management path until the new one has been tested. Canary one
port/SSID/client, then migrate the remainder; never reconfigure all access at once.

design_network_segment is only partial IPv4 scaffolding, not a full isolation
engine. It does not configure bridge port PVID/admission, enable VLAN filtering,
map SSIDs, build router INPUT or IPv6 policy, prove rule reachability, preserve
remote routing, or roll back a partial apply. NAT needs explicit wan_interface;
isolation drops need a current reviewed isolation_before rule .id. Non-/24 DHCP
needs an explicit valid pool. Discover schemas before previewing; apply only after
the surrounding approved configuration satisfies these prerequisites. Do not call
it repeatedly to finish a partially applied plan; read back and reconcile first.
For a complete migration, prefer an explicit reviewed plan with separate steps.`,
  verification: `## Verification, reporting and clean memory
Read back bridge VLAN current-tagged/current-untagged, PVID/admission, gateway IPs,
DHCP and IPv6 ND/RA, rules and counters, routing tables and VPN return routes.
Then test from real representative wired AND wireless clients in each segment:
address/lease, DNS, gateway, required internet/VPN services, allowed local services,
denied cross-zone services, denied router management and guest peer isolation if
requested. Test IPv4 and IPv6 independently, with fresh connections; existing
tracked/FastTracked flows can conceal new policy. Never flush all connections as
an unapproved test. Router-originated ping does not prove client FORWARD policy.

Record expected vs observed per test, sample time, source, address family and
remaining unknowns. If no endpoint is available, mark client isolation unverified.
For performance claims, compare the same path/client/workload before and after:
link speed, CPU/offload, throughput, latency and loss. Ask before disruptive loads.
Commit only an authorized, verified change; uncertain connectivity requires stop,
read-back and the agreed rollback/recovery path, not speculative cleanup.

Only after successful validation, review stale objects and all references before
proposing removals. Disabled is not proof unused. Preserve unrelated tunnels,
WAN failover, management allowlists and domain-routing exceptions.
Memory: store exact VLAN maps, addresses and evidence on each Device with source,
verification time and expiry. Use a dedicated Group policy with explicit members
for site-wide rules; Shared is only for intentionally reusable safeguards. Do not
promote a device entity or store secrets/raw exports. Memory never grants new
permission; generic guidance does not prove live facts.`,
};

const sources = `## Authoritative references
- Bridge VLAN table: https://help.mikrotik.com/docs/spaces/ROS/pages/28606465/Bridge+VLAN+Table
- Wi-Fi packages and CAPsMAN: https://help.mikrotik.com/docs/spaces/ROS/pages/224559120/WiFi
- IPv4/IPv6 firewall: https://help.mikrotik.com/docs/spaces/ROS/pages/328513/Building+Advanced+Firewall
- Packet flow and FastTrack: https://help.mikrotik.com/docs/spaces/ROS/pages/328227/Packet+Flow+in+RouterOS
Verify version-specific behavior against the current official manual before applying.
Adapted from the homelab-vlan-segmentation skill with RouterOS-specific safety gates.`;

/** Same body delivered by the read tool, MCP resource and prompt catalog. */
export function getVlanSegmentationGuide(topic: VlanGuideTopic | "all" = "all"): string {
  const selected = topic === "all" ? VLAN_GUIDE_TOPICS : [topic];
  return [
    `# RouterOS VLAN segmentation knowledge\nGuide version: ${VLAN_GUIDE_VERSION}\nReference only; no device inspection or changes.`,
    ...selected.map((key) => sections[key]),
    sources,
  ].join("\n\n");
}

export const VLAN_INSTRUCTIONS = `VLAN segmentation knowledge:
Before VLAN/guest/IoT/management-network work, read ${VLAN_GUIDE_URI}.
Begin with read-only discovery; never infer port roles from names or example IDs.
Protect the management path, stage VLAN membership/PVID/CPU access before enabling
filtering, and check BOTH IPv4 and IPv6 INPUT/FORWARD policy and remote return routes.
design_network_segment is partial IPv4 scaffolding, NOT a complete isolation plan.
Use only available tools; an audit or this guide never authorizes router changes.
Verified device facts belong to Device memory; reusable safeguards may be Shared
only with explicit intent. Do not treat shared memory as a live VLAN map.`;

/** Enrich the shared catalog, so MCP, dashboard and Raycast receive identical guidance. */
export function vlanPromptGuidance(name: string, body: string): string {
  if (!["setup-vlan-network", "setup-guest-wifi", "audit-vlan-segmentation"].includes(name)) {
    return body;
  }
  return `${body}\n\n${getVlanSegmentationGuide()}`;
}
