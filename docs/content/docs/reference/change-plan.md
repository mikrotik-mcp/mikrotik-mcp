---
title: "Change Plan"
description: "Terraform-style dry-run: preview intended commands (risk, lock-out, safe order) and apply them under Safe Mode with the exact `/export` diff (`plan_changes`, `apply_plan`)."
---

## Tools

- [Plan RouterOS Changes (Dry-Run Preview)](#plan_changes)
- [Apply RouterOS Change Plan](#apply_plan)

## plan_changes

**Plan RouterOS Changes (Dry-Run Preview)** · Risk: **read**

Parses a set of intended RouterOS CLI commands locally — without contacting the device — and returns a risk-scored, lock-out-aware execution plan. Classifies each command as ADD/MODIFY/REMOVE/OTHER, calculates an overall risk score, emits warnings when commands would drop input-chain traffic or remove the management IP, and reorders steps into the safest sequence (additive changes before destructive ones). Use this to understand what will happen before committing; to execute the plan use apply_plan. Provide commands as an array via `commands`, as a newline-delimited string via `script`, or both — they are merged. Before planning a change, FIRST call capture_config_snapshot to take a restore point — it stores a local `/export` on the MCP host (~/.mikrotik-mcp/snapshots.db) with zero footprint on the device's disk (no file is written to the router). Returns a human-readable plan text and a structured plan object with per-step details.

| Parameter  | Required | Definition                                                                   |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| `commands` | No       | Intended RouterOS CLI commands. `{"type":"array","items":{"type":"string"}}` |
| `script`   | No       | Newline-delimited commands (alternative to `commands`). `{"type":"string"}`  |

## apply_plan

**Apply RouterOS Change Plan** · Risk: **dangerous**

Executes intended RouterOS commands and reports the exact unified diff of what changed, computed from `/export terse` captured before and after on a separate connection. Default (use_safe_mode=true): the steps run inside RouterOS Safe Mode (Ctrl+X over an interactive SSH shell). With confirm=false (default) it applies all steps, captures the diff, then rolls everything back — a true dry-run. With confirm=true it commits, but ONLY after a fresh connection to the device still works — a change that would lock you out reverts instead of sticking. If any step fails, or the Safe Mode session times out, the session is closed (RouterOS reverts uncommitted changes), the real device state is read back and compared with the pre-change export, and the result is reported; this tool never leaves a Safe Mode session open and needs no follow-up tool to recover. use_safe_mode=false (only when the user explicitly asks to write without Safe Mode): stores a restore-point snapshot on the MCP host, runs the steps directly (each one is permanent at once, there is no automatic rollback and no dry-run, confirm=true is required), stops at the first error, then reads back and diffs. This mode also works on MAC-Telnet devices; Safe Mode requires SSH. Steps execute in the same safe order that plan_changes computes (additive before destructive). For a no-device preview use plan_changes. Returns the plan summary, per-step log, unified diff, and the outcome.

| Parameter       | Required | Definition                                                                                                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands`      | No       | `{"type":"array","items":{"type":"string"}}`                                                                                                                                               |
| `script`        | No       | `{"type":"string"}`                                                                                                                                                                        |
| `confirm`       | Yes      | false = apply, show diff, roll back (dry-run). true = commit if still reachable. `{"default":false,"type":"boolean"}`                                                                      |
| `use_safe_mode` | Yes      | false = write directly without Safe Mode (snapshot first, read-back diff after, no automatic rollback). Use only when the user explicitly asks for it. `{"default":true,"type":"boolean"}` |
