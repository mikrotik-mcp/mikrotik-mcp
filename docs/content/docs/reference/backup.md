---
title: "Backup"
description: "Binary backups, text exports, file transfer and restore."
---

## Tools

- [Create System Backup](#create_backup)
- [List Backup Files](#list_backups)
- [Create Full Configuration Export](#create_export)
- [Export Configuration Section](#export_section)
- [Download File from Device](#download_file)
- [Upload File to Device](#upload_file)
- [Restore System Backup](#restore_backup)
- [Import RouterOS Configuration Script](#import_configuration)
- [Remove File from Device](#remove_file)
- [Get Backup File Details](#backup_info)

## create_backup

**Create System Backup** · Risk: **write**

Creates a binary system backup (`/system backup save`) — a full encrypted snapshot of all device configuration, suitable for disaster recovery and full-config restore. Unlike `create_export` or `export_section` which produce human-readable text files, this produces an opaque `.backup` binary that can only be applied via `restore_backup`. Name defaults to `backup_<device-datetime>` if omitted; `dont_encrypt=true` skips encryption; `include_password=false` omits credentials from the snapshot. Returns file details of the created `.backup` file on success.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `name`             | No       | `{"type":"string"}`                  |
| `dont_encrypt`     | Yes      | `{"default":false,"type":"boolean"}` |
| `include_password` | Yes      | `{"default":true,"type":"boolean"}`  |
| `comment`          | No       | `{"type":"string"}`                  |

## list_backups

**List Backup Files** · Risk: **read**

Lists `.backup` binary files on the device filesystem (`/file print where type=backup`). By default shows only binary backup files; set `include_exports=true` to also include `.rsc` script files. Filter by name substring with `name_filter`. For detailed metadata on a specific file use `backup_info`. Returns a table of matching files or a not-found message.

| Parameter         | Required | Definition                           |
| ----------------- | -------- | ------------------------------------ |
| `name_filter`     | No       | `{"type":"string"}`                  |
| `include_exports` | Yes      | `{"default":false,"type":"boolean"}` |

## create_export

**Create Full Configuration Export** · Risk: **read**

Exports the complete device configuration to a `.rsc` plain-text script file (`/export file=<name>`), re-applicable via `import_configuration`. Unlike `create_backup`, the result is human-readable plain text — not a binary snapshot — and passwords are hidden by default (`hide_sensitive=true`). `file_format` changes only the file extension used when looking up the saved file — no `format=` flag is ever sent to RouterOS, so the content is always RouterOS script text regardless of the chosen extension; selecting `json` or `xml` will also cause the post-export file lookup to fail because RouterOS saves the file as `.rsc`. ALWAYS default to a FULL configuration export: leave `compact` and `verbose` off (the plain full export) unless the user explicitly asks for less or more. Set `compact` ONLY when the user wants a smaller diff that omits default values, or `verbose` ONLY when they want every parameter (including defaults). `export_type` only controls where the `file=` argument is positioned in the command and does not independently drive compactness or verbosity. For a single subsection only use `export_section`. Returns file details of the created export file.

| Parameter        | Required | Definition                                                               |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `name`           | No       | `{"type":"string"}`                                                      |
| `file_format`    | Yes      | `{"default":"rsc","type":"string","enum":["rsc","json","xml"]}`          |
| `export_type`    | Yes      | `{"default":"full","type":"string","enum":["full","compact","verbose"]}` |
| `hide_sensitive` | Yes      | `{"default":true,"type":"boolean"}`                                      |
| `verbose`        | Yes      | `{"default":false,"type":"boolean"}`                                     |
| `compact`        | Yes      | `{"default":false,"type":"boolean"}`                                     |
| `comment`        | No       | `{"type":"string"}`                                                      |

## export_section

**Export Configuration Section** · Risk: **read**

Exports one RouterOS subsection to a `.rsc` script file (`/<section> export file=<name>`). Use when you need only a partial config snapshot rather than the full device export. `section` is the RouterOS command path without a leading slash — e.g. "ip address", "interface vlan", "ip firewall filter", "ip firewall nat", "queue simple". For the full device configuration use `create_export`; to apply the resulting file use `import_configuration`. Returns file details of the created `.rsc` file.

| Parameter        | Required | Definition                           |
| ---------------- | -------- | ------------------------------------ |
| `section`        | Yes      | `{"type":"string"}`                  |
| `name`           | No       | `{"type":"string"}`                  |
| `hide_sensitive` | Yes      | `{"default":true,"type":"boolean"}`  |
| `compact`        | Yes      | `{"default":false,"type":"boolean"}` |

## download_file

**Download File from Device** · Risk: **read**

Downloads a file from the device filesystem over SFTP and returns its raw bytes base64-encoded as `FILE_CONTENT_BASE64:<data>`. Works for any file type — `.backup`, `.rsc`, `.p12` certificates, keys, etc. Verifies file existence first (`/file print count-only`). The SSH user MUST have the `read` policy (and `sensitive` for `.backup` / certificate files) on RouterOS for SFTP downloads to work. NOT available on MAC-Telnet devices (Layer-2 has no file transfer). To list available files use `list_backups`; for file metadata use `backup_info`; to push a file onto the device use `upload_file`.

| Parameter  | Required | Definition                                                                             |
| ---------- | -------- | -------------------------------------------------------------------------------------- |
| `filename` | Yes      | Name of the file on the device, e.g. 'cert.p12' or 'backup.backup' `{"type":"string"}` |

## upload_file

**Upload File to Device** · Risk: **write**

Transfer a file to the device filesystem over SFTP (the file subsystem RouterOS exposes on its SSH server) — this actually pushes the bytes, then verifies the file appears in `/file`. Use it to put a file on the router before another tool can use it: a `.rsc` config script (then apply with `import_configuration`), a `.backup` file (then `restore_backup`), or a certificate/key (then `import_certificate`). `filename` is the DESTINATION path on the device — root by default (e.g. `config.rsc`), or an external-disk path (e.g. `disk1/cert.pem`). `content_base64` is the file's raw bytes, base64-encoded (binary-safe — works for `.backup`/cert files, not just text). Overwrites any existing file of the same name. NOT available on MAC-Telnet devices (Layer-2 has no file transfer) — there, have the router pull the file itself with `/tool fetch` from a reachable URL.

| Parameter        | Required | Definition                                                                                |
| ---------------- | -------- | ----------------------------------------------------------------------------------------- |
| `filename`       | Yes      | Destination path on the device, e.g. 'config.rsc' or 'disk1/cert.pem' `{"type":"string"}` |
| `content_base64` | Yes      | File bytes, base64-encoded (binary-safe) `{"type":"string"}`                              |

## restore_backup

**Restore System Backup** · Risk: **dangerous**

Loads a `.backup` file from the device filesystem and replaces the running configuration (`/system backup load`). DANGEROUS: the device REBOOTS immediately — all current config is replaced with the snapshot. Verifies file existence first (`/file print count-only`). Provide `password` if the backup was created with encryption. For applying a text `.rsc` script without rebooting use `import_configuration`; to create a new backup first use `create_backup`.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `filename` | Yes      | `{"type":"string"}` |
| `password` | No       | `{"type":"string"}` |

## import_configuration

**Import RouterOS Configuration Script** · Risk: **dangerous**

Executes a `.rsc` script file already on the device filesystem (`/import file=<filename>`). Use to apply a configuration exported by `create_export` or `export_section`. DANGEROUS: the script's commands run immediately and can overwrite live configuration; unlike `restore_backup` no reboot is triggered. `run_after_reset=true` defers execution until after the next factory-reset; `verbose=true` logs each command as it runs. Returns the script execution output or a success message.

| Parameter         | Required | Definition                           |
| ----------------- | -------- | ------------------------------------ |
| `filename`        | Yes      | `{"type":"string"}`                  |
| `run_after_reset` | Yes      | `{"default":false,"type":"boolean"}` |
| `verbose`         | Yes      | `{"default":false,"type":"boolean"}` |

## remove_file

**Remove File from Device** · Risk: **dangerous**

Permanently deletes a named file from the device filesystem (`/file remove <filename>`). DANGEROUS: deletion is immediate and irreversible — applies to any file type (`.backup`, `.rsc`, logs, etc.). Verifies existence first via `/file print count-only`; returns success or a not-found message.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `filename` | Yes      | `{"type":"string"}` |

## backup_info

**Get Backup File Details** · Risk: **read**

Returns detailed metadata for a specific file on the device filesystem (`/file print detail where name=<filename>`). Shows size, creation time, type, and other file attributes. For scanning all backup files use `list_backups`; to retrieve the file contents use `download_file`.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `filename` | Yes      | `{"type":"string"}` |
