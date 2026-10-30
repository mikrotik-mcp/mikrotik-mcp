---
title: "Routing — Static"
description: "Static routes, routing table, route checks and cache (`/ip route`)."
---

## Tools

- [Add IPv4 Static Route](#add_route)
- [List IPv4 Routes](#list_routes)
- [Get IPv4 Route Detail](#get_route)
- [Update IPv4 Route](#update_route)
- [Remove IPv4 Route](#remove_route)
- [Enable IPv4 Route](#enable_route)
- [Disable IPv4 Route](#disable_route)
- [Get IPv4 Routing Table by Name](#get_routing_table)
- [Check IPv4 Route Path](#check_route_path)
- [Get IPv4 Route Cache / Forwarding Table](#get_route_cache)
- [Flush IPv4 Route Cache](#flush_route_cache)
- [Add IPv4 Default Route](#add_default_route)
- [Add IPv4 Blackhole Route](#add_blackhole_route)
- [Get IPv4 Route Statistics](#get_route_statistics)

## add_route

**Add IPv4 Static Route** · Risk: **write**

Adds an IPv4 static route (`/ip route add`) to the routing table — use this to define any non-default unicast next-hop (host, subnet, or summarized prefix). For the 0.0.0.0/0 default gateway use add_default_route; for null/drop routes use add_blackhole_route; for IPv6 use add_ipv6_route. `distance` sets priority (1–255, lower wins); `routing_table` assigns the route to a policy-routing table (must already exist — see add_routing_table); `check_gateway` ("ping" or "arp") enables active gateway monitoring. Returns the created route's detail including its `.id`.

| Parameter             | Required | Definition                                                                                                                                                      |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dst_address`         | Yes      | CIDR e.g. "0.0.0.0/0", "192.168.1.0/24" `{"type":"string"}`                                                                                                     |
| `gateway`             | Yes      | `{"type":"string"}`                                                                                                                                             |
| `distance`            | No       | 1-255 (lower = higher priority) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `scope`               | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                     |
| `target_scope`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                     |
| `routing_table`       | No       | Policy-routing table name, e.g. "main" or a custom table (RouterOS v7) `{"type":"string"}`                                                                      |
| `routing_mark`        | No       | Deprecated alias for routing_table (RouterOS v6 name) `{"type":"string"}`                                                                                       |
| `comment`             | No       | `{"type":"string"}`                                                                                                                                             |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                            |
| `vrf_interface`       | No       | `{"type":"string"}`                                                                                                                                             |
| `pref_src`            | No       | `{"type":"string"}`                                                                                                                                             |
| `check_gateway`       | No       | "ping" or "arp" `{"type":"string"}`                                                                                                                             |
| `suppress_hw_offload` | No       | Exclude route from hardware (HW) offloading `{"type":"boolean"}`                                                                                                |
| `type`                | No       | "unicast" (default) or "blackhole" (drop silently). RouterOS v7 has no "unreachable"/"prohibit" route types. `{"type":"string","enum":["unicast","blackhole"]}` |

## list_routes

**List IPv4 Routes** · Risk: **read**

Lists IPv4 routes from `/ip route` with optional filters — the primary tool for inspecting what routes the router knows. `dst_filter` and `gateway_filter` do substring matching; `routing_table_filter` and `distance_filter` do exact matching; `active_only`/`disabled_only`/`dynamic_only`/`static_only` are boolean flags. For a table-scoped view of active routes use get_routing_table; for counts and summary stats use get_route_statistics; for IPv6 use list_ipv6_routes. Returns all matching route entries.

| Parameter              | Required | Definition                                                                  |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `dst_filter`           | No       | `{"type":"string"}`                                                         |
| `gateway_filter`       | No       | `{"type":"string"}`                                                         |
| `routing_table_filter` | No       | Exact policy-routing table name (RouterOS v7) `{"type":"string"}`           |
| `routing_mark_filter`  | No       | Deprecated alias for routing_table_filter `{"type":"string"}`               |
| `distance_filter`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `active_only`          | Yes      | `{"default":false,"type":"boolean"}`                                        |
| `disabled_only`        | Yes      | `{"default":false,"type":"boolean"}`                                        |
| `dynamic_only`         | Yes      | `{"default":false,"type":"boolean"}`                                        |
| `static_only`          | Yes      | `{"default":false,"type":"boolean"}`                                        |

## get_route

**Get IPv4 Route Detail** · Risk: **read**

Fetches full detail for a single IPv4 route (`/ip route print detail where .id=…`) — use this after list_routes to inspect one entry's flags, nexthop, distance, scope, and all attributes. `route_id` is the `*N` or `N` `.id` value from list_routes. For listing multiple routes use list_routes; for a table-scoped view use get_routing_table. Returns the complete detail block for that route, or a not-found message.

| Parameter  | Required | Definition                                                 |
| ---------- | -------- | ---------------------------------------------------------- |
| `route_id` | Yes      | "*N" or "N" from list output e.g. "*3" `{"type":"string"}` |

## update_route

**Update IPv4 Route** · Risk: **write-idempotent**

Modifies an existing IPv4 static route (`/ip route set`) — change its gateway, dst-address, distance, scope, routing-table, VRF interface, preferred-source, or gateway check method. `route_id` is the `*N` `.id` from list_routes. Pass an empty string ("") for `routing_table`, `vrf_interface`, or `pref_src` to clear those fields. For toggling active state without editing attributes use enable_route / disable_route. Returns the updated route detail.

| Parameter             | Required | Definition                                                                                                                                                        |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route_id`            | Yes      | "*N" or "N" from list output e.g. "*3" `{"type":"string"}`                                                                                                        |
| `dst_address`         | No       | CIDR e.g. "192.168.1.0/24" `{"type":"string"}`                                                                                                                    |
| `gateway`             | No       | `{"type":"string"}`                                                                                                                                               |
| `distance`            | No       | 1-255 `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                 |
| `scope`               | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                       |
| `target_scope`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                       |
| `routing_table`       | No       | Policy-routing table name (RouterOS v7); "" clears it `{"type":"string"}`                                                                                         |
| `routing_mark`        | No       | Deprecated alias for routing_table (RouterOS v6 name) `{"type":"string"}`                                                                                         |
| `comment`             | No       | `{"type":"string"}`                                                                                                                                               |
| `disabled`            | No       | `{"type":"boolean"}`                                                                                                                                              |
| `vrf_interface`       | No       | `{"type":"string"}`                                                                                                                                               |
| `pref_src`            | No       | `{"type":"string"}`                                                                                                                                               |
| `check_gateway`       | No       | "ping" or "arp" `{"type":"string"}`                                                                                                                               |
| `suppress_hw_offload` | No       | Exclude route from hardware (HW) offloading `{"type":"boolean"}`                                                                                                  |
| `type`                | No       | "blackhole" makes the route drop traffic; "unicast" turns a blackhole route back into a normal next-hop route. `{"type":"string","enum":["unicast","blackhole"]}` |

## remove_route

**Remove IPv4 Route** · Risk: **destructive**

Permanently deletes an IPv4 route (`/ip route remove`) — verifies the entry exists first (count-only check) then removes it. `route_id` is the `*N` `.id` from list_routes. To temporarily take a route out of service without deleting it use disable_route instead. Confirms deletion or reports not-found.

| Parameter  | Required | Definition                                                 |
| ---------- | -------- | ---------------------------------------------------------- |
| `route_id` | Yes      | "*N" or "N" from list output e.g. "*3" `{"type":"string"}` |

## enable_route

**Enable IPv4 Route** · Risk: **write-idempotent**

Activates a disabled IPv4 route (`/ip route set disabled=no`) — makes it eligible for route selection without altering any other attributes. `route_id` is the `*N` `.id` from list_routes. To deactivate a route use disable_route; to remove it permanently use remove_route. Returns the updated route detail.

| Parameter  | Required | Definition                                                 |
| ---------- | -------- | ---------------------------------------------------------- |
| `route_id` | Yes      | "*N" or "N" from list output e.g. "*3" `{"type":"string"}` |

## disable_route

**Disable IPv4 Route** · Risk: **write-idempotent**

Deactivates an IPv4 route (`/ip route set disabled=yes`) — removes it from route selection without deleting it so it can be re-enabled later. `route_id` is the `*N` `.id` from list_routes. To re-activate use enable_route; to permanently delete use remove_route. Returns the updated route detail.

| Parameter  | Required | Definition                                                 |
| ---------- | -------- | ---------------------------------------------------------- |
| `route_id` | Yes      | "*N" or "N" from list output e.g. "*3" `{"type":"string"}` |

## get_routing_table

**Get IPv4 Routing Table by Name** · Risk: **read**

Reads IPv4 route entries scoped by routing table (`/ip route print`) — for any `table_name` other than "main" adds `where routing-table=<name>`; for the implicit default "main" table the routing-table filter is omitted (routes without an explicit table belong to main). Designed for policy-routing setups with multiple tables (e.g. "main", "ISP1", "ISP2"). Filters by `table_name` (default "main"), optional `protocol_filter`, and `active_only` (default true, showing only routes currently used for forwarding). For an unfiltered list across all tables use list_routes; for total/active/static counts use get_route_statistics. Returns matching route entries from the specified table.

| Parameter         | Required | Definition                           |
| ----------------- | -------- | ------------------------------------ |
| `table_name`      | Yes      | `{"default":"main","type":"string"}` |
| `protocol_filter` | No       | `{"type":"string"}`                  |
| `active_only`     | Yes      | `{"default":true,"type":"boolean"}`  |

## check_route_path

**Check IPv4 Route Path** · Risk: **read**

Resolves which nexthop RouterOS would use for a given IPv4 destination — answers "which gateway will this packet take?" without sending any traffic. Version-aware: uses `/ip route check` on v6, falls back to `/ip route print where <dest> in dst-address active=yes` on v7+ where the check command was removed. Optionally scoped by `routing_table` (v7) / `routing_mark` (v6) for policy-routing table lookups. For listing all known routes use list_routes; for a named-table view use get_routing_table. Returns the resolved nexthop and interface detail.

| Parameter       | Required | Definition                                                                          |
| --------------- | -------- | ----------------------------------------------------------------------------------- |
| `destination`   | Yes      | `{"type":"string"}`                                                                 |
| `routing_table` | No       | Policy-routing table name (v7) or routing-mark (v6), e.g. "VPN" `{"type":"string"}` |

## get_route_cache

**Get IPv4 Route Cache / Forwarding Table** · Risk: **read**

Shows the IPv4 route cache or active forwarding table — version-aware: on RouterOS v6 reads the real per-flow route cache (`/ip route cache print`); on v7+ (where the cache was removed) returns active `/ip route` entries with active=yes (the FIB equivalent). Use this to inspect what the dataplane is actually forwarding. For all routes including inactive/disabled entries use list_routes. Returns cache entries (v6) or active forwarding-table entries (v7+).

No tool-specific parameters.

## flush_route_cache

**Flush IPv4 Route Cache** · Risk: **destructive**

Clears the IPv4 per-flow route cache (`/ip route cache flush`) — forces the dataplane to re-resolve nexthops from the routing table, useful after manual route changes that have not yet propagated to the cache. Version-aware: on RouterOS v7+ there is no separate cache (the FIB is rebuilt directly from `/ip route`), so this is a no-op and reports accordingly. To view the current cache before flushing use get_route_cache.

No tool-specific parameters.

## add_default_route

**Add IPv4 Default Route** · Risk: **write**

Adds an IPv4 default route (`/ip route add dst-address=0.0.0.0/0`) with gateway health monitoring — a convenience wrapper around add_route fixed to the 0.0.0.0/0 prefix. `check_gateway` defaults to "ping" (active gateway probing); set `distance` to control failover priority when multiple default routes exist. For any other prefix use add_route; for null/drop routes use add_blackhole_route; for IPv6 use add_ipv6_route. Returns the created route detail including its `.id`.

| Parameter       | Required | Definition                                                                              |
| --------------- | -------- | --------------------------------------------------------------------------------------- |
| `gateway`       | Yes      | `{"type":"string"}`                                                                     |
| `distance`      | Yes      | `{"default":1,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`       | No       | `{"type":"string"}`                                                                     |
| `check_gateway` | Yes      | `{"default":"ping","type":"string"}`                                                    |

## add_blackhole_route

**Add IPv4 Blackhole Route** · Risk: **write**

Adds an IPv4 null/blackhole route (`/ip route add … blackhole`) — traffic to `dst_address` is silently dropped at the routing layer without generating an ICMP unreachable. Used for traffic engineering, bogon suppression, or null-routing abusive prefixes. For a normal next-hop route use add_route; for a default gateway use add_default_route. Returns the created route's `.id` on success.

| Parameter     | Required | Definition                                                                                    |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `dst_address` | Yes      | CIDR e.g. "10.0.0.0/8" `{"type":"string"}`                                                    |
| `distance`    | Yes      | 1-255 `{"default":1,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`     | No       | `{"type":"string"}`                                                                           |

## get_route_statistics

**Get IPv4 Route Statistics** · Risk: **read**

Returns a count summary of the IPv4 routing table (`/ip route print count-only`) broken down by total, active, dynamic, static, and disabled entries — a fast health-check without returning the full route list. For the actual route entries use list_routes; for a named-table view use get_routing_table. Returns a formatted ROUTE STATISTICS block with five counters.

No tool-specific parameters.
