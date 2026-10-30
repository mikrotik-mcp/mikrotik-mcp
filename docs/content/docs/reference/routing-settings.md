---
title: "Routing Settings"
description: "Global routing settings: ECMP hash policy, VRF-as-interface (`/routing settings`)."
---

## Tools

- [Get Global Routing Settings](#get_routing_settings)
- [Update Global Routing Settings](#update_routing_settings)

## get_routing_settings

**Get Global Routing Settings** · Risk: **read**

Reads global routing daemon settings (`/routing settings print`) on RouterOS v7 — the ECMP/multipath hash policies for IPv4 and IPv6 and the VRF-as-interface flag. Use this to inspect how equal-cost next-hops are hashed and whether VRFs are exposed as interfaces. For individual IPv4 route entries use list_routes; for IPv6 routes use list_ipv6_routes; for policy-routing rules use list_routing_rules; for BGP peers use list_bgp_connections. Returns all fields from /routing settings.

No tool-specific parameters.

## update_routing_settings

**Update Global Routing Settings** · Risk: **write-idempotent**

Sets global routing daemon settings (`/routing settings set`) on RouterOS v7 — controls ECMP/multipath hash policy and VRF-as-interface behavior. `ipv4_multipath_hash_policy` and `ipv6_multipath_hash_policy` choose how equal-cost next-hops are selected: `l3` = src/dst IP only, `l3-inner` = inner packet header for tunnelled traffic, `l4` = include L4 src/dst ports. `ipv4_vrf_as_interface` exposes VRFs as interfaces to the rest of the config. For modifying individual IPv4 route entries use update_route; for policy-based routing rules use update_routing_rule. Returns the full /routing settings after applying changes.

| Parameter                    | Required | Definition                                        |
| ---------------------------- | -------- | ------------------------------------------------- |
| `ipv4_multipath_hash_policy` | No       | `{"type":"string","enum":["l3","l3-inner","l4"]}` |
| `ipv6_multipath_hash_policy` | No       | `{"type":"string","enum":["l3","l3-inner","l4"]}` |
| `ipv4_vrf_as_interface`      | No       | `{"type":"boolean"}`                              |
