---
title: "Next-hops"
description: "Resolved recursive next-hop table, read-only diagnostics (`/routing nexthop`)."
---

## Tools

- [List Routing Next-Hops](#list_routing_nexthops)
- [Get Routing Next-Hop Statistics](#get_routing_nexthop_stats)

## list_routing_nexthops

**List Routing Next-Hops** · Risk: **read**

List resolved routing next-hops (`/routing nexthop`) — the recursive next-hop resolution table that shows how each gateway maps to a concrete egress interface and immediate next-hop address, and whether it is currently active. Use this to debug recursive or BGP next-hop resolution failures where a route exists but traffic is not forwarded as expected. For the IPv4 route table use list_routes; for IPv6 routes use list_ipv6_routes; for routing policy rules use list_routing_rules; for next-hop counts only use get_routing_nexthop_stats. Requires RouterOS v7 with the routing package. Returns full detail for each next-hop entry. Filter with gateway_filter (substring match on gateway address) and active_only=true to restrict to active entries.

| Parameter        | Required | Definition                                                          |
| ---------------- | -------- | ------------------------------------------------------------------- |
| `gateway_filter` | No       | Substring match on the resolved gateway address `{"type":"string"}` |
| `active_only`    | Yes      | `{"default":false,"type":"boolean"}`                                |

## get_routing_nexthop_stats

**Get Routing Next-Hop Statistics** · Risk: **read**

Summarise the routing next-hop table (`/routing nexthop`) — returns total and active next-hop counts. Use this for a quick health check on next-hop resolution capacity without fetching full entry detail. For the full per-entry list with gateway and interface detail use list_routing_nexthops; for the IPv4 route table use list_routes; for IPv6 routes use list_ipv6_routes. Requires RouterOS v7 with the routing package. Returns two counts: total next-hops and active next-hops.

No tool-specific parameters.
