---
title: "Address Sets"
description: "Versioned CIDR algebra, publication previews and guarded rollback of selected rule references."
---

## Tools

- [Compose an Address Set](#compose_address_set)
- [List Address Set Revisions](#list_address_sets)
- [Save Address Set Revision](#create_address_set)
- [Preview Address Set Publication or Rollback](#preview_address_set)
- [Apply Approved Address Set Preview](#apply_address_set)

## compose_address_set

**Compose an Address Set** · Risk: **read**

Pure IPv4/IPv6 CIDR union, intersection or difference. Normalizes, deduplicates and compacts exact coverage; returns checksum and exact address count. Source is a provenance label, never fetched/executed. No router or disk I/O.

| Parameter   | Required | Definition                                                                                                                                                                                                               |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`      | Yes      | `{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$"}`                                                                                                                                                         |
| `family`    | Yes      | `{"default":"ipv4","type":"string","enum":["ipv4","ipv6"]}`                                                                                                                                                              |
| `operation` | Yes      | `{"default":"union","type":"string","enum":["union","intersection","difference"]}`                                                                                                                                       |
| `left`      | Yes      | `{"minItems":1,"maxItems":2048,"type":"array","items":{"type":"string","maxLength":80}}`                                                                                                                                 |
| `right`     | Yes      | `{"default":[],"maxItems":2048,"type":"array","items":{"type":"string","maxLength":80}}`                                                                                                                                 |
| `source`    | Yes      | Provenance label, not a URL to fetch `{"type":"string","minLength":1,"maxLength":256}`                                                                                                                                   |
| `parent`    | No       | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## list_address_sets

**List Address Set Revisions** · Risk: **read**

Read the newest 100 locally persisted address-set revisions for the selected device, including publication state and rollback references. No router I/O.

No tool-specific parameters.

## create_address_set

**Save Address Set Revision** · Risk: **write**

Save an immutable non-empty CIDR composition with checksum, provenance and optional parent revision. Local write only; never changes a router. Input at most 2048 prefixes per operand, output at most 4096. Publication currently capped at 64 compacted prefixes to preserve Safe Mode undo coverage.

| Parameter   | Required | Definition                                                                                                                                                                                                               |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`      | Yes      | `{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$"}`                                                                                                                                                         |
| `family`    | Yes      | `{"default":"ipv4","type":"string","enum":["ipv4","ipv6"]}`                                                                                                                                                              |
| `operation` | Yes      | `{"default":"union","type":"string","enum":["union","intersection","difference"]}`                                                                                                                                       |
| `left`      | Yes      | `{"minItems":1,"maxItems":2048,"type":"array","items":{"type":"string","maxLength":80}}`                                                                                                                                 |
| `right`     | Yes      | `{"default":[],"maxItems":2048,"type":"array","items":{"type":"string","maxLength":80}}`                                                                                                                                 |
| `source`    | Yes      | Provenance label, not a URL to fetch `{"type":"string","minLength":1,"maxLength":256}`                                                                                                                                   |
| `parent`    | No       | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## preview_address_set

**Preview Address Set Publication or Rollback** · Risk: **read**

Read current rules and prepare a two-minute state-bound preview. Explicitly select 1–8 filter/mangle rule IDs, address-list fields and expected old list names. Creates a new generation without deleting old/manual entries. Rollback restores only these references, retaining generations. Never changes router configuration; use apply_address_set only after explicit review. Not an atomic packet-wide swap.

| Parameter          | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}`                                                                                                                                                                                      |
| `references`       | Yes      | `{"default":[],"maxItems":8,"type":"array","items":{"type":"object","properties":{"table":{"type":"string","enum":["filter","mangle"]},"id":{"type":"string","pattern":"^\\*[0-9A-Fa-f]+$"},"field":{"type":"string","enum":["src-address-list","dst-address-list"]},"expected":{"type":"string","minLength":1,"maxLength":128}},"required":["table","id","field","expected"],"additionalProperties":false}}` |
| `rollback`         | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                                          |
| `allowLargeChange` | Yes      | Explicitly acknowledge /0 or coverage changing by more than 50% of the parent `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                            |

## apply_address_set

**Apply Approved Address Set Preview** · Risk: **write**

After explicit confirmation: capture a local backup, acquire exclusive Safe Mode, recheck preview fingerprint, create the generation, switch only selected references, verify exact contents and commit. Maximum 64 prefixes + 8 references, SSH only. Failure/ambiguous commit is uncertain and never automatically retried. Rollback previews preserve all lists. Requires fresh preview id and confirm=true.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `planId`  | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
