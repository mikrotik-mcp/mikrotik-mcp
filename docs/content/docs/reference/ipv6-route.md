---
title: "IPv6 Routes"
description: "Static IPv6 routes, incl. default and blackhole routes (`/ipv6 route`)."
---

## Tools

- [Add IPv6 Static Route](#add_ipv6_route)
- [Add IPv6 Default Route](#add_ipv6_default_route)
- [List IPv6 Routes](#list_ipv6_routes)
- [Get IPv6 Route Details](#get_ipv6_route)
- [Remove IPv6 Static Route](#remove_ipv6_route)
- [Enable IPv6 Route](#enable_ipv6_route)
- [Disable IPv6 Route](#disable_ipv6_route)

## add_ipv6_route

**Add IPv6 Static Route** · Risk: **write**

Adds an IPv6 static route (`/ipv6 route add`) to the routing table — use to configure next-hop forwarding, black-hole drops, or VRF-targeted routes for IPv6 prefixes. For the IPv4 equivalent use add_route. To set the gateway-of-last-resort (::/0) use add_ipv6_default_route instead. Returns the created route's full detail including its `.id`.

Notes:
dst_address: destination prefix, e.g. '2001:db8:1::/64'.
type: 'unicast' (default) routes via gateway; 'blackhole' discards
traffic (no gateway needed). RouterOS v7 has no 'unreachable'/'prohibit'.
routing_table: target a named routing table/FIB.

| Parameter             | Required | Definition                                                                                                            |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `dst_address`         | Yes      | Destination prefix, e.g. '2001:db8:1::/64' `{"type":"string"}`                                                        |
| `gateway`             | No       | Next-hop IPv6 address or interface (required for unicast) `{"type":"string"}`                                         |
| `type`                | No       | `{"type":"string","enum":["unicast","blackhole"]}`                                                                    |
| `distance`            | No       | `{"type":"integer","minimum":1,"maximum":255}`                                                                        |
| `scope`               | No       | `{"type":"integer","minimum":0,"maximum":255}`                                                                        |
| `target_scope`        | No       | `{"type":"integer","minimum":0,"maximum":255}`                                                                        |
| `routing_table`       | No       | `{"type":"string"}`                                                                                                   |
| `pref_src`            | No       | `{"type":"string"}`                                                                                                   |
| `check_gateway`       | No       | 'ping', 'arp', 'bfd' or 'none' `{"type":"string"}`                                                                    |
| `vrf_interface`       | No       | `{"type":"string"}`                                                                                                   |
| `route_tag`           | No       | Route tag for matching in routing filters `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `suppress_hw_offload` | No       | Disable hardware offloading for this route `{"type":"boolean"}`                                                       |
| `comment`             | No       | `{"type":"string"}`                                                                                                   |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                                  |

## add_ipv6_default_route

**Add IPv6 Default Route** · Risk: **write**

Adds an IPv6 default route (::/0) (`/ipv6 route add`) via the specified gateway — shortcut for setting the gateway-of-last-resort for all IPv6 traffic with no more-specific match. For a non-default prefix use add_ipv6_route. For the IPv4 default route use add_default_route. Returns the created route's full detail including its `.id`.

| Parameter       | Required | Definition                                             |
| --------------- | -------- | ------------------------------------------------------ |
| `gateway`       | Yes      | Next-hop IPv6 address or interface `{"type":"string"}` |
| `distance`      | No       | `{"type":"integer","minimum":1,"maximum":255}`         |
| `check_gateway` | No       | `{"type":"string"}`                                    |
| `routing_table` | No       | `{"type":"string"}`                                    |
| `comment`       | No       | `{"type":"string"}`                                    |
| `disabled`      | Yes      | `{"default":false,"type":"boolean"}`                   |

## list_ipv6_routes

**List IPv6 Routes** · Risk: **read**

Lists IPv6 routes (`/ipv6 route print`) from the routing table — use to inspect static and dynamic IPv6 routes and obtain `.id` values for get/remove/enable/disable operations. For IPv4 routes use list_routes. For policy routing rules use list_routing_rules. Accepts optional filters: dst_filter (substring match on destination prefix), gateway_filter, routing_table_filter, active_only, disabled_only, dynamic_only. Returns a formatted route table or a not-found message.

| Parameter              | Required | Definition                           |
| ---------------------- | -------- | ------------------------------------ |
| `dst_filter`           | No       | `{"type":"string"}`                  |
| `gateway_filter`       | No       | `{"type":"string"}`                  |
| `routing_table_filter` | No       | `{"type":"string"}`                  |
| `active_only`          | Yes      | `{"default":false,"type":"boolean"}` |
| `disabled_only`        | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`         | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_route

**Get IPv6 Route Details** · Risk: **read**

Fetches full detail for a single IPv6 route (`/ipv6 route print detail`) by RouterOS `.id` or destination prefix — use when you need all attributes of one specific route rather than the full table. For the complete route table use list_ipv6_routes. For the IPv4 equivalent use get_route. Accepts a `.id` (e.g. '*1', obtained from list_ipv6_routes) or a destination prefix string; tries `.id` first then falls back to a dst-address match. Returns the route's detail block.

| Parameter  | Required | Definition                                                             |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `route_id` | Yes      | RouterOS .id (e.g. '*1') or the destination prefix `{"type":"string"}` |

## remove_ipv6_route

**Remove IPv6 Static Route** · Risk: **destructive**

Permanently removes an IPv6 static route (`/ipv6 route remove`) by its RouterOS `.id`. For the IPv4 equivalent use remove_route. Obtain the `.id` (e.g. '*5') from list_ipv6_routes; use it instead of a destination prefix to avoid ambiguity when multiple routes share the same dst-address. Verifies the route exists before removal and returns an error if not found. Dynamic routes injected by routing protocols cannot be removed this way.

| Parameter  | Required | Definition                                  |
| ---------- | -------- | ------------------------------------------- |
| `route_id` | Yes      | RouterOS .id, e.g. '*5' `{"type":"string"}` |

## enable_ipv6_route

**Enable IPv6 Route** · Risk: **write-idempotent**

Enables a disabled IPv6 route (`/ipv6 route set disabled=no`) by its RouterOS `.id` — makes the route active and eligible for forwarding decisions again without recreating it. To suppress it without deleting it use disable_ipv6_route. Obtain the `.id` from list_ipv6_routes. Returns a confirmation string.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `route_id` | Yes      | `{"type":"string"}` |

## disable_ipv6_route

**Disable IPv6 Route** · Risk: **write-idempotent**

Disables an active IPv6 route (`/ipv6 route set disabled=yes`) by its RouterOS `.id` — suppresses the route from the forwarding table without deleting it, preserving its config for later re-activation. To re-activate it use enable_ipv6_route. To permanently delete it use remove_ipv6_route. Obtain the `.id` from list_ipv6_routes. Returns a confirmation string.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `route_id` | Yes      | `{"type":"string"}` |
