---
name: setup-guest-wifi
title: Set up an isolated guest network
description: Create a segmented guest VLAN/network with its own DHCP, internet access, and isolation from the LAN.
arguments:
  - name: subnet
    description: The guest subnet in CIDR, e.g. 192.168.80.0/24.
    required: true
  - name: vlan_id
    description: VLAN ID for the guest segment, e.g. 80. Optional if using a flat interface.
    required: false
  - name: wan_interface
    description: The interface that reaches the internet (for the masquerade rule).
    required: true
---

Plan an **isolated guest network** on the explicitly selected MikroTik device.
Guests may use approved internet/services, but not local devices or administration.
Start read-only, show the complete plan and request approval before any writes.

Guest subnet: {{subnet}}
Guest VLAN ID: {{vlan_id}}
WAN interface: {{wan_interface}}

1. Discover port roles, AP VLAN support and Wi-Fi package, bridge membership,
   existing addressing, policy routing and IPv4/IPv6 firewall order with `find_tools`.
2. Plan the SSID-to-VLAN mapping on AP and uplink, access PVID/admission, trunk
   membership and bridge/CPU gateway access. Without VLANs, require a genuinely
   separate L2 interface/bridge; a second subnet on the same LAN is not isolation.
3. Check subnet overlap and assign a valid gateway/pool excluding reserved hosts.
   Identify working DNS and egress. Reuse existing NAT where appropriate; never
   add unscoped masquerade. NAT does not allow traffic through a forward firewall.
4. Plan INPUT management protection and FORWARD isolation in BOTH IPv4 and IPv6.
   RFC1918-only drops miss local public addresses, remote/VPN subnets and IPv6.
   Scope essential DHCP/DNS/ICMPv6 allowances; put approved service exceptions
   before denies and denies before conflicting broad accepts. Do not blindly append.
5. Treat guest-to-guest isolation as an additional AP/switch requirement. Prove
   it separately; routed rules cannot prevent all same-VLAN communication.
6. Show exact changes, an independent recovery path and backup/rollback plan.
   After approval only, stage under the suitable safe execution workflow, enable
   VLAN filtering LAST and canary one client before migrating everyone.
7. Test DHCP, DNS, allowed internet, denied local/management access and guest peer
   isolation from actual clients over both families. Read-back alone is insufficient.
   Commit only if verification succeeds and the approval covers this exact change.
