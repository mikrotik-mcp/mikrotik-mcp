---
title: "S3 Backup"
description: "Optional: ship device backups/exports to S3-compatible storage, organised per device (`/tool fetch` + Bun S3)."
---

## Tools

- [Check S3 Backup Configuration Status](#s3_backup_status)
- [Upload Device Backup File to S3](#upload_backup_to_s3)
- [Download S3 Backup File to Device](#download_backup_from_s3)
- [List S3 Backup Objects](#list_s3_backups)
- [Get S3 Backup Object Metadata](#s3_backup_info)
- [Delete S3 Backup Object](#delete_s3_backup)

## s3_backup_status

**Check S3 Backup Configuration Status** · Risk: **read**

Report whether S3 backup storage is enabled and show the configured target bucket/endpoint (MCP-side check only — no RouterOS command is executed). Use this to verify the S3 integration is active before attempting uploads or downloads; if disabled, the response includes the required environment variables / config block. For uploading a device file to S3 use upload_backup_to_s3; for listing stored objects use list_s3_backups. Returns 'ENABLED' with the target endpoint, or 'DISABLED' with setup instructions.

No tool-specific parameters.

## upload_backup_to_s3

**Upload Device Backup File to S3** · Risk: **write**

Upload a file from the RouterOS device filesystem to the configured S3-compatible bucket (`/tool fetch` with `http-method=put` via a server-side presigned PUT URL). Solves the problem of pushing `.backup` or `.rsc` export files from the router to cloud storage without routing bytes through this MCP process — the device streams directly to S3. First verifies the file exists on the device via `/file print count-only`; fails clearly if S3 is not configured. For downloading a stored object back to the device use download_backup_from_s3; for listing what is already in S3 use list_s3_backups; to check S3 is configured use s3_backup_status.

Notes:
filename: the on-device filename, e.g. 'daily.backup'.
key: optional S3 object key; defaults to '<prefix>/<device>/<device-datetime>-<filename>' stamped with the DEVICE's local date-time (Jalali calendar in Tehran, Gregorian elsewhere) so repeat uploads version automatically instead of overwriting.
expires_in: presigned-URL lifetime in seconds (minimum 60).
Returns the final S3 key and target endpoint on success.

| Parameter    | Required | Definition                                                                                     |
| ------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `filename`   | Yes      | File on the device, e.g. 'daily.backup' `{"type":"string"}`                                    |
| `key`        | No       | S3 object key (defaults to prefix + device-local datetime + filename) `{"type":"string"}`      |
| `expires_in` | No       | Presigned-URL lifetime in seconds `{"type":"integer","minimum":60,"maximum":9007199254740991}` |

## download_backup_from_s3

**Download S3 Backup File to Device** · Risk: **write**

Download an object from the configured S3 bucket onto the RouterOS device filesystem (`/tool fetch` via a server-side presigned GET URL). Use this to stage a previously uploaded backup or export onto the router before restoring it — bytes stream directly from S3 to the device without passing through this MCP process. For uploading a device file to S3 use upload_backup_to_s3; to find available object keys use list_s3_backups; to inspect a key's metadata before downloading use s3_backup_info.

Notes:
key: the exact S3 object key to download (get it from list_s3_backups).
filename: optional device destination path; defaults to the key's basename.
expires_in: presigned-URL lifetime in seconds (minimum 60).
Returns the S3 key and device filename on success.

| Parameter    | Required | Definition                                                                                     |
| ------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `key`        | Yes      | S3 object key to download `{"type":"string"}`                                                  |
| `filename`   | No       | Device destination filename (defaults to the key basename) `{"type":"string"}`                 |
| `expires_in` | No       | Presigned-URL lifetime in seconds `{"type":"integer","minimum":60,"maximum":9007199254740991}` |

## list_s3_backups

**List S3 Backup Objects** · Risk: **read**

List objects in the configured S3 bucket (MCP-side `S3.list()` call — no RouterOS command is executed). Use this to discover available backup keys before downloading or deleting. By default scopes to this device's prefix (`<prefix>/<device>/`); pass an explicit `prefix` (including `''` for the entire bucket) to list backups for all devices or arbitrary paths. For metadata on a specific key use s3_backup_info; to download a key to the device use download_backup_from_s3; to delete a key use delete_s3_backup; to upload a new file use upload_backup_to_s3. Returns each object's key, size in bytes, and last-modified timestamp (up to `max_keys`, 1–1000); indicates if results are truncated.

| Parameter  | Required | Definition                                                                                                 |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `prefix`   | No       | Key prefix to list under (defaults to this device's '<prefix>/<device>/') `{"type":"string"}`              |
| `max_keys` | Yes      | Maximum number of objects to return (1-1000) `{"default":100,"type":"integer","minimum":1,"maximum":1000}` |

## s3_backup_info

**Get S3 Backup Object Metadata** · Risk: **read**

Retrieve metadata for a single S3 object (`S3.stat()` server-side — no RouterOS command is executed): size in bytes, content-type, ETag, and last-modified timestamp. Use this to verify an upload completed correctly or to inspect a backup before downloading it. To list all available keys first use list_s3_backups; to download the object to the device use download_backup_from_s3; to delete it use delete_s3_backup. `key` is the exact S3 object key as returned by list_s3_backups. Returns 'not found' if the key does not exist.

| Parameter | Required | Definition                        |
| --------- | -------- | --------------------------------- |
| `key`     | Yes      | S3 object key `{"type":"string"}` |

## delete_s3_backup

**Delete S3 Backup Object** · Risk: **destructive**

Permanently delete a single object from the configured S3 bucket (`S3.delete()` server-side — no RouterOS command is executed). Use this to clean up old or superseded backup files from S3 storage; the operation is irreversible. To list available keys before deleting use list_s3_backups; to inspect an object's metadata first use s3_backup_info; to upload new backups use upload_backup_to_s3. `key` is the exact S3 object key as returned by list_s3_backups. Returns a 'not found' message if the key does not exist.

| Parameter | Required | Definition                                  |
| --------- | -------- | ------------------------------------------- |
| `key`     | Yes      | S3 object key to delete `{"type":"string"}` |
