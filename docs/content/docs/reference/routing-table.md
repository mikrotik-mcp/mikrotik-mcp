---
title: "Routing Tables"
description: "Named routing tables / FIBs (`/routing table`)."
---

## Tools

- [List Routing Table Definitions](#list_routing_tables)
- [Get Routing Table Definition](#get_routing_table_def)
- [Add Routing Table Definition](#add_routing_table)
- [Update Routing Table Definition](#update_routing_table)
- [Remove Routing Table Definition](#remove_routing_table)
- [Enable or Disable Routing Table](#set_routing_table_enabled)

## list_routing_tables

**List Routing Table Definitions** · Risk: **read**

Lists named routing table definitions (`/routing table print detail`) — the RIB (Routing Information Base) containers used by RouterOS v7 policy-based routing. Each table isolates a routing domain; `fib=true` means its routes are installed into the forwarding plane. The built-in `main` table is always present. For actual IPv4 routes stored inside a table use `list_routes`; for IPv6 routes use `list_ipv6_routes`; for the policy rules that steer packets into a table use `list_routing_rules`. Returns all table definitions with name, fib flag, disabled state, and comment; supports optional `name_filter` substring match.

| Parameter     | Required | Definition                                        |
| ------------- | -------- | ------------------------------------------------- |
| `name_filter` | No       | Substring match on table name `{"type":"string"}` |

## get_routing_table_def

**Get Routing Table Definition** · Risk: **read**

Gets the definition of a single named routing table (`/routing table print detail where name=…`) — inspects whether `fib` is active and whether the table is disabled. For listing all tables use `list_routing_tables`. For the IPv4 routes stored inside a table use `list_routes`; for IPv6 routes use `list_ipv6_routes`. Returns the full detail record for the named table, or a not-found message if the name does not exist.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `name`    | Yes      | Routing table name `{"type":"string"}` |

## add_routing_table

**Add Routing Table Definition** · Risk: **write**

Creates a named routing table (`/routing table add`) on RouterOS v7 — establishes a new RIB container for policy-based routing. `fib` defaults to `true`, which installs the table's routes into the forwarding plane; set `fib=false` to keep it RIB-only, used purely for lookups by routing rules/marks. After creation, assign IPv4 routes to this table via `add_route` (set its `routing-table` argument); for IPv6 routes use `add_ipv6_route`. For the policy rules that steer packets into a table use `list_routing_rules` / `update_routing_rule`. To modify an existing table use `update_routing_table`. Returns the new table's full detail record on success.

| Parameter  | Required | Definition                                                                         |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `name`     | Yes      | Unique table name, referenced by routes and routing rules `{"type":"string"}`      |
| `fib`      | Yes      | Install routes into the FIB (forwarding plane) `{"default":true,"type":"boolean"}` |
| `comment`  | No       | `{"type":"string"}`                                                                |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`                                               |

## update_routing_table

**Update Routing Table Definition** · Risk: **write-idempotent**

Modifies an existing routing table (`/routing table set [find name=…]`) — changes its `fib` flag, `comment`, or `disabled` state. To create a new table use `add_routing_table`; to toggle only the enabled/disabled state use `set_routing_table_enabled`. No-ops safely if no optional arguments are provided. Returns the updated table's full detail record on success.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `name`     | Yes      | Existing routing table name `{"type":"string"}`  |
| `fib`      | No       | Install routes into the FIB `{"type":"boolean"}` |
| `comment`  | No       | `{"type":"string"}`                              |
| `disabled` | No       | `{"type":"boolean"}`                             |

## remove_routing_table

**Remove Routing Table Definition** · Risk: **destructive**

Permanently deletes a named routing table (`/routing table remove [find name=…]`). The built-in `main` table cannot be removed. Routes referencing this table should be removed first via `remove_route` to avoid orphaned entries. To disable without deleting use `set_routing_table_enabled`; to modify properties use `update_routing_table`. Confirms deletion by name on success.

| Parameter | Required | Definition                                       |
| --------- | -------- | ------------------------------------------------ |
| `name`    | Yes      | Routing table name to remove `{"type":"string"}` |

## set_routing_table_enabled

**Enable or Disable Routing Table** · Risk: **write-idempotent**

Enables or disables a named routing table (`/routing table set [find name=…] disabled=yes/no`) without removing it — a disabled table is inactive in the routing engine. To permanently delete a table use `remove_routing_table`; to change other properties (fib, comment) use `update_routing_table`. Pass `enabled=true` to enable, `enabled=false` to disable. Confirms the new state by name on success.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `name`    | Yes      | Routing table name `{"type":"string"}`                |
| `enabled` | Yes      | true to enable, false to disable `{"type":"boolean"}` |
