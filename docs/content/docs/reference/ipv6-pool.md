---
title: "IPv6 Pool"
description: "IPv6 address/prefix pools for delegation and addressing (`/ipv6 pool`)."
---

## Tools

- [Create IPv6 Prefix Pool](#create_ipv6_pool)
- [List IPv6 Prefix Pools](#list_ipv6_pools)
- [Get IPv6 Pool Details](#get_ipv6_pool)
- [List IPv6 Pool Delegated Prefixes](#list_ipv6_pool_used)
- [Update IPv6 Prefix Pool](#update_ipv6_pool)
- [Remove IPv6 Prefix Pool](#remove_ipv6_pool)

## create_ipv6_pool

**Create IPv6 Prefix Pool** · Risk: **write**

Creates an IPv6 prefix pool (`/ipv6 pool`) — defines a large address block from which smaller per-client prefix delegations are carved, typically used with DHCPv6 prefix delegation (PD). For IPv4 address pools use `create_ip_pool`. `prefix` is the overall block (e.g. `2001:db8::/48`); `prefix_length` is the size of each carved delegation (e.g. 64) and must be longer than the pool prefix length. Returns the created pool's full detail including name and prefix configuration.

| Parameter       | Required | Definition                                                                             |
| --------------- | -------- | -------------------------------------------------------------------------------------- |
| `name`          | Yes      | `{"type":"string"}`                                                                    |
| `prefix`        | Yes      | Overall block, e.g. '2001:db8::/48' `{"type":"string"}`                                |
| `prefix_length` | Yes      | Size of each carved delegation, e.g. 64 `{"type":"integer","minimum":1,"maximum":128}` |
| `comment`       | No       | `{"type":"string"}`                                                                    |

## list_ipv6_pools

**List IPv6 Prefix Pools** · Risk: **read**

Lists IPv6 prefix pools (`/ipv6 pool print`) — returns all defined pools, optionally filtered by name or prefix substring. For full detail on a single pool use `get_ipv6_pool`. To see which prefixes have already been delegated from a pool use `list_ipv6_pool_used`. For IPv4 address pools use `list_ip_pools`. Returns pool names, prefixes, prefix-lengths, and comments.

| Parameter       | Required | Definition          |
| --------------- | -------- | ------------------- |
| `name_filter`   | No       | `{"type":"string"}` |
| `prefix_filter` | No       | `{"type":"string"}` |

## get_ipv6_pool

**Get IPv6 Pool Details** · Risk: **read**

Fetches full detail of a single IPv6 prefix pool (`/ipv6 pool print detail`) identified by name — use when you need all fields for one pool rather than a summary list. For scanning all pools use `list_ipv6_pools`. To check active delegations handed out from a pool use `list_ipv6_pool_used`. Returns the pool's prefix, prefix-length, comment, and all configuration fields.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## list_ipv6_pool_used

**List IPv6 Pool Delegated Prefixes** · Risk: **read**

Lists actively delegated prefixes from IPv6 pools (`/ipv6 pool used print`) — shows which sub-prefixes have been handed out (e.g. via DHCPv6 prefix delegation) and to which clients. This is the runtime usage view, not the pool definitions. For the pool configuration itself use `list_ipv6_pools` or `get_ipv6_pool`. Optionally filter by pool name substring (`pool_filter`). Returns delegated prefix entries with pool name, prefix, and binding information.

| Parameter     | Required | Definition                                  |
| ------------- | -------- | ------------------------------------------- |
| `pool_filter` | No       | Partial pool-name match `{"type":"string"}` |

## update_ipv6_pool

**Update IPv6 Prefix Pool** · Risk: **write-idempotent**

Updates an existing IPv6 prefix pool (`/ipv6 pool set`) — modifies the pool's name, prefix block, delegation size, or comment. Use `list_ipv6_pools` to find the current pool `name` before updating. Pass comment="" to clear the comment. Returns the updated pool's full detail after the change.

| Parameter       | Required | Definition                                     |
| --------------- | -------- | ---------------------------------------------- |
| `name`          | Yes      | `{"type":"string"}`                            |
| `new_name`      | No       | `{"type":"string"}`                            |
| `prefix`        | No       | `{"type":"string"}`                            |
| `prefix_length` | No       | `{"type":"integer","minimum":1,"maximum":128}` |
| `comment`       | No       | `{"type":"string"}`                            |

## remove_ipv6_pool

**Remove IPv6 Prefix Pool** · Risk: **destructive**

Permanently removes an IPv6 prefix pool (`/ipv6 pool remove`) by name. Performs a count-only existence check first and returns an error if the pool is not found. Active delegations visible via `list_ipv6_pool_used` may be disrupted. Use `list_ipv6_pools` to confirm the exact pool name before removing. Returns a success confirmation or an error message if the pool does not exist.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
