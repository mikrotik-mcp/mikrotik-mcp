---
title: "Safe Mode"
description: "Transactional config window with auto-revert (Ctrl+X session)."
---

## Tools

- [Set Safe Mode Command Timeouts](#set_safe_mode_timeout)
- [Get Safe Mode Session Status](#safe_mode_status)
- [Enable Safe Mode Session](#enable_safe_mode)
- [Commit Safe Mode Changes](#commit_safe_mode)
- [Roll Back Safe Mode Changes](#rollback_safe_mode)

## set_safe_mode_timeout

**Set Safe Mode Command Timeouts** · Risk: **write**

Set per-device MCP Safe Mode command deadlines before or during a session. Applies only to subsequent commands. Increase for slow exports, decrease for faster failure detection. Does not change RouterOS rollback timing, MCP client deadlines, or unblock an uncertain session. Settings are in-memory and reset on MCP restart. Defaults: command 120000ms, idle 15000ms.

| Parameter          | Required | Definition                                                                                                              |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `commandTimeoutMs` | Yes      | Absolute command deadline in milliseconds. `{"type":"integer","minimum":1000,"maximum":600000}`                         |
| `idleTimeoutMs`    | Yes      | Maximum silence in milliseconds; must not exceed commandTimeoutMs. `{"type":"integer","minimum":1000,"maximum":600000}` |

## safe_mode_status

**Get Safe Mode Session Status** · Risk: **read**

Queries the Safe Mode SSH session state for the targeted device — reports whether a Safe Mode window is currently open (active) or closed. Safe Mode (RouterOS Ctrl+X) stages all configuration changes in memory for automatic revert on disconnect; this tool does not modify any state. Returns a status string indicating whether Safe Mode is currently active. Use enable_safe_mode to open a session, commit_safe_mode to persist staged changes, or rollback_safe_mode to discard them.

No tool-specific parameters.

## enable_safe_mode

**Enable Safe Mode Session** · Risk: **write**

Opens a Safe Mode SSH session on the targeted device (RouterOS Ctrl+X equivalent) — all subsequent configuration changes are staged in memory and auto-reverted if the SSH connection drops before an explicit commit. Take a backup first: protection may be lost and disconnect is not proof of rollback. Use set_safe_mode_timeout to tune subsequent command deadlines. Safe Mode is SSH-only and is not supported over MAC-Telnet connections. Check current state first with safe_mode_status; persist staged changes with commit_safe_mode; discard staged changes without saving with rollback_safe_mode.

No tool-specific parameters.

## commit_safe_mode

**Commit Safe Mode Changes** · Risk: **write**

Commits all pending Safe Mode changes on the targeted device to persistent flash storage and exits the Safe Mode session — equivalent to pressing Ctrl+X a second time to confirm in a RouterOS terminal. Use this after enable_safe_mode once staged changes have been verified as correct. To discard staged changes instead of persisting them, use rollback_safe_mode. Check whether Safe Mode is currently active with safe_mode_status.

No tool-specific parameters.

## rollback_safe_mode

**Roll Back Safe Mode Changes** · Risk: **write**

Closes the targeted Safe Mode SSH session to request RouterOS automatic rollback. Completion is unverified and may be delayed; compare live configuration against a backup before retrying writes. Use this when staged changes are incorrect or need to be abandoned without saving. To persist staged changes instead, use commit_safe_mode. Check current Safe Mode state with safe_mode_status.

No tool-specific parameters.
