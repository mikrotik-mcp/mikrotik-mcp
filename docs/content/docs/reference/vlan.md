---
title: "VLAN"
description: "802.1Q VLAN interfaces (`/interface vlan`)."
---

## Tools

- [Create VLAN Interface](#create_vlan_interface)
- [List VLAN Interfaces](#list_vlan_interfaces)
- [Get VLAN Interface Details](#get_vlan_interface)
- [Update VLAN Interface](#update_vlan_interface)
- [Remove VLAN Interface](#remove_vlan_interface)

## create_vlan_interface

**Create VLAN Interface** · Risk: **write**

Creates an 802.1Q VLAN sub-interface (`/interface vlan`) on a specified parent physical or bridge interface. This creates only a VLAN sub-interface, NOT bridge port membership, PVID, firewall isolation or SSID mapping. For a bridge member use the bridge as routed parent; read get_vlan_segmentation_guide before migration. Set `use_service_tag=true` for 802.1ad QinQ double-tagging. For listing existing VLAN interfaces use `list_vlan_interfaces`; for editing an existing VLAN use `update_vlan_interface`. Returns the created interface's full detail including its name, which is the identifier accepted by `get_vlan_interface`, `update_vlan_interface`, and `remove_vlan_interface`. ARP mode accepts: enabled (default), disabled, proxy-arp, reply-only.

| Parameter                    | Required | Definition                                                                                     |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`                       | Yes      | Name for the new VLAN interface, e.g. 'vlan100' `{"type":"string","pattern":"^\\S+$"}`         |
| `vlan_id`                    | Yes      | 802.1Q VLAN ID (1-4094) `{"type":"integer","minimum":1,"maximum":4094}`                        |
| `interface`                  | Yes      | Parent interface, e.g. 'ether1' or 'bridge' `{"type":"string"}`                                |
| `comment`                    | No       | `{"type":"string"}`                                                                            |
| `disabled`                   | Yes      | `{"default":false,"type":"boolean"}`                                                           |
| `mtu`                        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                    |
| `forced_mac_address`         | No       | RouterOS 7.25+ forced VLAN interface MAC address `{"type":"string"}`                           |
| `use_service_tag`            | Yes      | Use 802.1ad service tag (QinQ) `{"default":false,"type":"boolean"}`                            |
| `arp`                        | Yes      | `{"default":"enabled","type":"string","enum":["enabled","disabled","proxy-arp","reply-only"]}` |
| `arp_timeout`                | No       | `{"type":"string"}`                                                                            |
| `loop_protect`               | No       | Loop protection: default, on, off `{"type":"string","enum":["default","on","off"]}`            |
| `loop_protect_disable_time`  | No       | Time to disable interface on loop detection, e.g. '5m' (0 = forever) `{"type":"string"}`       |
| `loop_protect_send_interval` | No       | Interval between loop-protect probe packets, e.g. '5s' `{"type":"string"}`                     |

## list_vlan_interfaces

**List VLAN Interfaces** · Risk: **read**

Lists all 802.1Q VLAN sub-interfaces (`/interface vlan print`) with optional filters by name substring, VLAN ID, parent interface, or disabled state. Use to discover existing VLANs and obtain interface names for `get_vlan_interface`, `update_vlan_interface`, or `remove_vlan_interface`. For a single interface's full property detail use `get_vlan_interface`. Returns a table of matching VLAN interfaces, or a not-found message when no entries match the filters.

| Parameter          | Required | Definition                                                                  |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `name_filter`      | No       | Partial name match `{"type":"string"}`                                      |
| `vlan_id_filter`   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `interface_filter` | No       | Exact parent interface name `{"type":"string"}`                             |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}`                                        |

## get_vlan_interface

**Get VLAN Interface Details** · Risk: **read**

Returns full detail for a single named VLAN interface (`/interface vlan print detail where name="..."`), including VLAN ID, parent interface, ARP mode, MTU, and running state. Use when you already know the exact interface name and need all properties. For searching across all VLANs or filtering by parent interface or VLAN ID use `list_vlan_interfaces`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_vlan_interface

**Update VLAN Interface** · Risk: **write-idempotent**

Modifies properties of an existing VLAN sub-interface (`/interface vlan set [find name="..."]`). Accepts any subset of the create parameters; omit fields to leave them unchanged. Supply the current `name` from `list_vlan_interfaces` or `get_vlan_interface`; use `new_name` to rename the interface. For creating a new VLAN interface use `create_vlan_interface`; to permanently delete use `remove_vlan_interface`. Returns the updated interface's full detail after applying the change. ARP mode accepts: enabled, disabled, proxy-arp, reply-only.

| Parameter                    | Required | Definition                                                                               |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `name`                       | Yes      | Current name of the VLAN interface to update `{"type":"string"}`                         |
| `new_name`                   | No       | Rename the interface to this (no spaces). `{"type":"string","pattern":"^\\S+$"}`         |
| `vlan_id`                    | No       | `{"type":"integer","minimum":1,"maximum":4094}`                                          |
| `interface`                  | No       | `{"type":"string"}`                                                                      |
| `comment`                    | No       | `{"type":"string"}`                                                                      |
| `disabled`                   | No       | `{"type":"boolean"}`                                                                     |
| `mtu`                        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`              |
| `forced_mac_address`         | No       | RouterOS 7.25+ forced VLAN interface MAC address `{"type":"string"}`                     |
| `use_service_tag`            | No       | `{"type":"boolean"}`                                                                     |
| `arp`                        | No       | `{"type":"string","enum":["enabled","disabled","proxy-arp","reply-only"]}`               |
| `arp_timeout`                | No       | `{"type":"string"}`                                                                      |
| `loop_protect`               | No       | Loop protection: default, on, off `{"type":"string","enum":["default","on","off"]}`      |
| `loop_protect_disable_time`  | No       | Time to disable interface on loop detection, e.g. '5m' (0 = forever) `{"type":"string"}` |
| `loop_protect_send_interval` | No       | Interval between loop-protect probe packets, e.g. '5s' `{"type":"string"}`               |

## remove_vlan_interface

**Remove VLAN Interface** · Risk: **destructive**

Permanently deletes a VLAN sub-interface (`/interface vlan remove [find name="..."]`) after confirming it exists via a count-only check. Supply the interface `name` from `list_vlan_interfaces` or `get_vlan_interface`. Removing a VLAN interface also removes IP addresses assigned to it; firewall rules and other configuration that reference it by name are not automatically deleted and will remain as orphaned, ineffective entries. To disable a VLAN temporarily without deleting it use `update_vlan_interface` with `disabled=true`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
