---
title: "Switch — Ports"
description: "Per-port switch chip VLAN settings (`/interface ethernet switch port`)."
---

## Tools

- [List Switch Chip Ports](#list_switch_ports)
- [Get Switch Chip Port Details](#get_switch_port)
- [Update Switch Chip Port VLAN Settings](#update_switch_port)

## list_switch_ports

**List Switch Chip Ports** · Risk: **read**

List all switch chip ports (`/interface ethernet switch port print`) — the hardware-level per-port VLAN configuration entries on RouterOS switch chips. Use this to discover port names and their current vlan-mode, vlan-header, and default-vlan-id (PVID) settings before updating them. For a single port's full detail use get_switch_port; to change settings use update_switch_port. Optional filters narrow results by partial port name or owning switch (e.g. 'switch1'). Returns all matching port rows including VLAN mode, tag-header treatment, and PVID.

| Parameter       | Required | Definition                                                  |
| --------------- | -------- | ----------------------------------------------------------- |
| `name_filter`   | No       | Partial port-name match `{"type":"string"}`                 |
| `switch_filter` | No       | Filter by owning switch, e.g. 'switch1' `{"type":"string"}` |

## get_switch_port

**Get Switch Chip Port Details** · Risk: **read**

Retrieve detailed settings for a single switch chip port (`/interface ethernet switch port print detail`) by port name (e.g. 'ether1') or RouterOS '.id' from list_switch_ports. Use this when you need the full attribute set of one port before updating it; for all ports use list_switch_ports; to change settings use update_switch_port. Returns a detailed view of vlan-mode, vlan-header, default-vlan-id, and force-vlan-id for the matched port.

| Parameter | Required | Definition                                                      |
| --------- | -------- | --------------------------------------------------------------- |
| `port_id` | Yes      | Port name (e.g. 'ether1') or RouterOS '.id' `{"type":"string"}` |

## update_switch_port

**Update Switch Chip Port VLAN Settings** · Risk: **write-idempotent**

Set hardware VLAN settings on a switch chip port (`/interface ethernet switch port set`) — controls how the port handles 802.1Q VLAN tags at the chip level (PVID, enforcement mode, tag treatment). To inspect current settings first use get_switch_port or list_switch_ports. port_id accepts a port name (e.g. 'ether1') or the '.id' returned by list_switch_ports. Returns the updated port's full detail on success.

Notes:
vlan_mode: 'disabled' (ignore VLAN table), 'optional', 'enabled', or
'secure' (strict VLAN table enforcement).
vlan_header: how the egress VLAN tag is handled — 'leave-as-is',
'always-strip', or 'add-if-missing'.
default_vlan_id: PVID for untagged ingress ('auto', 'none', or a number).

| Parameter         | Required | Definition                                                                 |
| ----------------- | -------- | -------------------------------------------------------------------------- |
| `port_id`         | Yes      | Port name (e.g. 'ether1') or RouterOS '.id' `{"type":"string"}`            |
| `default_vlan_id` | No       | PVID: 'auto', 'none', or a VLAN id number `{"type":"string"}`              |
| `vlan_mode`       | No       | `{"type":"string","enum":["disabled","optional","enabled","secure"]}`      |
| `vlan_header`     | No       | `{"type":"string","enum":["leave-as-is","always-strip","add-if-missing"]}` |
| `force_vlan_id`   | No       | `{"type":"boolean"}`                                                       |
