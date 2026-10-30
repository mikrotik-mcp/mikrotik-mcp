---
title: "IPv6 Neighbors"
description: "IPv6 neighbor cache (ND-discovered addresses), read + flush (`/ipv6 neighbor`)."
---

## Tools

- [List IPv6 Neighbor Cache Entries](#list_ipv6_neighbors)
- [Get IPv6 Neighbor Cache Entry Detail](#get_ipv6_neighbor)
- [Flush IPv6 Neighbor Cache Entry](#remove_ipv6_neighbor)

## list_ipv6_neighbors

**List IPv6 Neighbor Cache Entries** · Risk: **read**

List IPv6 neighbor cache entries (`/ipv6 neighbor`) — the IPv6 equivalent of the ARP table, populated automatically by Neighbor Discovery (ND). Use this to inspect which IPv6 addresses are reachable on each interface and what MAC they map to. This tool covers only IPv6 neighbor cache (ND) entries; for IPv6 routing entries use list_ipv6_routes. Returns each entry's address, mac-address, interface, status, and router flag. Optional filters: interface_filter (exact interface name), address_filter (regex match on IPv6 address), mac_filter (regex match on MAC), status_filter (e.g. 'reachable', 'stale', 'delay', 'probe'), router_only=true to show only entries flagged as routers.

| Parameter          | Required | Definition                                                                    |
| ------------------ | -------- | ----------------------------------------------------------------------------- |
| `interface_filter` | No       | `{"type":"string"}`                                                           |
| `address_filter`   | No       | `{"type":"string"}`                                                           |
| `mac_filter`       | No       | `{"type":"string"}`                                                           |
| `status_filter`    | No       | Match status, e.g. 'reachable', 'stale', 'delay', 'probe' `{"type":"string"}` |
| `router_only`      | Yes      | Only entries flagged as routers `{"default":false,"type":"boolean"}`          |

## get_ipv6_neighbor

**Get IPv6 Neighbor Cache Entry Detail** · Risk: **read**

Retrieve full detail for a single IPv6 neighbor cache entry (`/ipv6 neighbor print detail`) by its RouterOS `.id` or by IPv6 address — resolves whichever form matches first. Use this when you already know which entry you need and want its complete fields (address, mac-address, interface, status, router flag). To browse all entries or search by interface/status use list_ipv6_neighbors. The neighbor_id argument accepts either a RouterOS .id (e.g. '*1', obtained from list_ipv6_neighbors) or a full IPv6 address string.

| Parameter     | Required | Definition                                                       |
| ------------- | -------- | ---------------------------------------------------------------- |
| `neighbor_id` | Yes      | RouterOS .id (e.g. '*1') or the IPv6 address `{"type":"string"}` |

## remove_ipv6_neighbor

**Flush IPv6 Neighbor Cache Entry** · Risk: **destructive**

Flush (remove) a single IPv6 neighbor cache entry (`/ipv6 neighbor remove`) by its RouterOS `.id` or by IPv6 address — the device performs a count-only existence check before removing. Use this to clear a stale or incorrect ND-learned address-to-MAC binding so the router re-probes and re-learns the correct mapping. The entry will be re-added automatically by Neighbor Discovery once traffic resumes. To look up the `.id` or address of the entry to flush, use list_ipv6_neighbors or get_ipv6_neighbor first. This operates only on the dynamic ND cache — it does not affect IPv6 routes (use remove_ipv6_route) or IPv6 addresses assigned to interfaces (use the IPv6 address tools).

| Parameter     | Required | Definition                                                       |
| ------------- | -------- | ---------------------------------------------------------------- |
| `neighbor_id` | Yes      | RouterOS .id (e.g. '*1') or the IPv6 address `{"type":"string"}` |
