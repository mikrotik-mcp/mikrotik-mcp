---
title: "Interfaces"
description: "Generic interface listing and enable/disable (`/interface`)."
---

## Tools

- [List All Network Interfaces](#list_interfaces)
- [Get Network Interface Details](#get_interface)
- [Enable a Network Interface](#enable_interface)
- [Disable a Network Interface](#disable_interface)

## list_interfaces

**List All Network Interfaces** · Risk: **read**

List all interfaces (`/interface print`) — the primary discovery tool for every interface name, type, and running state on the device (ethernet, bridge, WireGuard, PPPoE, VLAN, WiFi, SFP, LTE, loopback). Filter by `type_filter` (e.g. 'ether', 'bridge', 'wg'), `name_filter` (partial name match), `running_only`, or `disabled_only`. For a single interface's full property block use `get_interface`; to create type-specific interfaces use `create_vlan_interface`, `create_wireguard_interface`, or `create_wireless_interface`. Returns name, type, MAC, MTU, and running/disabled state for each matched interface.

| Parameter       | Required | Definition                                                                                                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type_filter`   | No       | RouterOS interface type, e.g. 'ether', 'bridge' `{"type":"string","enum":["ether","wg","bridge","vlan","pppoe-out","pppoe-server","wifi","wireless","lte","loopback","sfp","sfp-sfpplus"]}` |
| `name_filter`   | No       | Partial name match, e.g. 'ether' `{"type":"string"}`                                                                                                                                        |
| `running_only`  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                        |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                        |

## get_interface

**Get Network Interface Details** · Risk: **read**

Get full detail for a single interface by exact name (`/interface print detail where name=<name>`). Use when you already know the interface name and need its complete property set (MAC, MTU, type, running state, tx/rx counters). To browse all interfaces or find a name first use `list_interfaces`. Returns the full RouterOS detail block for the interface, or a not-found message if the name does not exist.

| Parameter | Required | Definition                                                     |
| --------- | -------- | -------------------------------------------------------------- |
| `name`    | Yes      | Exact interface name, e.g. 'ether1', 'wg0' `{"type":"string"}` |

## enable_interface

**Enable a Network Interface** · Risk: **write-idempotent**

Enable a disabled interface (`/interface enable [find name=<name>]`) so it resumes passing traffic. Idempotent — safe to call on an already-enabled interface. To take an interface offline use `disable_interface`. Returns the updated interface detail after enabling, confirming its new running state.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_interface

**Disable a Network Interface** · Risk: **write-idempotent**

Disable an active interface (`/interface disable [find name=<name>]`) so it stops forwarding traffic while remaining fully configured. Idempotent — safe to call on an already-disabled interface. To bring an interface back up use `enable_interface`. Returns the updated interface detail after disabling, confirming its new state.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
