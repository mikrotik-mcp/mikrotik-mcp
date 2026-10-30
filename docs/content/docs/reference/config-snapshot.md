---
title: "Config Snapshots"
description: "Capture point-in-time `/export` snapshots locally and time-travel diff any two (or against the live device) to see exactly what changed."
---

## Tools

- [Capture RouterOS Configuration Snapshot](#capture_config_snapshot)
- [List RouterOS Configuration Snapshots](#list_config_snapshots)
- [Get RouterOS Configuration Snapshot Body](#get_config_snapshot)
- [Diff RouterOS Configuration Snapshots](#diff_config_snapshots)
- [Remove RouterOS Configuration Snapshots](#remove_config_snapshot)

## capture_config_snapshot

**Capture RouterOS Configuration Snapshot** · Risk: **write**

Runs `/export` (or `/<section> export` when `section` is set) on the device and persists the output as a timestamped snapshot in the local MCP-host SQLite database (`~/.mikrotik-mcp/snapshots.db`) — not on the device filesystem. Use this to build a configuration history that survives device reboots and can be diffed later to answer 'what changed since X?'. If the content SHA matches the previous snapshot and force=false (default), nothing is written and a 'no change' message is returned; set force=true to store unconditionally. Limit to one RouterOS section via `section` (e.g. "ip firewall filter"); sensitive values (passwords, keys) are redacted unless show_sensitive=true. To compare snapshots use diff_config_snapshots; to read a stored body use get_config_snapshot; to browse stored entries use list_config_snapshots. Returns the new snapshot id and metadata, or a 'no change' message.

| Parameter        | Required | Definition                                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `label`          | No       | Human label, e.g. 'pre-firewall-change'. `{"type":"string"}`                                                  |
| `section`        | No       | RouterOS path without leading slash, e.g. "ip firewall filter". Omit for full config. `{"type":"string"}`     |
| `terse`          | Yes      | Use `/export terse` (one self-contained line per item) for cleaner diffs. `{"default":true,"type":"boolean"}` |
| `show_sensitive` | Yes      | `{"default":false,"type":"boolean"}`                                                                          |
| `force`          | Yes      | `{"default":false,"type":"boolean"}`                                                                          |

## list_config_snapshots

**List RouterOS Configuration Snapshots** · Risk: **read**

Lists metadata for stored configuration snapshots for the current device from the local MCP-host SQLite database (`~/.mikrotik-mcp/snapshots.db`), newest first. Returns each snapshot's id, optional label, capture timestamp, line/byte count, RouterOS version (when available), and content SHA — the `/export` body text is not included. Use the returned id with get_config_snapshot to read the full body, or pass it to diff_config_snapshots as `from` or `to`. To capture a new snapshot use capture_config_snapshot; to delete entries use remove_config_snapshot.

| Parameter | Required | Definition                                                  |
| --------- | -------- | ----------------------------------------------------------- |
| `limit`   | Yes      | `{"default":50,"type":"integer","minimum":1,"maximum":500}` |

## get_config_snapshot

**Get RouterOS Configuration Snapshot Body** · Risk: **read**

Retrieves a stored configuration snapshot by id from the local MCP-host SQLite database. With include_body=true (default) returns the full `/export` text — a RouterOS `.rsc` script suitable for review or manual re-application on the device. Set include_body=false to return metadata only (id, timestamp, size, SHA). The id comes from list_config_snapshots. To compare two snapshots or a snapshot against the live device use diff_config_snapshots; to delete a snapshot use remove_config_snapshot.

| Parameter      | Required | Definition                          |
| -------------- | -------- | ----------------------------------- |
| `id`           | Yes      | `{"type":"string"}`                 |
| `include_body` | Yes      | `{"default":true,"type":"boolean"}` |

## diff_config_snapshots

**Diff RouterOS Configuration Snapshots** · Risk: **read**

Compares two RouterOS `/export` configurations and returns a unified diff (lines added/removed) plus a +added/-removed/unchanged summary. Each of `from`/`to` may be `<id>`, `latest` (newest stored), or `live` (capture the device now). Typical uses: drift check (from=latest, to=live) to see what changed since the last stored snapshot; or compare two stored snapshots by id. Volatile `/export` header timestamps are normalized out so unchanged configs diff clean. To capture a new snapshot first use capture_config_snapshot; to list snapshot ids use list_config_snapshots; to read a full snapshot body use get_config_snapshot. Returns the unified diff text truncated at max_output_lines (raise it if needed).

| Parameter          | Required | Definition                                                                                                                                    |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`             | Yes      | Baseline side: `<id>`, `latest` (newest stored), or `live` (capture the device now). `{"type":"string"}`                                      |
| `to`               | Yes      | Comparison side: `<id>`, `latest` (newest stored), or `live` (capture the device now). Defaults to live. `{"default":"live","type":"string"}` |
| `context_lines`    | Yes      | `{"default":3,"type":"integer","minimum":0,"maximum":20}`                                                                                     |
| `max_output_lines` | Yes      | Truncate the unified diff beyond this many lines. `{"default":800,"type":"integer","minimum":50,"maximum":5000}`                              |

## remove_config_snapshot

**Remove RouterOS Configuration Snapshots** · Risk: **destructive**

Deletes one or more stored configuration snapshots by id from the local MCP-host SQLite database (`~/.mikrotik-mcp/snapshots.db`) — never touches the device. Accepts a list of one or more ids (obtain ids from list_config_snapshots). Returns the count of entries actually removed. To capture snapshots use capture_config_snapshot.

| Parameter | Required | Definition                                                |
| --------- | -------- | --------------------------------------------------------- |
| `ids`     | Yes      | `{"minItems":1,"type":"array","items":{"type":"string"}}` |
