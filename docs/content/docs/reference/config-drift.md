---
title: "Config Drift Guardian"
description: "Golden-config baselines with drift detection, change attribution via system logs, and Safe Mode reconciliation."
---

## Tools

- [Set Golden Config Baseline](#config_set_baseline)
- [Check Config Drift Against Baseline](#config_check_drift)
- [Reconcile Device to Golden Baseline](#config_reconcile)
- [Promote Current Config as New Baseline](#config_promote_drift)

## config_set_baseline

**Set Golden Config Baseline** · Risk: **write**

Capture the current device `/export` and designate it as the golden-config baseline — the known-good reference point for drift detection. A device can have exactly one baseline; setting a new one replaces the previous. The export is also stored as a regular config snapshot in `~/.mikrotik-mcp/snapshots.db`. Use `config_check_drift` to compare the live config against this baseline; use `config_promote_drift` to accept the current (drifted) config as the new baseline. Optionally limit to one RouterOS section via `section` (e.g. 'ip firewall filter').

| Parameter        | Required | Definition                                                                               |
| ---------------- | -------- | ---------------------------------------------------------------------------------------- |
| `label`          | No       | Human label for this baseline, e.g. 'production-v2'. `{"type":"string"}`                 |
| `notes`          | No       | Free-text notes about why this baseline was set. `{"type":"string"}`                     |
| `section`        | No       | RouterOS path without leading slash. Omit for full config. `{"type":"string"}`           |
| `terse`          | Yes      | Use `/export terse` for cleaner diffs. Default true. `{"default":true,"type":"boolean"}` |
| `show_sensitive` | Yes      | `{"default":false,"type":"boolean"}`                                                     |

## config_check_drift

**Check Config Drift Against Baseline** · Risk: **read**

Compare the live device configuration against its golden baseline and return a drift report with: severity score (0–100), per-section breakdown of what changed, change attribution from system logs (who changed what and when), and a unified diff. Requires a baseline to be set first via `config_set_baseline`. Set `include_logs=false` to skip log-based change attribution (faster). Use `config_reconcile` to push the baseline back onto the device, or `config_promote_drift` to accept the drift.

| Parameter          | Required | Definition                                                                                                       |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `include_logs`     | Yes      | Fetch system logs for change attribution. Default true. `{"default":true,"type":"boolean"}`                      |
| `log_duration`     | Yes      | How far back to search logs. RouterOS duration (e.g. '7d', '24h'). `{"default":"7d","type":"string"}`            |
| `max_output_lines` | Yes      | Truncate the unified diff beyond this many lines. `{"default":800,"type":"integer","minimum":50,"maximum":5000}` |

## config_reconcile

**Reconcile Device to Golden Baseline** · Risk: **dangerous**

Push the golden baseline configuration back onto the device, reverting all drift. Replays the baseline's `/export` commands through RouterOS Safe Mode — if any command fails or the device becomes unreachable, all changes are automatically rolled back. With `confirm=false` (default) this is a DRY RUN: commands are applied and then rolled back, showing what would change. Set `confirm=true` to actually commit. Requires SSH (not MAC-Telnet). After a successful commit, a verification snapshot is captured to confirm the state.

| Parameter | Required | Definition                                                                                       |
| --------- | -------- | ------------------------------------------------------------------------------------------------ |
| `confirm` | Yes      | false = dry-run (apply + rollback); true = commit for real. `{"default":false,"type":"boolean"}` |

## config_promote_drift

**Promote Current Config as New Baseline** · Risk: **write**

Accept the device's current (drifted) configuration as the new golden baseline. Captures a fresh `/export` snapshot and replaces the existing baseline pointer. Use this after reviewing drift with `config_check_drift` and deciding the changes are intentional. The old baseline snapshot is preserved in snapshot history.

| Parameter | Required | Definition                                           |
| --------- | -------- | ---------------------------------------------------- |
| `label`   | No       | Label for the new baseline. `{"type":"string"}`      |
| `notes`   | No       | Why the drift is being accepted. `{"type":"string"}` |
