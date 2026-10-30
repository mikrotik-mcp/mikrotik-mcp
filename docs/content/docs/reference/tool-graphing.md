---
title: "Graphing"
description: "Interface/queue/resource graphing rules (`/tool graphing`)."
---

## Tools

- [Add Interface Graphing Rule](#add_graphing_interface)
- [Add Queue Graphing Rule](#add_graphing_queue)
- [Add Resource Graphing Rule](#add_graphing_resource)
- [List Graphing Rules](#list_graphing)
- [Remove Graphing Rule](#remove_graphing)

## add_graphing_interface

**Add Interface Graphing Rule** · Risk: **write**

Adds an interface graphing rule (`/tool graphing interface add`) so the device begins recording per-interface bandwidth graphs viewable via the router's built-in web graph page. Use `interface='all'` to graph every interface. `allow_address` restricts which subnet may view the graphs (e.g. '0.0.0.0/0' for all). For simple-queue bandwidth graphs use `add_graphing_queue`; for CPU/memory/disk graphs use `add_graphing_resource`. Returns a confirmation string on success.

| Parameter       | Required | Definition                                                              |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `interface`     | Yes      | Interface to graph, or 'all' `{"default":"all","type":"string"}`        |
| `allow_address` | No       | Subnet allowed to view the graphs, e.g. '0.0.0.0/0' `{"type":"string"}` |
| `store_on_disk` | No       | `{"type":"boolean"}`                                                    |
| `disabled`      | No       | Whether the graphing rule is disabled `{"type":"boolean"}`              |
| `comment`       | No       | Free-text comment for the rule `{"type":"string"}`                      |

## add_graphing_queue

**Add Queue Graphing Rule** · Risk: **write**

Adds a simple-queue graphing rule (`/tool graphing queue add`) so the device records bandwidth graphs for a named simple queue, viewable via the router's built-in web graph page. Use `simple_queue='all'` to graph every simple queue. `allow_address` restricts which subnet may view the graphs (e.g. '0.0.0.0/0' for all). For interface traffic graphs use `add_graphing_interface`; for CPU/memory/disk graphs use `add_graphing_resource`. Note: this targets simple queues only — for queue-tree entries there is no separate graphing scope. Returns a confirmation string on success.

| Parameter       | Required | Definition                                                          |
| --------------- | -------- | ------------------------------------------------------------------- |
| `simple_queue`  | Yes      | Simple queue to graph, or 'all' `{"default":"all","type":"string"}` |
| `allow_address` | No       | `{"type":"string"}`                                                 |
| `store_on_disk` | No       | `{"type":"boolean"}`                                                |
| `disabled`      | No       | Whether the graphing rule is disabled `{"type":"boolean"}`          |
| `comment`       | No       | Free-text comment for the rule `{"type":"string"}`                  |

## add_graphing_resource

**Add Resource Graphing Rule** · Risk: **write**

Adds a system-resource graphing rule (`/tool graphing resource add`) so the device records CPU load, memory usage, and disk usage graphs viewable via the router's built-in web graph page. `allow_address` restricts which subnet may view the graphs (e.g. '0.0.0.0/0' for all). For per-interface bandwidth graphs use `add_graphing_interface`; for simple-queue graphs use `add_graphing_queue`. Returns a confirmation string on success.

| Parameter       | Required | Definition                                                 |
| --------------- | -------- | ---------------------------------------------------------- |
| `allow_address` | No       | `{"type":"string"}`                                        |
| `store_on_disk` | No       | `{"type":"boolean"}`                                       |
| `disabled`      | No       | Whether the graphing rule is disabled `{"type":"boolean"}` |
| `comment`       | No       | Free-text comment for the rule `{"type":"string"}`         |

## list_graphing

**List Graphing Rules** · Risk: **read**

Lists all graphing rules of a given kind (`/tool graphing {kind} print`) — specify `kind` as `interface`, `queue`, or `resource` to select the matching table. Use this to audit which interfaces, queues, or resource metrics are being graphed and to retrieve the `.id` values needed by `remove_graphing`. Returns all configured graphing entries for the selected table, or an empty-result message.

| Parameter | Required | Definition                                                                               |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `kind`    | Yes      | Which graphing table to list `{"type":"string","enum":["interface","queue","resource"]}` |

## remove_graphing

**Remove Graphing Rule** · Risk: **destructive**

Removes a graphing rule of the given kind (`/tool graphing {kind} remove`) by `.id`, stopping the device from recording graphs for that entry. Verifies the entry exists with a count-only check before deleting. `kind` must be `interface`, `queue`, or `resource`; `entry_id` is the RouterOS `.id` (e.g. '*1') obtained from `list_graphing`. Returns a confirmation string on success, or a not-found message if the `.id` does not exist.

| Parameter  | Required | Definition                                                  |
| ---------- | -------- | ----------------------------------------------------------- |
| `kind`     | Yes      | `{"type":"string","enum":["interface","queue","resource"]}` |
| `entry_id` | Yes      | RouterOS '.id', e.g. '*1' `{"type":"string"}`               |
