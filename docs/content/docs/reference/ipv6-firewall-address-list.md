---
title: "IPv6 Firewall — Address List"
description: "IPv6 firewall address-lists (`/ipv6 firewall address-list`)."
---

## Tools

- [Add IPv6 Firewall Address-List Entry](#add_ipv6_address_list_entry)
- [List IPv6 Firewall Address-List Entries](#list_ipv6_address_lists)
- [Get IPv6 Firewall Address-List Entry](#get_ipv6_address_list_entry)
- [Remove IPv6 Firewall Address-List Entry](#remove_ipv6_address_list_entry)
- [Enable IPv6 Firewall Address-List Entry](#enable_ipv6_address_list_entry)
- [Disable IPv6 Firewall Address-List Entry](#disable_ipv6_address_list_entry)

## add_ipv6_address_list_entry

**Add IPv6 Firewall Address-List Entry** · Risk: **write**

Adds an IPv6 address or prefix to a named group (`/ipv6 firewall address-list`) referenced by IPv6 filter, mangle, NAT, and raw rules — use this to build blocklists, allowlists, or dynamic-population targets for IPv6 traffic. For IPv4 address lists use `add_address_list_entry`. Accepts a static entry or a timeout-expiring one (e.g. `1d00:00:00`); address formats: `2001:db8::1` or `2001:db8::/32`. Returns the created entry's detail including its `.id`.

| Parameter  | Required | Definition                                                                               |
| ---------- | -------- | ---------------------------------------------------------------------------------------- |
| `list`     | Yes      | Address-list name `{"type":"string"}`                                                    |
| `address`  | Yes      | IPv6 address or prefix to add, e.g. '2001:db8::1' or '2001:db8::/32' `{"type":"string"}` |
| `timeout`  | No       | Auto-remove timeout, e.g. '1d00:00:00' `{"type":"string"}`                               |
| `comment`  | No       | `{"type":"string"}`                                                                      |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`                                                     |

## list_ipv6_address_lists

**List IPv6 Firewall Address-List Entries** · Risk: **read**

Lists all IPv6 firewall address-list entries (`/ipv6 firewall address-list`) — both static and dynamically-populated — used as named groups by IPv6 filter, mangle, NAT, and raw rules. For IPv4 address lists use `list_address_lists`. Optionally filter by partial list name (`list_filter`), partial address (`address_filter`), or restrict to dynamic-only entries (`dynamic_only`). Returns a table of matching entries with their `.id`, list name, address, timeout, and status.

| Parameter        | Required | Definition                                                               |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `list_filter`    | No       | Partial list-name match `{"type":"string"}`                              |
| `address_filter` | No       | Partial address match `{"type":"string"}`                                |
| `dynamic_only`   | Yes      | Only show dynamically-added entries `{"default":false,"type":"boolean"}` |

## get_ipv6_address_list_entry

**Get IPv6 Firewall Address-List Entry** · Risk: **read**

Retrieves full detail for a single IPv6 firewall address-list entry (`/ipv6 firewall address-list print detail`) by its `.id`. Use to inspect one specific entry; to browse all entries use `list_ipv6_address_lists`. For IPv4 address-list entries use `get_address_list_entry`. `entry_id` takes the `.id` (e.g. `*1`) returned by `list_ipv6_address_lists`. Returns the full entry detail including list name, address, timeout, comment, and dynamic/disabled flags.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## remove_ipv6_address_list_entry

**Remove IPv6 Firewall Address-List Entry** · Risk: **destructive**

Permanently deletes an IPv6 firewall address-list entry (`/ipv6 firewall address-list remove`) by its `.id`. Use when an address/prefix should no longer belong to the named group. To temporarily suppress the entry without deleting it use `disable_ipv6_address_list_entry`; for IPv4 address-list removal use the equivalent IPv4 tool. Verifies existence before removing; `entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## enable_ipv6_address_list_entry

**Enable IPv6 Firewall Address-List Entry** · Risk: **write-idempotent**

Re-activates a disabled IPv6 firewall address-list entry (`/ipv6 firewall address-list enable`) by its `.id`, making it visible to IPv6 firewall rules again. Counterpart to `disable_ipv6_address_list_entry`. `entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`. Returns confirmation of the enabled state.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## disable_ipv6_address_list_entry

**Disable IPv6 Firewall Address-List Entry** · Risk: **write-idempotent**

Deactivates an IPv6 firewall address-list entry (`/ipv6 firewall address-list disable`) by its `.id` without deleting it — IPv6 firewall rules referencing the list will no longer match this address while it is disabled. To permanently delete the entry use `remove_ipv6_address_list_entry`; to re-activate use `enable_ipv6_address_list_entry`. `entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`. Returns confirmation of the disabled state.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |
