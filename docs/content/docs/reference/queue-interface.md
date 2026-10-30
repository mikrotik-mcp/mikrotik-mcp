---
title: "Queues — Interface"
description: "Per-interface queue-type assignment (`/queue interface`)."
---

## Tools

- [List Queue Interface Assignments](#list_queue_interfaces)
- [Get Queue Interface Assignment](#get_queue_interface)
- [Update Queue Interface Assignment](#update_queue_interface)

## list_queue_interfaces

**List Queue Interface Assignments** · Risk: **read**

List per-interface queue assignments (`/queue interface`). Shows which queue type (e.g. 'ethernet-default', 'only-hardware-queue') is currently applied to each interface's egress traffic. RouterOS maintains exactly one entry per interface — these entries are fixed and cannot be created or deleted, only updated. For bandwidth-limited queues use list_simple_queues; for hierarchical queues use list_queue_trees. Returns all matching entries filtered optionally by partial interface name (interface_filter) or partial queue-type name (queue_filter).

| Parameter          | Required | Definition                                        |
| ------------------ | -------- | ------------------------------------------------- |
| `interface_filter` | No       | Partial interface-name match `{"type":"string"}`  |
| `queue_filter`     | No       | Partial queue-type-name match `{"type":"string"}` |

## get_queue_interface

**Get Queue Interface Assignment** · Risk: **read**

Get the queue-type assignment for a single interface (`/queue interface print detail`). Resolves by RouterOS '.id' first, then falls back to matching by interface name — pass either the interface name (e.g. 'ether1') or the '.id' from list_queue_interfaces. For all interfaces at once use list_queue_interfaces. Returns the full detail output for the matched entry including the interface name, queue type, and any active properties.

| Parameter      | Required | Definition                                                           |
| -------------- | -------- | -------------------------------------------------------------------- |
| `interface_id` | Yes      | Interface name (e.g. 'ether1') or RouterOS '.id' `{"type":"string"}` |

## update_queue_interface

**Update Queue Interface Assignment** · Risk: **write-idempotent**

Assign a queue type to a specific interface (`/queue interface set`) — controls which egress queuing discipline is applied to outbound traffic on that interface. Use this to switch between built-in types such as 'ethernet-default' or 'only-hardware-queue', or to apply a custom queue type defined under /queue type. This does NOT create a bandwidth-limiting queue; for that use create_simple_queue (simple rate-limit) or create_queue_tree (hierarchical/HTB shaping). Accepts the interface name (e.g. 'ether1') or RouterOS '.id' (from list_queue_interfaces) as interface_id; if the id begins with '*' it is matched by .id, otherwise by interface name. Returns the updated entry detail on success.

| Parameter      | Required | Definition                                                           |
| -------------- | -------- | -------------------------------------------------------------------- |
| `interface_id` | Yes      | Interface name (e.g. 'ether1') or RouterOS '.id' `{"type":"string"}` |
| `queue`        | Yes      | Queue-type name to apply to the interface `{"type":"string"}`        |
