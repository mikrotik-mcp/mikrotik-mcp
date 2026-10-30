---
title: "DHCPv6 Relay"
description: "DHCPv6 relay: forward client requests to upstream servers (`/ipv6 dhcp-relay`)."
---

## Tools

- [Add IPv6 DHCP Relay](#add_ipv6_dhcp_relay)
- [List IPv6 DHCP Relays](#list_ipv6_dhcp_relays)
- [Get IPv6 DHCP Relay Details](#get_ipv6_dhcp_relay)
- [Enable IPv6 DHCP Relay](#enable_ipv6_dhcp_relay)
- [Disable IPv6 DHCP Relay](#disable_ipv6_dhcp_relay)
- [Remove IPv6 DHCP Relay](#remove_ipv6_dhcp_relay)

## add_ipv6_dhcp_relay

**Add IPv6 DHCP Relay** · Risk: **write**

Creates an IPv6 DHCP relay agent (`/ipv6 dhcp-relay`) that forwards DHCPv6 client requests from a local interface to one or more upstream DHCPv6 servers. Use when clients on a subnet cannot reach the DHCPv6 server directly and need relay forwarding. For serving DHCPv6 addresses directly (no relay) use create_ipv6_dhcp_server. Returns the created relay's full detail on success.

Args:
dhcp_server: comma-separated IPv6 address(es) of upstream DHCPv6 servers.
interface: the interface facing the DHCPv6 clients.

| Parameter     | Required | Definition                                                                  |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `name`        | Yes      | `{"type":"string"}`                                                         |
| `interface`   | Yes      | Interface facing the DHCPv6 clients `{"type":"string"}`                     |
| `dhcp_server` | Yes      | Comma-separated upstream DHCPv6 server IPv6 address(es) `{"type":"string"}` |
| `delay_time`  | No       | `{"type":"string"}`                                                         |
| `comment`     | No       | `{"type":"string"}`                                                         |
| `disabled`    | Yes      | `{"default":false,"type":"boolean"}`                                        |

## list_ipv6_dhcp_relays

**List IPv6 DHCP Relays** · Risk: **read**

Lists IPv6 DHCP relay agents (`/ipv6 dhcp-relay`) configured on the device. Use to enumerate all DHCPv6 relay forwarders or to find a relay's `name` for use with get_ipv6_dhcp_relay, enable_ipv6_dhcp_relay, disable_ipv6_dhcp_relay, or remove_ipv6_dhcp_relay. Supports optional filtering by name substring, interface, or disabled state. Returns all matching relay entries.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `name_filter`      | No       | `{"type":"string"}`                  |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_dhcp_relay

**Get IPv6 DHCP Relay Details** · Risk: **read**

Retrieves full detail for a single IPv6 DHCP relay agent (`/ipv6 dhcp-relay print detail`) by name. Use to inspect a specific relay's configuration including its upstream servers and client-facing interface. For a summary listing of all relays use list_ipv6_dhcp_relays. Returns all fields for the named relay, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_ipv6_dhcp_relay

**Enable IPv6 DHCP Relay** · Risk: **write-idempotent**

Enables a disabled IPv6 DHCP relay agent (`/ipv6 dhcp-relay enable`) by name. Use to re-activate relay forwarding that was previously stopped without deleting the entry. For the inverse operation use disable_ipv6_dhcp_relay; to create a new relay use add_ipv6_dhcp_relay. The `name` must match an entry returned by list_ipv6_dhcp_relays.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_ipv6_dhcp_relay

**Disable IPv6 DHCP Relay** · Risk: **write-idempotent**

Disables an active IPv6 DHCP relay agent (`/ipv6 dhcp-relay disable`) by name without removing it. Use to temporarily stop DHCPv6 request forwarding on a relay. For the inverse operation use enable_ipv6_dhcp_relay; to permanently delete the relay use remove_ipv6_dhcp_relay. The `name` must match an entry returned by list_ipv6_dhcp_relays.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_ipv6_dhcp_relay

**Remove IPv6 DHCP Relay** · Risk: **destructive**

Permanently deletes an IPv6 DHCP relay agent (`/ipv6 dhcp-relay remove`) by name. First confirms existence with a count-only check before removing. Use to permanently tear down relay forwarding for a subnet; to disable temporarily without deleting use disable_ipv6_dhcp_relay. The `name` must match an entry returned by list_ipv6_dhcp_relays.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
