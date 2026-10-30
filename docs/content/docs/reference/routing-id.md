---
title: "Router ID"
description: "Router-ID instances for OSPF/BGP (`/routing id`)."
---

## Tools

- [List Routing ID Instances](#list_routing_ids)
- [Get Routing ID Instance](#get_routing_id)
- [Add Routing ID Instance](#add_routing_id)
- [Update Routing ID Instance](#update_routing_id)
- [Remove Routing ID Instance](#remove_routing_id)
- [Enable or Disable Routing ID Instance](#set_routing_id_enabled)

## list_routing_ids

**List Routing ID Instances** · Risk: **read**

Lists all Router-ID instances (`/routing id print detail`). Router-IDs are named 32-bit identifiers assigned to routing processes (OSPF, BGP) to uniquely identify the router within the routing domain; each instance can carry a fixed IPv4 address or auto-derive one from an interface/loopback. Use `get_routing_id` to inspect a single instance by name. For IPv4 route table entries use `list_routes`; for policy routing rules use `list_routing_rules`; for BGP connections that reference a router-id use `list_bgp_connections`. Returns all instance names, configured IDs, dynamic-selection settings, and enabled/disabled state. Requires RouterOS v7 with the routing package.

| Parameter     | Required | Definition                                               |
| ------------- | -------- | -------------------------------------------------------- |
| `name_filter` | No       | Substring match on the instance name `{"type":"string"}` |

## get_routing_id

**Get Routing ID Instance** · Risk: **read**

Returns full detail for a single named Router-ID instance (`/routing id print detail where name=...`). Use this to inspect the configured or dynamically-selected 32-bit router identifier for a specific OSPF/BGP process. Use `list_routing_ids` to enumerate all instances and discover names. For IPv4 route table entries use `get_route`; for policy routing rules use `list_routing_rules`. Returns all properties (id, select-dynamic-id, disabled, comment) of the named instance, or a not-found message if the name does not exist.

| Parameter | Required | Definition                                  |
| --------- | -------- | ------------------------------------------- |
| `name`    | Yes      | Router-ID instance name `{"type":"string"}` |

## add_routing_id

**Add Routing ID Instance** · Risk: **write**

Creates a new Router-ID instance (`/routing id add`) that assigns a stable 32-bit router identifier to a routing process (OSPF, BGP). Either pin a fixed `id` (an IPv4 address, e.g. '10.0.0.1') or let RouterOS auto-derive it from an interface/loopback via `select_dynamic_id` — at least one of the two should be set. For BGP connections that consume a router-id use `add_bgp_connection`; to modify an existing instance use `update_routing_id`; for IPv4 static routes use `add_route`; for IPv6 static routes use `add_ipv6_route`. Requires RouterOS v7 with the routing package. Returns the created instance's full detail.

| Parameter           | Required | Definition                                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `name`              | Yes      | Unique instance name, referenced by OSPF/BGP `{"type":"string"}`                            |
| `id`                | No       | Fixed router-id as an IPv4 address, e.g. '10.0.0.1' `{"type":"string"}`                     |
| `select_dynamic_id` | No       | Interface/loopback name to auto-derive the id from when `id` is omitted `{"type":"string"}` |
| `comment`           | No       | `{"type":"string"}`                                                                         |
| `disabled`          | Yes      | `{"default":false,"type":"boolean"}`                                                        |

## update_routing_id

**Update Routing ID Instance** · Risk: **write-idempotent**

Modifies an existing Router-ID instance (`/routing id set [find name=...]`). Supply any combination of fields to change; omitted fields are left untouched. Pass `""` for `id` to clear the fixed router-id (RouterOS unsets it with `!id`); pass `""` for `select_dynamic_id` to clear dynamic interface selection (`!select-dynamic-id`). Use `add_routing_id` to create a new instance; use `set_routing_id_enabled` to toggle enabled state without changing other properties. For updating IPv4 routes use `update_route`; for policy routing rules use `update_routing_rule`. Returns the updated instance's full detail.

| Parameter           | Required | Definition                                                  |
| ------------------- | -------- | ----------------------------------------------------------- |
| `name`              | Yes      | Existing Router-ID instance name `{"type":"string"}`        |
| `id`                | No       | IPv4 router-id, or "" to clear `{"type":"string"}`          |
| `select_dynamic_id` | No       | Interface/loopback name, or "" to clear `{"type":"string"}` |
| `comment`           | No       | `{"type":"string"}`                                         |
| `disabled`          | No       | `{"type":"boolean"}`                                        |

## remove_routing_id

**Remove Routing ID Instance** · Risk: **destructive**

Permanently deletes a named Router-ID instance (`/routing id remove [find name=...]`). Removing a router-id that is actively referenced by an OSPF or BGP process will break that process's identifier — verify dependencies before removing. Use `list_routing_ids` to discover instance names. To disable without deleting use `set_routing_id_enabled`. For removing IPv4 routes use `remove_route`; for IPv6 routes use `remove_ipv6_route`. Returns a success confirmation or an error message.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `name`    | Yes      | Router-ID instance name to remove `{"type":"string"}` |

## set_routing_id_enabled

**Enable or Disable Routing ID Instance** · Risk: **write-idempotent**

Enables or disables a named Router-ID instance (`/routing id set [find name=...] disabled=yes/no`). Disabling prevents the instance from being advertised or used by OSPF/BGP without removing it. Use `add_routing_id` to create a new instance; use `update_routing_id` to change the ID value or other properties; use `remove_routing_id` for permanent deletion. Set `enabled=true` to enable, `enabled=false` to disable. Returns a confirmation string.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `name`    | Yes      | Router-ID instance name `{"type":"string"}`           |
| `enabled` | Yes      | true to enable, false to disable `{"type":"boolean"}` |
