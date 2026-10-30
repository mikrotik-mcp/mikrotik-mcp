---
title: "L2 Fabric Map"
description: "Port-level Layer-2 map: which host sits on which bridge port, joined from the bridge host table, ARP, DHCP leases and the neighbour cache, with access/uplink classification. Sees every host that has passed a frame — not just MNDP/LLDP speakers."
---

## Tools

- [Map Hosts to Physical Switch Ports](#map_l2_fabric)
- [Find Which Port a Host Is Plugged Into](#locate_host_port)

## map_l2_fabric

**Map Hosts to Physical Switch Ports** · Risk: **read**

Builds a PORT-LEVEL Layer-2 map: which hosts are behind each bridge port, joined from the bridge host table (`/interface bridge host`), ARP, DHCP leases and the neighbour cache so every MAC gets a real name — hostname, RouterOS identity, IP or hardware vendor. Also classifies each port as access (one host), uplink (many hosts, or a discovered network device behind it) or hybrid. Use this to answer 'what is plugged into ether5', to find unexpected devices on the fabric, or to spot an unmanaged switch someone added. This is different from list_neighbors, which only sees MNDP/CDP/LLDP speakers — the bridge host table sees EVERY host that has passed a frame, including printers, IoT and laptops. Read-only.

| Parameter          | Required | Definition                                                                                         |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `interface_filter` | No       | Only show ports whose name contains this substring. `{"type":"string"}`                            |
| `role`             | No       | Only show ports classified with this role. `{"type":"string","enum":["access","uplink","hybrid"]}` |
| `summary_only`     | No       | Show per-port counts without listing individual hosts. `{"type":"boolean"}`                        |

## locate_host_port

**Find Which Port a Host Is Plugged Into** · Risk: **read**

Locates a specific host on the Layer-2 fabric and reports the exact bridge port it is reachable through. Accepts a MAC address (any separator style), an IP address, or a hostname/identity substring. This is the 'my printer is 192.168.1.40, which switch port is it on?' lookup — it resolves the IP to a MAC via ARP/DHCP and then to a port via the bridge host table. Returns every match, since a MAC can legitimately appear behind an uplink as well as on its access port. Read-only.

| Parameter | Required | Definition                                                                             |
| --------- | -------- | -------------------------------------------------------------------------------------- |
| `query`   | Yes      | MAC address, IP address, or hostname/identity substring to locate. `{"type":"string"}` |
