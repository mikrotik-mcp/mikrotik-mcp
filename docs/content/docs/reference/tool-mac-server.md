---
title: "MAC Server"
description: "MAC-Telnet/MAC-Winbox/MAC-ping servers and sessions (`/tool mac-server`)."
---

## Tools

- [Get MAC-Telnet Server Settings](#get_mac_server)
- [Update MAC-Telnet Server Settings](#update_mac_server)
- [Get MAC-Winbox Server Settings](#get_mac_winbox)
- [Update MAC-Winbox Server Settings](#update_mac_winbox)
- [Get MAC-Ping Server Settings](#get_mac_ping)
- [Update MAC-Ping Server Settings](#update_mac_ping)
- [List Active MAC-Telnet Sessions](#list_mac_server_sessions)

## get_mac_server

**Get MAC-Telnet Server Settings** · Risk: **read**

Read MAC-Telnet server settings (`/tool mac-server`). Returns the current `allowed-interface-list` controlling which interfaces accept inbound MAC-Telnet connections — the Layer-2 terminal protocol that reaches MikroTik devices by MAC address when no IP is reachable. For MAC-Winbox settings use `get_mac_winbox`; for MAC-ping use `get_mac_ping`. Returns the full `/tool mac-server print` output.

No tool-specific parameters.

## update_mac_server

**Update MAC-Telnet Server Settings** · Risk: **write-idempotent**

Update the MAC-Telnet server's `allowed-interface-list` (`/tool mac-server set`). Controls which interface list accepts inbound MAC-Telnet sessions — the Layer-2 terminal protocol for reaching the router by MAC address without an IP. For MAC-Winbox interface control use `update_mac_winbox`; for MAC-ping toggle use `update_mac_ping`. Returns the updated settings after the change.

Notes:
allowed_interface_list: interface-list name, or 'all' / 'none'.

| Parameter                | Required | Definition                                                 |
| ------------------------ | -------- | ---------------------------------------------------------- |
| `allowed_interface_list` | Yes      | Interface-list name, or 'all' / 'none' `{"type":"string"}` |

## get_mac_winbox

**Get MAC-Winbox Server Settings** · Risk: **read**

Read MAC-Winbox server settings (`/tool mac-server mac-winbox`). Returns which interface list is allowed to connect via Winbox over MAC (Layer-2 Winbox access without an IP address). Distinct from MAC-Telnet — for MAC-Telnet settings use `get_mac_server`; for MAC-ping use `get_mac_ping`. Returns the full `/tool mac-server mac-winbox print` output.

No tool-specific parameters.

## update_mac_winbox

**Update MAC-Winbox Server Settings** · Risk: **write-idempotent**

Update the MAC-Winbox server's `allowed-interface-list` (`/tool mac-server mac-winbox set`). Controls which interfaces accept Winbox connections over MAC (Layer-2, no IP required). Set to an interface-list name, 'all', or 'none'. For MAC-Telnet interface control use `update_mac_server`; for MAC-ping toggle use `update_mac_ping`. Returns the updated settings after the change.

| Parameter                | Required | Definition                                                 |
| ------------------------ | -------- | ---------------------------------------------------------- |
| `allowed_interface_list` | Yes      | Interface-list name, or 'all' / 'none' `{"type":"string"}` |

## get_mac_ping

**Get MAC-Ping Server Settings** · Risk: **read**

Read MAC-ping server settings (`/tool mac-server ping`). Returns whether MAC-ping is enabled — the Layer-2 ping that reaches devices by MAC address rather than IP, used to check reachability when no IP is configured. For MAC-Telnet settings use `get_mac_server`; for MAC-Winbox settings use `get_mac_winbox`. Returns the full `/tool mac-server ping print` output.

No tool-specific parameters.

## update_mac_ping

**Update MAC-Ping Server Settings** · Risk: **write-idempotent**

Enable or disable the MAC-ping server (`/tool mac-server ping set`). Toggles whether the router responds to Layer-2 MAC-ping requests (pings by MAC address, no IP needed). Accepts a boolean `enabled` argument. For MAC-Telnet interface control use `update_mac_server`; for MAC-Winbox use `update_mac_winbox`. Returns the updated settings after the change.

| Parameter | Required | Definition                                       |
| --------- | -------- | ------------------------------------------------ |
| `enabled` | Yes      | Whether MAC-ping is enabled `{"type":"boolean"}` |

## list_mac_server_sessions

**List Active MAC-Telnet Sessions** · Risk: **read**

List active MAC-Telnet sessions (`/tool mac-server session`). Shows currently connected MAC-Telnet clients — useful for auditing who has Layer-2 terminal access to the router without an IP. Optionally filter by `interface_filter` (interface name string). Distinct from MAC-Winbox connections (managed via `get_mac_winbox`/ `update_mac_winbox`). Returns all active session entries or a no-sessions message.

| Parameter          | Required | Definition          |
| ------------------ | -------- | ------------------- |
| `interface_filter` | No       | `{"type":"string"}` |
