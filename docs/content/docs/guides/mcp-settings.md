---
title: "Update MCP settings with tools"
description: "Preview, revision checks, timed rollback and restart requirements."
---

The **MCP Settings** module (`mcp-settings`) manages host-side settings without
contacting a router, even when the dashboard is disabled:

| Tool                      | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `get_mcp_settings`        | Read editable settings, revision, config path and pending change              |
| `get_mcp_settings_schema` | Discover allowed fields and validation limits                                 |
| `preview_mcp_settings`    | Validate a partial patch and inspect its diff and restart requirements        |
| `update_mcp_settings`     | Back up and persist an approved patch to the source JSON, with timed rollback |
| `confirm_mcp_settings`    | Keep the pending tool-created change after readback                           |
| `rollback_mcp_settings`   | Restore its local backup before confirmation                                  |

Editable fields cover MCP tool pagination, App views and capability gating;
SSH pooling; dashboard retention/body capture/redaction; Memory enablement; and
startup update checks. Partial patches preserve omitted settings. For example,
preview `{"changes":{"ssh":{"keepAlive":true,"idleTimeout":60000}}}`,
then apply the same changes with the returned `revision` and `confirm:true` only
after user approval. Read back and confirm using the **new** revision and
`pending_id` (the update result's `pendingId`, also `pending.id` in readback).

Writes are unavailable in read-only mode. Devices, credentials, listener addresses,
file paths, access ceilings, tool restrictions and probe allowlists remain
operator-managed. These tools cannot disable redaction; enabling body capture
requires redaction. They return no credential values. Config files and backups
are written with owner-only permissions (`0600` on POSIX).

Dashboard and tool edits in the same process share one pending transaction; stale revisions and
conflicting edits are rejected. Unconfirmed tool updates roll back after **60s**
by default (configurable from 30–600s) **while the process remains alive**.
Never restart with a pending update: confirm first, then restart separately if
the preview requires it. MCP presentation, dashboard recorder and update-check
changes need a restart for full activation. Memory enablement is checked on the
next operation; SSH settings affect subsequent calls/new connections and new idle
timers without forcibly disconnecting existing sessions.

The saved config path is returned by the tools. If the server was started from
environment variables alone, use `--config <path>` on future starts; CLI/env
overrides can still take precedence. A configured value is not evidence of a
restart or of router connectivity.
