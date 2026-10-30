---
title: "DHCP"
description: "DHCP servers, networks and pools (`/ip dhcp-server`)."
---

## Tools

- [Create DHCP Server Instance](#create_dhcp_server)
- [List DHCP Servers](#list_dhcp_servers)
- [Get DHCP Server Details](#get_dhcp_server)
- [Create DHCP Network (Subnet Parameters)](#create_dhcp_network)
- [Create IP Address Pool](#create_dhcp_pool)
- [Remove DHCP Server Instance](#remove_dhcp_server)

## create_dhcp_server

**Create DHCP Server Instance** · Risk: **write**

Creates an IPv4 DHCP server (`/ip dhcp-server`) bound to a specific interface — assigns a name, address pool, lease time, and authoritative mode to the server process. For the subnet parameters pushed to clients (gateway, DNS, domain, NTP) use `create_dhcp_network`. For the IP address range the server draws from use `create_dhcp_pool`. Returns the created server's full detail including its `.id`.

Notes:
lease_time: duration e.g. "1d", "12h", "30m", "1h30m"
authoritative: "yes" | "no" | "after-2sec-delay"

| Parameter             | Required | Definition                                                                                                       |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`                | Yes      | `{"type":"string"}`                                                                                              |
| `interface`           | Yes      | `{"type":"string"}`                                                                                              |
| `lease_time`          | Yes      | Lease duration e.g. "1d", "12h", "30m", "1h30m" `{"default":"1d","type":"string"}`                               |
| `address_pool`        | No       | `{"type":"string"}`                                                                                              |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                             |
| `authoritative`       | Yes      | `{"default":"yes","type":"string","enum":["yes","no","after-2sec-delay"]}`                                       |
| `delay_threshold`     | No       | `{"type":"string"}`                                                                                              |
| `add_arp`             | No       | Add dynamic ARP entry for each lease (use with reply-only ARP on the interface) `{"type":"boolean"}`             |
| `always_broadcast`    | No       | Always send replies as broadcast `{"type":"boolean"}`                                                            |
| `ipv6_only_preferred` | No       | RouterOS 7.25+ advertise DHCP option 108 for IPv6-only preferred clients `{"type":"boolean"}`                    |
| `bootp_support`       | No       | Which BOOTP requests to answer `{"type":"string","enum":["none","static","dynamic"]}`                            |
| `conflict_detection`  | No       | Ping/ARP-probe an address before offering it to detect conflicts `{"type":"boolean"}`                            |
| `use_radius`          | No       | Use RADIUS for leases (accounting = RADIUS accounting only) `{"type":"string","enum":["yes","no","accounting"]}` |
| `relay`               | No       | DHCP relay address this server services `{"type":"string"}`                                                      |
| `server_address`      | No       | Override the server identifier address sent to clients `{"type":"string"}`                                       |
| `lease_script`        | No       | Script run on lease assign/release `{"type":"string"}`                                                           |
| `comment`             | No       | `{"type":"string"}`                                                                                              |

## list_dhcp_servers

**List DHCP Servers** · Risk: **read**

Lists all IPv4 DHCP server instances (`/ip dhcp-server`) — returns name, interface, address-pool, lease-time, authoritative mode, and enabled/disabled state for each. Optionally filter by name substring (`name_filter`), exact interface (`interface_filter`), disabled-only, or invalid-only. To inspect a single server in full detail use `get_dhcp_server`. To configure the subnet/gateway/DNS parameters pushed to clients use `create_dhcp_network`; to configure the IP address ranges use `create_dhcp_pool`.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `name_filter`      | No       | `{"type":"string"}`                  |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`     | Yes      | `{"default":false,"type":"boolean"}` |

## get_dhcp_server

**Get DHCP Server Details** · Risk: **read**

Fetches full detail for a single IPv4 DHCP server (`/ip dhcp-server print detail`) by name — returns all fields including `.id`, bound interface, address-pool, lease-time, authoritative mode, and status flags. Use `list_dhcp_servers` first to discover server names. To create or update the subnet/gateway/DNS parameters this server advertises use `create_dhcp_network`; to create or update the IP pool range use `create_dhcp_pool`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_dhcp_network

**Create DHCP Network (Subnet Parameters)** · Risk: **write**

Creates an IPv4 DHCP network entry (`/ip dhcp-server network`) that defines the subnet parameters pushed to DHCP clients — including gateway, DNS servers, domain, WINS servers, NTP servers, and DHCP options for a given address prefix. This is the network/scope record, NOT the server process; to create the server process itself use `create_dhcp_server`. To define the IP range the server assigns use `create_dhcp_pool`. dns_servers, wins_servers, and ntp_servers accept arrays of IP address strings; dhcp_option accepts an array of DHCP option names. Returns the created network entry's full detail.

| Parameter         | Required | Definition                                                                                   |
| ----------------- | -------- | -------------------------------------------------------------------------------------------- |
| `network`         | Yes      | `{"type":"string"}`                                                                          |
| `gateway`         | Yes      | `{"type":"string"}`                                                                          |
| `netmask`         | No       | `{"type":"string"}`                                                                          |
| `dns_servers`     | No       | `{"type":"array","items":{"type":"string"}}`                                                 |
| `domain`          | No       | `{"type":"string"}`                                                                          |
| `wins_servers`    | No       | `{"type":"array","items":{"type":"string"}}`                                                 |
| `ntp_servers`     | No       | `{"type":"array","items":{"type":"string"}}`                                                 |
| `dhcp_option`     | No       | `{"type":"array","items":{"type":"string"}}`                                                 |
| `dhcp_option_set` | No       | Named option set (`/ip dhcp-server option sets`) to append `{"type":"string"}`               |
| `dns_none`        | No       | Do not send any DNS server to clients (overrides dns_servers) `{"type":"boolean"}`           |
| `next_server`     | No       | Next-server (siaddr) address for PXE/TFTP boot `{"type":"string"}`                           |
| `boot_file_name`  | No       | Boot file name (option 67) for PXE/TFTP boot `{"type":"string"}`                             |
| `caps_manager`    | No       | CAPsMAN address(es) advertised to CAPs via DHCP `{"type":"array","items":{"type":"string"}}` |
| `comment`         | No       | `{"type":"string"}`                                                                          |

## create_dhcp_pool

**Create IP Address Pool** · Risk: **write**

Creates an IPv4 address pool (`/ip pool`) that defines IP ranges a DHCP server (or PPP) can assign to clients. To create the DHCP server process that uses this pool, call `create_dhcp_server` with `address_pool` set to this pool's name. Optionally chains to `next_pool` when this pool is exhausted. Returns the created pool's full detail including its `.id`.

Notes:
ranges: hyphen-separated range e.g. "192.168.1.1-192.168.1.100"
Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120"

| Parameter   | Required | Definition                                                       |
| ----------- | -------- | ---------------------------------------------------------------- |
| `name`      | Yes      | `{"type":"string"}`                                              |
| `ranges`    | Yes      | IP range(s) e.g. "192.168.1.1-192.168.1.100" `{"type":"string"}` |
| `next_pool` | No       | `{"type":"string"}`                                              |
| `comment`   | No       | `{"type":"string"}`                                              |

## remove_dhcp_server

**Remove DHCP Server Instance** · Risk: **destructive**

Permanently removes an IPv4 DHCP server instance (`/ip dhcp-server remove`) by name — first verifies existence via count-only, then deletes. Does NOT remove the associated network entry (`/ip dhcp-server network`) or address pool (`/ip pool`); those must be removed separately. Stops DHCP service on the bound interface immediately. Use `list_dhcp_servers` to confirm the server name before removing.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
