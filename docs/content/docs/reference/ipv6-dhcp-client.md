---
title: "DHCPv6 Client"
description: "DHCPv6 client: address/prefix delegation requests (`/ipv6 dhcp-client`)."
---

## Tools

- [Add IPv6 DHCP Client](#add_ipv6_dhcp_client)
- [List IPv6 DHCP Clients](#list_ipv6_dhcp_clients)
- [Get IPv6 DHCP Client Details](#get_ipv6_dhcp_client)
- [Release IPv6 DHCP Client Lease](#release_ipv6_dhcp_client)
- [Renew IPv6 DHCP Client Lease](#renew_ipv6_dhcp_client)
- [Remove IPv6 DHCP Client](#remove_ipv6_dhcp_client)

## add_ipv6_dhcp_client

**Add IPv6 DHCP Client** · Risk: **write**

Adds an IPv6 DHCP client (`/ipv6 dhcp-client`) on a named interface so the router can request an IPv6 address and/or delegated prefix from an upstream DHCPv6 server (e.g. an ISP). Use when the router is the DHCP _client_, not the server — for serving IPv6 addresses to downstream hosts use the DHCPv6 server tools. Returns the new client's full detail print including its `.id` (use that `.id` in get_ipv6_dhcp_client, release_ipv6_dhcp_client, renew_ipv6_dhcp_client, or remove_ipv6_dhcp_client).

Notes:
request: what to ask the server for — 'address', 'prefix', or 'address,prefix' (both).
pool_name: when requesting a prefix, the delegated prefix is exposed
as this IPv6 pool (used by '/ipv6 address from-pool').
pool_prefix_length: per-interface prefix length carved from the pool,
e.g. 64.
prefix_hint: hint the desired delegated prefix, e.g. '::/56'.

| Parameter                | Required | Definition                                                                                           |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `interface`              | Yes      | `{"type":"string"}`                                                                                  |
| `request`                | Yes      | `{"default":"prefix","type":"string","enum":["address","prefix","address,prefix"]}`                  |
| `pool_name`              | No       | Name of the IPv6 pool to expose the delegated prefix as `{"type":"string"}`                          |
| `pool_prefix_length`     | No       | Prefix length carved from the delegated pool, e.g. 64 `{"type":"integer","minimum":1,"maximum":128}` |
| `prefix_hint`            | No       | Hint the desired delegated prefix, e.g. '::/56' `{"type":"string"}`                                  |
| `add_default_route`      | No       | `{"type":"string","enum":["yes","no","special-classless"]}`                                          |
| `default_route_distance` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                          |
| `use_peer_dns`           | No       | `{"type":"boolean"}`                                                                                 |
| `rapid_commit`           | No       | `{"type":"boolean"}`                                                                                 |
| `dhcp_options`           | No       | Comma-separated custom DHCP option names `{"type":"string"}`                                         |
| `use_interface_duid`     | No       | Use the interface MAC address to generate the DUID instead of the system DUID `{"type":"boolean"}`   |
| `custom_duid`            | No       | Override the DUID with a custom hex value, e.g. '0x00010001...' `{"type":"string"}`                  |
| `script`                 | No       | RouterOS script run on lease bind/release/renew events `{"type":"string"}`                           |
| `comment`                | No       | `{"type":"string"}`                                                                                  |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                                                 |

## list_ipv6_dhcp_clients

**List IPv6 DHCP Clients** · Risk: **read**

Lists all IPv6 DHCP clients (`/ipv6 dhcp-client`) configured on the router — each entry is an interface on which the router requests an IPv6 address or delegated prefix from an upstream DHCPv6 server. Supports filtering by interface name, status (e.g. 'bound', 'searching', 'stopped'), disabled state, or invalid state. Returns all matching client entries with current status and lease/prefix info.

| Parameter          | Required | Definition                                                             |
| ------------------ | -------- | ---------------------------------------------------------------------- |
| `interface_filter` | No       | `{"type":"string"}`                                                    |
| `status_filter`    | No       | Match status, e.g. 'bound', 'searching', 'stopped' `{"type":"string"}` |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}`                                   |
| `invalid_only`     | Yes      | `{"default":false,"type":"boolean"}`                                   |

## get_ipv6_dhcp_client

**Get IPv6 DHCP Client Details** · Risk: **read**

Fetches full detail for a single IPv6 DHCP client (`/ipv6 dhcp-client print detail`) by its `.id` (e.g. '*1') or interface name — the `.id` is available from list_ipv6_dhcp_clients. Returns the complete detail print including status, lease times, assigned address, and delegated prefix.

| Parameter   | Required | Definition                                                         |
| ----------- | -------- | ------------------------------------------------------------------ |
| `client_id` | Yes      | RouterOS .id (e.g. '*1') or the interface name `{"type":"string"}` |

## release_ipv6_dhcp_client

**Release IPv6 DHCP Client Lease** · Risk: **write-idempotent**

Releases the current IPv6 DHCP address/prefix lease for a client (`/ipv6 dhcp-client release`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. Causes the client to stop using the assigned address or delegated prefix and notify the server. To immediately re-acquire a lease use renew_ipv6_dhcp_client instead.

| Parameter   | Required | Definition          |
| ----------- | -------- | ------------------- |
| `client_id` | Yes      | `{"type":"string"}` |

## renew_ipv6_dhcp_client

**Renew IPv6 DHCP Client Lease** · Risk: **write-idempotent**

Renews the IPv6 DHCP address/prefix lease for a client (`/ipv6 dhcp-client renew`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. Sends a DHCPv6 RENEW message to refresh the assignment without releasing it first. To give up the lease first use release_ipv6_dhcp_client.

| Parameter   | Required | Definition          |
| ----------- | -------- | ------------------- |
| `client_id` | Yes      | `{"type":"string"}` |

## remove_ipv6_dhcp_client

**Remove IPv6 DHCP Client** · Risk: **destructive**

Permanently deletes an IPv6 DHCP client entry (`/ipv6 dhcp-client remove`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. After removal the router will no longer request IPv6 address or prefix on that interface. Confirms existence before attempting removal and returns an error if the client is not found.

| Parameter   | Required | Definition          |
| ----------- | -------- | ------------------- |
| `client_id` | Yes      | `{"type":"string"}` |
