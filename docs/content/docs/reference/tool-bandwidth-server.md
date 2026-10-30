---
title: "Btest Server"
description: "Bandwidth-test server settings and sessions (`/tool bandwidth-server`)."
---

## Tools

- [Get Bandwidth Test Server Settings](#get_bandwidth_server)
- [Update Bandwidth Test Server Settings](#update_bandwidth_server)
- [List Active Bandwidth Test Server Sessions](#list_bandwidth_server_sessions)

## get_bandwidth_server

**Get Bandwidth Test Server Settings** · Risk: **read**

Reads bandwidth-test server configuration (`/tool bandwidth-server print`) — use to inspect whether the server is enabled, requires client authentication, and what session/port limits are active. For live in-progress tests use `list_bandwidth_server_sessions`. Returns the full settings block including `enabled`, `authenticate`, `max-sessions`, and `allocate-udp-ports-from`.

No tool-specific parameters.

## update_bandwidth_server

**Update Bandwidth Test Server Settings** · Risk: **write-idempotent**

Configures the bandwidth-test server (`/tool bandwidth-server set`) — enables or disables the server, toggles client authentication, caps concurrent sessions, and sets the UDP port allocation base. To inspect current values before changing them use `get_bandwidth_server`. Returns the updated settings block after applying changes.

Arguments:
`enabled`: accept incoming bandwidth-test sessions.
`authenticate`: require valid device credentials from test clients.
`max_sessions`: cap concurrent test sessions.
`allocate_udp_ports_from`: first UDP port used for test streams.

| Parameter                 | Required | Definition                                                                  |
| ------------------------- | -------- | --------------------------------------------------------------------------- |
| `enabled`                 | No       | `{"type":"boolean"}`                                                        |
| `authenticate`            | No       | `{"type":"boolean"}`                                                        |
| `max_sessions`            | No       | `{"type":"integer","minimum":1,"maximum":9007199254740991}`                 |
| `allocate_udp_ports_from` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## list_bandwidth_server_sessions

**List Active Bandwidth Test Server Sessions** · Risk: **read**

Lists currently active bandwidth-test server sessions (`/tool bandwidth-server session print`) — use to see in-progress tests accepted by this device's server side, including remote client usernames. Optionally filter by partial username with `user_filter`. To inspect or change the server's global settings use `get_bandwidth_server` or `update_bandwidth_server`. Returns zero or more active session records; empty when no tests are running.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `user_filter` | No       | Partial user match `{"type":"string"}` |
