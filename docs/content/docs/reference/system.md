---
title: "System"
description: "Identity, resources, health, clock/NTP, packages, reboot/shutdown."
---

## Tools

- [Get System Identity](#get_system_identity)
- [Set System Identity](#set_system_identity)
- [Get System Resources](#get_system_resources)
- [Get System Health Sensors](#get_system_health)
- [Get RouterBOARD Hardware Info](#get_routerboard)
- [Get System Clock](#get_system_clock)
- [Set System Clock](#set_system_clock)
- [Get NTP Client Configuration](#get_ntp_client)
- [Set NTP Client Configuration](#set_ntp_client)
- [List Installed Packages](#get_installed_packages)
- [Check for RouterOS Updates](#check_for_updates)
- [Get System Change History](#get_system_history)
- [Reboot System](#reboot_system)
- [Shutdown System](#shutdown_system)

## get_system_identity

**Get System Identity** · Risk: **read**

Read the system identity (hostname) (`/system identity print`). Use to confirm the name the router announces to neighbors, Winbox, and SSH prompts. Returns the current `name` field. To change it use `set_system_identity`.

No tool-specific parameters.

## set_system_identity

**Set System Identity** · Risk: **write**

Set the system hostname (`/system identity set`) — the name shown in neighbor discovery, Winbox title bar, and SSH prompts. To read the current value use `get_system_identity`. Returns the updated identity after the change.

| Parameter | Required | Definition                                         |
| --------- | -------- | -------------------------------------------------- |
| `name`    | Yes      | New system identity / hostname `{"type":"string"}` |

## get_system_resources

**Get System Resources** · Risk: **read**

Return system resource counters (`/system resource print`) — CPU load and count, free/total memory, uptime, board name, RouterOS version, and architecture. Use to assess load or confirm firmware version. For hardware sensor readings (voltage, temperature) use `get_system_health`; for hardware model and serial number use `get_routerboard`.

No tool-specific parameters.

## get_system_health

**Get System Health Sensors** · Risk: **read**

Read hardware health sensor values (`/system health print`) — PSU voltage, CPU/board temperature, and fan speed. Not all models expose sensors; returns a 'no sensors available' message for those. For CPU load and memory usage use `get_system_resources`; for board model and serial number use `get_routerboard`.

No tool-specific parameters.

## get_routerboard

**Get RouterBOARD Hardware Info** · Risk: **read**

Return RouterBOARD hardware details (`/system routerboard print`) — model name, serial number, current firmware version, and available upgrade firmware. Use to identify physical hardware or confirm firmware state. For RouterOS version and resource usage use `get_system_resources`; for sensor readings use `get_system_health`.

No tool-specific parameters.

## get_system_clock

**Get System Clock** · Risk: **read**

Read the current system date, time, and time-zone (`/system clock print`). Use to verify clock accuracy before troubleshooting logs or certificate validity. To adjust the clock use `set_system_clock`; for NTP synchronization status use `get_ntp_client`.

No tool-specific parameters.

## set_system_clock

**Set System Clock** · Risk: **write**

Set the system date, time, and/or time-zone (`/system clock set`). Provide at least one of `time_zone_name` (e.g. `'Europe/Amsterdam'` or `'manual'`), `date` (e.g. `'jun/19/2026'`), or `time` (e.g. `'13:45:00'`). For automatic time synchronization configure NTP with `set_ntp_client`. Returns the updated clock after the change.

| Parameter              | Required | Definition                                                        |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `time_zone_name`       | No       | e.g. 'Europe/Amsterdam' or 'manual' `{"type":"string"}`           |
| `date`                 | No       | e.g. 'jun/19/2026' `{"type":"string"}`                            |
| `time`                 | No       | e.g. '13:45:00' `{"type":"string"}`                               |
| `time_zone_autodetect` | No       | Auto-detect the time zone from the public IP `{"type":"boolean"}` |

## get_ntp_client

**Get NTP Client Configuration** · Risk: **read**

Read NTP client settings and synchronization status (`/system ntp client print`) — enabled state, server list, and last sync result. Use to verify whether the router clock is synchronizing automatically. To enable NTP or change servers use `set_ntp_client`; to read the resulting system time use `get_system_clock`.

No tool-specific parameters.

## set_ntp_client

**Set NTP Client Configuration** · Risk: **write**

Configure the NTP client (`/system ntp client set`) — enable or disable it and set the server list as a comma-separated string (e.g. `'0.pool.ntp.org,1.pool.ntp.org'`). To read current NTP status use `get_ntp_client`; to set the clock manually instead use `set_system_clock`. Returns the updated NTP client configuration after the change.

| Parameter | Required | Definition                                                                                          |
| --------- | -------- | --------------------------------------------------------------------------------------------------- |
| `enabled` | No       | Enable or disable the NTP client `{"type":"boolean"}`                                               |
| `servers` | No       | Comma-separated NTP server list `{"type":"string"}`                                                 |
| `mode`    | No       | NTP client operating mode `{"type":"string","enum":["unicast","broadcast","multicast","manycast"]}` |
| `vrf`     | No       | VRF the NTP client operates in (e.g. 'main') `{"type":"string"}`                                    |

## get_installed_packages

**List Installed Packages** · Risk: **read**

List all RouterOS software packages installed on the device (`/system package print`) including name, version, and enabled state. Use to confirm which feature packages (e.g. `routing`, `security`, `wireless`) are present. To check for newer versions available on the update channel use `check_for_updates`.

No tool-specific parameters.

## check_for_updates

**Check for RouterOS Updates** · Risk: **read**

Query the configured update channel for available RouterOS updates (`/system package update check-for-updates once`). Returns the latest version available on the channel and whether the device is up to date. To see what is currently installed use `get_installed_packages`.

No tool-specific parameters.

## get_system_history

**Get System Change History** · Risk: **read**

Read the system change history log (`/system history print`) — a record of recent configuration actions applied to the device, including undo/redo entries. Use to audit recent changes or identify what was modified before a problem appeared.

No tool-specific parameters.

## reboot_system

**Reboot System** · Risk: **dangerous**

Send a reboot command to the device (`/system reboot`). This is a high-blast-radius action: all connections drop and the device is offline for 1-2 minutes while it restarts. Must pass `confirm=true` or the command is rejected without touching the device. For a permanent power-off use `shutdown_system`.

| Parameter | Required | Definition                                                      |
| --------- | -------- | --------------------------------------------------------------- |
| `confirm` | Yes      | Must be true to actually reboot the device `{"type":"boolean"}` |

## shutdown_system

**Shutdown System** · Risk: **dangerous**

Power off the device (`/system shutdown`). This is a high-blast-radius action: all connections drop and the device remains offline until physically powered on again. Must pass `confirm=true` or the command is rejected without touching the device. For a temporary restart use `reboot_system`.

| Parameter | Required | Definition                                                         |
| --------- | -------- | ------------------------------------------------------------------ |
| `confirm` | Yes      | Must be true to actually shut down the device `{"type":"boolean"}` |
