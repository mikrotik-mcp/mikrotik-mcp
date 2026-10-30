---
title: "PIM-SM"
description: "PIM Sparse-Mode instances, interface-templates, RPs and neighbors (`/routing pimsm`)."
---

## Tools

- [List PIM-SM Instances](#list_pimsm_instances)
- [Add PIM-SM Instance](#add_pimsm_instance)
- [Remove PIM-SM Instance](#remove_pimsm_instance)
- [List PIM-SM Interface Templates](#list_pimsm_interface_templates)
- [Add PIM-SM Interface Template](#add_pimsm_interface_template)
- [Remove PIM-SM Interface Template](#remove_pimsm_interface_template)
- [List PIM-SM Rendezvous Points](#list_pimsm_rps)
- [Add PIM-SM Rendezvous Point](#add_pimsm_rp)
- [Remove PIM-SM Rendezvous Point](#remove_pimsm_rp)
- [List PIM-SM Neighbors](#list_pimsm_neighbors)

## list_pimsm_instances

**List PIM-SM Instances** · Risk: **read**

List all PIM-SM protocol instances (`/routing pimsm instance`). Each instance enables PIM Sparse-Mode multicast routing for a specific address family (ipv4 or ipv6) and VRF. For interface bindings within an instance use list_pimsm_interface_templates; for static RP entries use list_pimsm_rps; for discovered PIM peers use list_pimsm_neighbors. Returns a detail printout of every instance, or 'No PIM-SM instances found.' if none exist.

No tool-specific parameters.

## add_pimsm_instance

**Add PIM-SM Instance** · Risk: **write**

Create a PIM-SM protocol instance (`/routing pimsm instance`). An instance is required before any interface templates or static RPs can be added — it anchors the address family (ipv4/ipv6) and VRF that multicast routing runs in. Once created, bind interfaces with add_pimsm_interface_template and add RPs with add_pimsm_rp. Returns the detail of the newly created instance including its name and settings.

| Parameter                 | Required | Definition                                                                                                                         |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | Yes      | Unique instance name `{"type":"string"}`                                                                                           |
| `afi`                     | Yes      | Address family `{"default":"ipv4","type":"string","enum":["ipv4","ipv6"]}`                                                         |
| `vrf`                     | No       | `{"type":"string"}`                                                                                                                |
| `rp_set`                  | No       | Static RP-set name, if used `{"type":"string"}`                                                                                    |
| `ssm_range`               | No       | Source-Specific Multicast group range(s) for this instance `{"type":"string"}`                                                     |
| `rp_hash_mask_length`     | No       | RP hash mask length for group-to-RP mapping `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`            |
| `rp_static_override`      | No       | Static RP entries override dynamically learned (BSR) RPs `{"type":"boolean"}`                                                      |
| `switch_to_spt`           | No       | Switch from the shared (RP) tree to the shortest-path tree `{"type":"boolean"}`                                                    |
| `switch_to_spt_bytes`     | No       | Traffic threshold in bytes before switching to the SPT `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `switch_to_spt_interval`  | No       | SPT switchover measurement interval, e.g. "1m" `{"type":"string"}`                                                                 |
| `bsm_forward_back`        | No       | Forward bootstrap (BSM) messages back out the receiving interface `{"type":"boolean"}`                                             |
| `crp_advertise_contained` | No       | Candidate-RP advertises only contained group ranges `{"type":"boolean"}`                                                           |
| `comment`                 | No       | `{"type":"string"}`                                                                                                                |
| `disabled`                | Yes      | `{"default":false,"type":"boolean"}`                                                                                               |

## remove_pimsm_instance

**Remove PIM-SM Instance** · Risk: **destructive**

Remove a PIM-SM protocol instance (`/routing pimsm instance`) by name, tearing down all multicast routing for that address family and VRF. Use list_pimsm_instances to obtain the exact instance name. To remove only an interface binding without deleting the instance use remove_pimsm_interface_template; to remove only an RP entry use remove_pimsm_rp. Confirms success or returns the RouterOS error on failure.

| Parameter | Required | Definition                                         |
| --------- | -------- | -------------------------------------------------- |
| `name`    | Yes      | PIM-SM instance name to remove `{"type":"string"}` |

## list_pimsm_interface_templates

**List PIM-SM Interface Templates** · Risk: **read**

List PIM-SM interface templates (`/routing pimsm interface-template`) — the per-interface bindings that activate PIM on physical or logical interfaces within a named instance. Shows the interface or interface-list, DR election priority, and hello interval for each template. For the parent instance configuration use list_pimsm_instances; for dynamically discovered PIM peers on those interfaces use list_pimsm_neighbors. Returns a detail printout of all interface templates, or 'No PIM-SM interface templates found.'

No tool-specific parameters.

## add_pimsm_interface_template

**Add PIM-SM Interface Template** · Risk: **write**

Activate PIM-SM on one or more interfaces by creating an interface template (`/routing pimsm interface-template`). Binds a physical or logical interface (or interface-list) to an existing PIM-SM instance and sets DR election priority and hello interval (e.g. hello_period="30s"). Requires the parent instance to exist first — use add_pimsm_instance. To configure static RPs for that instance use add_pimsm_rp instead. Returns the new template's `.id` (e.g. '*1') if RouterOS echoes it back from the add command, or a plain success message; use list_pimsm_interface_templates to look it up afterwards.

| Parameter               | Required | Definition                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `instance`              | Yes      | PIM-SM instance name `{"type":"string"}`                                                         |
| `interfaces`            | Yes      | Interface or interface-list name `{"type":"string"}`                                             |
| `priority`              | No       | DR election priority `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `hello_period`          | No       | Hello interval, e.g. "30s" `{"type":"string"}`                                                   |
| `hello_delay`           | No       | Max random delay before the first Hello, e.g. "5s" `{"type":"string"}`                           |
| `join_prune_period`     | No       | Interval between periodic Join/Prune messages, e.g. "1m" `{"type":"string"}`                     |
| `join_tracking_support` | No       | Enable explicit Join/Prune tracking support `{"type":"boolean"}`                                 |
| `override_interval`     | No       | Randomized Join override interval, e.g. "2s500ms" `{"type":"string"}`                            |
| `propagation_delay`     | No       | Expected link propagation delay, e.g. "500ms" `{"type":"string"}`                                |
| `source_addresses`      | No       | Source IP address(es) used for PIM messages on these interfaces `{"type":"string"}`              |
| `comment`               | No       | `{"type":"string"}`                                                                              |
| `disabled`              | Yes      | `{"default":false,"type":"boolean"}`                                                             |

## remove_pimsm_interface_template

**Remove PIM-SM Interface Template** · Risk: **destructive**

Remove a PIM-SM interface template (`/routing pimsm interface-template`) by its `.id`, deactivating PIM on the interfaces it covered without removing the parent instance. The template_id (e.g. '*1') comes from list_pimsm_interface_templates. To tear down the entire PIM instance use remove_pimsm_instance; to remove a static RP entry use remove_pimsm_rp. Confirms success or returns the RouterOS error on failure.

| Parameter     | Required | Definition                                 |
| ------------- | -------- | ------------------------------------------ |
| `template_id` | Yes      | Template id, e.g. "*1" `{"type":"string"}` |

## list_pimsm_rps

**List PIM-SM Rendezvous Points** · Risk: **read**

List statically configured PIM-SM Rendezvous Points (`/routing pimsm rp`). Each entry maps an RP IP address to the multicast group range it roots the shared distribution tree for. For the parent instance configuration use list_pimsm_instances; for interface PIM settings use list_pimsm_interface_templates; for dynamically discovered PIM peers (not RPs) use list_pimsm_neighbors. Returns a detail printout of all RP entries, or 'No PIM-SM RPs found.'

No tool-specific parameters.

## add_pimsm_rp

**Add PIM-SM Rendezvous Point** · Risk: **write**

Register a static Rendezvous Point (RP) for a multicast group range (`/routing pimsm rp`). Tells PIM-SM routers which IP address is the root of the shared distribution tree for a given multicast prefix. The group field accepts a multicast prefix e.g. '239.0.0.0/8'; omit to cover the default multicast range. Requires the target instance to exist — use add_pimsm_instance first. To enable PIM on interfaces (not configure an RP) use add_pimsm_interface_template. Returns a success message; use list_pimsm_rps to retrieve the new entry's `.id`.

| Parameter  | Required | Definition                                                    |
| ---------- | -------- | ------------------------------------------------------------- |
| `instance` | Yes      | PIM-SM instance name `{"type":"string"}`                      |
| `address`  | Yes      | RP IP address `{"type":"string"}`                             |
| `group`    | No       | Multicast group range, e.g. "239.0.0.0/8" `{"type":"string"}` |
| `comment`  | No       | `{"type":"string"}`                                           |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`                          |

## remove_pimsm_rp

**Remove PIM-SM Rendezvous Point** · Risk: **destructive**

Remove a static PIM-SM Rendezvous Point entry (`/routing pimsm rp`) by its `.id`, stopping the router from treating that address as the shared-tree root for the associated multicast group range. The rp_id (e.g. '*1') comes from list_pimsm_rps. To remove an interface template instead use remove_pimsm_interface_template; to tear down the whole PIM instance use remove_pimsm_instance. Confirms success or returns the RouterOS error on failure.

| Parameter | Required | Definition                           |
| --------- | -------- | ------------------------------------ |
| `rp_id`   | Yes      | RP id, e.g. "*1" `{"type":"string"}` |

## list_pimsm_neighbors

**List PIM-SM Neighbors** · Risk: **read**

List dynamically discovered PIM-SM neighbors (`/routing pimsm neighbor`) — adjacent PIM routers learned via Hello messages, showing their DR priority and liveliness timers. This table is read-only and cannot be configured; entries appear automatically when PIM interfaces are active. For interface PIM configuration (hello interval, DR priority) use list_pimsm_interface_templates; for statically configured RP addresses use list_pimsm_rps. Returns a detail printout of all discovered PIM peers, or 'No PIM-SM neighbors found.'

No tool-specific parameters.
