---
title: "DHCPv6 Server"
description: "DHCPv6 server, static bindings and custom options (`/ipv6 dhcp-server`)."
---

## Tools

- [Create IPv6 DHCP Server](#create_ipv6_dhcp_server)
- [List IPv6 DHCP Servers](#list_ipv6_dhcp_servers)
- [Get IPv6 DHCP Server Details](#get_ipv6_dhcp_server)
- [Remove IPv6 DHCP Server](#remove_ipv6_dhcp_server)
- [Add IPv6 DHCP Server Binding](#add_ipv6_dhcp_binding)
- [List IPv6 DHCP Server Bindings](#list_ipv6_dhcp_bindings)
- [Remove IPv6 DHCP Server Binding](#remove_ipv6_dhcp_binding)
- [Add IPv6 DHCP Server Option](#add_ipv6_dhcp_option)
- [List IPv6 DHCP Server Options](#list_ipv6_dhcp_options)
- [Remove IPv6 DHCP Server Option](#remove_ipv6_dhcp_option)

## create_ipv6_dhcp_server

**Create IPv6 DHCP Server** · Risk: **write**

Creates an IPv6 DHCPv6 server instance (`/ipv6 dhcp-server`) bound to a network interface, delegating prefixes or addresses from a named IPv6 pool. Use this to provision stateful DHCPv6 service on an interface. For IPv4 DHCP use create_dhcp_server; for pinning a prefix to a known client by DUID use add_ipv6_dhcp_binding. Returns the created server's full detail including its `.id`.

Argument notes:
address_pool: IPv6 pool name the server delegates prefixes/addresses from.
lease_time: RouterOS duration string e.g. '1d', '12h', '30m'.
rapid_commit: enable 2-message (Solicit/Reply) exchange.
preference: server preference (0-255) used in multi-server deployments.
dhcp_option: list of custom DHCPv6 option names defined via add_ipv6_dhcp_option.

| Parameter                | Required | Definition                                                                   |
| ------------------------ | -------- | ---------------------------------------------------------------------------- |
| `name`                   | Yes      | `{"type":"string"}`                                                          |
| `interface`              | Yes      | `{"type":"string"}`                                                          |
| `address_pool`           | Yes      | IPv6 pool name the server delegates from `{"type":"string"}`                 |
| `lease_time`             | Yes      | Lease duration e.g. '1d', '12h', '30m' `{"default":"3d","type":"string"}`    |
| `binding_script`         | No       | `{"type":"string"}`                                                          |
| `rapid_commit`           | No       | `{"type":"boolean"}`                                                         |
| `add_dns_entries`        | No       | RouterOS 7.25+ create AAAA DNS entries for client FQDNs `{"type":"boolean"}` |
| `add_dns_entries_suffix` | No       | Suffix for dynamically created DHCPv6 DNS entries `{"type":"string"}`        |
| `preference`             | No       | `{"type":"integer","minimum":0,"maximum":255}`                               |
| `route_distance`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`  |
| `use_radius`             | No       | Authenticate clients via RADIUS `{"type":"boolean"}`                         |
| `allow_dual_stack_queue` | No       | Share a simple queue with the client's IPv4 DHCP lease `{"type":"boolean"}`  |
| `parent_queue`           | No       | Parent queue for dynamically created simple queues `{"type":"string"}`       |
| `dhcp_option`            | No       | Custom DHCPv6 option names `{"type":"array","items":{"type":"string"}}`      |
| `comment`                | No       | `{"type":"string"}`                                                          |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                         |

## list_ipv6_dhcp_servers

**List IPv6 DHCP Servers** · Risk: **read**

Lists all IPv6 DHCPv6 server instances (`/ipv6 dhcp-server`) configured on the device. Use to discover which interfaces have DHCPv6 service, their associated pools, and enabled/invalid status. For full detail on a single server use get_ipv6_dhcp_server; for client prefix assignments use list_ipv6_dhcp_bindings. Returns all matching server entries; filterable by name, interface, disabled-only, or invalid-only.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `name_filter`      | No       | `{"type":"string"}`                  |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`     | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_dhcp_server

**Get IPv6 DHCP Server Details** · Risk: **read**

Retrieves full configuration detail for a single named IPv6 DHCPv6 server (`/ipv6 dhcp-server print detail`). Use when you need the complete configuration of one server rather than a summary listing. For all servers use list_ipv6_dhcp_servers; for client prefix assignments on this server use list_ipv6_dhcp_bindings. Returns the server's detailed configuration or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_ipv6_dhcp_server

**Remove IPv6 DHCP Server** · Risk: **destructive**

Permanently deletes a named IPv6 DHCPv6 server instance (`/ipv6 dhcp-server remove`) after confirming it exists. Removing the server stops DHCPv6 service on the bound interface but does not automatically remove its bindings or option definitions. For removing static/dynamic prefix assignments use remove_ipv6_dhcp_binding; for removing option definitions use remove_ipv6_dhcp_option. Returns a success or not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_ipv6_dhcp_binding

**Add IPv6 DHCP Server Binding** · Risk: **write**

Creates a static IPv6 DHCPv6 server binding (`/ipv6 dhcp-server binding add`) that pins a delegated prefix or specific IPv6 address to a client identified by its DUID. Use to ensure a known client always receives the same prefix/address assignment. The binding references a server created by create_ipv6_dhcp_server; for viewing all bindings use list_ipv6_dhcp_bindings. Returns the created binding's detail or a completion notice.

Argument notes:
duid: client DHCP Unique Identifier (required) — the binding matches on this.
prefix: delegated prefix e.g. '2001:db8:1::/64'.
address: specific IPv6 address to assign (alternative or complement to prefix).
iaid: Identity Association ID.
server: target DHCPv6 server name, or 'all' to match any server.
life_time: RouterOS duration string e.g. '1d', '12h'.

| Parameter   | Required | Definition                                                   |
| ----------- | -------- | ------------------------------------------------------------ |
| `address`   | No       | Assigned IPv6 address, if any `{"type":"string"}`            |
| `prefix`    | No       | Delegated prefix, e.g. '2001:db8:1::/64' `{"type":"string"}` |
| `duid`      | Yes      | Client DUID the binding matches `{"type":"string"}`          |
| `iaid`      | No       | Identity Association ID `{"type":"string"}`                  |
| `server`    | No       | DHCPv6 server name, or 'all' `{"type":"string"}`             |
| `life_time` | No       | `{"type":"string"}`                                          |
| `comment`   | No       | `{"type":"string"}`                                          |
| `disabled`  | Yes      | `{"default":false,"type":"boolean"}`                         |

## list_ipv6_dhcp_bindings

**List IPv6 DHCP Server Bindings** · Risk: **read**

Lists IPv6 DHCPv6 server bindings (`/ipv6 dhcp-server binding`) — both static (manually created via add_ipv6_dhcp_binding) and dynamic (auto-leased) client prefix/address assignments. Use to audit which clients have received delegated prefixes and inspect DUID-to-prefix mappings. For server configuration detail use get_ipv6_dhcp_server; to delete a binding use remove_ipv6_dhcp_binding. Returns all matching bindings; filterable by server name, DUID substring, or dynamic-only.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `server_filter` | No       | `{"type":"string"}`                  |
| `duid_filter`   | No       | `{"type":"string"}`                  |
| `dynamic_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## remove_ipv6_dhcp_binding

**Remove IPv6 DHCP Server Binding** · Risk: **destructive**

Permanently deletes an IPv6 DHCPv6 server binding (`/ipv6 dhcp-server binding remove`) identified by its RouterOS `.id` or by its client DUID. Use to revoke a static prefix assignment or clear a stale dynamic lease. The `.id` comes from list_ipv6_dhcp_bindings; supply either `.id` (e.g. '*1') or a DUID string — the tool tries `.id` first then falls back to DUID. To remove the server itself use remove_ipv6_dhcp_server. Returns a success or not-found message.

| Parameter    | Required | Definition                                               |
| ------------ | -------- | -------------------------------------------------------- |
| `binding_id` | Yes      | RouterOS .id (e.g. '*1') or the DUID `{"type":"string"}` |

## add_ipv6_dhcp_option

**Add IPv6 DHCP Server Option** · Risk: **write**

Defines a named custom IPv6 DHCPv6 option (`/ipv6 dhcp-server option add`) by numeric option code and value. Use to configure vendor-specific or non-standard DHCPv6 options that can then be referenced by name in create_ipv6_dhcp_server via the `dhcp_option` field. For viewing existing options use list_ipv6_dhcp_options; to delete one use remove_ipv6_dhcp_option. Returns the created option's detail or a completion notice.

Argument notes:
code: numeric DHCPv6 option code (e.g. 23 for DNS recursive name server).
value: option value; use '0x...' prefix for raw hex encoding.

| Parameter | Required | Definition                                                                                             |
| --------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`    | Yes      | `{"type":"string"}`                                                                                    |
| `code`    | Yes      | Numeric DHCPv6 option code `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `value`   | Yes      | Option value (use '0x...' for raw hex) `{"type":"string"}`                                             |
| `comment` | No       | `{"type":"string"}`                                                                                    |

## list_ipv6_dhcp_options

**List IPv6 DHCP Server Options** · Risk: **read**

Lists all named custom IPv6 DHCPv6 option definitions (`/ipv6 dhcp-server option`) on the device. Use to audit available option codes and values before referencing them in DHCPv6 server configurations via the `dhcp_option` field of create_ipv6_dhcp_server. To add a new option use add_ipv6_dhcp_option; to delete one use remove_ipv6_dhcp_option. Returns all matching option definitions; filterable by name substring.

| Parameter     | Required | Definition          |
| ------------- | -------- | ------------------- |
| `name_filter` | No       | `{"type":"string"}` |

## remove_ipv6_dhcp_option

**Remove IPv6 DHCP Server Option** · Risk: **destructive**

Permanently deletes a named custom IPv6 DHCPv6 option definition (`/ipv6 dhcp-server option remove`) after confirming it exists. Note: removing an option that is still referenced by an active server's `dhcp_option` list will affect that server's advertised options. For listing existing options use list_ipv6_dhcp_options; to add options use add_ipv6_dhcp_option. Returns a success or not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
