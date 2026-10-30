---
title: "Address Lists"
description: "Firewall address-lists (`/ip firewall address-list`)."
---

## Tools

- [Add Firewall Address-List Entry](#add_address_list_entry)
- [List Firewall Address-List Entries](#list_address_lists)
- [Get Firewall Address-List Entry Detail](#get_address_list_entry)
- [Remove Firewall Address-List Entry](#remove_address_list_entry)
- [Enable Firewall Address-List Entry](#enable_address_list_entry)
- [Disable Firewall Address-List Entry](#disable_address_list_entry)

## add_address_list_entry

**Add Firewall Address-List Entry** · Risk: **write**

Adds an address or subnet to a named IPv4 firewall address-list (`/ip firewall address-list`) — the mechanism for grouping IPs so firewall filter, NAT, and mangle rules can match them via `src-address-list` or `dst-address-list`. Use this for static entries; dynamic entries are auto-populated by firewall rules with `action=add-to-list`. Accepts a `timeout` (e.g. `'1d00:00:00'`) to auto-expire the entry. Returns the created entry's details including its `.id`.

| Parameter  | Required | Definition                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `list`     | Yes      | Address-list name `{"type":"string"}`                                          |
| `address`  | Yes      | Address or subnet to add, e.g. '10.0.0.1' or '10.0.0.0/24' `{"type":"string"}` |
| `timeout`  | No       | Auto-remove timeout, e.g. '1d00:00:00' `{"type":"string"}`                     |
| `comment`  | No       | `{"type":"string"}`                                                            |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`                                           |

## list_address_lists

**List Firewall Address-List Entries** · Risk: **read**

Lists all IPv4 firewall address-list entries (`/ip firewall address-list print`) with optional filters — partial list name (`list_filter`), partial address match (`address_filter`), or dynamic-only entries (`dynamic_only`). Use this to browse all lists and retrieve the `.id` values needed by get_address_list_entry, remove_address_list_entry, enable_address_list_entry, and disable_address_list_entry. Returns a formatted table of all matching entries.

| Parameter        | Required | Definition                                                               |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `list_filter`    | No       | Partial list-name match `{"type":"string"}`                              |
| `address_filter` | No       | Partial address match `{"type":"string"}`                                |
| `dynamic_only`   | Yes      | Only show dynamically-added entries `{"default":false,"type":"boolean"}` |

## get_address_list_entry

**Get Firewall Address-List Entry Detail** · Risk: **read**

Returns full detail for a single IPv4 firewall address-list entry (`/ip firewall address-list print detail`) by its `.id` (e.g. `'*1'`). Use this to inspect one entry precisely; to browse all entries or find `.id` values use list_address_lists instead.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## remove_address_list_entry

**Remove Firewall Address-List Entry** · Risk: **destructive**

Permanently removes an IPv4 firewall address-list entry (`/ip firewall address-list remove`) by its `.id` (e.g. `'*1'`). Confirms the entry exists first (count-only check) and returns an error if not found. To temporarily suspend an entry without deleting it use disable_address_list_entry instead. The `entry_id` is the `.id` from list_address_lists output.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## enable_address_list_entry

**Enable Firewall Address-List Entry** · Risk: **write-idempotent**

Re-activates a disabled IPv4 firewall address-list entry (`/ip firewall address-list enable`) by its `.id` (e.g. `'*1'`), making it visible again to firewall rules that reference the list. Use this to restore an entry suspended with disable_address_list_entry without re-adding it. To delete permanently use remove_address_list_entry. The `entry_id` is the `.id` from list_address_lists output.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |

## disable_address_list_entry

**Disable Firewall Address-List Entry** · Risk: **write-idempotent**

Suspends an IPv4 firewall address-list entry (`/ip firewall address-list disable`) by its `.id` (e.g. `'*1'`), making firewall rules that reference the list ignore this address without removing it. Use enable_address_list_entry to restore it, or remove_address_list_entry to delete it permanently. The `entry_id` is the `.id` from list_address_lists output.

| Parameter  | Required | Definition                                       |
| ---------- | -------- | ------------------------------------------------ |
| `entry_id` | Yes      | Internal entry id, e.g. '*1' `{"type":"string"}` |
