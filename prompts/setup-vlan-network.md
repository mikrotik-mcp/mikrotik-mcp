---
name: setup-vlan-network
title: Design a safe dual-stack VLAN migration
description: Audit the existing topology and plan VLAN ports, SSIDs, management access, IPv4/IPv6 policy and staged verification before any approved change.
arguments:
  - name: vlans
    description: Describe the VLANs you need — e.g. "management=10, staff=20, IoT=30, guest=40" (name=VLAN-ID).
    required: true
  - name: trunk_interface
    description: Optional proposed physical trunk. If omitted, discover and confirm the port map; never assume a bridge or WAN port is the trunk.
    required: false
---

Plan a VLAN-segmented network on the explicitly selected MikroTik device.
Start read-only. A design request is NOT permission to apply it.

VLANs requested: {{vlans}}
Trunk interface: {{trunk_interface}}

1. Discover the current bridge, ports, CPU membership, Wi-Fi package/SSID mapping,
   addresses, DHCP, IPv6, both firewall families and routing dependencies using
   `find_tools`. Resolve management/recovery access and ambiguous port roles first.
2. Present a per-device VLAN map: role, ID, subnet, gateway, DHCP pool, IPv6 /64,
   SSID, access ports/PVIDs, allowed trunk VLANs and bridge/CPU membership. Do not
   allocate conflicting subnets or assume every role needs its own VLAN.
3. Show an IPv4/IPv6 INPUT and FORWARD service matrix and exact rule placement.
   Include remote-site return routes and VPN allowed-addresses only if affected.
   Flag policy routing, NAT, FastTrack, queues and scripts tied to old interfaces.
4. Present ordered steps, prerequisites, backup/rollback and canary tests. Enable
   filtering LAST; do not disable existing filtering during migration. Do not
   silently renumber the working LAN or expose management to every trusted client.
5. `design_network_segment` may preview partial IPv4 scaffolding only. It is NOT
   a full migration or isolation engine. Discover its schema and account for all
   omitted L2/SSID/INPUT/IPv6/routing work; do not apply it once per VLAN blindly.
6. Stop for approval of the exact changes. For approved dependent multi-router
   writes, use the coordinated transaction workflow if available and suitable.
   Never run transaction verification during a read-only audit: it performs writes.
7. After approved changes, read back and test real wired and wireless clients for
   intended allows AND denies over both families. List unverified tests explicitly;
   configuration creation alone is not proof of isolation. Clean up only after
   validation and dependency review, with separate approval for removals.
