---
title: "IPv6 Settings"
description: "Global IPv6 settings: forwarding, RA/redirect acceptance, neighbor table (`/ipv6 settings`)."
---

## Tools

- [Get IPv6 Global Settings](#get_ipv6_settings)
- [Update IPv6 Global Settings](#update_ipv6_settings)

## get_ipv6_settings

**Get IPv6 Global Settings** · Risk: **read**

Read IPv6 global settings (`/ipv6 settings`) — the single device-wide control record that governs whether IPv6 is enabled, packet forwarding, ICMP redirect acceptance, router-advertisement acceptance, and the neighbor-cache limit.

Use this to inspect the current state before calling update_ipv6_settings. This is not for per-interface IPv6 addresses (use add_ipv6_address / list_ipv6_addresses) or routes (use list_ipv6_routes / add_ipv6_route) or firewall rules (use list_ipv6_filter_rules).

Returns the full `/ipv6 settings print` output as a text block.

No tool-specific parameters.

## update_ipv6_settings

**Update IPv6 Global Settings** · Risk: **write-idempotent**

Update IPv6 global settings (`/ipv6 settings set`) — modify the device-wide IPv6 control record that covers the enable/disable toggle, packet forwarding, ICMP redirect acceptance, router-advertisement acceptance, and the neighbor-cache ceiling.

Use this to toggle IPv6 entirely or tune host-vs-router behavior. This does NOT add IPv6 addresses (use add_ipv6_address), static routes (use add_ipv6_route), or firewall rules (use create_ipv6_filter_rule / create_ipv6_nat_rule / create_ipv6_mangle_rule). To read the current state first, use get_ipv6_settings.

Argument notes:
disable_ipv6: true turns off IPv6 device-wide.
forward: true enables IPv6 packet forwarding (router mode).
accept_redirects / accept_router_advertisements: 'yes', 'no', or
'yes-if-forwarding-disabled' (the host-like default).
max_neighbor_entries: integer cap on the IPv6 neighbor cache.

Returns the updated `/ipv6 settings print` output on success.

| Parameter                         | Required | Definition                                                                                                                                                     |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disable_ipv6`                    | No       | `{"type":"boolean"}`                                                                                                                                           |
| `forward`                         | No       | `{"type":"boolean"}`                                                                                                                                           |
| `accept_redirects`                | No       | `{"type":"string","enum":["yes","no","yes-if-forwarding-disabled"]}`                                                                                           |
| `accept_router_advertisements`    | No       | `{"type":"string","enum":["yes","no","yes-if-forwarding-disabled"]}`                                                                                           |
| `accept_router_advertisements_on` | No       | Interface list on which to accept router advertisements (e.g. 'all'). `{"type":"string"}`                                                                      |
| `max_neighbor_entries`            | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                    |
| `min_neighbor_entries`            | No       | Lower threshold for the IPv6 neighbor cache below which entries are not reclaimed. `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `soft_max_neighbor_entries`       | No       | Soft ceiling for the IPv6 neighbor cache before aggressive garbage collection. `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`     |
| `stale_neighbor_timeout`          | No       | Time a stale IPv6 neighbor entry is kept before revalidation (e.g. '60'). `{"type":"string"}`                                                                  |
| `multipath_hash_policy`           | No       | Hashing fields for ECMP multipath route selection: l3, l4, or l3-inner. `{"type":"string","enum":["l3","l4","l3-inner"]}`                                      |
| `allow_fast_path`                 | No       | Allow IPv6 FastPath processing. `{"type":"boolean"}`                                                                                                           |
