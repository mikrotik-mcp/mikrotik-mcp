---
title: "RPKI"
description: "RPKI validator sessions for BGP origin validation (`/routing rpki`)."
---

## Tools

- [List RPKI Sessions](#list_rpki_sessions)
- [Add RPKI Session](#add_rpki_session)
- [Update RPKI Session](#update_rpki_session)
- [Remove RPKI Session](#remove_rpki_session)
- [Enable or Disable RPKI Session](#set_rpki_session_enabled)

## list_rpki_sessions

**List RPKI Sessions** · Risk: **read**

Lists all RPKI RTR sessions (`/routing rpki print detail`) — each session is a connection to a validator cache that streams Validated ROA Payloads (VRPs) for BGP Route Origin Validation. BGP route-policy filters reference the session `group` name to mark prefixes valid/invalid/unknown. Use `add_rpki_session` to create a session; for BGP peer configuration use `add_bgp_connection`. Returns connection status, group, address, port, VRP counts, and refresh/expire state for each session; filtered to `group_filter` when supplied.

| Parameter      | Required | Definition                                           |
| -------------- | -------- | ---------------------------------------------------- |
| `group_filter` | No       | Show only sessions in this group `{"type":"string"}` |

## add_rpki_session

**Add RPKI Session** · Risk: **write**

Adds an RPKI RTR session (`/routing rpki add`) connecting to a validator cache for BGP Route Origin Validation. The `group` name is what BGP route-policy filters match against to mark prefixes valid/invalid/unknown; `address`/`port` identify the RTR cache (port 8282 is the common default, 323 for RTR-over-TLS). Tune `refresh_interval`, `retry_interval`, and `expire_interval` (e.g. "10m", "30s", "2h") to control how frequently VRPs are pulled and when stale data is dropped. For BGP peer configuration use `add_bgp_connection`; to inspect existing sessions use `list_rpki_sessions`. Returns the new session `.id`.

| Parameter          | Required | Definition                                                                                                            |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `group`            | Yes      | RPKI group name referenced by BGP route filters `{"type":"string"}`                                                   |
| `address`          | Yes      | Validator (RTR cache) IP address or hostname `{"type":"string"}`                                                      |
| `port`             | Yes      | RTR port, e.g. 8282 or 323 `{"default":8282,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `refresh_interval` | No       | e.g. "10m" `{"type":"string"}`                                                                                        |
| `expire_interval`  | No       | e.g. "2h" `{"type":"string"}`                                                                                         |
| `retry_interval`   | No       | e.g. "30s" `{"type":"string"}`                                                                                        |
| `vrf`              | No       | `{"type":"string"}`                                                                                                   |
| `comment`          | No       | `{"type":"string"}`                                                                                                   |
| `disabled`         | Yes      | `{"default":false,"type":"boolean"}`                                                                                  |

## update_rpki_session

**Update RPKI Session** · Risk: **write-idempotent**

Modifies an existing RPKI RTR session (`/routing rpki set`) by its `.id`. Use `list_rpki_sessions` to obtain the `session_id` (e.g. "*1"). Updatable fields include `address`, `port`, interval timings (`refresh_interval`, `expire_interval`, `retry_interval`, e.g. "10m", "30s", "2h"), `comment`, and `disabled`. To toggle enabled/disabled only, prefer `set_rpki_session_enabled`. Returns the updated session detail.

| Parameter          | Required | Definition                                                                  |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `session_id`       | Yes      | Session id, e.g. "*1" `{"type":"string"}`                                   |
| `address`          | No       | `{"type":"string"}`                                                         |
| `port`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `refresh_interval` | No       | `{"type":"string"}`                                                         |
| `expire_interval`  | No       | `{"type":"string"}`                                                         |
| `retry_interval`   | No       | `{"type":"string"}`                                                         |
| `comment`          | No       | `{"type":"string"}`                                                         |
| `disabled`         | No       | `{"type":"boolean"}`                                                        |

## remove_rpki_session

**Remove RPKI Session** · Risk: **destructive**

Permanently removes an RPKI RTR session (`/routing rpki remove`) by its `.id`. Use `list_rpki_sessions` to obtain the `session_id` (e.g. "*1"). After removal, BGP routes that matched this session's `group` fall back to validation state 'unknown'; ensure BGP filters are updated before removing. To deactivate without deleting, use `set_rpki_session_enabled` instead.

| Parameter    | Required | Definition                                |
| ------------ | -------- | ----------------------------------------- |
| `session_id` | Yes      | Session id, e.g. "*1" `{"type":"string"}` |

## set_rpki_session_enabled

**Enable or Disable RPKI Session** · Risk: **write-idempotent**

Toggles an RPKI RTR session active or inactive (`/routing rpki set disabled=yes/no`) by its `.id`. Use `list_rpki_sessions` to obtain the `session_id` (e.g. "*1"). Disabling suspends the RTR connection and stops VRP updates without deleting the session; BGP routes referencing its group fall back to 'unknown' while disabled. To change address, port, or intervals use `update_rpki_session`; to delete the session permanently use `remove_rpki_session`.

| Parameter    | Required | Definition                                |
| ------------ | -------- | ----------------------------------------- |
| `session_id` | Yes      | Session id, e.g. "*1" `{"type":"string"}` |
| `enabled`    | Yes      | `{"type":"boolean"}`                      |
