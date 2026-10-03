---
name: homelab-vlan-segmentation
description: Segmenting home networks into VLANs for IoT, guest, trusted, and server traffic using UniFi, pfSense/OPNsense, and MikroTik — including switch trunk config, firewall rules, and wireless SSID mapping. Use when splitting a home network into IoT, guest, trusted, and server VLANs on UniFi, pfSense/OPNsense, or MikroTik.
metadata:
  origin: community
---

# Homelab VLAN Segmentation

How to split a home network into isolated VLANs so IoT devices, guests, and your main
PCs cannot talk to each other. The most impactful security upgrade for a home network.

Examples are design sketches, not paste-ready changes or proof of isolation.
Existing rule order and IPv6 may invalidate a simple IPv4 deny. Inspect first,
preserve management/recovery access and existing protections, obtain approval,
then apply in a maintenance window with backups and client-side verification.

## When to Use

- Setting up VLANs on a home network for the first time
- Isolating IoT devices (smart bulbs, cameras, TVs) from trusted devices
- Creating a guest Wi-Fi network that cannot reach home devices
- Explaining how VLANs work to someone unfamiliar with the concept
- Configuring trunk ports, access ports, and SSID-to-VLAN mapping
- Troubleshooting inter-VLAN routing or firewall rule issues on pfSense/OPNsense/UniFi

## How It Works

```
Without VLANs — flat network:
  All devices on 192.168.1.0/24
  Smart TV (potential malware) → can reach your NAS, PCs, everything

With VLANs:
  VLAN 10 — Trusted    192.168.10.0/24  (PCs, phones, laptops)
  VLAN 20 — IoT        192.168.20.0/24  (smart TV, bulbs, cameras)
  VLAN 30 — Servers    192.168.30.0/24  (NAS, Pi, VMs)
  VLAN 40 — Guest      192.168.40.0/24  (visitor Wi-Fi)
  VLAN 99 — Management 192.168.99.0/24  (switch/AP web UIs)

  Smart TV → blocked from reaching 192.168.10.0/24 and 192.168.30.0/24
  Guests → internet only, cannot see any home devices
```

## VLAN Design Template

```
VLAN  Name        Subnet              Gateway         Purpose
10    trusted     192.168.10.0/24     192.168.10.1    PCs, phones, laptops
20    iot         192.168.20.0/24     192.168.20.1    Smart home devices
30    servers     192.168.30.0/24     192.168.30.1    NAS, Pi, self-hosted
40    guest       192.168.40.0/24     192.168.40.1    Visitor Wi-Fi
99    management  192.168.99.0/24     192.168.99.1    Network gear web UIs
```

## Examples

**Typical homelab with UniFi AP and managed switch:**

```
Scenario: 3-bedroom house, UniFi Dream Machine + UniFi 8-port switch + 2 APs

VLAN 10 — Trusted    192.168.10.0/24   MacBook, iPhones, iPad
VLAN 20 — IoT        192.168.20.0/24   Nest thermostat, Philips Hue, Ring doorbell, smart TVs
VLAN 30 — Servers    192.168.30.0/24   Synology NAS (192.168.30.10), Pi-hole (192.168.30.2)
VLAN 40 — Guest      192.168.40.0/24   Visitor Wi-Fi — internet only

SSID → VLAN mapping:
  "Home"      → VLAN 10 (WPA2, strong password, trusted devices only)
  "IoT"       → VLAN 20 (WPA2, separate password, printed on router for setup)
  "Guest"     → VLAN 40 (WPA2, simple password you can share freely)

Switch port behavior:
  Port 1  → trunk to router (tagged VLANs 10,20,30,40,99)
  Port 2  → trunk to APs (tagged VLANs 10,20,40; AP handles per-SSID tagging)
  Port 3  → access VLAN 30 (NAS — untagged, no VLAN awareness needed)
  Port 4  → access VLAN 30 (Pi-hole — untagged)
  Port 5–8 → access VLAN 10 (wired workstations)

Firewall rules applied (all rules add isolation, none remove existing protections):
  IoT → Trusted: BLOCK
  IoT → Servers: BLOCK except 192.168.30.2:53 (Pi-hole DNS allowed)
  IoT → Internet: ALLOW
  Guest → Local networks: BLOCK
  Guest → Internet: ALLOW
  Trusted → everywhere: ALLOW
```

## UniFi Configuration

### Create Networks in UniFi Controller

```
Settings → Networks → Create New Network

For each VLAN:
  Name: IoT
  Purpose: Corporate  (gives DHCP + routing)
  VLAN ID: 20
  Network: 192.168.20.0/24
  Gateway IP: 192.168.20.1
  DHCP: Enable
  DHCP Range: 192.168.20.100 – 192.168.20.254
```

### Map SSIDs to VLANs (UniFi)

```
Settings → WiFi → Create New WiFi

  Name: IoT-Network
  Password: <separate password>
  Network: IoT  ← select your VLAN here
  # All devices connecting to this SSID land in VLAN 20

  Name: Guest
  Password: <guest password>
  Network: Guest
  Guest Policy: Enable  ← isolates guests from each other too
```

### UniFi Firewall Rules (Traffic Rules)

```
Settings → Traffic & Security → Traffic Rules

# Block IoT from reaching Trusted VLAN
  Action: Block
  Category: Local Network
  Source: IoT (192.168.20.0/24)
  Destination: Trusted (192.168.10.0/24)

# Allow IoT to reach internet only
  Action: Allow
  Source: IoT
  Destination: Internet

# Block Guest from all local networks
  Action: Block
  Source: Guest
  Destination: Local Networks
```

## pfSense / OPNsense Configuration

### Create VLANs

```
Interfaces → Assignments → VLANs → Add

  Parent Interface: em1  (your LAN NIC)
  VLAN Tag: 20
  Description: IoT

# Repeat for each VLAN, then assign each VLAN to an interface:
Interfaces → Assignments → Add
  Select the VLAN you created → click Add
  Enable the interface, set IP to gateway address (192.168.20.1/24)
```

### DHCP for Each VLAN

```
Services → DHCP Server → Select your VLAN interface

  Enable DHCP
  Range: 192.168.20.100 to 192.168.20.254
  DNS Servers: 192.168.30.2  ← Pi-hole IP if you have one
```

### Firewall Rules (pfSense/OPNsense)

```
# Rules are processed top-to-bottom, first match wins.

# On the IoT interface (VLAN 20):
  Rule 1: Allow IoT → Pi-hole DNS  ← MUST come before the RFC1918 block rule
    Protocol: UDP/TCP
    Source: IoT net
    Destination: 192.168.30.2 port 53
    Action: Allow

  Rule 2: Block IoT → RFC1918 (all private IP ranges)
    Protocol: any
    Source: IoT net
    Destination: RFC1918  (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12)
    Action: Block

  Rule 3: Allow IoT → internet
    Protocol: any
    Source: IoT net
    Destination: any
    Action: Allow

# On the Trusted interface (VLAN 10):
  Allow all (trusted devices can reach everything)
    Source: Trusted net
    Destination: any
    Action: Allow

# Additional exceptions for IoT devices that need specific local services:
  Insert before Rule 2 (the RFC1918 block):
    Protocol: TCP
    Source: IoT net
    Destination: 192.168.30.x port 8123  ← Home Assistant
    Action: Allow
```

## MikroTik Configuration

In this MCP, read `get_vlan_segmentation_guide` (or the resource
`mikrotik://knowledge/vlan-segmentation`). It is shared by MCP prompts, the dashboard
and Raycast. Use `audit-vlan-segmentation` for a read-only review and
`setup-vlan-network` for a staged proposal. Guidance never grants write permission.

1. Resolve exact devices and discover the physical port map, bridges, VLAN table,
   PVIDs, IP/DHCP, IPv6/ND, Wi-Fi package, firewall order and routing dependencies.
   Never assume ether1 is a trunk or put the WAN/ONT in the LAN bridge.
2. Confirm an independent management/recovery path, host-side snapshot and backup.
   Stage a NEW bridge with `vlan-filtering=no`; do not turn off filtering on an
   existing production bridge. Safe Mode helps but is not a universal rollback.
3. Plan one access VLAN per port, matching PVID/untagged membership and ingress
   admission. Trunks carry an explicit tagged allowlist. Include the bridge/CPU
   as tagged for each VLAN terminated/routed there; inspect dynamic membership.
   Put routed VLAN interfaces on the bridge, not an enslaved physical port.
4. Define non-overlapping gateway/subnet/DHCP ranges, excluding reserved addresses.
   Use a separate routed /64 for each IPv6 SLAAC segment. Verify upstream return
   routes, VPN allowed-addresses, NAT and policy-routing consumers before migration.
5. Map SSIDs on the AP and trunk. Verify `wifi-qcom`, `wifi-qcom-ac` or legacy
   wireless behavior; do not copy CAPsMAN datapath `vlan-id` blindly to qcom-ac.
6. Review BOTH IPv4 and IPv6 INPUT and FORWARD policy. Essential DHCP/DNS/ICMPv6
   and approved services precede denies; denies must precede broad accepts they
   constrain. Appending a drop at the bottom does not prove isolation. Do not
   treat RFC1918-only drops as a complete local-network policy or blanket-block ND.
7. After exact-plan approval, stage the change using the appropriate safe workflow.
   Enable VLAN filtering LAST after membership and management access are ready.
   Canary one port/SSID; test real wired/wireless clients, management and allow/deny
   paths for both families before committing and retiring the old access path.

`design_network_segment` only builds partial IPv4 scaffolding. It does not configure
port PVID/admission, filtering activation, SSIDs, INPUT/IPv6 policies or recovery.
New NAT needs an explicit egress, and isolation rules need a reviewed placement
anchor. Command success is not evidence of isolation. Use a complete migration plan.

References: [Bridge VLAN table](https://help.mikrotik.com/docs/spaces/ROS/pages/28606465/Bridge+VLAN+Table),
[WiFi](https://help.mikrotik.com/docs/spaces/ROS/pages/224559120/WiFi),
[IPv4/IPv6 firewall](https://help.mikrotik.com/docs/spaces/ROS/pages/328513/Building+Advanced+Firewall).

## Switch Trunk vs Access Ports

```
# Trunk port: carries multiple VLANs (tagged) — connects switch-to-switch, switch-to-router, switch-to-AP
# Access port: carries one VLAN (untagged) — connects to end devices (PC, camera, NAS)

# A managed switch port connected to your router should be a trunk:
  Allowed VLANs: 10, 20, 30, 40, 99

# A port connecting to a PC should be an access port:
  VLAN: 10 (trusted)
  No tagging — the PC does not know or care about VLANs

# A port connecting to an AP must be a trunk:
  The AP tags traffic from each SSID with the right VLAN ID
  Allowed VLANs: 10, 20, 40  (whichever SSIDs the AP serves)
```

## Anti-Patterns

```
# BAD: Creating VLANs without adding firewall rules
# VLANs without firewall rules do not provide security — inter-VLAN routing is open by default
# GOOD: Add explicit block rules immediately after creating VLANs

# BAD: Putting the Pi-hole in the IoT VLAN
# IoT devices can reach it but trusted devices cannot (without extra rules)
# GOOD: Pi-hole in the Servers VLAN with a rule allowing all VLANs to reach port 53

# BAD: Native VLAN equals management VLAN
# Untagged traffic landing in your management VLAN enables VLAN hopping attacks
# GOOD: Use a dedicated unused VLAN as native (e.g. VLAN 999), keep management traffic tagged

# BAD: Same Wi-Fi password for IoT SSID and trusted SSID
# Anyone who learns the password can connect IoT devices to the wrong segment
```

## Best Practices

- Start with the roles actually needed; VLAN IDs/subnets above are illustrative, not defaults
- Put Pi-hole in the Servers VLAN (192.168.30.x)
- Add a firewall rule allowing DNS (port 53) from all VLANs to the Pi-hole IP — before any RFC1918 block rule
- Test isolation after every rule change: from the IoT VLAN, try to ping a trusted device — it should fail
- Use a management VLAN and restrict administration to explicitly approved admin sources/VPNs, not every trusted client
- Document your VLAN design in a table (VLAN ID, name, subnet, purpose)

## Related Skills

- homelab-network-setup
- homelab-pihole-dns
- homelab-wireguard-vpn
