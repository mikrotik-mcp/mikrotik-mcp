---
title: "DHCP Client"
description: "IPv4 DHCP client - obtain address/gateway/DNS on an interface (`/ip dhcp-client`)."
---

## Tools

- [List DHCP Clients](#list_dhcp_clients)
- [Get DHCP Client Detail](#get_dhcp_client)
- [Add DHCP Client](#add_dhcp_client)
- [Update DHCP Client](#set_dhcp_client)
- [Renew / Release DHCP Lease](#renew_dhcp_client)
- [Remove DHCP Client](#remove_dhcp_client)

## list_dhcp_clients

**List DHCP Clients** · Risk: **read**

Lists IPv4 DHCP clients (`/ip dhcp-client print`) — each interface configured to obtain its address/gateway/DNS from an upstream DHCP server (typically a WAN port). Shows the bound address, status, and whether a default route / peer DNS is used. Optional `interface_filter`. For one client's detail use get_dhcp_client; to add one use add_dhcp_client.

| Parameter          | Required | Definition                                       |
| ------------------ | -------- | ------------------------------------------------ |
| `interface_filter` | No       | Substring match on interface `{"type":"string"}` |

## get_dhcp_client

**Get DHCP Client Detail** · Risk: **read**

Full detail for the DHCP client on an interface (`/ip dhcp-client print detail where interface=...`) — bound address, gateway, lease time, status, and options. Use list_dhcp_clients to find interfaces. Returns the detail block or a not-found message.

| Parameter   | Required | Definition                                        |
| ----------- | -------- | ------------------------------------------------- |
| `interface` | Yes      | Interface name, e.g. 'ether1' `{"type":"string"}` |

## add_dhcp_client

**Add DHCP Client** · Risk: **write**

Adds an IPv4 DHCP client on an interface (`/ip dhcp-client add`) so it obtains an address from an upstream DHCP server — the usual way to configure a WAN port. `add_default_route` installs the received gateway; `use_peer_dns`/`use_peer_ntp` adopt the server's DNS/NTP. Returns the created client's detail.

| Parameter                | Required | Definition                                                                                                                         |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `interface`              | Yes      | Interface to run the DHCP client on, e.g. 'ether1' `{"type":"string"}`                                                             |
| `add_default_route`      | Yes      | Install the received default gateway `{"default":true,"type":"boolean"}`                                                           |
| `default_route_distance` | No       | Administrative distance of the installed default route `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_peer_dns`           | Yes      | `{"default":true,"type":"boolean"}`                                                                                                |
| `use_peer_ntp`           | Yes      | `{"default":true,"type":"boolean"}`                                                                                                |
| `dhcp_options`           | No       | Comma-separated DHCP options to send, e.g. 'hostname,clientid' `{"type":"string"}`                                                 |
| `client_id`              | No       | Override the DHCP client identifier sent to the server `{"type":"string"}`                                                         |
| `host_name`              | No       | Host name sent to the DHCP server `{"type":"string"}`                                                                              |
| `script`                 | No       | Script run on lease bound/released `{"type":"string"}`                                                                             |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                                                                               |
| `comment`                | No       | `{"type":"string"}`                                                                                                                |

## set_dhcp_client

**Update DHCP Client** · Risk: **write-idempotent**

Updates the DHCP client on an interface (`/ip dhcp-client set [find interface=...]`) — toggle `add_default_route`, `use_peer_dns`, `use_peer_ntp`, or `disabled`. No-ops if nothing is supplied. Returns the updated detail.

| Parameter                | Required | Definition                                                                                                                         |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `interface`              | Yes      | `{"type":"string"}`                                                                                                                |
| `add_default_route`      | No       | `{"type":"boolean"}`                                                                                                               |
| `default_route_distance` | No       | Administrative distance of the installed default route `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_peer_dns`           | No       | `{"type":"boolean"}`                                                                                                               |
| `use_peer_ntp`           | No       | `{"type":"boolean"}`                                                                                                               |
| `dhcp_options`           | No       | Comma-separated DHCP options to send, e.g. 'hostname,clientid' `{"type":"string"}`                                                 |
| `client_id`              | No       | Override the DHCP client identifier sent to the server `{"type":"string"}`                                                         |
| `host_name`              | No       | Host name sent to the DHCP server `{"type":"string"}`                                                                              |
| `script`                 | No       | Script run on lease bound/released `{"type":"string"}`                                                                             |
| `disabled`               | No       | `{"type":"boolean"}`                                                                                                               |

## renew_dhcp_client

**Renew / Release DHCP Lease** · Risk: **write**

Renews or releases the DHCP lease on an interface (`/ip dhcp-client renew|release`). `release=true` drops the current lease; otherwise it renews — use to re-pull WAN settings after an upstream change. Returns the client status afterward.

| Parameter   | Required | Definition                                                                   |
| ----------- | -------- | ---------------------------------------------------------------------------- |
| `interface` | Yes      | `{"type":"string"}`                                                          |
| `release`   | Yes      | true = release the lease; false = renew `{"default":false,"type":"boolean"}` |

## remove_dhcp_client

**Remove DHCP Client** · Risk: **destructive**

Removes the DHCP client from an interface (`/ip dhcp-client remove [find interface=...]`) — the interface stops obtaining an address from DHCP (set a static address separately if needed). Confirms removal or reports not-found.

| Parameter   | Required | Definition          |
| ----------- | -------- | ------------------- |
| `interface` | Yes      | `{"type":"string"}` |
