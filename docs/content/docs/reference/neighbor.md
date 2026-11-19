---
title: "Neighbors / MNDP"
description: "Discovered Layer-2 neighbours and discovery settings — the data behind the topology map (`/ip neighbor`, MNDP/CDP/LLDP)."
---

## Tools

- [List Discovered Neighbor Devices (MNDP/CDP/LLDP)](#list_neighbors)
- [Get Neighbor Discovery Settings](#get_neighbor_discovery_settings)
- [Set Neighbor Discovery Settings](#set_neighbor_discovery_settings)
- [Discover Devices That Are Not Managed Yet](#discover_unmanaged_devices)
- [Add a Device to This Server](#enrol_device)

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

## discover_unmanaged_devices

**Discover Devices That Are Not Managed Yet** · Risk: **read**

Finds MikroTik and other devices that are attached to your network but are NOT in this server's device list. It reads the neighbour table (`/ip neighbor`, filled by MNDP, CDP and LLDP) of every configured router, or of the routers you name, merges what they saw, and removes every neighbour that is already a configured device (matched by MAC, IP or identity). For each remaining device it returns the identity, board, RouterOS version, MAC, IP, which router saw it on which interface, and a ready device-config entry. Use it to answer 'which routers are not managed yet?' or before you add a device. It only reads; it does NOT add a device or log in to one. A person adds a device with its credentials in the dashboard (Topology page, or the configuration editor) or in the devices file. A neighbour is seen only on a directly attached Layer-2 segment, so a router behind another router does not appear.

| Parameter        | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`        | No       | Routers to ask. Omit to ask every configured router that is not disabled. `{"type":"array","items":{"type":"string"}}`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `listen_seconds` | Yes      | Also listen for MikroTik discovery (MNDP, UDP 5678) on the MCP host itself for this many seconds. Finds devices on the host's own network segment, also with no managed router. `{"default":0,"type":"integer","minimum":0,"maximum":30}`                                                                                                                                                                                                                                                                                                                        |
| `scan`           | No       | Also scan a subnet from one router (`/tool ip-scan`). Finds hosts that announce nothing, by address and MAC. It sends probes on that network. `{"type":"object","properties":{"device":{"type":"string","description":"The router that runs the scan"},"interface":{"description":"Scan the subnet on this interface","type":"string"},"address_range":{"description":"Range or CIDR, e.g. '192.168.88.0/24'","type":"string"},"seconds":{"default":8,"type":"integer","minimum":1,"maximum":60}},"required":["device","seconds"],"additionalProperties":false}` |

## enrol_device

**Add a Device to This Server** · Risk: **write**

Adds a router to this server's device list, so the other tools can manage it. It is the step after discover_unmanaged_devices. The sign-in secret NEVER passes through this call: give `password_from` (a reference: `env:NAME`, `file:/path` or `keyring:service/account`), `ssh_agent=true`, or `key_filename`. A literal password is not accepted, so a person puts the secret in place first and you pass only where it is. The tool first connects to the device with those settings; a device that cannot be reached or signed in to is NOT added. DEFAULTS TO A CHECK ONLY (`apply=false`) that reports whether the connection works. With `apply=true` the device is written to the configuration file (a backup is kept) and is usable at once, with no restart. Give `host` for SSH, or `mac` for a device with no IP (MAC-Telnet; that needs a password reference). It changes nothing on the device itself. A name that already exists is refused.

| Parameter         | Required | Definition                                                                                                                                                                                                                    |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Name for the device in this server `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$"}`                                                                                                                         |
| `host`            | No       | IP address or host name (SSH) `{"type":"string"}`                                                                                                                                                                             |
| `mac`             | No       | MAC address, for a device with no IP (MAC-Telnet) `{"type":"string"}`                                                                                                                                                         |
| `port`            | Yes      | `{"default":22,"type":"integer","minimum":1,"maximum":65535}`                                                                                                                                                                 |
| `username`        | Yes      | `{"default":"admin","type":"string","minLength":1}`                                                                                                                                                                           |
| `password_from`   | No       | Where the password is: env:NAME, file:/path or keyring:service/account `{"type":"string","pattern":"^(?:env:[A-Za-z_][A-Za-z0-9_]*\|file:.+\|keyring:[A-Za-z0-9][A-Za-z0-9._@-]{0,63}\\/[A-Za-z0-9][A-Za-z0-9._@-]{0,63})$"}` |
| `ssh_agent`       | Yes      | Sign in with the SSH agent of the host `{"default":false,"type":"boolean"}`                                                                                                                                                   |
| `key_filename`    | No       | Path of a private key file on the host `{"type":"string"}`                                                                                                                                                                    |
| `host_key_sha256` | No       | Pin the SSH host key (SHA256:…) `{"type":"string"}`                                                                                                                                                                           |
| `apply`           | Yes      | false = test the connection; true = add `{"default":false,"type":"boolean"}`                                                                                                                                                  |
