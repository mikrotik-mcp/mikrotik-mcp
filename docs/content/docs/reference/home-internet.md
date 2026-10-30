---
title: "Home Internet"
description: "Plain-language internet diagnosis, household inventory and approved temporary client policies with bounded path comparisons."
---

## Tools

- [Why Is My Internet Slow?](#diagnose_home_internet)
- [Compare Internet Paths](#compare_home_paths)
- [Read Household Internet Workspace](#get_home_internet)
- [Discover Household Devices](#refresh_home_devices)
- [Name a Household Device](#name_home_device)
- [Preview a Temporary Household Policy](#preview_home_policy)
- [Apply an Approved Household Policy](#apply_home_policy)
- [Undo a Household Policy](#undo_home_policy)

## diagnose_home_internet

**Why Is My Internet Slow?** · Risk: **read**

Start here when a household client reports slow internet. Read router CPU/memory, client Wi-Fi signal, DNS, exact-IP queues and five bounded router ICMP probes. Return plain-language observed facts, suspected causes and unknowns with next steps. Never changes MTU/config, enables accounting or claims client application success. No throughput test is run.

| Parameter | Required | Definition                                                                                                                                                                   |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`  | Yes      | `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}` |
| `target`  | Yes      | `{"default":"example.com","type":"string","maxLength":253,"pattern":"^[a-z\\d](?:[a-z\\d.-]*[a-z\\d])?$"}`                                                                   |

## compare_home_paths

**Compare Internet Paths** · Risk: **read**

Compare up to three existing enabled FIB routing tables with five ICMP probes each to one explicit IPv4 target. For calls/gaming suggest the lowest-loss/latency candidate; download throughput is unmeasured, so no fastest-download recommendation. Router output mangle may affect probes. Selection is separate: preview_home_policy, then explicit user approval and apply_home_policy. Never switches routes automatically.

| Parameter | Required | Definition                                                                                                                                                                   |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`  | Yes      | `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}` |
| `tables`  | Yes      | `{"minItems":1,"maxItems":3,"type":"array","items":{"type":"string","minLength":1,"maxLength":64}}`                                                                          |
| `goal`    | Yes      | `{"default":"calls","type":"string","enum":["calls","gaming","download"]}`                                                                                                   |

## get_home_internet

**Read Household Internet Workspace** · Risk: **read**

Read locally saved household device names, people, newly discovered devices and temporary policy history for this router. Historical policy status is not current router proof. No router queries; refresh_home_devices explicitly collects current DHCP records and available routing tables.

No tool-specific parameters.

## refresh_home_devices

**Discover Household Devices** · Risk: **write**

Read DHCP clients and routing tables, saving a local first/last-seen household inventory. First scan establishes a baseline; later new MACs appear as unacknowledged notices. No router writes or background scans. WRITE reflects local persistence. Randomized MACs may look like new devices; absence does not prove offline.

No tool-specific parameters.

## name_home_device

**Name a Household Device** · Risk: **write**

Save a friendly device name and person locally and acknowledge its new-device notice. Does not modify router DHCP, reserve an IP or change access.

| Parameter | Required | Definition                                                       |
| --------- | -------- | ---------------------------------------------------------------- |
| `mac`     | Yes      | `{"type":"string","pattern":"^(?:[\\da-f]{2}:){5}[\\da-f]{2}$"}` |
| `name`    | Yes      | `{"type":"string","maxLength":80}`                               |
| `person`  | Yes      | `{"default":"","type":"string","maxLength":80}`                  |

## preview_home_policy

**Preview a Temporary Household Policy** · Risk: **write**

Prepare a device-bound five-minute consent preview for a reserved IPv4 DHCP client: pause routed access, raise an existing child queue to meeting priority, or select an existing route table. Duration 5–120 minutes; optional start delay up to 24h. Local preview only, no router changes. Fails closed on FastTrack, ambiguous leases, conflicting route marks or missing QoS. Pause refuses IPv6 forwarding. Review exact commands, limitations and expiry with the user before applying.

| Parameter        | Required | Definition                                                       |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `mac`            | Yes      | `{"type":"string","pattern":"^(?:[\\da-f]{2}:){5}[\\da-f]{2}$"}` |
| `action`         | Yes      | `{"type":"string","enum":["pause","priority","route"]}`          |
| `minutes`        | Yes      | `{"default":30,"type":"integer","minimum":5,"maximum":120}`      |
| `startInMinutes` | Yes      | `{"default":0,"type":"integer","minimum":0,"maximum":1440}`      |
| `table`          | No       | `{"type":"string","minLength":1,"maxLength":64}`                 |

## apply_home_policy

**Apply an Approved Household Policy** · Risk: **write**

Only after explicit user approval of preview_home_policy: consume its one-use ID, recheck unchanged router state, save a local snapshot, apply in a NEW Safe Mode session, install router-side expiry and commit. No direct-write fallback. Scheduled policies expire even if MCP stops; priority restoration requires scheduler permission. Existing sessions may disconnect. Uncertain results must be inspected/undone, never blindly retried.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |

## undo_home_policy

**Undo a Household Policy** · Risk: **write**

With user confirmation remove only this policy's tagged rules/timers and restore its previous queue priority when the queue still matches. Works from durable history after an MCP restart. Does not restore an entire config or touch unrelated rules. Use to reconcile expired or uncertain policies too.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
