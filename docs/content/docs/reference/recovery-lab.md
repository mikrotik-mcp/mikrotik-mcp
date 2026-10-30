---
title: "Recovery Lab"
description: "Isolated CHR rehearsal orchestration with immutable snapshot subsets, coverage and verified runner evidence."
---

## Tools

- [Read Recovery Lab](#get_recovery_lab)
- [Inspect Recovery Lab Inputs](#recovery_lab_inventory)
- [Prepare Isolated Recovery Rehearsal](#prepare_recovery_lab)
- [Start Approved Recovery Rehearsal](#start_recovery_lab)
- [Read Recovery Runner Evidence](#poll_recovery_lab)
- [Destroy Owned Disposable Lab](#destroy_recovery_lab)

## get_recovery_lab

**Read Recovery Lab** · Risk: **read**

Read device-scoped recovery rehearsals and last-known runner evidence. Local only, no router or runner contact. A passed portable subset is not proof of a full physical-router restore or production upgrade safety.

No tool-specific parameters.

## recovery_lab_inventory

**Inspect Recovery Lab Inputs** · Risk: **read**

List this router's local snapshots and read the administrator-configured runner's isolation claims and pinned CHR images. Does not provision VMs or transmit snapshots. Runner must be separately installed; no fallback to production routers.

No tool-specific parameters.

## prepare_recovery_lab

**Prepare Isolated Recovery Rehearsal** · Risk: **write**

Build a local immutable preview from an existing device-owned snapshot: allowlisted additive literal commands only, coverage counts, no secrets/scripts/management settings. No raw export upload, VM creation or router contact. Unknown scopes are excluded and remain untested. Preview expires in ten minutes.

| Parameter    | Required | Definition                                                                  |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `snapshotId` | Yes      | `{"type":"string","minLength":1,"maxLength":100}`                           |
| `version`    | Yes      | `{"type":"string","pattern":"^7\\.\\d+(?:\\.\\d+)?(?:beta\\d+\|rc\\d+)?$"}` |
| `mode`       | Yes      | `{"default":"restore","type":"string","enum":["restore","upgrade"]}`        |

## start_recovery_lab

**Start Approved Recovery Rehearsal** · Risk: **write**

Only after explicit approval, transmit the reviewed portable subset to the pinned isolated runner and request a disposable 15-minute CHR lab. Revalidate snapshot and runner capabilities. No production router I/O. An ambiguous request is never retried; poll the same ID. Requires a separately deployed runner implementing the documented protocol.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |

## poll_recovery_lab

**Read Recovery Runner Evidence** · Risk: **read**

Poll the exact existing rehearsal ID on its original approved runner. Check identity, request hash, target version, isolation, distinct checks and cleanup. Full pass requires authenticated boot/import/readback/reboot/isolation; excluded scopes and hardware remain untested. No write retry.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## destroy_recovery_lab

**Destroy Owned Disposable Lab** · Risk: **destructive**

After explicit confirmation, request destruction of the VM/resources belonging only to this submitted rehearsal ID on its original runner. Local evidence is retained. Requires verified destruction response; never destroys production devices or accepts arbitrary VM IDs.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
