---
title: "Device Mode"
description: "Read device-mode capabilities and request physically confirmed feature changes."
---

## Tools

- [Get RouterOS Device Mode](#get_device_mode)
- [Request Device Mode Feature Update](#update_device_mode_features)

## get_device_mode

**Get RouterOS Device Mode** · Risk: **read**

Read `/system device-mode print` to see which restricted RouterOS features are available and whether physical confirmation is pending.

No tool-specific parameters.

## update_device_mode_features

**Request Device Mode Feature Update** · Risk: **dangerous**

Request any RouterOS device-mode feature or mode setting. Changing mode replaces existing per-feature overrides; inspect get_device_mode first. Clearing flagged requires a security audit. Every update needs physical confirmation and a reboot; the command response only confirms a pending request. Read back after confirmation. Unsupported properties depend on RouterOS version and hardware.

| Parameter                         | Required | Definition                                                                                                                                                                   |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                            | No       | Changes the entire mode and resets prior per-feature overrides; include any overrides to keep in this request. `{"type":"string","enum":["home","basic","advanced","rose"]}` |
| `scheduler`                       | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `socks`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `fetch`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `pptp`                            | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `l2tp`                            | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `bandwidth_test`                  | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `traffic_gen`                     | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `sniffer`                         | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `ipsec`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `romon`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `proxy`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `hotspot`                         | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `smb`                             | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `email`                           | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `zerotier`                        | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `container`                       | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `install_any_version`             | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `partitions`                      | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `routerboard`                     | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `activation_timeout`              | No       | Physical confirmation window, 10 seconds to 1 day (RouterOS duration, e.g. 5m or 00:05:00). `{"type":"string","minLength":1,"maxLength":20}`                                 |
| `flagging_enabled`                | No       | `{"type":"boolean"}`                                                                                                                                                         |
| `flagged`                         | No       | Set false only after a security audit of the router configuration. `{"type":"boolean"}`                                                                                      |
| `confirm_mode_resets_overrides`   | No       | Required with mode: existing per-feature overrides will be reset unless included in this request. `{"type":"boolean","const":true}`                                          |
| `confirm_flagged_audit_complete`  | No       | Required to clear flagged after auditing configuration, passwords, and RouterOS version. `{"type":"boolean","const":true}`                                                   |
| `physical_confirmation_available` | Yes      | Operator is physically present and has authorized the device-mode change. `{"type":"boolean","const":true}`                                                                  |
