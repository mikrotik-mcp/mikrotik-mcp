---
title: "IGMP Proxy"
description: "IGMP proxy settings, interfaces and forwarding cache (`/routing igmp-proxy`)."
---

## Tools

- [Get IGMP Proxy Global Settings](#get_igmp_proxy_settings)
- [Update IGMP Proxy Global Settings](#update_igmp_proxy_settings)
- [List IGMP Proxy Interfaces](#list_igmp_proxy_interfaces)
- [Add IGMP Proxy Interface](#add_igmp_proxy_interface)
- [Update IGMP Proxy Interface](#update_igmp_proxy_interface)
- [Remove IGMP Proxy Interface](#remove_igmp_proxy_interface)
- [Enable or Disable IGMP Proxy Interface](#set_igmp_proxy_interface_enabled)
- [List IGMP Proxy Multicast Forwarding Cache](#list_igmp_proxy_mfc)

## get_igmp_proxy_settings

**Get IGMP Proxy Global Settings** · Risk: **read**

Read global IGMP proxy settings (`/routing igmp-proxy print`). IGMP proxy forwards IPv4 multicast between a single upstream interface and one or more downstream interfaces without a full multicast routing daemon — ideal for IPTV distribution. For interface membership configuration use `list_igmp_proxy_interfaces`; for live forwarding state use `list_igmp_proxy_mfc`. Returns the current `quick-leave`, `query-interval`, and `query-response-interval` values.

No tool-specific parameters.

## update_igmp_proxy_settings

**Update IGMP Proxy Global Settings** · Risk: **write-idempotent**

Update global IGMP proxy settings (`/routing igmp-proxy set`). Tunes IPv4 multicast membership refresh timing and fast-leave behaviour for the proxy daemon. For interface-level changes use `update_igmp_proxy_interface`. `quick_leave` prunes a multicast group immediately on member leave — recommended for IPTV channel zapping; `query_interval` e.g. "125s"; `query_response_interval` e.g. "10s". Returns updated settings on success.

| Parameter                 | Required | Definition                      |
| ------------------------- | -------- | ------------------------------- |
| `quick_leave`             | No       | `{"type":"boolean"}`            |
| `query_interval`          | No       | e.g. "125s" `{"type":"string"}` |
| `query_response_interval` | No       | e.g. "10s" `{"type":"string"}`  |

## list_igmp_proxy_interfaces

**List IGMP Proxy Interfaces** · Risk: **read**

List all IGMP proxy interface entries (`/routing igmp-proxy interface print detail`). Shows each interface's role (upstream vs downstream), alternative subnets, TTL threshold, and enabled state. Exactly one interface must be `upstream` (toward the IPv4 multicast source); all others are downstream toward receivers. For live forwarding state use `list_igmp_proxy_mfc`; to add an entry use `add_igmp_proxy_interface`. Returns all configured IGMP proxy interfaces with their properties.

No tool-specific parameters.

## add_igmp_proxy_interface

**Add IGMP Proxy Interface** · Risk: **write**

Add an interface to the IGMP proxy configuration (`/routing igmp-proxy interface add`). Registers a network interface as either upstream (`upstream=true`, toward the IPv4 multicast source) or downstream (toward receivers). Only one upstream interface is permitted per proxy instance. `alternative_subnets` whitelists extra source subnets reachable through this interface (e.g. "10.0.0.0/8"); `threshold` sets the minimum TTL required to forward. For updating an existing entry use `update_igmp_proxy_interface`; to view current entries use `list_igmp_proxy_interfaces`.

| Parameter             | Required | Definition                                                                                         |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `interface`           | Yes      | Interface name `{"type":"string"}`                                                                 |
| `upstream`            | Yes      | true = upstream (toward source), false = downstream `{"default":false,"type":"boolean"}`           |
| `alternative_subnets` | No       | Comma list of source subnets, e.g. "10.0.0.0/8" `{"type":"string"}`                                |
| `threshold`           | No       | Minimum TTL to forward `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`             | No       | `{"type":"string"}`                                                                                |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                               |

## update_igmp_proxy_interface

**Update IGMP Proxy Interface** · Risk: **write-idempotent**

Update an existing IGMP proxy interface entry by name (`/routing igmp-proxy interface set [find interface=...]`). Modifies the upstream/downstream role, alternative subnets, TTL threshold, comment, or disabled state of the named interface. For adding a new interface use `add_igmp_proxy_interface`; to toggle only the enabled state use `set_igmp_proxy_interface_enabled`. Returns updated interface detail on success.

| Parameter             | Required | Definition                                                                  |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `interface`           | Yes      | Existing IGMP-proxy interface name `{"type":"string"}`                      |
| `upstream`            | No       | `{"type":"boolean"}`                                                        |
| `alternative_subnets` | No       | `{"type":"string"}`                                                         |
| `threshold`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`             | No       | `{"type":"string"}`                                                         |
| `disabled`            | No       | `{"type":"boolean"}`                                                        |

## remove_igmp_proxy_interface

**Remove IGMP Proxy Interface** · Risk: **destructive**

Remove an IGMP proxy interface entry by name (`/routing igmp-proxy interface remove [find interface=...]`). Permanently deletes the interface from the proxy configuration; multicast groups that relied on it will stop being forwarded. For disabling without removal use `set_igmp_proxy_interface_enabled`. Provide the interface name as it appears in `list_igmp_proxy_interfaces`.

| Parameter   | Required | Definition                                              |
| ----------- | -------- | ------------------------------------------------------- |
| `interface` | Yes      | IGMP-proxy interface name to remove `{"type":"string"}` |

## set_igmp_proxy_interface_enabled

**Enable or Disable IGMP Proxy Interface** · Risk: **write-idempotent**

Enable or disable a single IGMP proxy interface by name (`/routing igmp-proxy interface set [find interface=...] disabled=yes/no`). Pauses multicast forwarding through the interface without removing its configuration. For full property changes use `update_igmp_proxy_interface`; to permanently remove the entry use `remove_igmp_proxy_interface`. Provide the interface name as it appears in `list_igmp_proxy_interfaces`.

| Parameter   | Required | Definition                                    |
| ----------- | -------- | --------------------------------------------- |
| `interface` | Yes      | IGMP-proxy interface name `{"type":"string"}` |
| `enabled`   | Yes      | `{"type":"boolean"}`                          |

## list_igmp_proxy_mfc

**List IGMP Proxy Multicast Forwarding Cache** · Risk: **read**

List the live multicast forwarding cache (MFC) entries (`/routing igmp-proxy mfc print detail`). Shows each active IPv4 (source, group) pair and the downstream interfaces each is currently being forwarded to — runtime state populated by IGMP join messages, not user-configured entries. Read-only; entries cannot be created or removed via this tool. For interface configuration see `list_igmp_proxy_interfaces`; for global settings see `get_igmp_proxy_settings`.

No tool-specific parameters.
