---
title: "Change Plan"
description: "Terraform-style dry-run: preview intended commands (risk, lock-out, safe order) and apply them under Safe Mode with the exact `/export` diff (`plan_changes`, `apply_plan`)."
---

## Tools

- [Plan RouterOS Changes (Dry-Run Preview)](#plan_changes)
- [Apply RouterOS Change Plan in Safe Mode](#apply_plan)

## plan_changes

**Plan RouterOS Changes (Dry-Run Preview)** · Risk: **read**

Parses a set of intended RouterOS CLI commands locally — without contacting the device — and returns a risk-scored, lock-out-aware execution plan. Classifies each command as ADD/MODIFY/REMOVE/OTHER, calculates an overall risk score, emits warnings when commands would drop input-chain traffic or remove the management IP, and reorders steps into the safest sequence (additive changes before destructive ones). Use this to understand what will happen before committing; to execute the plan use apply_plan. Provide commands as an array via `commands`, as a newline-delimited string via `script`, or both — they are merged. Before planning a change, FIRST call capture_config_snapshot to take a restore point — it stores a local `/export` on the MCP host (~/.mikrotik-mcp/snapshots.db) with zero footprint on the device's disk (no file is written to the router). Returns a human-readable plan text and a structured plan object with per-step details.

| Parameter  | Required | Definition                                                                   |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| `commands` | No       | Intended RouterOS CLI commands. `{"type":"array","items":{"type":"string"}}` |
| `script`   | No       | Newline-delimited commands (alternative to `commands`). `{"type":"string"}`  |

## apply_plan

**Apply RouterOS Change Plan in Safe Mode** · Risk: **dangerous**

Executes intended RouterOS commands inside RouterOS Safe Mode (activated by Ctrl+X over an interactive SSH shell) and reports the exact unified diff of what changed, computed from `/export terse` snapshots captured before and after execution. With confirm=false (default) it applies all steps, captures the diff, then rolls everything back — a true dry-run that shows precisely what would change without persisting anything. With confirm=true it commits permanently, but ONLY after verifying the device still responds to `/system identity print` — a change that would lock you out auto-reverts instead of sticking. Steps execute in the same safe order that plan_changes computes (additive before destructive); if any step returns a RouterOS error the entire plan rolls back immediately. Safe Mode requires SSH — not available on MAC-Telnet devices. For a no-device preview use plan_changes instead. ALWAYS call capture_config_snapshot BEFORE this tool to record a restore point — it stores a local `/export` on the MCP host (~/.mikrotik-mcp/snapshots.db), adding no load to the device's disk and leaving nothing to remove on the router; after the change, diff_config_snapshots (from=latest, to=live) confirms what changed. Returns the plan summary, per-step execution log, unified diff, and commit/rollback outcome.

| Parameter  | Required | Definition                                                                                                            |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `commands` | No       | `{"type":"array","items":{"type":"string"}}`                                                                          |
| `script`   | No       | `{"type":"string"}`                                                                                                   |
| `confirm`  | Yes      | false = apply, show diff, roll back (dry-run). true = commit if still reachable. `{"default":false,"type":"boolean"}` |
