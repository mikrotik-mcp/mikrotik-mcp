---
title: "Server Pulse"
description: "Server self-awareness: running version, update availability, release notes, upgrade path, and server vitals. No RouterOS device is contacted."
---

## Tools

- [Server Pulse & Update Check](#check_server_pulse)

## check_server_pulse

**Server Pulse & Update Check** · Risk: **read**

Check the MCP server's own heartbeat: running version, whether a newer release is available, release notes for the latest version, upgrade commands, and server vitals (tool count, uptime). This is server self-awareness — no RouterOS device is contacted. Call this when the user asks about the MCP server version, updates, what's new, or 'is my server up to date'. Returns rich release notes from GitHub so you can summarize what changed.

| Parameter               | Required | Definition                                                                                                                      |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `include_release_notes` | No       | Include the full GitHub release notes markdown (default true). Set false for a compact version-only check. `{"type":"boolean"}` |
