---
title: "Neighbors / MNDP"
description: "Discovered Layer-2 neighbours and discovery settings — the data behind the topology map (`/ip neighbor`, MNDP/CDP/LLDP)."
---

## Tools

- [List Discovered Neighbor Devices (MNDP/CDP/LLDP)](#list_neighbors)
- [Get Neighbor Discovery Settings](#get_neighbor_discovery_settings)
- [Set Neighbor Discovery Settings](#set_neighbor_discovery_settings)

## list_neighbors

**List Discovered Neighbor Devices (MNDP/CDP/LLDP)** · Risk: **read**

Lists directly-attached devices discovered via MNDP, CDP, and LLDP (`/ip neighbor`) — each entry shows identity, MAC address, IP address, the local interface it was seen on, platform, board name, and RouterOS version. Use this to build a Layer-2 topology view or to locate devices (including those with no routable IP yet) before initiating MAC-Telnet onboarding. Filterable by local interface, identity substring, IP address substring, or MAC address substring. Returns all matching neighbor cache entries; the cache is read-only and populated by the protocols — to control which interfaces and protocols participate use get_neighbor_discovery_settings or set_neighbor_discovery_settings.

| Parameter          | Required | Definition                                                         |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `interface_filter` | No       | Match the local discovery interface. `{"type":"string"}`           |
| `identity_filter`  | No       | Match the neighbour's identity (substring). `{"type":"string"}`    |
| `address_filter`   | No       | Match the neighbour's IP address (substring). `{"type":"string"}`  |
| `mac_filter`       | No       | Match the neighbour's MAC address (substring). `{"type":"string"}` |

## get_neighbor_discovery_settings

**Get Neighbor Discovery Settings** · Risk: **read**

Reads the global neighbor-discovery configuration (`/ip neighbor discovery-settings print`) — the interface-list that participates in discovery, the tx/rx mode, and which protocols (MNDP, CDP, LLDP) are active. Use this to inspect discovery scope before changing it with set_neighbor_discovery_settings. Returns a single settings block; for the actual cache of discovered devices use list_neighbors.

No tool-specific parameters.

## set_neighbor_discovery_settings

**Set Neighbor Discovery Settings** · Risk: **write-idempotent**

Updates the global neighbor-discovery configuration (`/ip neighbor discovery-settings set`) — controls which interface-list participates (e.g. 'all', 'LAN', 'none'), the direction mode (tx-only, rx-only, tx-and-rx), the active protocols (comma-separated: 'mndp,cdp,lldp'), and the LLDP-MED network-policy VLAN. Use this to narrow or broaden which interfaces and protocols contribute entries to the neighbor cache. To inspect the current settings first use get_neighbor_discovery_settings; to view the resulting neighbor cache use list_neighbors. Returns the updated settings block.

| Parameter                  | Required | Definition                                                                                                                  |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `discover_interface_list`  | No       | Interface-list to run discovery on, e.g. "all", "LAN", "none". `{"type":"string"}`                                          |
| `mode`                     | No       | Whether the router transmits and/or receives discovery frames. `{"type":"string","enum":["tx-only","rx-only","tx-and-rx"]}` |
| `protocol`                 | No       | Comma-separated protocols, e.g. "mndp,cdp,lldp". `{"type":"string"}`                                                        |
| `lldp_med_net_policy_vlan` | No       | LLDP-MED network-policy VLAN, e.g. "auto" or a VLAN id. `{"type":"string"}`                                                 |
| `lldp_mac_phy_config`      | No       | Include the IEEE 802.3 MAC/PHY Configuration/Status TLV in LLDP frames. `{"type":"boolean"}`                                |
| `lldp_max_frame_size`      | No       | Include the Maximum Frame Size TLV in LLDP frames. `{"type":"boolean"}`                                                     |
| `lldp_vlan_info`           | No       | Include the Port VLAN ID and VLAN Name TLVs in LLDP frames. `{"type":"boolean"}`                                            |
