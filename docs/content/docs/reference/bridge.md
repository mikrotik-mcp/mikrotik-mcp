---
title: "Bridge"
description: "Bridges, ports, host table and bridge VLANs (`/interface bridge`)."
---

## Tools

- [Create Bridge Interface](#create_bridge)
- [List Bridge Interfaces](#list_bridges)
- [Get Bridge Interface Detail](#get_bridge)
- [Update Bridge Interface Settings](#update_bridge)
- [Remove Bridge Interface](#remove_bridge)
- [Add Bridge Port (Enslave Interface)](#add_bridge_port)
- [List Bridge Port Memberships](#list_bridge_ports)
- [Remove Bridge Port (Release Interface)](#remove_bridge_port)
- [List Bridge MAC Address (Host) Table](#list_bridge_hosts)
- [Add Bridge VLAN Table Entry](#add_bridge_vlan)
- [List Bridge VLAN Table Entries](#list_bridge_vlans)

## create_bridge

**Create Bridge Interface** · Risk: **write**

Creates a bridge interface (`/interface bridge`) — combines multiple interfaces into a Layer-2 switch domain. For VLAN migration read get_vlan_segmentation_guide first. Stage a new bridge with filtering off; enable it LAST after VLAN membership and protected management access are ready. Set `protocol_mode` for STP/RSTP/MSTP spanning-tree. For adding a member interface to an existing bridge use `add_bridge_port`; for standalone 802.1Q VLAN sub-interfaces use `create_vlan_interface`. Returns the created bridge's full detail including its `.id`.

| Parameter                     | Required | Definition                                                                                                                                         |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | Yes      | Name for the new bridge, e.g. 'bridge1' `{"type":"string","pattern":"^\\S+$"}`                                                                     |
| `comment`                     | No       | `{"type":"string"}`                                                                                                                                |
| `vlan_filtering`              | Yes      | Enable 802.1Q VLAN filtering on the bridge `{"default":false,"type":"boolean"}`                                                                    |
| `protocol_mode`               | No       | Spanning-tree protocol mode `{"type":"string","enum":["none","rstp","stp","mstp"]}`                                                                |
| `disabled`                    | Yes      | `{"default":false,"type":"boolean"}`                                                                                                               |
| `mtu`                         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                        |
| `ageing_time`                 | No       | Host table entry timeout, e.g. '5m' `{"type":"string"}`                                                                                            |
| `arp`                         | No       | ARP resolution mode `{"type":"string","enum":["disabled","enabled","proxy-arp","reply-only","local-proxy-arp"]}`                                   |
| `arp_timeout`                 | No       | ARP entry timeout, e.g. '30s' or 'auto' `{"type":"string"}`                                                                                        |
| `auto_mac`                    | No       | Automatically pick the bridge MAC from a member port `{"type":"boolean"}`                                                                          |
| `admin_mac`                   | No       | Static bridge MAC address (requires auto_mac=false) `{"type":"string"}`                                                                            |
| `priority`                    | No       | STP/RSTP bridge priority, e.g. '0x8000' `{"type":"string"}`                                                                                        |
| `ether_type`                  | No       | Service VLAN (S-tag) EtherType when VLAN filtering `{"type":"string","enum":["0x8100","0x88a8","0x9100"]}`                                         |
| `pvid`                        | No       | Bridge-level default port VLAN ID `{"type":"integer","minimum":1,"maximum":4094}`                                                                  |
| `frame_types`                 | No       | Default accepted frame types for ports `{"type":"string","enum":["admit-all","admit-only-untagged-and-priority-tagged","admit-only-vlan-tagged"]}` |
| `ingress_filtering`           | No       | Default ingress VLAN filtering for ports `{"type":"boolean"}`                                                                                      |
| `dhcp_snooping`               | No       | Enable DHCP snooping `{"type":"boolean"}`                                                                                                          |
| `arp_inspection`              | No       | RouterOS 7.25+ validate ARP against DHCP snooping bindings `{"type":"boolean"}`                                                                    |
| `ip_source_guard`             | No       | RouterOS 7.25+ validate IPv4 source against DHCP snooping bindings `{"type":"boolean"}`                                                            |
| `mlag_init_delay`             | No       | RouterOS 7.25+ MLAG LACP initialization delay `{"type":"string"}`                                                                                  |
| `mlag_lacp_fallback`          | No       | RouterOS 7.25+ MLAG LACP fallback after peer loss `{"type":"boolean"}`                                                                             |
| `confirm_security_disruption` | No       | Required when enabling ARP inspection or IP source guard; DHCP bindings may be cleared and traffic interrupted `{"type":"boolean","const":true}`   |
| `igmp_snooping`               | No       | Enable IGMP/MLD snooping `{"type":"boolean"}`                                                                                                      |
| `fast_forward`                | No       | Enable Fast Forward optimization `{"type":"boolean"}`                                                                                              |
| `mvrp`                        | No       | Enable Multiple VLAN Registration Protocol `{"type":"boolean"}`                                                                                    |
| `forward_delay`               | No       | STP forward delay timer, e.g. '15s' `{"type":"string"}`                                                                                            |
| `max_message_age`             | No       | STP maximum message age, e.g. '20s' `{"type":"string"}`                                                                                            |
| `transmit_hold_count`         | No       | STP transmit hold count `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                |

## list_bridges

**List Bridge Interfaces** · Risk: **read**

Lists bridge interfaces (`/interface bridge`). Use to enumerate all bridge domains or confirm whether a named bridge exists. For member ports enslaved to a bridge use `list_bridge_ports`; for the VLAN membership table use `list_bridge_vlans`; for learned MAC addresses use `list_bridge_hosts`. Optional `name_filter` does a partial name match. Returns bridge name, MTU, VLAN-filtering flag, and STP state.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_bridge

**Get Bridge Interface Detail** · Risk: **read**

Fetches full detail for a single bridge interface (`/interface bridge print detail`). Use to inspect STP/MSTP state, VLAN-filtering flag, MTU, MAC address, and operational status for one bridge. For all bridges use `list_bridges`; for the member ports of this bridge use `list_bridge_ports`. Requires the exact bridge `name`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_bridge

**Update Bridge Interface Settings** · Risk: **write-idempotent**

Modifies settings on an existing bridge interface (`/interface bridge set`). Use to rename a bridge (`new_name`), toggle VLAN filtering, change STP/RSTP/MSTP protocol mode, adjust MTU, or enable/disable the bridge. VLAN filtering can interrupt management: read get_vlan_segmentation_guide, verify CPU membership, PVID/admission and recovery access before enabling it LAST. Do not disable existing filtering to simplify migration. For adding or removing member interfaces use `add_bridge_port` / `remove_bridge_port`; for VLAN table entries use `add_bridge_vlan`. Identified by the current bridge `name`; supply only the fields you want to change.

| Parameter                     | Required | Definition                                                                                                                                         |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | Yes      | Current name of the bridge to update `{"type":"string"}`                                                                                           |
| `new_name`                    | No       | Rename the bridge to this (no spaces). `{"type":"string","pattern":"^\\S+$"}`                                                                      |
| `comment`                     | No       | `{"type":"string"}`                                                                                                                                |
| `vlan_filtering`              | No       | `{"type":"boolean"}`                                                                                                                               |
| `protocol_mode`               | No       | `{"type":"string","enum":["none","rstp","stp","mstp"]}`                                                                                            |
| `disabled`                    | No       | `{"type":"boolean"}`                                                                                                                               |
| `mtu`                         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                        |
| `ageing_time`                 | No       | Host table entry timeout, e.g. '5m' `{"type":"string"}`                                                                                            |
| `arp`                         | No       | ARP resolution mode `{"type":"string","enum":["disabled","enabled","proxy-arp","reply-only","local-proxy-arp"]}`                                   |
| `arp_timeout`                 | No       | ARP entry timeout, e.g. '30s' or 'auto' `{"type":"string"}`                                                                                        |
| `auto_mac`                    | No       | Automatically pick the bridge MAC from a member port `{"type":"boolean"}`                                                                          |
| `admin_mac`                   | No       | Static bridge MAC address (requires auto_mac=false) `{"type":"string"}`                                                                            |
| `priority`                    | No       | STP/RSTP bridge priority, e.g. '0x8000' `{"type":"string"}`                                                                                        |
| `ether_type`                  | No       | Service VLAN (S-tag) EtherType when VLAN filtering `{"type":"string","enum":["0x8100","0x88a8","0x9100"]}`                                         |
| `pvid`                        | No       | Bridge-level default port VLAN ID `{"type":"integer","minimum":1,"maximum":4094}`                                                                  |
| `frame_types`                 | No       | Default accepted frame types for ports `{"type":"string","enum":["admit-all","admit-only-untagged-and-priority-tagged","admit-only-vlan-tagged"]}` |
| `ingress_filtering`           | No       | Default ingress VLAN filtering for ports `{"type":"boolean"}`                                                                                      |
| `dhcp_snooping`               | No       | Enable DHCP snooping `{"type":"boolean"}`                                                                                                          |
| `arp_inspection`              | No       | RouterOS 7.25+ validate ARP against DHCP snooping bindings `{"type":"boolean"}`                                                                    |
| `ip_source_guard`             | No       | RouterOS 7.25+ validate IPv4 source against DHCP snooping bindings `{"type":"boolean"}`                                                            |
| `mlag_init_delay`             | No       | RouterOS 7.25+ MLAG LACP initialization delay `{"type":"string"}`                                                                                  |
| `mlag_lacp_fallback`          | No       | RouterOS 7.25+ MLAG LACP fallback after peer loss `{"type":"boolean"}`                                                                             |
| `confirm_security_disruption` | No       | Required when enabling ARP inspection or IP source guard; DHCP bindings may be cleared and traffic interrupted `{"type":"boolean","const":true}`   |
| `igmp_snooping`               | No       | Enable IGMP/MLD snooping `{"type":"boolean"}`                                                                                                      |
| `fast_forward`                | No       | Enable Fast Forward optimization `{"type":"boolean"}`                                                                                              |
| `mvrp`                        | No       | Enable Multiple VLAN Registration Protocol `{"type":"boolean"}`                                                                                    |
| `forward_delay`               | No       | STP forward delay timer, e.g. '15s' `{"type":"string"}`                                                                                            |
| `max_message_age`             | No       | STP maximum message age, e.g. '20s' `{"type":"string"}`                                                                                            |
| `transmit_hold_count`         | No       | STP transmit hold count `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                |

## remove_bridge

**Remove Bridge Interface** · Risk: **destructive**

Deletes a bridge interface (`/interface bridge remove`). Verifies existence first and returns an error if the bridge is not found. Removing the bridge also releases all enslaved member ports. To detach a single member without deleting the bridge use `remove_bridge_port`. Identified by bridge `name`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_bridge_port

**Add Bridge Port (Enslave Interface)** · Risk: **write**

Enslaves an interface as a member port of a bridge (`/interface bridge port add`). Use to add an Ethernet, VLAN sub-interface, or other interface type to an existing bridge domain. Set `pvid` (1-4094) to assign the port's native/untagged VLAN; set `hw=true` to enable hardware offload. To create the bridge itself first use `create_bridge`; to add a VLAN entry to the bridge VLAN table use `add_bridge_vlan`; for standalone VLAN sub-interfaces use `create_vlan_interface`. Returns the new port entry's detail.

| Parameter                 | Required | Definition                                                                                                                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge`                  | Yes      | Bridge to add the port to `{"type":"string"}`                                                                                               |
| `interface`               | Yes      | Interface to enslave to the bridge `{"type":"string"}`                                                                                      |
| `pvid`                    | No       | Port VLAN ID for untagged ingress `{"type":"integer","minimum":1,"maximum":4094}`                                                           |
| `comment`                 | No       | `{"type":"string"}`                                                                                                                         |
| `hw`                      | No       | Use hardware offload for this port `{"type":"boolean"}`                                                                                     |
| `disabled`                | No       | Disable this bridge port `{"type":"boolean"}`                                                                                               |
| `frame_types`             | No       | Accepted frame types on ingress `{"type":"string","enum":["admit-all","admit-only-untagged-and-priority-tagged","admit-only-vlan-tagged"]}` |
| `ingress_filtering`       | No       | Drop ingress frames tagged with a VLAN the port isn't a member of `{"type":"boolean"}`                                                      |
| `tag_stacking`            | No       | Force an extra VLAN tag (Q-in-Q) on ingress `{"type":"boolean"}`                                                                            |
| `priority`                | No       | STP port priority, e.g. '0x80' `{"type":"string"}`                                                                                          |
| `path_cost`               | No       | STP path cost for this port `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                     |
| `internal_path_cost`      | No       | MSTP internal path cost `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                         |
| `horizon`                 | No       | Split-horizon group number for forwarding isolation `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`             |
| `learn`                   | No       | MAC address learning mode `{"type":"string","enum":["auto","yes","no"]}`                                                                    |
| `edge`                    | No       | STP edge-port setting `{"type":"string","enum":["auto","no","yes","no-discover","yes-discover"]}`                                           |
| `point_to_point`          | No       | STP point-to-point link setting `{"type":"string","enum":["auto","yes","no"]}`                                                              |
| `auto_isolate`            | No       | Keep port in discarding until a BPDU is received `{"type":"boolean"}`                                                                       |
| `bpdu_guard`              | No       | Disable the port if it receives a BPDU `{"type":"boolean"}`                                                                                 |
| `restricted_role`         | No       | Exclude port from becoming the root port `{"type":"boolean"}`                                                                               |
| `restricted_tcn`          | No       | Block topology change notifications from this port `{"type":"boolean"}`                                                                     |
| `trusted`                 | No       | Trust DHCP server replies on this port (DHCP snooping) `{"type":"boolean"}`                                                                 |
| `trusted_arp`             | No       | RouterOS 7.25+ exempt this port from ARP inspection `{"type":"boolean"}`                                                                    |
| `multicast_router`        | No       | IGMP-snooping multicast router state `{"type":"string","enum":["disabled","permanent","temporary-query"]}`                                  |
| `fast_leave`              | No       | IGMP-snooping fast leave `{"type":"boolean"}`                                                                                               |
| `unknown_unicast_flood`   | No       | Flood unknown-unicast frames to this port `{"type":"boolean"}`                                                                              |
| `unknown_multicast_flood` | No       | Flood unknown-multicast frames to this port `{"type":"boolean"}`                                                                            |
| `broadcast_flood`         | No       | Flood broadcast frames to this port `{"type":"boolean"}`                                                                                    |

## list_bridge_ports

**List Bridge Port Memberships** · Risk: **read**

Lists bridge port memberships (`/interface bridge port print`). Use to see which interfaces are enslaved to a bridge, their PVID, horizon, and hardware-offload status. For the bridge interfaces themselves use `list_bridges`; for MAC addresses learned on the bridge use `list_bridge_hosts`; for VLAN table entries use `list_bridge_vlans`. Filter by exact `bridge_filter` (bridge name) or `interface_filter` (member interface name).

| Parameter          | Required | Definition                               |
| ------------------ | -------- | ---------------------------------------- |
| `bridge_filter`    | No       | Exact bridge name `{"type":"string"}`    |
| `interface_filter` | No       | Exact interface name `{"type":"string"}` |

## remove_bridge_port

**Remove Bridge Port (Release Interface)** · Risk: **destructive**

Detaches a member interface from its bridge (`/interface bridge port remove`). Verifies the port exists first and returns an error if not found. Releases the interface back to standalone mode without deleting the bridge itself. To delete the entire bridge (and release all ports) use `remove_bridge`. Identified by the member `interface` name.

| Parameter   | Required | Definition                                              |
| ----------- | -------- | ------------------------------------------------------- |
| `interface` | Yes      | Interface to remove from the bridge `{"type":"string"}` |

## list_bridge_hosts

**List Bridge MAC Address (Host) Table** · Risk: **read**

Lists the learned MAC forwarding table of a bridge (`/interface bridge host print`). Use to see which MAC addresses are known on each bridge port — useful for Layer-2 troubleshooting and verifying device reachability. This is the bridge forwarding database, not the ARP table (ARP maps IP-to-MAC; use ARP tools for that). Not the same as `list_bridge_ports` (which lists enslaved interfaces, not learned MACs). Filter by exact `bridge_filter`; returns MAC address, port, age, and dynamic/static flag.

| Parameter       | Required | Definition                            |
| --------------- | -------- | ------------------------------------- |
| `bridge_filter` | No       | Exact bridge name `{"type":"string"}` |

## add_bridge_vlan

**Add Bridge VLAN Table Entry** · Risk: **write**

Adds a VLAN membership entry to a bridge's 802.1Q VLAN table (`/interface bridge vlan add`). Use to define which ports carry a specific VLAN as tagged (trunk) or untagged (access). Entries can be staged BEFORE enabling filtering; filtering enforces membership and should be enabled LAST after management is protected. For routed VLANs verify tagged bridge/CPU membership. Use one VLAN ID per entry containing access ports and align their PVID/admission; read get_vlan_segmentation_guide first. `vlan_ids` accepts a single ID (e.g. '100') or comma-separated list (e.g. '100,200'); `tagged` and `untagged` accept comma-separated interface names. For standalone 802.1Q VLAN sub-interfaces use `create_vlan_interface`; for listing existing VLAN table entries use `list_bridge_vlans`; for setting per-port native VLAN use the `pvid` parameter in `add_bridge_port`.

| Parameter  | Required | Definition                                              |
| ---------- | -------- | ------------------------------------------------------- |
| `bridge`   | Yes      | Bridge to add the VLAN entry to `{"type":"string"}`     |
| `vlan_ids` | Yes      | VLAN ID(s), e.g. '100' or '100,200' `{"type":"string"}` |
| `tagged`   | No       | Comma-separated tagged interfaces `{"type":"string"}`   |
| `untagged` | No       | Comma-separated untagged interfaces `{"type":"string"}` |
| `comment`  | No       | `{"type":"string"}`                                     |
| `disabled` | No       | Disable this VLAN table entry `{"type":"boolean"}`      |

## list_bridge_vlans

**List Bridge VLAN Table Entries** · Risk: **read**

Lists VLAN membership entries from the bridge VLAN table (`/interface bridge vlan print`). Use to inspect which ports are tagged or untagged for each VLAN on a bridge where `vlan-filtering` is active. For standalone 802.1Q VLAN sub-interfaces (not bridge VLAN table) use `create_vlan_interface` and related VLAN tools; for bridge port PVID (native VLAN) settings use `list_bridge_ports`. Filter by exact `bridge_filter`; returns VLAN IDs with their tagged and untagged port lists.

| Parameter       | Required | Definition                            |
| --------------- | -------- | ------------------------------------- |
| `bridge_filter` | No       | Exact bridge name `{"type":"string"}` |
