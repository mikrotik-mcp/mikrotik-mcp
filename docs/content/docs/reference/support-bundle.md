---
title: "Support Bundles"
description: "Minimised, pseudonymised local incident evidence with reviewed HTML/JSON export."
---

## Tools

- [Prepare a Minimised Support Report](#create_support_bundle)
- [Read Local Support Reports](#list_support_bundles)
- [Export a Reviewed Support Report](#export_support_bundle)
- [Delete a Local Support Report](#delete_support_bundle)

## create_support_bundle

**Prepare a Minimised Support Report** · Risk: **write**

Build a local support package for at most seven days using selected investigations, event metadata, snapshot section counts and client-check summaries. No live router queries or uploads. Excludes raw logs/exports/tool bodies, secrets, comments and personal labels BEFORE persistence; aliases network identifiers consistently within this bundle. Missing evidence remains unknown. Review timestamps/counts/relationships before sharing: minimisation is not absolute anonymity.

| Parameter          | Required | Definition                                                                                                                                                                                                                                                                   |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`            | Yes      | `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`                                                                                                                                                                                                         |
| `until`            | Yes      | `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`                                                                                                                                                                                                         |
| `cases`            | Yes      | `{"default":[],"maxItems":10,"type":"array","items":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}` |
| `includeEvents`    | Yes      | `{"default":true,"type":"boolean"}`                                                                                                                                                                                                                                          |
| `includeSnapshots` | Yes      | `{"default":true,"type":"boolean"}`                                                                                                                                                                                                                                          |
| `includeChecks`    | Yes      | `{"default":true,"type":"boolean"}`                                                                                                                                                                                                                                          |

## list_support_bundles

**Read Local Support Reports** · Risk: **read**

Read minimised locally saved support reports for this router. Does not send reports to anyone.

No tool-specific parameters.

## export_support_bundle

**Export a Reviewed Support Report** · Risk: **read**

Return a saved, minimised support report as JSON or self-contained script-free HTML. No filesystem path or external destination is accepted. Review before sharing; no automatic upload.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `format`  | Yes      | `{"default":"json","type":"string","enum":["json","html"]}`                                                                                                                                                              |

## delete_support_bundle

**Delete a Local Support Report** · Risk: **write**

Delete this saved minimised report only after explicit approval. Original investigations, snapshots and events are retained; exported copies cannot be revoked.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
