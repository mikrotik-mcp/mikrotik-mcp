---
title: "OSPF"
description: "OSPF instances, areas, ranges, interface-templates, neighbors and LSAs (`/routing ospf`)."
---

## Tools

- [List OSPF Instances](#list_ospf_instances)
- [Add OSPF Instance](#add_ospf_instance)
- [Update OSPF Instance](#update_ospf_instance)
- [Remove OSPF Instance](#remove_ospf_instance)
- [List OSPF Areas](#list_ospf_areas)
- [Add OSPF Area](#add_ospf_area)
- [Remove OSPF Area](#remove_ospf_area)
- [List OSPF Area Ranges](#list_ospf_area_ranges)
- [Add OSPF Area Range](#add_ospf_area_range)
- [Remove OSPF Area Range](#remove_ospf_area_range)
- [List OSPF Interface Templates](#list_ospf_interface_templates)
- [Add OSPF Interface Template](#add_ospf_interface_template)
- [Remove OSPF Interface Template](#remove_ospf_interface_template)
- [List OSPF Neighbors](#list_ospf_neighbors)
- [List OSPF LSAs](#list_ospf_lsa)

## list_ospf_instances

**List OSPF Instances** · Risk: **read**

List all OSPF instances (`/routing ospf instance`) — each instance is one OSPF process with a fixed protocol version (2=OSPFv2/IPv4, 3=OSPFv3/IPv6), router-id, redistribution list, and import/export filter chains. Use this to verify running processes before adding areas or interface templates. For area topology use list_ospf_areas; for per-link config use list_ospf_interface_templates; for adjacency state use list_ospf_neighbors. Returns full detail for every instance including disabled ones.

No tool-specific parameters.

## add_ospf_instance

**Add OSPF Instance** · Risk: **write**

Create an OSPF instance (`/routing ospf instance add`) — the top-level OSPF process. `version` 2 = OSPFv2 (IPv4 routing), 3 = OSPFv3 (IPv6 routing); each address family needs its own instance. `router_id` may be an IPv4 address, 'main', or the name of a `/routing id`. `redistribute` is a comma-separated list (connected,static,rip,bgp,…). Requires RouterOS v7 with the routing package. After creating an instance, add areas with add_ospf_area and bind interfaces with add_ospf_interface_template. Returns the created instance's full detail.

| Parameter           | Required | Definition                                                                                                        |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`              | Yes      | Unique instance name `{"type":"string"}`                                                                          |
| `version`           | Yes      | 2 = OSPFv2, 3 = OSPFv3 `{"default":2,"type":"integer","minimum":2,"maximum":3}`                                   |
| `router_id`         | No       | IPv4 address, 'main', or a /routing id name `{"type":"string"}`                                                   |
| `vrf`               | No       | `{"type":"string"}`                                                                                               |
| `redistribute`      | No       | Comma list, e.g. "connected,static" `{"type":"string"}`                                                           |
| `in_filter_chain`   | No       | Routing filter chain for received routes `{"type":"string"}`                                                      |
| `out_filter_chain`  | No       | Routing filter chain for redistributed routes `{"type":"string"}`                                                 |
| `originate_default` | No       | never, if-installed, or always `{"type":"string"}`                                                                |
| `domain_id`         | No       | OSPF domain ID (MPLS VPN PE-CE OSPF) `{"type":"string"}`                                                          |
| `domain_tag`        | No       | OSPF domain tag (MPLS VPN PE-CE OSPF) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_dn`            | No       | Use/ignore DN bit on OSPF routes (MPLS VPN) `{"type":"boolean"}`                                                  |
| `mpls_te_area`      | No       | Area used for MPLS traffic engineering `{"type":"string"}`                                                        |
| `mpls_te_address`   | No       | Router address advertised for MPLS TE `{"type":"string"}`                                                         |
| `comment`           | No       | `{"type":"string"}`                                                                                               |
| `disabled`          | Yes      | `{"default":false,"type":"boolean"}`                                                                              |

## update_ospf_instance

**Update OSPF Instance** · Risk: **write-idempotent**

Update an existing OSPF instance (`/routing ospf instance set`) by name — change router-id, redistribution list, import/export filter chains, originate-default policy, comment, or disabled state. Only supplied fields are modified; omitting a field leaves it unchanged. `name` identifies the target instance (use list_ospf_instances to find names). Returns the updated instance detail. To remove an instance entirely use remove_ospf_instance.

| Parameter           | Required | Definition                                                                                                        |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`              | Yes      | Existing OSPF instance name `{"type":"string"}`                                                                   |
| `router_id`         | No       | `{"type":"string"}`                                                                                               |
| `redistribute`      | No       | `{"type":"string"}`                                                                                               |
| `in_filter_chain`   | No       | `{"type":"string"}`                                                                                               |
| `out_filter_chain`  | No       | `{"type":"string"}`                                                                                               |
| `originate_default` | No       | `{"type":"string"}`                                                                                               |
| `domain_id`         | No       | OSPF domain ID (MPLS VPN PE-CE OSPF) `{"type":"string"}`                                                          |
| `domain_tag`        | No       | OSPF domain tag (MPLS VPN PE-CE OSPF) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_dn`            | No       | Use/ignore DN bit on OSPF routes (MPLS VPN) `{"type":"boolean"}`                                                  |
| `mpls_te_area`      | No       | Area used for MPLS traffic engineering `{"type":"string"}`                                                        |
| `mpls_te_address`   | No       | Router address advertised for MPLS TE `{"type":"string"}`                                                         |
| `comment`           | No       | `{"type":"string"}`                                                                                               |
| `disabled`          | No       | `{"type":"boolean"}`                                                                                              |

## remove_ospf_instance

**Remove OSPF Instance** · Risk: **destructive**

Remove an OSPF instance by name (`/routing ospf instance remove`) — permanently stops the named OSPF process. Use list_ospf_instances to find the instance name. Remove dependent areas (remove_ospf_area), area ranges (remove_ospf_area_range), and interface templates (remove_ospf_interface_template) first to avoid orphaned config or removal errors. Irreversible — all OSPF adjacencies for that process will drop immediately. For a non-destructive pause use update_ospf_instance with disabled=true.

| Parameter | Required | Definition                                       |
| --------- | -------- | ------------------------------------------------ |
| `name`    | Yes      | OSPF instance name to remove `{"type":"string"}` |

## list_ospf_areas

**List OSPF Areas** · Risk: **read**

List all OSPF areas (`/routing ospf area`) — areas group links within an OSPF instance and control LSA flooding scope; `type` is default (normal), stub, or nssa; area-id 0.0.0.0 is the backbone. Use this to verify area membership before adding area ranges or interface templates. For prefix summarisation use list_ospf_area_ranges; for adjacency health use list_ospf_neighbors. Returns full detail for every area including its instance and type.

No tool-specific parameters.

## add_ospf_area

**Add OSPF Area** · Risk: **write**

Create an OSPF area (`/routing ospf area add`) within a named instance — area-id must be in IPv4 dotted notation (backbone = '0.0.0.0'). `type` controls LSA flooding: default (normal), stub (no external LSAs), or nssa (allow external redistribution via NSSA LSAs). `no_summaries=true` makes a totally-stubby or totally-NSSA area by blocking summary LSAs. Requires the instance to already exist (add_ospf_instance). After adding an area, bind interfaces to it with add_ospf_interface_template. Returns a success confirmation.

| Parameter      | Required | Definition                                                                                                                                 |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`         | Yes      | Unique area name `{"type":"string"}`                                                                                                       |
| `area_id`      | Yes      | Area id in IPv4 notation, e.g. "0.0.0.0" for backbone `{"type":"string"}`                                                                  |
| `instance`     | Yes      | OSPF instance name this area belongs to `{"type":"string"}`                                                                                |
| `type`         | No       | `{"type":"string","enum":["default","stub","nssa"]}`                                                                                       |
| `no_summaries` | No       | Make a totally-stubby/NSSA area (block summary LSAs) `{"type":"boolean"}`                                                                  |
| `default_cost` | No       | Cost of the default route an ABR injects into a stub/NSSA area `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`      | No       | `{"type":"string"}`                                                                                                                        |
| `disabled`     | Yes      | `{"default":false,"type":"boolean"}`                                                                                                       |

## remove_ospf_area

**Remove OSPF Area** · Risk: **destructive**

Remove an OSPF area by name (`/routing ospf area remove`) — permanently deletes the area and its association with the instance. Use list_ospf_areas to find the area name. Remove any area ranges (remove_ospf_area_range) and interface templates (remove_ospf_interface_template) that reference this area first to avoid orphaned config or removal errors.

| Parameter | Required | Definition                                   |
| --------- | -------- | -------------------------------------------- |
| `name`    | Yes      | OSPF area name to remove `{"type":"string"}` |

## list_ospf_area_ranges

**List OSPF Area Ranges** · Risk: **read**

List OSPF area summarisation ranges (`/routing ospf area range`) — aggregate prefixes that an ABR (area border router) advertises to condense intra-area routes into fewer inter-area Type-3 LSAs. Use this to verify summarisation config before adding or removing ranges. For the areas themselves use list_ospf_areas. Returns full detail including prefix, area, cost, and advertise flag.

No tool-specific parameters.

## add_ospf_area_range

**Add OSPF Area Range** · Risk: **write**

Add an OSPF area summarisation range (`/routing ospf area range add`) to a named area — the ABR will aggregate matching intra-area prefixes into a single Type-3 LSA advertised to other areas. `advertise=false` suppresses the summary entirely (null-routes the aggregate). `cost` overrides the auto-computed metric. Area must already exist (add_ospf_area). `prefix` is the aggregate prefix, e.g. '10.10.0.0/16'. Use list_ospf_area_ranges to verify after creation. Returns a success confirmation.

| Parameter   | Required | Definition                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------- |
| `area`      | Yes      | OSPF area name `{"type":"string"}`                                              |
| `prefix`    | Yes      | Aggregate prefix, e.g. "10.10.0.0/16" `{"type":"string"}`                       |
| `advertise` | Yes      | Advertise the summary (false suppresses it) `{"default":true,"type":"boolean"}` |
| `cost`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`     |
| `comment`   | No       | `{"type":"string"}`                                                             |
| `disabled`  | No       | `{"type":"boolean"}`                                                            |

## remove_ospf_area_range

**Remove OSPF Area Range** · Risk: **destructive**

Remove an OSPF area summarisation range (`/routing ospf area range remove`) by its `.id` — use list_ospf_area_ranges to obtain the id (e.g. '*1'). The ABR will revert to advertising individual intra-area prefixes instead of the aggregate.

| Parameter  | Required | Definition                              |
| ---------- | -------- | --------------------------------------- |
| `range_id` | Yes      | Range id, e.g. "*1" `{"type":"string"}` |

## list_ospf_interface_templates

**List OSPF Interface Templates** · Risk: **read**

List OSPF interface templates (`/routing ospf interface-template`) — templates bind interfaces or network prefixes to an area and set per-link OSPF parameters (cost, type, timers, authentication, passive). This is the RouterOS v7 mechanism that activates OSPF on interfaces; there is no per-interface sub-menu. Use this before adding or removing templates. For area membership use list_ospf_areas; for active adjacencies use list_ospf_neighbors. Returns full detail for every template including its area, interfaces/networks, and auth settings.

No tool-specific parameters.

## add_ospf_interface_template

**Add OSPF Interface Template** · Risk: **write**

Bind interfaces or network prefixes to an OSPF area (`/routing ospf interface-template add`). Match links via `interfaces` (interface or interface-list name) and/or `networks` (prefix, e.g. '10.0.0.0/24'). `type` sets the link model: broadcast (LAN), ptp (point-to-point), ptp-unnumbered (point-to-point over an unnumbered link), ptmp, ptmp-broadcast, nbma, or virtual-link. `passive=true` advertises the subnet without forming OSPF adjacencies (for stub networks). `auth`/`auth_id`/`auth_key` enable per-interface authentication; `hello_interval` e.g. '10s', `dead_interval` e.g. '40s'. Requires the area to already exist (add_ospf_area). Returns the new template id (e.g. '*2') if RouterOS echoes one; use list_ospf_interface_templates to verify.

| Parameter             | Required | Definition                                                                                                            |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `area`                | Yes      | OSPF area name to attach matched interfaces to `{"type":"string"}`                                                    |
| `interfaces`          | No       | Interface or interface-list name `{"type":"string"}`                                                                  |
| `networks`            | No       | Network prefix(es) to enable OSPF on, e.g. "10.0.0.0/24" `{"type":"string"}`                                          |
| `cost`                | No       | Output cost / metric `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                      |
| `priority`            | No       | DR election priority (0 = never DR) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`       |
| `type`                | No       | `{"type":"string","enum":["broadcast","ptp","ptp-unnumbered","ptmp","ptmp-broadcast","nbma","virtual-link"]}`         |
| `passive`             | No       | `{"type":"boolean"}`                                                                                                  |
| `hello_interval`      | No       | e.g. "10s" `{"type":"string"}`                                                                                        |
| `dead_interval`       | No       | e.g. "40s" `{"type":"string"}`                                                                                        |
| `retransmit_interval` | No       | Interval between LSA retransmissions, e.g. "5s" `{"type":"string"}`                                                   |
| `transmit_delay`      | No       | Estimated LSA transmit delay, e.g. "1s" `{"type":"string"}`                                                           |
| `instance_id`         | No       | OSPF instance-id carried in hello packets `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `prefix_list`         | No       | Prefix-list name filtering which connected networks are advertised `{"type":"string"}`                                |
| `vlink_neighbor_id`   | No       | Virtual-link remote router-id (type=virtual-link) `{"type":"string"}`                                                 |
| `vlink_transit_area`  | No       | Transit area the virtual-link traverses (type=virtual-link) `{"type":"string"}`                                       |
| `auth`                | No       | `{"type":"string","enum":["simple","md5","sha1","sha256","sha384","sha512"]}`                                         |
| `auth_id`             | No       | Key id for keyed authentication `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`           |
| `auth_key`            | No       | Authentication key/password `{"type":"string"}`                                                                       |
| `comment`             | No       | `{"type":"string"}`                                                                                                   |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                                  |

## remove_ospf_interface_template

**Remove OSPF Interface Template** · Risk: **destructive**

Remove an OSPF interface template (`/routing ospf interface-template remove`) by its `.id` — use list_ospf_interface_templates to obtain the id (e.g. '*2'). Removing a template stops OSPF on all matched interfaces; existing adjacencies will drop immediately.

| Parameter     | Required | Definition                                 |
| ------------- | -------- | ------------------------------------------ |
| `template_id` | Yes      | Template id, e.g. "*2" `{"type":"string"}` |

## list_ospf_neighbors

**List OSPF Neighbors** · Risk: **read**

List active OSPF adjacencies (`/routing ospf neighbor`) — shows each neighbor's router-id, address, interface, instance, area, and adjacency state (Full/2-Way/ExStart/Exchange/Loading/…). Read-only — the primary health check for confirming OSPF is forming Full adjacencies. For the link-state database use list_ospf_lsa; for per-interface config use list_ospf_interface_templates. Returns full detail for every discovered neighbor.

No tool-specific parameters.

## list_ospf_lsa

**List OSPF LSAs** · Risk: **read**

List the OSPF link-state database (`/routing ospf lsa`) — every LSA the router holds, by type (Router/Network/Summary/ASBR-Summary/External/NSSA/…), area, and originating router-id. Read-only — used to inspect topology, verify summarisation (Type-3 LSAs), confirm external redistribution (Type-5/Type-7), and diagnose flooding or database synchronisation problems. Filter to a single area with `area_filter`. For adjacency state use list_ospf_neighbors; for instance/area config use list_ospf_instances.

| Parameter     | Required | Definition                                       |
| ------------- | -------- | ------------------------------------------------ |
| `area_filter` | No       | Show only LSAs for this area `{"type":"string"}` |
