---
title: "Parental Controls"
description: "Time-of-day internet policy per device address-list (scheduled drop) plus DNS content sinkholes, with preview-before-apply."
---

## Tools

- [Set Time-of-Day / Parental Policy](#set_time_policy)
- [Remove Time-of-Day / Parental Policy](#remove_time_policy)

## set_time_policy

**Set Time-of-Day / Parental Policy** · Risk: **write**

Schedules per-device internet access and content blocking. Cuts internet for devices in the `list` address-list between `block_start` and `block_end` daily (a forward-drop rule toggled by two schedulers), optionally adds `addresses` to that list, and DNS-sinkholes any `block_domains` (always blocked). DEFAULTS TO A DRY RUN (`apply=false`) showing every command; set `apply=true` to install. Everything is tagged 'parental-<name>' so remove_time_policy can undo it. Returns the plan or a build report.

| Parameter       | Required | Definition                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------- |
| `name`          | Yes      | Policy id, e.g. 'kids-bedtime' `{"type":"string"}`                                    |
| `list`          | Yes      | Address-list of the affected devices `{"default":"parental-devices","type":"string"}` |
| `addresses`     | No       | Device IPs to add to the list `{"type":"array","items":{"type":"string"}}`            |
| `block_start`   | Yes      | Daily cut-off time (HH:MM) `{"default":"22:00","type":"string"}`                      |
| `block_end`     | Yes      | Daily restore time (HH:MM) `{"default":"07:00","type":"string"}`                      |
| `block_domains` | No       | Domains to always block via DNS `{"type":"array","items":{"type":"string"}}`          |
| `apply`         | Yes      | false = preview (default); true = install `{"default":false,"type":"boolean"}`        |

## remove_time_policy

**Remove Time-of-Day / Parental Policy** · Risk: **destructive**

Removes a policy installed by set_time_policy: the schedulers, the forward-drop rule, and the DNS sinkhole entries tagged 'parental-<name>'. Address-list members added for it are also removed. Returns what was cleared.

| Parameter | Required | Definition                                             |
| --------- | -------- | ------------------------------------------------------ |
| `name`    | Yes      | The policy id used when installing `{"type":"string"}` |
