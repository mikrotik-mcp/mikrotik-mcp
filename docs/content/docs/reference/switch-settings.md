---
title: "Switch — Settings"
description: "Hardware switch chips: mirroring, CPU flow control (`/interface ethernet switch`)."
---

## Tools

- [List Hardware Switch Chips](#list_switches)
- [Get Hardware Switch Chip Details](#get_switch)
- [Update Hardware Switch Chip Settings](#update_switch)

## list_switches

**List Hardware Switch Chips** · Risk: **read**

Lists hardware switch chips (`/interface ethernet switch`). Use to discover switch chip names and types present on the device before targeting a chip with get_switch or update_switch. Accepts optional `name_filter` and `type_filter` for partial-match filtering. Returns chip name, type, and mirror/flow-control configuration for each matching entry; returns an empty message if none match.

| Parameter     | Required | Definition                                    |
| ------------- | -------- | --------------------------------------------- |
| `name_filter` | No       | Partial switch-name match `{"type":"string"}` |
| `type_filter` | No       | Partial switch-type match `{"type":"string"}` |

## get_switch

**Get Hardware Switch Chip Details** · Risk: **read**

Fetches full detail for a single hardware switch chip (`/interface ethernet switch print detail`). Use to inspect the current cpu-flow-control flag and mirror-source, mirror-target, and mirror-egress settings before modifying them with update_switch. `switch_id` accepts the chip name (e.g. 'switch1') or the RouterOS `.id` returned by list_switches — tries `.id` lookup first, then falls back to name lookup. Returns detailed chip settings or a not-found message.

| Parameter   | Required | Definition                                                         |
| ----------- | -------- | ------------------------------------------------------------------ |
| `switch_id` | Yes      | Switch name (e.g. 'switch1') or RouterOS '.id' `{"type":"string"}` |

## update_switch

**Update Hardware Switch Chip Settings** · Risk: **write-idempotent**

Modifies settings on a hardware switch chip (`/interface ethernet switch set`) — use to configure port mirroring (SPAN) or CPU flow control on the chip itself. `switch_id` accepts the chip name (e.g. 'switch1') or the RouterOS `.id` returned by list_switches.

cpu_flow_control: pauses CPU-bound traffic when the CPU port is congested.
mirror_source / mirror_target: span a port's traffic to a monitor port or 'cpu' (chip-dependent availability).
mirror_egress: egress mirror source port on newer chips.
Pass mirror_source / mirror_target / mirror_egress='none' to disable mirroring.

Returns updated switch details on success.

| Parameter              | Required | Definition                                                                                 |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `switch_id`            | Yes      | Switch name (e.g. 'switch1') or RouterOS '.id' `{"type":"string"}`                         |
| `name`                 | No       | Rename the switch `{"type":"string"}`                                                      |
| `cpu_flow_control`     | No       | `{"type":"boolean"}`                                                                       |
| `mirror_source`        | No       | Source port to mirror, or 'none' `{"type":"string"}`                                       |
| `mirror_target`        | No       | Monitor port, 'cpu', or 'none' `{"type":"string"}`                                         |
| `mirror_egress`        | No       | Egress mirror source port (newer chips), or 'none' `{"type":"string"}`                     |
| `mirror_egress_target` | No       | Egress mirror target port (88E6393X/88E6191X/88E6190 chips), or 'none' `{"type":"string"}` |
| `switch_all_ports`     | No       | Switch all ports together (RB450G/RB435G/RB850Gx2 only) `{"type":"boolean"}`               |
