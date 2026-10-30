---
title: "IP Addresses"
description: "Interface IP addressing (`/ip address`)."
---

## Tools

- [Add IPv4 Address to Interface](#add_ip_address)
- [List IPv4 Addresses](#list_ip_addresses)
- [Get IPv4 Address Details](#get_ip_address)
- [Remove IPv4 Address](#remove_ip_address)

## add_ip_address

**Add IPv4 Address to Interface** · Risk: **write**

Assigns an IPv4 address to an interface (`/ip address add`). Use this to add a CIDR address (e.g. '192.168.1.1/24') as the router's own address on a network segment — sets the interface's local address, optional network, and broadcast. For IPv6 use add_ipv6_address. Before creating, this checks the existing `/ip address` list and REFUSES to add an address that duplicates or overlaps an already-assigned subnet, returning the conflicting entries so you can pick a non-overlapping address. To intentionally add an overlapping/secondary address, set `allow_overlap: true`. Returns the full detail of the new address entry including its `.id`.

| Parameter       | Required | Definition                                                                                                               |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `address`       | Yes      | Address with CIDR, e.g. '192.168.1.1/24' `{"type":"string"}`                                                             |
| `interface`     | Yes      | `{"type":"string"}`                                                                                                      |
| `network`       | No       | `{"type":"string"}`                                                                                                      |
| `broadcast`     | No       | `{"type":"string"}`                                                                                                      |
| `comment`       | No       | `{"type":"string"}`                                                                                                      |
| `disabled`      | Yes      | `{"default":false,"type":"boolean"}`                                                                                     |
| `allow_overlap` | Yes      | Bypass the duplicate/overlap guard to add a secondary address in an existing subnet `{"default":false,"type":"boolean"}` |

## list_ip_addresses

**List IPv4 Addresses** · Risk: **read**

Lists IPv4 interface address assignments (`/ip address print`). Use this to enumerate which addresses are bound to which interfaces, or to find `.id` values needed by get_ip_address and remove_ip_address. Supports filtering by interface name (interface_filter), address substring (address_filter), network (network_filter), disabled-only, or dynamic-only. For IPv6 use list_ipv6_addresses. Returns all matching entries with address/prefix, interface, network, flags, and `.id`.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `address_filter`   | No       | `{"type":"string"}`                  |
| `network_filter`   | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`     | Yes      | `{"default":false,"type":"boolean"}` |

## get_ip_address

**Get IPv4 Address Details** · Risk: **read**

Retrieves full detail for a single IPv4 address entry (`/ip address print detail`). Accepts either a RouterOS `.id` (e.g. '*1', obtained from list_ip_addresses) or the dotted-decimal CIDR address string (e.g. '192.168.1.1/24'). Use this to inspect one specific assignment rather than the full list. For IPv6 use get_ipv6_address. Returns the complete record including interface, network, broadcast, flags, and `.id`.

| Parameter    | Required | Definition                                                        |
| ------------ | -------- | ----------------------------------------------------------------- |
| `address_id` | Yes      | RouterOS .id (e.g. '*1') or the address value `{"type":"string"}` |

## remove_ip_address

**Remove IPv4 Address** · Risk: **destructive**

Removes an IPv4 interface address from the device (`/ip address remove`). Accepts either a RouterOS `.id` (e.g. '*1', from list_ip_addresses) or the CIDR address value (e.g. '192.168.1.1/24'); performs an existence check before deletion and returns a not-found message if the entry is absent. For IPv6 use remove_ipv6_address. Returns confirmation of successful removal.

| Parameter    | Required | Definition          |
| ------------ | -------- | ------------------- |
| `address_id` | Yes      | `{"type":"string"}` |
