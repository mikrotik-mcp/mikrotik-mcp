---
title: "IP Pools"
description: "Address pools for DHCP/PPP (`/ip pool`)."
---

## Tools

- [Create IP Pool](#create_ip_pool)
- [List IP Pools](#list_ip_pools)
- [Get IP Pool Details](#get_ip_pool)
- [Update IP Pool](#update_ip_pool)
- [Remove IP Pool](#remove_ip_pool)
- [List IP Pool Allocated Addresses](#list_ip_pool_used)
- [Expand IP Pool Ranges](#expand_ip_pool)

## create_ip_pool

**Create IP Pool** · Risk: **write**

Creates a named IPv4 address pool (`/ip pool`) — a set of IP ranges that DHCP servers (via `address-pool`) and PPP/tunnel interfaces draw leases from. For full DHCP server provisioning use `create_dhcp_server`. Ranges use hyphen notation e.g. `192.168.1.1-192.168.1.100`; multiple ranges are comma-separated. Optionally chains to another pool via `next_pool` when this pool is exhausted. Returns the created pool's detail.

| Parameter   | Required | Definition                                                                                                                                                  |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | Yes      | `{"type":"string"}`                                                                                                                                         |
| `ranges`    | Yes      | Hyphen-separated range(s) e.g. "192.168.1.1-192.168.1.100". Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120" `{"type":"string"}` |
| `next_pool` | No       | `{"type":"string"}`                                                                                                                                         |
| `comment`   | No       | `{"type":"string"}`                                                                                                                                         |

## list_ip_pools

**List IP Pools** · Risk: **read**

Lists all configured IPv4 address pools (`/ip pool print`) — the named range sets used by DHCP and PPP/tunnel services as address sources. Supports substring filtering by name or ranges. Set `include_used=true` to append a used-address count per pool (issues a `/ip pool used print count-only` sub-query for each pool); for the full per-lease allocation detail (with MAC and lease owner) use `list_ip_pool_used`. Returns all matching pool entries.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `ranges_filter` | No       | `{"type":"string"}`                  |
| `include_used`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_ip_pool

**Get IP Pool Details** · Risk: **read**

Fetches full detail for a single named IPv4 pool (`/ip pool print detail`) including its ranges, next-pool chain, comment, and currently used-address count (`/ip pool used print count-only`). Takes the pool `name` (not an `.id`). For a summary listing of all pools use `list_ip_pools`; for the individual allocated addresses with MAC and lease-owner info use `list_ip_pool_used`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ip_pool

**Update IP Pool** · Risk: **write-idempotent**

Modifies an existing IPv4 pool (`/ip pool set`) — rename it, replace its full ranges string, update the next-pool chain reference, or set a comment. Omit a field to leave it unchanged; pass `""` (empty string) for `next_pool` to clear the chained-pool reference. Ranges use hyphen notation e.g. `192.168.1.1-192.168.1.100`, multiple ranges comma-separated: `10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120`. To append ranges without knowing the current set use `expand_ip_pool`. Returns the updated pool detail.

| Parameter   | Required | Definition                                                                                                                                                  |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | Yes      | `{"type":"string"}`                                                                                                                                         |
| `new_name`  | No       | `{"type":"string"}`                                                                                                                                         |
| `ranges`    | No       | Hyphen-separated range(s) e.g. "192.168.1.1-192.168.1.100". Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120" `{"type":"string"}` |
| `next_pool` | No       | `{"type":"string"}`                                                                                                                                         |
| `comment`   | No       | `{"type":"string"}`                                                                                                                                         |

## remove_ip_pool

**Remove IP Pool** · Risk: **destructive**

Deletes a named IPv4 pool (`/ip pool remove`). Before removing, pre-checks that no addresses are currently allocated from it (`/ip pool used print count-only`) and that no DHCP server references it (`/ip dhcp-server print count-only`); returns an error describing the blocker instead of deleting. To inspect active allocations first call `list_ip_pool_used`; to see which DHCP servers reference the pool use `list_dhcp_servers`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## list_ip_pool_used

**List IP Pool Allocated Addresses** · Risk: **read**

Lists currently allocated (in-use) addresses from IPv4 pools (`/ip pool used print`), showing pool name, IP address, MAC address, and lease owner (`info` field). Filterable by pool name (exact), address substring, MAC address substring, or info substring. Use to diagnose address exhaustion or find which client holds a specific IP. For pool configuration (ranges, next-pool) use `list_ip_pools` or `get_ip_pool`.

| Parameter        | Required | Definition          |
| ---------------- | -------- | ------------------- |
| `pool_name`      | No       | `{"type":"string"}` |
| `address_filter` | No       | `{"type":"string"}` |
| `mac_filter`     | No       | `{"type":"string"}` |
| `info_filter`    | No       | `{"type":"string"}` |

## expand_ip_pool

**Expand IP Pool Ranges** · Risk: **write-idempotent**

Appends additional IPv4 ranges to an existing pool (`/ip pool set`) without requiring the caller to know the current ranges — reads them first via `/ip pool print detail`, then writes the merged range list. Convenience wrapper over `update_ip_pool` for range expansion; use `update_ip_pool` when you want to replace the full range set. Ranges use hyphen notation e.g. `192.168.1.101-192.168.1.150`; multiple ranges comma-separated: `10.0.0.51-10.0.0.60,10.0.0.70-10.0.0.80`. Returns the updated pool detail.

| Parameter           | Required | Definition                                                                                                                                                   |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | Yes      | `{"type":"string"}`                                                                                                                                          |
| `additional_ranges` | Yes      | Hyphen-separated range(s) e.g. "192.168.1.101-192.168.1.150". Multiple ranges comma-separated: "10.0.0.51-10.0.0.60,10.0.0.70-10.0.0.80" `{"type":"string"}` |
