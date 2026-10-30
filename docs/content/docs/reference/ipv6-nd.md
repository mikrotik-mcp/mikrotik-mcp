---
title: "IPv6 ND"
description: "Neighbor Discovery / Router Advertisement config and advertised prefixes (`/ipv6 nd`)."
---

## Tools

- [Add IPv6 ND Interface Configuration](#add_ipv6_nd)
- [List IPv6 ND Interface Configurations](#list_ipv6_nd)
- [Get IPv6 ND Interface Configuration](#get_ipv6_nd)
- [Update IPv6 ND Interface Configuration](#update_ipv6_nd)
- [Remove IPv6 ND Interface Configuration](#remove_ipv6_nd)
- [Add IPv6 ND Advertised Prefix](#add_ipv6_nd_prefix)
- [List IPv6 ND Advertised Prefixes](#list_ipv6_nd_prefixes)
- [Remove IPv6 ND Advertised Prefix](#remove_ipv6_nd_prefix)

## add_ipv6_nd

**Add IPv6 ND Interface Configuration** · Risk: **write**

Create an IPv6 Neighbor Discovery / Router Advertisement interface entry (`/ipv6 nd`) — controls RA emission (intervals, lifetime, preference), M/O DHCPv6 flags, hop limit, MTU, reachable/retransmit timers, and DNS/MAC advertisement for a specific interface. Use when a new interface needs its own ND settings distinct from the global 'all' entry; to change an existing entry (including 'all') use update_ipv6_nd. To advertise IPv6 prefixes via RA, use add_ipv6_nd_prefix. Returns the created entry's full detail including its `.id`.

Notes:
managed_address_configuration (M flag): tell hosts to use DHCPv6 for addresses.
other_configuration (O flag): tell hosts to use DHCPv6 for other info (e.g. DNS).
ra_interval: min-max range, e.g. '3m20s-10m'.

| Parameter                       | Required | Definition                                                                                |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `interface`                     | Yes      | `{"type":"string"}`                                                                       |
| `ra_interval`                   | No       | RA min-max interval range, e.g. '3m20s-10m' `{"type":"string"}`                           |
| `ra_delay`                      | No       | `{"type":"string"}`                                                                       |
| `ra_lifetime`                   | No       | e.g. '30m' or 'none' `{"type":"string"}`                                                  |
| `ra_preference`                 | No       | `{"type":"string","enum":["low","medium","high"]}`                                        |
| `hop_limit`                     | No       | Advertised hop limit (0-255 or 'unspecified') `{"type":"string"}`                         |
| `mtu`                           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`               |
| `reachable_time`                | No       | `{"type":"string"}`                                                                       |
| `retransmit_interval`           | No       | `{"type":"string"}`                                                                       |
| `managed_address_configuration` | No       | `{"type":"boolean"}`                                                                      |
| `other_configuration`           | No       | `{"type":"boolean"}`                                                                      |
| `advertise_dns`                 | No       | `{"type":"boolean"}`                                                                      |
| `advertise_mac_address`         | No       | `{"type":"boolean"}`                                                                      |
| `dns`                           | No       | Recursive DNS servers advertised via RA (RDNSS), comma-separated IPv6 `{"type":"string"}` |
| `comment`                       | No       | `{"type":"string"}`                                                                       |
| `disabled`                      | Yes      | `{"default":false,"type":"boolean"}`                                                      |

## list_ipv6_nd

**List IPv6 ND Interface Configurations** · Risk: **read**

List all per-interface IPv6 Neighbor Discovery / Router Advertisement configurations (`/ipv6 nd print`) — shows RA intervals, M/O DHCPv6 flags, hop-limit, MTU, and enabled state for each interface entry including the global 'all'. To view the prefixes those RAs advertise, use list_ipv6_nd_prefixes. Supports optional filters by interface name or disabled-only. Returns all matching entries; use get_ipv6_nd for full detail on a single entry.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_nd

**Get IPv6 ND Interface Configuration** · Risk: **read**

Fetch full detail of a single IPv6 Neighbor Discovery interface configuration (`/ipv6 nd print detail`) by RouterOS `.id` (e.g. '*1') or interface name — tries `.id` first, falls back to interface name match. For a summary table of all interfaces use list_ipv6_nd. For advertised prefix entries use list_ipv6_nd_prefixes. Returns all RA parameters for the matched entry, or a not-found message.

| Parameter | Required | Definition                                                         |
| --------- | -------- | ------------------------------------------------------------------ |
| `nd_id`   | Yes      | RouterOS .id (e.g. '*1') or the interface name `{"type":"string"}` |

## update_ipv6_nd

**Update IPv6 ND Interface Configuration** · Risk: **write-idempotent**

Modify an existing IPv6 Neighbor Discovery / Router Advertisement configuration (`/ipv6 nd set`) by interface name (e.g. 'all', 'ether1') or `.id` — use this to tune the global 'all' entry or any per-interface override. Selects by `.id` when nd_id starts with '*', otherwise by interface name. For adding a brand-new interface entry use add_ipv6_nd. For changes to advertised prefixes use add_ipv6_nd_prefix or remove_ipv6_nd_prefix. Returns the updated entry's full detail.

| Parameter                       | Required | Definition                                                                                |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `nd_id`                         | Yes      | Interface name (e.g. 'all', 'ether1') or '.id' `{"type":"string"}`                        |
| `ra_interval`                   | No       | `{"type":"string"}`                                                                       |
| `ra_delay`                      | No       | `{"type":"string"}`                                                                       |
| `ra_lifetime`                   | No       | `{"type":"string"}`                                                                       |
| `ra_preference`                 | No       | `{"type":"string","enum":["low","medium","high"]}`                                        |
| `hop_limit`                     | No       | `{"type":"string"}`                                                                       |
| `mtu`                           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`               |
| `reachable_time`                | No       | `{"type":"string"}`                                                                       |
| `retransmit_interval`           | No       | `{"type":"string"}`                                                                       |
| `managed_address_configuration` | No       | `{"type":"boolean"}`                                                                      |
| `other_configuration`           | No       | `{"type":"boolean"}`                                                                      |
| `advertise_dns`                 | No       | `{"type":"boolean"}`                                                                      |
| `advertise_mac_address`         | No       | `{"type":"boolean"}`                                                                      |
| `dns`                           | No       | Recursive DNS servers advertised via RA (RDNSS), comma-separated IPv6 `{"type":"string"}` |
| `comment`                       | No       | `{"type":"string"}`                                                                       |
| `disabled`                      | No       | `{"type":"boolean"}`                                                                      |

## remove_ipv6_nd

**Remove IPv6 ND Interface Configuration** · Risk: **destructive**

Delete a per-interface IPv6 Neighbor Discovery configuration entry (`/ipv6 nd remove`) by interface name or `.id` — the `.id` is obtained from list_ipv6_nd. The built-in 'all' entry cannot be removed; to disable it use update_ipv6_nd with disabled=true. For removing advertised prefix entries use remove_ipv6_nd_prefix. Verifies existence via count-only before removal; returns success or not-found.

| Parameter | Required | Definition                                  |
| --------- | -------- | ------------------------------------------- |
| `nd_id`   | Yes      | Interface name or '.id' `{"type":"string"}` |

## add_ipv6_nd_prefix

**Add IPv6 ND Advertised Prefix** · Risk: **write**

Add an IPv6 prefix to the Router Advertisement prefix list (`/ipv6 nd prefix add`) — announces the prefix in RA messages so hosts can perform SLAAC (autonomous=true, the A flag) or learn the on-link prefix. This is distinct from ND interface settings (add_ipv6_nd) which control RA timing and M/O flags; this tool controls WHAT prefix is carried inside those RAs. To list existing advertised prefixes use list_ipv6_nd_prefixes. Returns the added prefix's detail including its `.id`.

Notes:
autonomous: allow hosts to auto-configure addresses from this prefix (SLAAC, the A flag).
prefix format: e.g. '2001:db8:1::/64'.

| Parameter            | Required | Definition                                                      |
| -------------------- | -------- | --------------------------------------------------------------- |
| `prefix`             | Yes      | Prefix to advertise, e.g. '2001:db8:1::/64' `{"type":"string"}` |
| `interface`          | No       | `{"type":"string"}`                                             |
| `valid_lifetime`     | No       | `{"type":"string"}`                                             |
| `preferred_lifetime` | No       | `{"type":"string"}`                                             |
| `autonomous`         | No       | `{"type":"boolean"}`                                            |
| `comment`            | No       | `{"type":"string"}`                                             |
| `disabled`           | Yes      | `{"default":false,"type":"boolean"}`                            |

## list_ipv6_nd_prefixes

**List IPv6 ND Advertised Prefixes** · Risk: **read**

List all IPv6 prefixes advertised in Router Advertisement messages (`/ipv6 nd prefix print`) — shows each prefix, its interface, valid/preferred lifetimes, and autonomous (SLAAC A-flag) status. To see ND interface settings (RA intervals, M/O flags) rather than the advertised prefixes, use list_ipv6_nd. Supports optional filters by interface name, prefix substring, or dynamic-only. Returns all matching entries; use the `.id` values with remove_ipv6_nd_prefix.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `prefix_filter`    | No       | `{"type":"string"}`                  |
| `dynamic_only`     | Yes      | `{"default":false,"type":"boolean"}` |

## remove_ipv6_nd_prefix

**Remove IPv6 ND Advertised Prefix** · Risk: **destructive**

Delete an IPv6 ND advertised prefix entry (`/ipv6 nd prefix remove`) by RouterOS `.id` (e.g. '*1') or prefix value (e.g. '2001:db8:1::/64') — the `.id` is obtained from list_ipv6_nd_prefixes. Tries `.id` match first, falls back to prefix string match. To remove the ND interface configuration (not a prefix) use remove_ipv6_nd. Verifies existence via count-only before deletion; returns success or not-found.

| Parameter   | Required | Definition                                                 |
| ----------- | -------- | ---------------------------------------------------------- |
| `prefix_id` | Yes      | RouterOS .id (e.g. '*1') or the prefix `{"type":"string"}` |
