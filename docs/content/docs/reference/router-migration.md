---
title: "Router Migration"
description: "Capability-aware router replacement, port mapping, Safe Mode rehearsal and inactive staging."
---

## Tools

- [Inspect Router Migration Capabilities](#inspect_router_migration)
- [Preview a Router Replacement](#preview_router_migration)
- [Read Router Migration Plans](#list_router_migrations)
- [Rehearse or Stage an Approved Migration](#apply_router_migration)
- [Remove Unchanged Staged Migration Objects](#undo_router_migration)

## inspect_router_migration

**Inspect Router Migration Capabilities** · Risk: **read**

Read router hardware, RouterOS version, installed packages and interfaces for a replacement migration. Does not expose the raw export or change configuration. Use a dedicated, unmapped management port on target.

No tool-specific parameters.

## preview_router_migration

**Preview a Router Replacement** · Risk: **write**

Read source and target, map physical Ethernet ports and persist a five-minute, device-bound staging plan. Select supported sections; incompatible fields, collisions and unresolved dependencies BLOCK staging. Lists ALL unselected/unsupported sections as manual work. Same RouterOS 7 version required. Never copies credentials, certificates, scripts, Wi-Fi drivers or VPN secrets, and never changes target management. Preview changes local state only.

| Parameter             | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`              | Yes      | `{"type":"string","minLength":1,"maxLength":120}`                                                                                                                                                                                                                                                                                                                                         |
| `target`              | Yes      | `{"type":"string","minLength":1,"maxLength":120}`                                                                                                                                                                                                                                                                                                                                         |
| `managementInterface` | Yes      | `{"type":"string","minLength":1,"maxLength":80}`                                                                                                                                                                                                                                                                                                                                          |
| `mapping`             | Yes      | `{"type":"object","propertyNames":{"type":"string","minLength":1,"maxLength":80},"additionalProperties":{"type":"string","minLength":1,"maxLength":80}}`                                                                                                                                                                                                                                  |
| `sections`            | Yes      | `{"minItems":1,"maxItems":15,"type":"array","items":{"type":"string","enum":["/interface/bridge","/interface/vlan","/interface/list","/interface/list/member","/interface/bridge/port","/ip/pool","/ip/address","/ip/dhcp-server/network","/ip/dhcp-server","/ip/dhcp-server/lease","/routing/table","/ip/route","/ip/firewall/address-list","/ip/firewall/filter","/ip/firewall/nat"]}}` |

## list_router_migrations

**Read Router Migration Plans** · Risk: **read**

Read durable migration previews, backup references, rehearsal/staging outcomes and manual cutover items for the selected TARGET router.

No tool-specific parameters.

## apply_router_migration

**Rehearse or Stage an Approved Migration** · Risk: **write**

Only after user reviews the exact preview: back up source and target locally, reject stale state, acquire NEW Safe Mode, apply at most 60 additive objects and read each back. Default rehearse rolls back and verifies the original export; stage commits INACTIVE addresses, ports, DHCP, routes and firewall rules. Never resets a router or activates duplicate networks. Manual physical cutover, secrets and application verification remain required. No direct-write fallback; uncertain results must not be retried.

| Parameter           | Required | Definition                                                                                                                                                                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `mode`              | Yes      | `{"default":"rehearse","type":"string","enum":["rehearse","stage"]}`                                                                                                                                                     |
| `confirm`           | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
| `acknowledgeManual` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |

## undo_router_migration

**Remove Unchanged Staged Migration Objects** · Risk: **destructive**

After explicit approval remove ONLY this plan's staged objects under Safe Mode, provided none was edited or activated. Verify target export matches pre-migration snapshot before commit. Refuses uncertain migrations; never wipes unrelated target configuration.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
