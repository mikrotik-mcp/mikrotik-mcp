---
title: "Queues / QoS"
description: "Queue types, queue trees and simple queues (`/queue`)."
---

## Tools

- [Create Queue Type (Qdisc)](#create_queue_type)
- [List Queue Types (Qdiscs)](#list_queue_types)
- [Get Queue Type Detail](#get_queue_type)
- [Update Queue Type Settings](#update_queue_type)
- [Remove Queue Type](#remove_queue_type)
- [Create Queue Tree Entry](#create_queue_tree)
- [List Queue Tree Entries](#list_queue_trees)
- [Get Queue Tree Entry Detail](#get_queue_tree)
- [Update Queue Tree Entry](#update_queue_tree)
- [Remove Queue Tree Entry](#remove_queue_tree)
- [Enable Queue Tree Entry](#enable_queue_tree)
- [Disable Queue Tree Entry](#disable_queue_tree)
- [Create Simple Queue](#create_simple_queue)
- [List Simple Queues](#list_simple_queues)
- [Get Simple Queue Detail](#get_simple_queue)
- [Update Simple Queue](#update_simple_queue)
- [Remove Simple Queue](#remove_simple_queue)
- [Enable Simple Queue](#enable_simple_queue)
- [Disable Simple Queue](#disable_simple_queue)

## create_queue_type

**Create Queue Type (Qdisc)** · Risk: **write**

Creates a named queue discipline (`/queue type`) — the algorithm (cake, fq-codel, sfq, red, pcq, pfifo, bfifo, pfifo-bpf, mq-pfifo, none) that controls how packets within a queue are scheduled and dropped. Queue types are referenced by name in `create_queue_tree` and `create_simple_queue` via their `queue` parameter. `kind` selects the discipline; remaining params are per-discipline options (e.g. cake_flowmode, cake_nat, pcq_rate, pcq_classifier, fq_codel_target). For hierarchical bandwidth shaping use `create_queue_tree`; for flat per-target rate limiting use `create_simple_queue`. Returns details of the created queue type.

| Parameter               | Required | Definition                                                                                                                      |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | Yes      | `{"type":"string"}`                                                                                                             |
| `kind`                  | Yes      | `{"default":"cake","type":"string","enum":["cake","fq-codel","sfq","red","pcq","pfifo","bfifo","pfifo-bpf","mq-pfifo","none"]}` |
| `cake_flowmode`         | No       | `{"type":"string","enum":["triple-isolate","dual-srchost","dual-dsthost","host","flow","none"]}`                                |
| `cake_nat`              | No       | `{"type":"boolean"}`                                                                                                            |
| `cake_overhead`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `cake_mpu`              | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `cake_diffserv`         | No       | `{"type":"string","enum":["besteffort","diffserv3","diffserv4","diffserv8"]}`                                                   |
| `cake_ack_filter`       | No       | `{"type":"string","enum":["filter","aggressive","none"]}`                                                                       |
| `cake_rtt`              | No       | Round-trip time e.g. "50ms", "100ms" `{"type":"string"}`                                                                        |
| `cake_wash`             | No       | `{"type":"boolean"}`                                                                                                            |
| `cake_overhead_scheme`  | No       | `{"type":"string"}`                                                                                                             |
| `cake_bandwidth`        | No       | CAKE shaper bandwidth e.g. "100M", "0" for unlimited `{"type":"string"}`                                                        |
| `cake_atm`              | No       | Link-layer ATM/PTM compensation `{"type":"string","enum":["none","atm","ptm"]}`                                                 |
| `cake_autorate_ingress` | No       | Automatic ingress rate estimation `{"type":"boolean"}`                                                                          |
| `cake_memlimit`         | No       | Override CAKE buffer memory limit `{"type":"string"}`                                                                           |
| `pcq_rate`              | No       | Bandwidth per flow e.g. "1M", "512k" `{"type":"string"}`                                                                        |
| `pcq_limit`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `pcq_classifier`        | No       | Comma-separated classifiers e.g. "src-address,dst-address" `{"type":"string"}`                                                  |
| `pcq_total_limit`       | No       | Total packet limit across all PCQ sub-queues `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`        |
| `pcq_burst_rate`        | No       | PCQ burst rate e.g. "1M" `{"type":"string"}`                                                                                    |
| `pcq_burst_threshold`   | No       | PCQ burst threshold e.g. "512k" `{"type":"string"}`                                                                             |
| `pcq_burst_time`        | No       | PCQ burst time e.g. "10s" `{"type":"string"}`                                                                                   |
| `pcq_src_address_mask`  | No       | IPv4 src classifier mask bits (0-32) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `pcq_dst_address_mask`  | No       | IPv4 dst classifier mask bits (0-32) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `pcq_src_address6_mask` | No       | IPv6 src classifier mask bits (0-128) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`               |
| `pcq_dst_address6_mask` | No       | IPv6 dst classifier mask bits (0-128) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`               |
| `pfifo_limit`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `bfifo_limit`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `sfq_perturb`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `sfq_allot`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `fq_codel_limit`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `fq_codel_quantum`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `fq_codel_target`       | No       | Time e.g. "5ms", "100ms" `{"type":"string"}`                                                                                    |
| `fq_codel_interval`     | No       | Time e.g. "5ms", "100ms" `{"type":"string"}`                                                                                    |
| `red_limit`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `red_min_threshold`     | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `red_max_threshold`     | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `red_burst`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `red_avg_packet`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |

## list_queue_types

**List Queue Types (Qdiscs)** · Risk: **read**

Lists all queue disciplines (`/queue type print`) configured on the device. Use `name_filter` (substring match) or `kind_filter` (exact kind) to narrow results. Returns all built-in and custom queue type entries. Use `get_queue_type` for full detail on a single entry. To list scheduling hierarchies use `list_queue_trees`; to list per-target rate limits use `list_simple_queues`.

| Parameter     | Required | Definition          |
| ------------- | -------- | ------------------- |
| `name_filter` | No       | `{"type":"string"}` |
| `kind_filter` | No       | `{"type":"string"}` |

## get_queue_type

**Get Queue Type Detail** · Risk: **read**

Retrieves full detail for a single queue discipline (`/queue type print detail where name=...`). Resolves the `name` referenced in `create_queue_tree` or `create_simple_queue` via the `queue` field. Returns all parameters of that type, or a not-found message. Use `list_queue_types` to discover available names.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_queue_type

**Update Queue Type Settings** · Risk: **write-idempotent**

Modifies an existing queue discipline (`/queue type set [find name=...]`). Supports renaming (`new_name`) and changing CAKE- or PCQ-specific parameters (cake_flowmode, cake_nat, cake_overhead, pcq_rate, pcq_classifier, etc.). Does not change the queue `kind` — to switch algorithm, remove and recreate the type with `remove_queue_type` then `create_queue_type`. Returns updated detail; if no parameters are provided returns 'No updates specified.' Use `get_queue_type` to confirm current values first.

| Parameter               | Required | Definition                                                                  |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `name`                  | Yes      | `{"type":"string"}`                                                         |
| `new_name`              | No       | `{"type":"string"}`                                                         |
| `cake_flowmode`         | No       | `{"type":"string"}`                                                         |
| `cake_nat`              | No       | `{"type":"boolean"}`                                                        |
| `cake_overhead`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `cake_mpu`              | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `cake_diffserv`         | No       | `{"type":"string"}`                                                         |
| `cake_ack_filter`       | No       | `{"type":"string"}`                                                         |
| `cake_rtt`              | No       | `{"type":"string"}`                                                         |
| `cake_wash`             | No       | `{"type":"boolean"}`                                                        |
| `cake_overhead_scheme`  | No       | `{"type":"string"}`                                                         |
| `cake_bandwidth`        | No       | `{"type":"string"}`                                                         |
| `cake_atm`              | No       | `{"type":"string"}`                                                         |
| `cake_autorate_ingress` | No       | `{"type":"boolean"}`                                                        |
| `cake_memlimit`         | No       | `{"type":"string"}`                                                         |
| `pcq_rate`              | No       | `{"type":"string"}`                                                         |
| `pcq_limit`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `pcq_classifier`        | No       | `{"type":"string"}`                                                         |
| `pcq_total_limit`       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `pcq_burst_rate`        | No       | `{"type":"string"}`                                                         |
| `pcq_burst_threshold`   | No       | `{"type":"string"}`                                                         |
| `pcq_burst_time`        | No       | `{"type":"string"}`                                                         |
| `pcq_src_address_mask`  | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `pcq_dst_address_mask`  | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `pcq_src_address6_mask` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `pcq_dst_address6_mask` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## remove_queue_type

**Remove Queue Type** · Risk: **destructive**

Permanently deletes a named queue discipline (`/queue type remove [find name=...]`). Will fail if the type is still referenced by an active queue tree or simple queue — remove those references first. Built-in types (e.g. 'default', 'default-small') cannot be removed. Returns a success or error message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_queue_tree

**Create Queue Tree Entry** · Risk: **write**

Creates a hierarchical bandwidth-shaping node (`/queue tree add`) attached to a `parent` interface or another queue tree entry — the HTB-style tree for multi-level QoS. Use this when you need nested queues with shared bandwidth pools and packet-mark-based classification (marks produced by mangle tools). `max_limit` caps peak throughput (e.g. '10M', '512k', '1G'); `limit_at` guarantees minimum bandwidth; `priority` sets preemption order (1 highest, 8 lowest); `queue` names the qdisc from `create_queue_type`. For flat per-IP/CIDR rate limiting without a hierarchy use `create_simple_queue` instead. Returns the created entry's detail.

| Parameter         | Required | Definition                                                                                           |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | `{"type":"string"}`                                                                                  |
| `parent`          | Yes      | Interface name e.g. "ether1" or parent queue name `{"type":"string"}`                                |
| `queue`           | No       | `{"type":"string"}`                                                                                  |
| `packet_mark`     | No       | `{"type":"string"}`                                                                                  |
| `max_limit`       | No       | Bandwidth e.g. "10M", "512k", "1G" `{"type":"string"}`                                               |
| `limit_at`        | No       | Bandwidth e.g. "10M", "512k", "1G" `{"type":"string"}`                                               |
| `burst_limit`     | No       | Bandwidth e.g. "10M", "512k", "1G" `{"type":"string"}`                                               |
| `burst_threshold` | No       | Bandwidth e.g. "10M", "512k", "1G" `{"type":"string"}`                                               |
| `burst_time`      | No       | Duration e.g. "8s" `{"type":"string"}`                                                               |
| `bucket_size`     | No       | `{"type":"string"}`                                                                                  |
| `priority`        | No       | 1 (highest) – 8 (lowest) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`         | No       | `{"type":"string"}`                                                                                  |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                                 |

## list_queue_trees

**List Queue Tree Entries** · Risk: **read**

Lists all hierarchical queue tree nodes (`/queue tree print`) on the device. Supports filtering by `name_filter` (substring match), `parent_filter` (exact interface or parent queue name), `disabled_only`, and `invalid_only`. Returns the shaping hierarchy; use `get_queue_tree` for full detail on one node. For flat per-target rate-limiting queues use `list_simple_queues`.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `parent_filter` | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_queue_tree

**Get Queue Tree Entry Detail** · Risk: **read**

Retrieves full detail for a single queue tree node (`/queue tree print detail where name=...`). Returns all attributes including bandwidth limits, parent, packet-mark, priority, qdisc reference, and enabled state, or a not-found message. Use `list_queue_trees` to discover names and `update_queue_tree` to modify. For simple per-target queues use `get_simple_queue`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_queue_tree

**Update Queue Tree Entry** · Risk: **write-idempotent**

Modifies an existing queue tree node (`/queue tree set [find name=...]`). Accepts `new_name`, `parent`, `queue` (qdisc reference from `create_queue_type`), `packet_mark`, bandwidth params (`max_limit`, `limit_at`, `burst_limit`, `burst_threshold` as RouterOS rate strings e.g. '10M', '512k', '1G'; `burst_time` e.g. '8s'), `priority` (1 highest – 8 lowest), `comment`, and `disabled`. Returns updated detail; if no parameters are specified returns 'No updates specified.' Use `get_queue_tree` to confirm current state before updating. For simple per-target queues use `update_simple_queue`.

| Parameter         | Required | Definition                                                                                           |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | `{"type":"string"}`                                                                                  |
| `new_name`        | No       | `{"type":"string"}`                                                                                  |
| `parent`          | No       | `{"type":"string"}`                                                                                  |
| `queue`           | No       | `{"type":"string"}`                                                                                  |
| `packet_mark`     | No       | `{"type":"string"}`                                                                                  |
| `max_limit`       | No       | Bandwidth e.g. "10M", "512k" `{"type":"string"}`                                                     |
| `limit_at`        | No       | Bandwidth e.g. "10M", "512k" `{"type":"string"}`                                                     |
| `burst_limit`     | No       | Bandwidth e.g. "10M", "512k" `{"type":"string"}`                                                     |
| `burst_threshold` | No       | Bandwidth e.g. "10M", "512k" `{"type":"string"}`                                                     |
| `burst_time`      | No       | Duration e.g. "8s" `{"type":"string"}`                                                               |
| `bucket_size`     | No       | `{"type":"string"}`                                                                                  |
| `priority`        | No       | 1 (highest) – 8 (lowest) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`         | No       | `{"type":"string"}`                                                                                  |
| `disabled`        | No       | `{"type":"boolean"}`                                                                                 |

## remove_queue_tree

**Remove Queue Tree Entry** · Risk: **destructive**

Permanently deletes a queue tree node (`/queue tree remove [find name=...]`). Child nodes that reference this entry as their `parent` will become invalid — remove or reparent them first. Returns a success or error message. Use `list_queue_trees` to identify the name. For simple per-target queues use `remove_simple_queue`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_queue_tree

**Enable Queue Tree Entry** · Risk: **write-idempotent**

Re-activates a disabled queue tree node (`/queue tree set [find name=...] disabled=no`). Restores the node's bandwidth-shaping rules in the hierarchy without modifying any other parameters. Returns the updated detail. To deactivate use `disable_queue_tree`. For simple per-target queues use `enable_simple_queue`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_queue_tree

**Disable Queue Tree Entry** · Risk: **write-idempotent**

Deactivates a queue tree node without removing it (`/queue tree set [find name=...] disabled=yes`). Suspends that node's bandwidth constraints while preserving its configuration; re-activate with `enable_queue_tree`. Returns the updated detail. For simple per-target queues use `disable_simple_queue`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_simple_queue

**Create Simple Queue** · Risk: **write**

Creates a flat per-target rate-limiting entry (`/queue simple add`) that shapes traffic for a specific IP address, CIDR subnet, or interface — the quickest way to cap upload/download bandwidth without building a queue tree hierarchy. `target` is the IP/CIDR or interface (e.g. '192.168.1.0/24', 'ether1'); `max_limit` caps bandwidth as 'UL/DL' or a single value (e.g. '10M/10M', '5M'); `limit_at` guarantees minimum bandwidth; `burst_limit`, `burst_threshold`, `burst_time` (e.g. '8s') allow short-term speed above `max_limit`; `queue` names the qdisc from `create_queue_type`. For packet-mark-based multi-level shaping use `create_queue_tree` instead. Returns the created entry's detail.

| Parameter         | Required | Definition                                                                                          |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | `{"type":"string"}`                                                                                 |
| `target`          | Yes      | IP/CIDR or interface e.g. "192.168.1.0/24" or "ether1" `{"type":"string"}`                          |
| `dst`             | No       | `{"type":"string"}`                                                                                 |
| `max_limit`       | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `limit_at`        | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_limit`     | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_threshold` | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_time`      | No       | Duration e.g. "8s" `{"type":"string"}`                                                              |
| `bucket_size`     | No       | `{"type":"string"}`                                                                                 |
| `queue`           | No       | `{"type":"string"}`                                                                                 |
| `parent`          | No       | `{"type":"string"}`                                                                                 |
| `priority`        | No       | 1 (highest) – 8 (lowest) `{"type":"string"}`                                                        |
| `packet_marks`    | No       | `{"type":"string"}`                                                                                 |
| `time`            | No       | Active time/days e.g. "0s-1d,sun,mon,tue,wed,thu,fri,sat" `{"type":"string"}`                       |
| `comment`         | No       | `{"type":"string"}`                                                                                 |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                                |

## list_simple_queues

**List Simple Queues** · Risk: **read**

Lists all per-target rate-limiting entries (`/queue simple print`) on the device. Supports filtering by `name_filter` (substring match), `target_filter` (substring match on IP/interface), `disabled_only`, and `invalid_only`. Returns all matching simple queue entries. Use `get_simple_queue` for full detail on a single entry. For the hierarchical shaping tree use `list_queue_trees`.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `target_filter` | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_simple_queue

**Get Simple Queue Detail** · Risk: **read**

Retrieves full detail for a single simple queue entry (`/queue simple print detail where name=...`). Returns target, bandwidth limits, burst parameters, qdisc reference, and enabled state, or a not-found message. Use `list_simple_queues` to discover names. For hierarchical queue nodes use `get_queue_tree`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_simple_queue

**Update Simple Queue** · Risk: **write-idempotent**

Modifies an existing per-target rate-limiting entry (`/queue simple set [find name=...]`). Accepts `new_name`, `target` (IP/CIDR or interface e.g. '192.168.1.0/24', 'ether1'), `dst`, bandwidth params (`max_limit`, `limit_at`, `burst_limit`, `burst_threshold` as 'UL/DL' or single value e.g. '10M/10M', '5M'; `burst_time` e.g. '8s'), `queue` (qdisc reference), `parent`, `priority` (1 highest – 8 lowest), `packet_marks`, `comment`, and `disabled`. Returns updated detail; if no parameters are provided returns 'No updates specified.' Use `get_simple_queue` to confirm current state first. For hierarchical queue nodes use `update_queue_tree`.

| Parameter         | Required | Definition                                                                                          |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | `{"type":"string"}`                                                                                 |
| `new_name`        | No       | `{"type":"string"}`                                                                                 |
| `target`          | No       | IP/CIDR or interface e.g. "192.168.1.0/24" or "ether1" `{"type":"string"}`                          |
| `dst`             | No       | `{"type":"string"}`                                                                                 |
| `max_limit`       | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `limit_at`        | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_limit`     | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_threshold` | No       | Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M" `{"type":"string"}` |
| `burst_time`      | No       | Duration e.g. "8s" `{"type":"string"}`                                                              |
| `bucket_size`     | No       | `{"type":"string"}`                                                                                 |
| `queue`           | No       | `{"type":"string"}`                                                                                 |
| `parent`          | No       | `{"type":"string"}`                                                                                 |
| `priority`        | No       | 1 (highest) – 8 (lowest) `{"type":"string"}`                                                        |
| `packet_marks`    | No       | `{"type":"string"}`                                                                                 |
| `time`            | No       | Active time/days e.g. "0s-1d,sun,mon,tue,wed,thu,fri,sat" `{"type":"string"}`                       |
| `comment`         | No       | `{"type":"string"}`                                                                                 |
| `disabled`        | No       | `{"type":"boolean"}`                                                                                |

## remove_simple_queue

**Remove Simple Queue** · Risk: **destructive**

Permanently deletes a simple queue entry (`/queue simple remove [find name=...]`). Removes the per-target rate limit for that IP/CIDR or interface. Returns a success or error message. Use `list_simple_queues` to identify the name. For hierarchical queue nodes use `remove_queue_tree`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_simple_queue

**Enable Simple Queue** · Risk: **write-idempotent**

Re-activates a disabled simple queue entry (`/queue simple set [find name=...] disabled=no`). Restores the per-target bandwidth shaping without altering any other parameters. Returns the updated detail. To deactivate use `disable_simple_queue`. For hierarchical queue nodes use `enable_queue_tree`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_simple_queue

**Disable Simple Queue** · Risk: **write-idempotent**

Deactivates a simple queue entry without removing it (`/queue simple set [find name=...] disabled=yes`). Suspends the per-target rate limit while preserving its configuration; re-activate with `enable_simple_queue`. Returns the updated detail. For hierarchical queue nodes use `disable_queue_tree`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
