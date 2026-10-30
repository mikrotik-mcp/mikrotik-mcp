---
title: "BGP"
description: "BGP connections, templates, sessions and advertisements (`/routing bgp`)."
---

## Tools

- [List BGP Instances](#list_bgp_instances)
- [Set BGP Instance MED Comparison](#update_bgp_instance_med_comparison)
- [List BGP Connections](#list_bgp_connections)
- [Get BGP Connection Details](#get_bgp_connection)
- [Add BGP Connection](#add_bgp_connection)
- [Update BGP Connection](#update_bgp_connection)
- [Remove BGP Connection](#remove_bgp_connection)
- [Enable or Disable BGP Connection](#set_bgp_connection_enabled)
- [List BGP Templates](#list_bgp_templates)
- [Add BGP Template](#add_bgp_template)
- [Remove BGP Template](#remove_bgp_template)
- [List BGP Sessions](#list_bgp_sessions)
- [List BGP Advertisements](#list_bgp_advertisements)

## list_bgp_instances

**List BGP Instances** · Risk: **read**

Read BGP instances and their best-path selection settings, including RouterOS 7.25+ always-compare-med. Use before changing an instance.

No tool-specific parameters.

## update_bgp_instance_med_comparison

**Set BGP Instance MED Comparison** · Risk: **write-idempotent**

Set RouterOS 7.25+ always-compare-med on one named BGP instance. This changes best-path selection and can reroute traffic; inspect list_bgp_instances and obtain operator approval first.

| Parameter                | Required | Definition                                                                        |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| `name`                   | Yes      | Exact BGP instance name `{"type":"string","minLength":1}`                         |
| `always_compare_med`     | Yes      | `{"type":"boolean"}`                                                              |
| `confirm_routing_change` | Yes      | Operator approved the best-path behavior change `{"type":"boolean","const":true}` |

## list_bgp_connections

**List BGP Connections** · Risk: **read**

Lists configured BGP peer connections (`/routing bgp connection`) — the static configuration of each peer or listener, including local/remote AS, addresses, and role. For runtime peering state (established/idle, uptime, prefix counts) use `list_bgp_sessions`. For shared configuration objects inherited by connections use `list_bgp_templates`. Optionally filters by connection name substring. Returns all matching connection entries. Requires RouterOS v7 with the routing package.

| Parameter     | Required | Definition                                             |
| ------------- | -------- | ------------------------------------------------------ |
| `name_filter` | No       | Substring match on connection name `{"type":"string"}` |

## get_bgp_connection

**Get BGP Connection Details** · Risk: **read**

Fetches full configuration detail for a single BGP connection by name (`/routing bgp connection print detail where name="<name>"`). Use this to inspect one peer's full settings; to browse all connections use `list_bgp_connections`. For runtime session status (established, uptime, prefix counts) use `list_bgp_sessions`. Returns the complete connection record or a not-found message.

| Parameter | Required | Definition                              |
| --------- | -------- | --------------------------------------- |
| `name`    | Yes      | BGP connection name `{"type":"string"}` |

## add_bgp_connection

**Add BGP Connection** · Risk: **write**

Creates a BGP peer connection (`/routing bgp connection add`) — the per-peer configuration that initiates or accepts a BGP session. At minimum supply `name`, `remote_address`, and `as`/`local_role` for the local side. `local_role` values: `ebgp`, `ibgp`, `ebgp-customer`, `ebgp-provider`, `ibgp-rr`, `ibgp-rr-client`. For `address_families` pass a comma-separated list, e.g. `"ip"` or `"ip,ipv6,l2vpn"`. For `hold_time`/`keepalive_time` use RouterOS duration strings, e.g. `"3m"` or `"180s"`. `input_filter`/`output_filter` reference `/routing filter` chain names. Common settings (AS, filters, timers) can be factored into a template referenced via `templates`; to create templates use `add_bgp_template`. To modify an existing connection use `update_bgp_connection`. Returns the created connection's full detail. Requires RouterOS v7 with the routing package.

| Parameter                               | Required | Definition                                                                                                                                |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                  | Yes      | Unique connection name `{"type":"string"}`                                                                                                |
| `remote_address`                        | Yes      | Peer IP address (remote.address) `{"type":"string"}`                                                                                      |
| `remote_as`                             | No       | Peer AS number (remote.as) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                    |
| `remote_port`                           | No       | Peer TCP port (remote.port) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                   |
| `as`                                    | No       | Local AS number `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                               |
| `local_role`                            | No       | local.role: ebgp, ibgp, ebgp-customer, ebgp-provider, ibgp-rr, ibgp-rr-client, … `{"type":"string"}`                                      |
| `local_address`                         | No       | Local source address (local.address) `{"type":"string"}`                                                                                  |
| `local_port`                            | No       | Local TCP port (local.port) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                   |
| `router_id`                             | No       | Override router-id for this connection `{"type":"string"}`                                                                                |
| `cluster_id`                            | No       | Route-reflector cluster ID (cluster-id) `{"type":"string"}`                                                                               |
| `templates`                             | No       | Template name(s) to inherit settings from `{"type":"string"}`                                                                             |
| `address_families`                      | No       | Comma list, e.g. "ip" or "ip,ipv6,l2vpn" `{"type":"string"}`                                                                              |
| `hold_time`                             | No       | e.g. "3m" or "180s" `{"type":"string"}`                                                                                                   |
| `keepalive_time`                        | No       | `{"type":"string"}`                                                                                                                       |
| `multihop`                              | No       | Allow non-directly-connected peers `{"type":"boolean"}`                                                                                   |
| `nexthop_choice`                        | No       | default, force-self, or propagate `{"type":"string"}`                                                                                     |
| `use_bfd`                               | No       | Use BFD for fast failure detection (use-bfd) `{"type":"boolean"}`                                                                         |
| `tcp_md5_key`                           | No       | TCP MD5 authentication key (tcp-md5-key) `{"type":"string"}`                                                                              |
| `connect`                               | No       | Actively initiate the TCP session (connect) `{"type":"boolean"}`                                                                          |
| `listen`                                | No       | Accept incoming TCP session (listen) `{"type":"boolean"}`                                                                                 |
| `input_filter`                          | No       | Routing filter chain for inbound routes (input.filter) `{"type":"string"}`                                                                |
| `input_accept_nlri`                     | No       | Address list of accepted NLRI prefixes (input.accept-nlri) `{"type":"string"}`                                                            |
| `input_allow_as`                        | No       | Number of times own AS may appear in AS-path (input.allow-as) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `input_ignore_as_path_len`              | No       | Ignore AS-path length in best-path selection (input.ignore-as-path-len) `{"type":"boolean"}`                                              |
| `output_filter`                         | No       | Routing filter chain for outbound routes (output.filter) `{"type":"string"}`                                                              |
| `output_network`                        | No       | Address list of networks to originate/advertise (output.network) `{"type":"string"}`                                                      |
| `output_default_originate`              | No       | Advertise a default route: never, if-installed, or always (output.default-originate) `{"type":"string"}`                                  |
| `output_redistribute`                   | No       | Comma list of route sources to redistribute, e.g. connected,static (output.redistribute) `{"type":"string"}`                              |
| `output_as_override`                    | No       | Replace peer AS in AS-path with local AS (output.as-override) `{"type":"boolean"}`                                                        |
| `output_keep_sent_attributes`           | No       | Retain sent path attributes for inspection (output.keep-sent-attributes) `{"type":"boolean"}`                                             |
| `output_no_client_to_client_reflection` | No       | Disable route-reflector client-to-client reflection (output.no-client-to-client-reflection) `{"type":"boolean"}`                          |
| `routing_table`                         | No       | RIB to install learned routes into `{"type":"string"}`                                                                                    |
| `vrf`                                   | No       | `{"type":"string"}`                                                                                                                       |
| `comment`                               | No       | `{"type":"string"}`                                                                                                                       |
| `disabled`                              | Yes      | `{"default":false,"type":"boolean"}`                                                                                                      |

## update_bgp_connection

**Update BGP Connection** · Risk: **write-idempotent**

Modifies settings of an existing BGP connection by name (`/routing bgp connection set [find name="<name>"]`). Only supplied fields are changed; omitted fields are left unchanged. To enable or disable a connection without touching other settings use `set_bgp_connection_enabled`. To delete a connection use `remove_bgp_connection`. Returns the full updated connection detail on success.

| Parameter                               | Required | Definition                                                                  |
| --------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `name`                                  | Yes      | Existing BGP connection name `{"type":"string"}`                            |
| `remote_address`                        | No       | `{"type":"string"}`                                                         |
| `remote_as`                             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `remote_port`                           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `as`                                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `local_role`                            | No       | `{"type":"string"}`                                                         |
| `local_address`                         | No       | `{"type":"string"}`                                                         |
| `local_port`                            | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `router_id`                             | No       | `{"type":"string"}`                                                         |
| `cluster_id`                            | No       | `{"type":"string"}`                                                         |
| `address_families`                      | No       | `{"type":"string"}`                                                         |
| `hold_time`                             | No       | `{"type":"string"}`                                                         |
| `keepalive_time`                        | No       | `{"type":"string"}`                                                         |
| `multihop`                              | No       | `{"type":"boolean"}`                                                        |
| `nexthop_choice`                        | No       | `{"type":"string"}`                                                         |
| `use_bfd`                               | No       | `{"type":"boolean"}`                                                        |
| `tcp_md5_key`                           | No       | `{"type":"string"}`                                                         |
| `connect`                               | No       | `{"type":"boolean"}`                                                        |
| `listen`                                | No       | `{"type":"boolean"}`                                                        |
| `input_filter`                          | No       | `{"type":"string"}`                                                         |
| `input_accept_nlri`                     | No       | `{"type":"string"}`                                                         |
| `input_allow_as`                        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `input_ignore_as_path_len`              | No       | `{"type":"boolean"}`                                                        |
| `output_filter`                         | No       | `{"type":"string"}`                                                         |
| `output_network`                        | No       | `{"type":"string"}`                                                         |
| `output_default_originate`              | No       | `{"type":"string"}`                                                         |
| `output_redistribute`                   | No       | `{"type":"string"}`                                                         |
| `output_as_override`                    | No       | `{"type":"boolean"}`                                                        |
| `output_keep_sent_attributes`           | No       | `{"type":"boolean"}`                                                        |
| `output_no_client_to_client_reflection` | No       | `{"type":"boolean"}`                                                        |
| `routing_table`                         | No       | `{"type":"string"}`                                                         |
| `comment`                               | No       | `{"type":"string"}`                                                         |
| `disabled`                              | No       | `{"type":"boolean"}`                                                        |

## remove_bgp_connection

**Remove BGP Connection** · Risk: **destructive**

Permanently deletes a BGP peer connection by name (`/routing bgp connection remove [find name="<name>"]`), tearing down the peering and removing all its configuration. To only suspend a connection without deleting it use `set_bgp_connection_enabled`. To remove a shared settings object use `remove_bgp_template`. The `name` is the connection name visible in `list_bgp_connections`.

| Parameter | Required | Definition                                        |
| --------- | -------- | ------------------------------------------------- |
| `name`    | Yes      | BGP connection name to remove `{"type":"string"}` |

## set_bgp_connection_enabled

**Enable or Disable BGP Connection** · Risk: **write-idempotent**

Enables or disables a BGP connection by name (`/routing bgp connection set [find name="<name>"] disabled=yes/no`). Pass `enabled=true` to bring a peer up, `enabled=false` to suspend it without deleting its configuration. To change other connection settings use `update_bgp_connection`. To permanently delete the connection use `remove_bgp_connection`.

| Parameter | Required | Definition                              |
| --------- | -------- | --------------------------------------- |
| `name`    | Yes      | BGP connection name `{"type":"string"}` |
| `enabled` | Yes      | `{"type":"boolean"}`                    |

## list_bgp_templates

**List BGP Templates** · Risk: **read**

Lists BGP template objects (`/routing bgp template print detail`). Templates hold shared peer settings — AS number, address-families, route filters, timers — that individual connections inherit via their `templates` field, avoiding repetition across many peers. For per-peer connection configuration use `list_bgp_connections`. For runtime session state use `list_bgp_sessions`. Returns all defined templates. Requires RouterOS v7 with the routing package.

No tool-specific parameters.

## add_bgp_template

**Add BGP Template** · Risk: **write**

Creates a BGP template (`/routing bgp template add`) to hold shared peer settings (AS, address-families, route filters, routing table) that multiple connections can inherit via their `templates` field, avoiding repetition across many peers. For `address_families` pass a comma-separated list, e.g. `"ip,ipv6"`. `input_filter`/`output_filter` reference `/routing filter` chain names. To create a peer that references this template use `add_bgp_connection`. To remove a template use `remove_bgp_template`. Returns success confirmation; verify with `list_bgp_templates`. Requires RouterOS v7 with the routing package.

| Parameter                  | Required | Definition                                                                                                   |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `name`                     | Yes      | Template name `{"type":"string"}`                                                                            |
| `as`                       | No       | Local AS number `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                  |
| `router_id`                | No       | `{"type":"string"}`                                                                                          |
| `cluster_id`               | No       | Route-reflector cluster ID (cluster-id) `{"type":"string"}`                                                  |
| `address_families`         | No       | e.g. "ip,ipv6" `{"type":"string"}`                                                                           |
| `hold_time`                | No       | e.g. "3m" or "180s" `{"type":"string"}`                                                                      |
| `keepalive_time`           | No       | `{"type":"string"}`                                                                                          |
| `multihop`                 | No       | Allow non-directly-connected peers `{"type":"boolean"}`                                                      |
| `nexthop_choice`           | No       | default, force-self, or propagate `{"type":"string"}`                                                        |
| `use_bfd`                  | No       | Use BFD for fast failure detection (use-bfd) `{"type":"boolean"}`                                            |
| `input_filter`             | No       | `{"type":"string"}`                                                                                          |
| `output_filter`            | No       | `{"type":"string"}`                                                                                          |
| `output_network`           | No       | Address list of networks to originate/advertise (output.network) `{"type":"string"}`                         |
| `output_default_originate` | No       | Advertise a default route: never, if-installed, or always (output.default-originate) `{"type":"string"}`     |
| `output_redistribute`      | No       | Comma list of route sources to redistribute, e.g. connected,static (output.redistribute) `{"type":"string"}` |
| `routing_table`            | No       | `{"type":"string"}`                                                                                          |
| `comment`                  | No       | `{"type":"string"}`                                                                                          |
| `disabled`                 | Yes      | `{"default":false,"type":"boolean"}`                                                                         |

## remove_bgp_template

**Remove BGP Template** · Risk: **destructive**

Permanently deletes a BGP template by name (`/routing bgp template remove [find name="<name>"]`). Connections that referenced this template lose the inherited settings — review with `list_bgp_connections` before removing. To remove a peer connection instead use `remove_bgp_connection`. The `name` is the template name visible in `list_bgp_templates`.

| Parameter | Required | Definition                                      |
| --------- | -------- | ----------------------------------------------- |
| `name`    | Yes      | BGP template name to remove `{"type":"string"}` |

## list_bgp_sessions

**List BGP Sessions** · Risk: **read**

Lists runtime BGP session state (`/routing bgp session print detail`) — negotiated peering status (established/idle/active/…), remote AS, uptime, and received/advertised prefix counts. This is the live operational view, not configuration; to view or change peer configuration use `list_bgp_connections`. Pass `established_only=true` to filter to established (fully up) sessions only. For prefixes being sent to a peer use `list_bgp_advertisements`. Returns all matching session entries. Requires RouterOS v7 with the routing package.

| Parameter          | Required | Definition                                                          |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `established_only` | Yes      | Show only established sessions `{"default":false,"type":"boolean"}` |

## list_bgp_advertisements

**List BGP Advertisements** · Risk: **read**

Lists prefixes currently being advertised to BGP peers (`/routing bgp advertisements print`) after output filters are applied — use this to verify exactly what routes this router is sending to a given peer. Read-only operational data; to see session status (prefix counts, uptime) use `list_bgp_sessions`. Filter by peer name substring with `peer_filter`. Returns advertisement entries per peer, or a not-found message. Requires RouterOS v7 with the routing package.

| Parameter     | Required | Definition                                           |
| ------------- | -------- | ---------------------------------------------------- |
| `peer_filter` | No       | Substring match on the peer name `{"type":"string"}` |
