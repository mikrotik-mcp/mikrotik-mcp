---
title: "Firmware Lifecycle"
description: "Zero-touch RouterOS upgrade pipeline: discover available releases, compare versions, stage packages, capture pre-upgrade health snapshots, execute upgrades with optional maintenance-window scheduling, and verify post-upgrade health — with automatic RouterOS fallback on failure."
---

## Tools

- [Check Firmware Updates](#firmware_check)
- [Stage Firmware Packages](#firmware_stage)
- [Upgrade Firmware](#firmware_upgrade)
- [Firmware Status & Health Check](#firmware_status)

## firmware_check

**Check Firmware Updates** · Risk: **read**

Discover available RouterOS updates for a single device or the entire fleet. Queries the configured update channel, compares installed vs. latest version, flags outdated firmware, and assesses upgrade readiness (CPU, memory, version jump). Optionally set the update channel before checking. Use `firmware_status` for detailed package/routerboard info; use `firmware_stage` to download packages after confirming an update is available.

| Parameter | Required | Definition                                                                                                                  |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `channel` | No       | Set the update channel before checking (default: keep current). `{"type":"string","enum":["stable","long-term","testing"]}` |
| `fleet`   | Yes      | Check all configured devices instead of just one. `{"default":false,"type":"boolean"}`                                      |
| `devices` | No       | Specific device names to check (fleet mode). Omit to check all. `{"type":"array","items":{"type":"string"}}`                |

## firmware_stage

**Stage Firmware Packages** · Risk: **write**

Download and pre-stage RouterOS update packages on the device WITHOUT installing or rebooting (`/system package update download`). Use after `firmware_check` confirms an update is available. Once staged, use `firmware_upgrade` to install during a maintenance window. The download runs in the background on the device; re-run `firmware_status` to verify the download completed.

| Parameter | Required | Definition                                                                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `channel` | No       | Set the update channel before downloading (default: keep current). `{"type":"string","enum":["stable","long-term","testing"]}` |

## firmware_upgrade

**Upgrade Firmware** · Risk: **dangerous**

Execute the RouterOS upgrade pipeline on a device. Takes a pre-upgrade health snapshot, installs staged packages (device reboots automatically), and optionally schedules the upgrade for a future maintenance window. RouterOS has a built-in fallback mechanism: if the device fails to boot after an upgrade, it automatically reverts to the previous firmware. Use `firmware_check` first to verify an update is available, and `firmware_stage` to pre-download packages. After the device reboots, use `firmware_status` to verify the upgrade and run the post-upgrade health comparison. Requires `confirm=true` — the device WILL REBOOT and be offline for 1-3 minutes.

| Parameter             | Required | Definition                                                                                                                                                                   |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirm`             | Yes      | Must be true to execute the upgrade. Device will reboot. `{"type":"boolean"}`                                                                                                |
| `schedule_time`       | No       | Schedule the upgrade for a future time instead of immediate execution. Format: HH:MM:SS (e.g. '03:00:00' for 3 AM). The device will reboot at this time. `{"type":"string"}` |
| `schedule_date`       | No       | Date for scheduled upgrade. Format: 'jan/01/2026'. Omit to use today (or the next occurrence of schedule_time). `{"type":"string"}`                                          |
| `upgrade_routerboard` | Yes      | Also upgrade RouterBOARD firmware after RouterOS upgrade (`/system routerboard upgrade`). Requires a second reboot. `{"default":false,"type":"boolean"}`                     |
| `capture_health`      | Yes      | Capture a pre-upgrade health snapshot for later comparison. `{"default":true,"type":"boolean"}`                                                                              |

## firmware_status

**Firmware Status & Health Check** · Risk: **read**

Show detailed firmware status for a device: RouterOS version, architecture, installed packages, RouterBOARD firmware, update channel status, and upgrade readiness assessment. Set `post_check=true` after an upgrade to capture a post-upgrade health snapshot and compare it against the pre-upgrade baseline — verifying routes, interfaces, sessions, and system resources came back healthy. For fleet-wide status use `firmware_check` with `fleet=true`.

| Parameter              | Required | Definition                                                                                                                                                                |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post_check`           | Yes      | Capture a health snapshot and compare against the pre-upgrade baseline. Use after an upgrade to verify the device came back healthy. `{"default":false,"type":"boolean"}` |
| `pre_snapshot_version` | No       | The version that was running before the upgrade (for comparison context). If not provided, the post-check captures the snapshot without comparison. `{"type":"string"}`   |
