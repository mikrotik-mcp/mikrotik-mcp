---
title: "RIP"
description: "RIP instances, interface-templates, static + dynamic neighbors (`/routing rip`)."
---

## Tools

- [List RIP Instances](#list_rip_instances)
- [Add RIP Instance](#add_rip_instance)
- [Update RIP Instance](#update_rip_instance)
- [Remove RIP Instance](#remove_rip_instance)
- [List RIP Interface Templates](#list_rip_interface_templates)
- [Add RIP Interface Template](#add_rip_interface_template)
- [Remove RIP Interface Template](#remove_rip_interface_template)
- [List RIP Static Neighbors](#list_rip_static_neighbors)
- [Add RIP Static Neighbor](#add_rip_static_neighbor)
- [Remove RIP Static Neighbor](#remove_rip_static_neighbor)
- [List Active RIP Neighbors](#list_rip_neighbors)

## list_rip_instances

**List RIP Instances** · Risk: **read**

List RIP process instances (`/routing rip instance`) — each instance is one RIPv2 process with its own router-id, redistribution policy, and import/export filter chains. Use before creating or updating an instance with add_rip_instance or update_rip_instance. For OSPF use the OSPF tools; for BGP use list_bgp_connections; for static routes use list_routes. Returns all instance details including router-id, VRF, redistribution config, and enabled/disabled state. Requires RouterOS v7 with the routing package.

No tool-specific parameters.

## add_rip_instance

**Add RIP Instance** · Risk: **write**

Create a RIP process instance (`/routing rip instance add`) — the top-level RIPv2 process object that governs route redistribution and filter chains. Required before attaching interfaces with add_rip_interface_template. `redistribute` is a comma-separated list (e.g. "connected,static,ospf,bgp"); `originate_default` accepts never, if-installed, or always; `router_id` accepts an IPv4 address, 'main', or a /routing id name; filter chains reference /routing filter. For OSPF use the OSPF tools; for BGP use add_bgp_connection. Returns the created instance's detail including its name. Requires RouterOS v7 with the routing package.

| Parameter           | Required | Definition                                                      |
| ------------------- | -------- | --------------------------------------------------------------- |
| `name`              | Yes      | Unique instance name `{"type":"string"}`                        |
| `router_id`         | No       | IPv4 address, 'main', or a /routing id name `{"type":"string"}` |
| `vrf`               | No       | `{"type":"string"}`                                             |
| `routing_table`     | No       | Routing table to install routes into `{"type":"string"}`        |
| `redistribute`      | No       | Comma list, e.g. "connected,static" `{"type":"string"}`         |
| `in_filter_chain`   | No       | `{"type":"string"}`                                             |
| `out_filter_chain`  | No       | `{"type":"string"}`                                             |
| `originate_default` | No       | never, if-installed, or always `{"type":"string"}`              |
| `comment`           | No       | `{"type":"string"}`                                             |
| `disabled`          | Yes      | `{"default":false,"type":"boolean"}`                            |

## update_rip_instance

**Update RIP Instance** · Risk: **write-idempotent**

Modify an existing RIP process instance (`/routing rip instance set`) identified by its name. Use to change redistribution policy, filter chains, router-id, or enabled/disabled state without recreating the instance. Obtain the name from list_rip_instances. For creating a new instance use add_rip_instance; for removing one use remove_rip_instance. Returns the updated instance's detail. Requires RouterOS v7 with the routing package.

| Parameter           | Required | Definition                                               |
| ------------------- | -------- | -------------------------------------------------------- |
| `name`              | Yes      | Existing RIP instance name `{"type":"string"}`           |
| `router_id`         | No       | `{"type":"string"}`                                      |
| `routing_table`     | No       | Routing table to install routes into `{"type":"string"}` |
| `redistribute`      | No       | `{"type":"string"}`                                      |
| `in_filter_chain`   | No       | `{"type":"string"}`                                      |
| `out_filter_chain`  | No       | `{"type":"string"}`                                      |
| `originate_default` | No       | `{"type":"string"}`                                      |
| `comment`           | No       | `{"type":"string"}`                                      |
| `disabled`          | No       | `{"type":"boolean"}`                                     |

## remove_rip_instance

**Remove RIP Instance** · Risk: **destructive**

Delete a RIP process instance (`/routing rip instance remove`) by its name, removing the process and all associated routing state. Obtain the name from list_rip_instances. Remove associated interface templates first with remove_rip_interface_template to avoid orphaned entries. To disable without deleting use update_rip_instance with disabled=true. Requires RouterOS v7 with the routing package.

| Parameter | Required | Definition                                      |
| --------- | -------- | ----------------------------------------------- |
| `name`    | Yes      | RIP instance name to remove `{"type":"string"}` |

## list_rip_interface_templates

**List RIP Interface Templates** · Risk: **read**

List RIP interface templates (`/routing rip interface-template`) — records that bind one or more interfaces to a RIP instance and set per-link options such as passive mode and authentication key-chain. Use to inspect which interfaces participate in RIP before adding or removing templates with add_rip_interface_template or remove_rip_interface_template. For static unicast neighbors use list_rip_static_neighbors; for discovered active peers use list_rip_neighbors. Returns all templates with their instance, interface(s), passive, key-chain, and enabled/disabled state. Requires RouterOS v7 with the routing package.

No tool-specific parameters.

## add_rip_interface_template

**Add RIP Interface Template** · Risk: **write**

Bind interfaces to a RIP instance (`/routing rip interface-template add`) so they participate in RIP route advertisement. The `instance` must already exist — create it first with add_rip_instance. `passive=true` suppresses outbound RIP updates while still receiving; `key_chain` names a /routing key-chain for MD5 authentication. For static unicast neighbors on non-broadcast links use add_rip_static_neighbor instead. Returns the new template's .id. Requires RouterOS v7 with the routing package.

| Parameter        | Required | Definition                                                |
| ---------------- | -------- | --------------------------------------------------------- |
| `instance`       | Yes      | RIP instance name `{"type":"string"}`                     |
| `interfaces`     | Yes      | Interface or interface-list name `{"type":"string"}`      |
| `passive`        | No       | `{"type":"boolean"}`                                      |
| `split_horizon`  | No       | Enable split-horizon loop prevention `{"type":"boolean"}` |
| `poison_reverse` | No       | Advertise back with infinite metric `{"type":"boolean"}`  |
| `key_chain`      | No       | Key-chain name for authentication `{"type":"string"}`     |
| `comment`        | No       | `{"type":"string"}`                                       |
| `disabled`       | Yes      | `{"default":false,"type":"boolean"}`                      |

## remove_rip_interface_template

**Remove RIP Interface Template** · Risk: **destructive**

Remove a RIP interface template (`/routing rip interface-template remove`) by its `.id`, detaching the bound interfaces from the RIP instance. Obtain the `.id` from list_rip_interface_templates. To re-configure instead of removing, delete and recreate with add_rip_interface_template. Requires RouterOS v7 with the routing package.

| Parameter     | Required | Definition                                 |
| ------------- | -------- | ------------------------------------------ |
| `template_id` | Yes      | Template id, e.g. "*1" `{"type":"string"}` |

## list_rip_static_neighbors

**List RIP Static Neighbors** · Risk: **read**

List manually configured RIP static neighbors (`/routing rip static-neighbor`) — IPv4 unicast targets for RIP updates on non-broadcast or point-to-point links where multicast does not reach. Use before adding or removing entries with add_rip_static_neighbor or remove_rip_static_neighbor. For dynamically discovered active peers see list_rip_neighbors; for interface participation config see list_rip_interface_templates. Returns address, instance, and enabled/disabled state. Requires RouterOS v7 with the routing package.

No tool-specific parameters.

## add_rip_static_neighbor

**Add RIP Static Neighbor** · Risk: **write**

Add a static RIP neighbor entry (`/routing rip static-neighbor add`) to unicast RIP updates to a specific IPv4 address on non-broadcast or point-to-point links. Optionally scope to a specific RIP instance by name (obtain from list_rip_instances). For multicast-reachable peers, binding an interface with add_rip_interface_template is sufficient. Returns a confirmation message on success. Requires RouterOS v7 with the routing package.

| Parameter  | Required | Definition                              |
| ---------- | -------- | --------------------------------------- |
| `address`  | Yes      | Neighbor IP address `{"type":"string"}` |
| `instance` | No       | RIP instance name `{"type":"string"}`   |
| `comment`  | No       | `{"type":"string"}`                     |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`    |

## remove_rip_static_neighbor

**Remove RIP Static Neighbor** · Risk: **destructive**

Delete a static RIP neighbor entry (`/routing rip static-neighbor remove`) by its `.id`, stopping unicast RIP updates to that IPv4 peer. Obtain the `.id` from list_rip_static_neighbors. The link itself is unaffected. Requires RouterOS v7 with the routing package.

| Parameter     | Required | Definition                                        |
| ------------- | -------- | ------------------------------------------------- |
| `neighbor_id` | Yes      | Static-neighbor id, e.g. "*1" `{"type":"string"}` |

## list_rip_neighbors

**List Active RIP Neighbors** · Risk: **read**

List dynamically discovered RIP peers (`/routing rip neighbor`) — read-only operational state showing which IPv4 peers this router is currently exchanging routes with, including last-update timestamps. For manually configured unicast targets see list_rip_static_neighbors; for interface participation config see list_rip_interface_templates. For BGP peers use list_bgp_sessions; for static routes use list_routes. Returns peer addresses, uptime, and last-update timing. Requires RouterOS v7 with the routing package.

No tool-specific parameters.
