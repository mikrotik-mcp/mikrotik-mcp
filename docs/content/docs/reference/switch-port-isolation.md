---
title: "Switch — Port Isolation"
description: "Hardware port isolation / forwarding overrides (`/interface ethernet switch port-isolation`)."
---

## Tools

- [Add Switch Port Isolation Entry](#add_switch_port_isolation)
- [List Switch Port Isolation Entries](#list_switch_port_isolation)
- [Get Switch Port Isolation Entry](#get_switch_port_isolation)
- [Update Switch Port Isolation Entry](#update_switch_port_isolation)
- [Remove Switch Port Isolation Entry](#remove_switch_port_isolation)

## add_switch_port_isolation

**Add Switch Port Isolation Entry** · Risk: **write**

Add a port-isolation entry (`/interface ethernet switch port-isolation add`) — restricts which switch-chip ports a given source port may forward traffic to, implementing hardware-level private-VLAN-style isolation without IP rules.

Use this when you need to prevent a switch port from communicating with all other ports except a specific allowed set (e.g. uplink only). This is a switch-chip hardware rule; for Layer-3 traffic filtering use the firewall tools (create_filter_rule, create_nat_rule). For VLAN segmentation use create_vlan_interface.

Returns the created entry's details including its `.id` (use list_switch_port_isolation to obtain `.id` values of existing entries).

Args:
port: source port to isolate, e.g. 'ether1'.
forwarding_override_ports: comma-separated list of the ONLY ports this port may forward to — all others are blocked in hardware.

| Parameter                   | Required | Definition                                                    |
| --------------------------- | -------- | ------------------------------------------------------------- |
| `port`                      | Yes      | Source port to isolate, e.g. 'ether1' `{"type":"string"}`     |
| `forwarding_override_ports` | Yes      | Comma-separated allowed destination ports `{"type":"string"}` |
| `comment`                   | No       | `{"type":"string"}`                                           |

## list_switch_port_isolation

**List Switch Port Isolation Entries** · Risk: **read**

List all switch port-isolation entries (`/interface ethernet switch port-isolation print`) — shows every source port that has a forwarding-override configured on the switch chip, including its allowed destination ports and `.id`.

Use this to audit current port isolation policy or to retrieve `.id` values needed by get_switch_port_isolation, update_switch_port_isolation, or remove_switch_port_isolation. For a single entry's full detail use get_switch_port_isolation.

Returns a table of all matching entries; optionally filter by partial port name via port_filter.

| Parameter     | Required | Definition                                    |
| ------------- | -------- | --------------------------------------------- |
| `port_filter` | No       | Partial source-port match `{"type":"string"}` |

## get_switch_port_isolation

**Get Switch Port Isolation Entry** · Risk: **read**

Retrieve detail for a single switch port-isolation entry (`/interface ethernet switch port-isolation print detail`) by source port name or RouterOS `.id`.

Use this to inspect the forwarding-override-ports of one specific port in full detail. For all entries use list_switch_port_isolation. The `.id` argument (e.g. '*1') comes from list_switch_port_isolation; a plain port name (e.g. 'ether1') is also accepted.

Returns the full detail block for the matched entry, or a not-found message.

| Parameter      | Required | Definition                                                             |
| -------------- | -------- | ---------------------------------------------------------------------- |
| `isolation_id` | Yes      | Source port name (e.g. 'ether1') or RouterOS '.id' `{"type":"string"}` |

## update_switch_port_isolation

**Update Switch Port Isolation Entry** · Risk: **write-idempotent**

Modify an existing switch port-isolation entry (`/interface ethernet switch port-isolation set`) — change the allowed forwarding-override-ports or comment without removing and recreating the entry.

isolation_id accepts either the source port name (e.g. 'ether1') or the RouterOS `.id` (e.g. '*1') from list_switch_port_isolation. Only supplied fields are changed; pass comment="" to clear the comment. To change which port is being isolated (the port field itself), use remove_switch_port_isolation then add_switch_port_isolation.

Returns the entry's updated detail block.

| Parameter                   | Required | Definition                                                    |
| --------------------------- | -------- | ------------------------------------------------------------- |
| `isolation_id`              | Yes      | Source port name or RouterOS '.id' `{"type":"string"}`        |
| `forwarding_override_ports` | No       | Comma-separated allowed destination ports `{"type":"string"}` |
| `comment`                   | No       | `{"type":"string"}`                                           |

## remove_switch_port_isolation

**Remove Switch Port Isolation Entry** · Risk: **destructive**

Permanently delete a switch port-isolation entry (`/interface ethernet switch port-isolation remove`) — restores the port's default forwarding behaviour (no forwarding restriction on the switch chip).

isolation_id accepts either the source port name (e.g. 'ether1') or the RouterOS `.id` (e.g. '*1') from list_switch_port_isolation. Performs a count-only existence check before removal and returns a not-found message if the entry does not exist. To add a new isolation rule afterwards use add_switch_port_isolation; to only modify allowed ports use update_switch_port_isolation.

| Parameter      | Required | Definition                                             |
| -------------- | -------- | ------------------------------------------------------ |
| `isolation_id` | Yes      | Source port name or RouterOS '.id' `{"type":"string"}` |
