---
title: "IPv6 Addresses"
description: "Interface IPv6 addressing (`/ipv6 address`)."
---

## Tools

- [Add IPv6 Address to Interface](#add_ipv6_address)
- [List IPv6 Addresses](#list_ipv6_addresses)
- [Get IPv6 Address Details](#get_ipv6_address)
- [Remove IPv6 Address](#remove_ipv6_address)

## add_ipv6_address

**Add IPv6 Address to Interface** · Risk: **write**

Assigns an IPv6 address to an interface (`/ipv6 address add`) — use this to give an interface a static or pool-derived IPv6 address and optionally advertise the prefix via Router Advertisements (ND). For IPv4 address assignment use add_ip_address. For IPv6 routing entries (next-hop/gateway records) use add_ipv6_route. Returns the created entry's full detail including its `.id`.

Before creating, this checks the existing `/ipv6 address` list and REFUSES to add an address that duplicates or overlaps an already-assigned prefix, returning the conflicting entries so you can pick a non-overlapping address. To intentionally add an overlapping/secondary address set `allow_overlap: true`.

Notes:
address: IPv6 with prefix length, e.g. '2001:db8::1/64'. When from_pool
is set the host part may be omitted and is taken from the pool.
eui_64: derive the host part from the interface MAC (modified EUI-64).
advertise: include this prefix in Router Advertisements (ND).

| Parameter       | Required | Definition                                                                                                               |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `address`       | Yes      | IPv6 address with prefix, e.g. '2001:db8::1/64' `{"type":"string"}`                                                      |
| `interface`     | Yes      | `{"type":"string"}`                                                                                                      |
| `advertise`     | No       | Advertise the prefix via Router Advertisements `{"type":"boolean"}`                                                      |
| `eui_64`        | No       | Derive the host part from the interface MAC (EUI-64) `{"type":"boolean"}`                                                |
| `from_pool`     | No       | IPv6 pool name to take the prefix from `{"type":"string"}`                                                               |
| `no_dad`        | No       | Skip Duplicate Address Detection for this address `{"type":"boolean"}`                                                   |
| `comment`       | No       | `{"type":"string"}`                                                                                                      |
| `disabled`      | Yes      | `{"default":false,"type":"boolean"}`                                                                                     |
| `allow_overlap` | Yes      | Bypass the duplicate/overlap guard to add a secondary address in an existing prefix `{"default":false,"type":"boolean"}` |

## list_ipv6_addresses

**List IPv6 Addresses** · Risk: **read**

List all IPv6 addresses assigned to interfaces (`/ipv6 address print`) — use this to survey which IPv6 addresses exist on the device, optionally filtered by interface name, address substring, disabled state, dynamic flag, or link-local flag. For IPv4 interface addresses use list_ip_addresses. For IPv6 routing table entries use list_ipv6_routes. Returns a table of matching address entries; use get_ipv6_address to fetch a single entry's full detail by `.id`.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `address_filter`   | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`     | Yes      | `{"default":false,"type":"boolean"}` |
| `link_local_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_address

**Get IPv6 Address Details** · Risk: **read**

Fetch full detail for a single IPv6 address entry (`/ipv6 address print detail`) by its RouterOS `.id` (e.g. '*1') or by the address value (e.g. '2001:db8::1/64') — use this to inspect flags, advertise state, EUI-64, DAD status, and dynamic/invalid markers for one specific entry. For browsing all entries use list_ipv6_addresses. For IPv6 routing entries use list_ipv6_routes. The `.id` is returned by list_ipv6_addresses or add_ipv6_address.

| Parameter    | Required | Definition                                                        |
| ------------ | -------- | ----------------------------------------------------------------- |
| `address_id` | Yes      | RouterOS .id (e.g. '*1') or the address value `{"type":"string"}` |

## remove_ipv6_address

**Remove IPv6 Address** · Risk: **destructive**

Delete an IPv6 address from an interface (`/ipv6 address remove`) — verifies the entry exists first via a count-only check, then removes it. Accepts either the RouterOS `.id` (e.g. '*1', from list_ipv6_addresses) or the address value (e.g. '2001:db8::1/64'). For IPv4 interface address removal use remove_ip_address. For removing an IPv6 routing entry use remove_ipv6_route. Returns a confirmation string on success.

| Parameter    | Required | Definition          |
| ------------ | -------- | ------------------- |
| `address_id` | Yes      | `{"type":"string"}` |
