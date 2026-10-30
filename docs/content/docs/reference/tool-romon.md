---
title: "RoMON"
description: "Router Management Overlay Network settings and ports (`/tool romon`)."
---

## Tools

- [Get RoMON Global Settings](#get_romon)
- [Update RoMON Global Settings](#update_romon)
- [Add RoMON Port Entry](#add_romon_port)
- [List RoMON Port Entries](#list_romon_ports)
- [Remove RoMON Port Entry](#remove_romon_port)

## get_romon

**Get RoMON Global Settings** · Risk: **read**

Read the global RoMON (Router Management Overlay Network) settings (`/tool romon print`). Use to check whether the Layer-2 management overlay is enabled, inspect the RoMON ID, and review configured secrets. Returns the current `enabled`, `id`, and `secrets` fields. For per-interface port entries use `list_romon_ports`.

No tool-specific parameters.

## update_romon

**Update RoMON Global Settings** · Risk: **write-idempotent**

Set global RoMON (Router Management Overlay Network) parameters (`/tool romon set`) — toggle the Layer-2 management overlay on/off, change the RoMON ID, or update shared secrets. For per-interface participation settings use `add_romon_port` or `remove_romon_port`. Returns the full updated settings after applying changes. Arguments: `enabled` (bool, turns overlay on/off), `id` (MAC-style RoMON node ID, defaults to device MAC), `secrets` (comma-separated shared secret(s) for the overlay).

| Parameter | Required | Definition                                           |
| --------- | -------- | ---------------------------------------------------- |
| `enabled` | No       | `{"type":"boolean"}`                                 |
| `id`      | No       | RoMON ID (MAC-style) `{"type":"string"}`             |
| `secrets` | No       | Comma-separated shared secret(s) `{"type":"string"}` |

## add_romon_port

**Add RoMON Port Entry** · Risk: **write**

Add an interface entry to the RoMON port table (`/tool romon port add`) — controls which interfaces participate in the Layer-2 management overlay and their path cost. Use `interface='all'` to configure the global default entry that applies to all interfaces. For listing existing entries use `list_romon_ports`; to delete an entry use `remove_romon_port`. Returns port detail for the added interface after creation. Arguments: `interface` (interface name or 'all'), `cost` (integer path cost for the overlay), `secrets` (per-port shared secret), `forbid` (bool, block RoMON on this interface), `disabled` (bool).

| Parameter   | Required | Definition                                                                                            |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `interface` | Yes      | Interface, or 'all' for the default entry `{"default":"all","type":"string"}`                         |
| `cost`      | No       | Path cost for the overlay `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `secrets`   | No       | `{"type":"string"}`                                                                                   |
| `forbid`    | No       | Forbid RoMON on this interface `{"type":"boolean"}`                                                   |
| `disabled`  | Yes      | `{"default":false,"type":"boolean"}`                                                                  |
| `comment`   | No       | Free-form comment for the port entry `{"type":"string"}`                                              |

## list_romon_ports

**List RoMON Port Entries** · Risk: **read**

List RoMON port entries (`/tool romon port print`) — shows all interfaces registered in the Layer-2 management overlay with their cost, secrets, forbid, and disabled flags. Optionally filter by `interface_filter` to narrow results to a single interface name. For the global RoMON toggle and ID use `get_romon`; to add or delete a port entry use `add_romon_port` or `remove_romon_port`. Returns the `.id` values needed by `remove_romon_port`.

| Parameter          | Required | Definition          |
| ------------------ | -------- | ------------------- |
| `interface_filter` | No       | `{"type":"string"}` |

## remove_romon_port

**Remove RoMON Port Entry** · Risk: **destructive**

Remove a RoMON port entry from the overlay port table (`/tool romon port remove`). `port_id` accepts either an interface name (e.g. `ether1`) or a RouterOS `.id` (e.g. `*1`) taken from `list_romon_ports`. Verifies the entry exists before removing and returns an error if not found. To recreate an entry with different parameters use `add_romon_port`; to change global overlay settings use `update_romon`.

| Parameter | Required | Definition                                           |
| --------- | -------- | ---------------------------------------------------- |
| `port_id` | Yes      | Interface name or RouterOS '.id' `{"type":"string"}` |
