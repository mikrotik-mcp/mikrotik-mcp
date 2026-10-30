---
title: "Local Backups"
description: "A local backup vault on the MCP server's own filesystem: create timestamped `/export` `.rsc` backups, list/read/rename/delete them, and restore one onto a device via Safe Mode."
---

## Tools

- [Create Local Config Backup (host vault)](#create_local_backup)
- [List Local Config Backups (host vault)](#list_local_backups)
- [Get Local Config Backup Contents (host vault)](#get_local_backup)
- [Rename Local Config Backup (host vault)](#rename_local_backup)
- [Delete Local Config Backup (host vault)](#delete_local_backup)
- [Restore Local Config Backup to Device (Safe Mode)](#restore_local_backup)

## create_local_backup

**Create Local Config Backup (host vault)** · Risk: **write**

Captures the device's full configuration with `/export` and saves it as a timestamped plain-text `.rsc` file in the MCP server's LOCAL backup vault (default `~/.mikrotik-mcp/backups/`, override with the `MIKROTIK_BACKUP_DIR` env var) — NOT on the device and NOT in S3. The filename is `<device-slug>_<date_time>.rsc` — the device name is slugified (spaces/underscores/etc → dash) — stamped in the device's local clock (24-hour; Jalali for the Tehran timezone, Gregorian otherwise). This is a host-side, human-readable, diffable copy you can restore later with restore_local_backup. Compare: create_backup makes a binary `/system backup` file ON the device; capture_config_snapshot stores an export in the local snapshot database; upload_backup_to_s3 pushes to S3. ALWAYS default to a FULL backup of the complete configuration: call this with no option flags (the bare `/export`) unless the user explicitly asks for less or more. Narrow it ONLY on request — set compact to drop default values, or use export_section for a single subsection. Broaden it ONLY on request — set verbose to include every parameter (even defaults), show_sensitive to include secrets (keys/passwords), or use create_backup for a binary full-system snapshot. terse just changes the text to one machine-readable line per item. Returns the saved filename, byte size and vault path.

| Parameter        | Required | Definition                                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `label`          | No       | Optional label appended to the filename, e.g. "pre-upgrade". `{"type":"string"}`                              |
| `show_sensitive` | Yes      | Include secrets (keys/passwords) in the export. Default false. `{"default":false,"type":"boolean"}`           |
| `verbose`        | Yes      | Include every parameter, even defaults (RouterOS `verbose`). `{"default":false,"type":"boolean"}`             |
| `compact`        | Yes      | Export only non-default values (RouterOS `compact`; ignored if verbose). `{"default":false,"type":"boolean"}` |
| `terse`          | Yes      | One self-contained, machine-readable line per item (RouterOS `terse`). `{"default":false,"type":"boolean"}`   |

## list_local_backups

**List Local Config Backups (host vault)** · Risk: **read**

Lists the `/export` config backups stored in the MCP server's LOCAL backup vault (`~/.mikrotik-mcp/backups/` or `MIKROTIK_BACKUP_DIR`) — each with its filename, source device, byte size and capture time, newest first. These are host-side text backups created by create_local_backup, distinct from list_backups (binary `.backup` files ON the device) and list_s3_backups (objects in an S3 bucket). Use a returned filename with get_local_backup, restore_local_backup, rename_local_backup or delete_local_backup.

No tool-specific parameters.

## get_local_backup

**Get Local Config Backup Contents (host vault)** · Risk: **read**

Returns the full `/export` `.rsc` text of one backup in the MCP server's LOCAL vault, by filename (get the name from list_local_backups). This is the exact configuration script that restore_local_backup would replay onto a device — useful for reviewing or diffing a saved config before restoring. Returns a 'not found' message if the filename doesn't exist. `name` is the exact filename from list_local_backups.

| Parameter | Required | Definition                                                            |
| --------- | -------- | --------------------------------------------------------------------- |
| `name`    | Yes      | Backup filename, e.g. 'edge_2026-06-25_1430.rsc'. `{"type":"string"}` |

## rename_local_backup

**Rename Local Config Backup (host vault)** · Risk: **write-idempotent**

Renames a backup file in the MCP server's LOCAL vault (e.g. to label it 'pre-upgrade' or 'golden'). Forces an `.rsc` extension and refuses if the target name already exists. Host-side only — it does NOT touch the device or S3. `name` is the current filename (from list_local_backups); `new_name` is the desired filename. Returns the new filename.

| Parameter  | Required | Definition                                                                   |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| `name`     | Yes      | Current backup filename. `{"type":"string"}`                                 |
| `new_name` | Yes      | Desired filename (an `.rsc` suffix is added if missing). `{"type":"string"}` |

## delete_local_backup

**Delete Local Config Backup (host vault)** · Risk: **destructive**

Permanently deletes one backup file from the MCP server's LOCAL vault by filename. This removes only the host-side copy — it does NOT touch the device's configuration, its on-device `.backup` files, or any S3 object. Use list_local_backups to find the name; for deleting an S3 object use delete_s3_backup instead. Returns a 'not found' message if the filename doesn't exist.

| Parameter | Required | Definition                                     |
| --------- | -------- | ---------------------------------------------- |
| `name`    | Yes      | Backup filename to delete. `{"type":"string"}` |

## restore_local_backup

**Restore Local Config Backup to Device (Safe Mode)** · Risk: **dangerous**

Replays a LOCAL vault backup's `/export` configuration onto a device INSIDE RouterOS Safe Mode — every command is held in memory and AUTO-REVERTS if the SSH session drops, so a change that would lock you out is undone instead of sticking. With confirm=false (default) it applies the whole config, then rolls it all back — a true dry-run that proves the restore runs cleanly. With confirm=true it commits, but ONLY after verifying the device still answers. Because a `/export` is additive, restoring onto an already-configured device LAYERS the saved config on top (duplicate rules are possible) — it is cleanest on a freshly reset device. Requires SSH (Safe Mode is not available on MAC-Telnet devices). Alternatives: import_configuration runs a `.rsc` already ON the device; restore_backup loads a binary `.backup` (and reboots). `name` is the filename from list_local_backups.

| Parameter | Required | Definition                                                                                                      |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `name`    | Yes      | Backup filename to restore (from list_local_backups). `{"type":"string"}`                                       |
| `confirm` | Yes      | false = apply, then roll back (dry-run). true = commit if still reachable. `{"default":false,"type":"boolean"}` |
