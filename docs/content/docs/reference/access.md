---
title: "Access Scope"
description: "Caller-scoped access control: inspect the risk/device/tool boundary enforced on this session, review denied calls, and voluntarily narrow the scope (one-way)."
---

## Tools

- [Show the Active Access Scope](#get_access_scope)
- [Narrow This Session's Access Scope](#narrow_access_scope)

## get_access_scope

**Show the Active Access Scope** · Risk: **read**

Reports the access scope currently enforced on this session: the maximum risk tier that may be invoked, which devices may be targeted, which tool-name globs are allowed or denied, and when the scope expires. Also lists recent DENIED calls with the rule that blocked each one. Call this after an 'Access denied' result to see exactly what the boundary is instead of guessing, and before attempting a batch of writes to confirm they are permitted. Contacts no device.

| Parameter | Required | Definition                                                                                                 |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `denials` | No       | How many recent denials to include (default 10, 0 to omit). `{"type":"integer","minimum":0,"maximum":200}` |

## narrow_access_scope

**Narrow This Session's Access Scope** · Risk: **write-idempotent**

Voluntarily restricts what THIS session may do for the rest of its life — lower the risk ceiling, limit which devices may be targeted, restrict tool names, or set an expiry. Useful before handing control to an unattended loop, or to self-limit to read-only while investigating a production issue. This operation is STRICTLY ONE-WAY: every field can only make the scope narrower, and there is no tool that widens it again — only the operator's server configuration sets the ceiling, and restarting the session is the only way back. Values that would widen the scope are silently clamped to the current one. Contacts no device.

| Parameter            | Required | Definition                                                                                                                                                                                                       |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_risk`           | No       | Highest risk tier to allow from now on. Ignored if it is higher than the current ceiling. READ is the most restrictive. `{"type":"string","enum":["READ","WRITE","WRITE_IDEMPOTENT","DESTRUCTIVE","DANGEROUS"]}` |
| `devices`            | No       | Restrict to these device keys (intersected with any current restriction). `{"type":"array","items":{"type":"string"}}`                                                                                           |
| `deny_devices`       | No       | Device keys to forbid outright (added to any existing denials). `{"type":"array","items":{"type":"string"}}`                                                                                                     |
| `tools`              | No       | Tool-name globs to permit, e.g. ['list__','get__','diagnose']. `{"type":"array","items":{"type":"string"}}`                                                                                                      |
| `deny_tools`         | No       | Tool-name globs to forbid (added to any existing denials). `{"type":"array","items":{"type":"string"}}`                                                                                                          |
| `expires_in_minutes` | No       | Expire the scope after this many minutes (max 7 days). `{"type":"integer","exclusiveMinimum":0,"maximum":10080}`                                                                                                 |
| `label`              | No       | A note recorded with the scope, shown in denials. `{"type":"string"}`                                                                                                                                            |
