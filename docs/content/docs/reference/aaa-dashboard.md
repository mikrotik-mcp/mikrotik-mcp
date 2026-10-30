---
title: "RADIUS & UM Dashboard"
description: "Interactive MCP App dashboard to manage RADIUS + User Manager (servers, users, profiles, limitations, NAS, assignments, sessions, settings) with full add/edit/remove."
---

## Tools

- [Manage RADIUS & User Manager (Dashboard)](#manage_radius_user_manager)
- [Get AAA Section (Dashboard)](#get_aaa_section)
- [Mutate AAA Row (Dashboard)](#aaa_mutate)
- [Get AAA Settings (Dashboard)](#get_aaa_settings)
- [Set AAA Settings (Dashboard)](#set_aaa_settings)

## manage_radius_user_manager

**Manage RADIUS & User Manager (Dashboard)** · Risk: **read**

Opens the interactive RADIUS & User Manager management dashboard — a single view to manage the router's RADIUS client (`/radius`) and the built-in User Manager RADIUS server (`/user-manager`). Tabs cover RADIUS servers, User Manager users, service profiles, rate/quota limitations, NAS clients (routers), profile assignments, accounting sessions, and global/CoA settings, each with full add/edit/enable-disable/remove. `section` picks the tab to open first. For one-off scripted changes the granular tools (add_radius_server, add_user_manager_user, …) still apply.

| Parameter | Required | Definition                                                                                                                                                                       |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section` | No       | Which section/tab to open first (default 'radius') `{"type":"string","enum":["radius","um-users","um-profiles","um-user-profiles","um-routers","um-limitations","um-sessions"]}` |

## get_aaa_section

**Get AAA Section (Dashboard)** · Risk: **read**

App-only helper for the RADIUS & User Manager dashboard: returns the rows of one section (radius, um-users, um-profiles, um-limitations, um-routers, um-user-profiles, um-sessions) as structured records with a stable id and secrets redacted, so the view can render and refresh its table.

| Parameter | Required | Definition                                                                                                                    |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `slug`    | Yes      | `{"type":"string","enum":["radius","um-users","um-profiles","um-user-profiles","um-routers","um-limitations","um-sessions"]}` |

## aaa_mutate

**Mutate AAA Row (Dashboard)** · Risk: **write**

App-only helper for the RADIUS & User Manager dashboard: performs one create/update/remove/toggle on a section row through the shared whitelist-guarded data layer, then returns the refreshed section so the view can adopt it. `op` is add|update|remove|toggle; `slug` is the section; `id` is the row's stable identifier (RouterOS .id or name); `fields` carries the RouterOS attribute values for add/update; `enable` is the target state for toggle.

| Parameter | Required | Definition                                                                                                                                   |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `op`      | Yes      | `{"type":"string","enum":["add","update","remove","toggle"]}`                                                                                |
| `slug`    | Yes      | `{"type":"string","enum":["radius","um-users","um-profiles","um-user-profiles","um-routers","um-limitations","um-sessions"]}`                |
| `id`      | No       | Row stable id (.id or name) for update/remove/toggle `{"type":"string"}`                                                                     |
| `enable`  | No       | Target enabled state for op=toggle `{"type":"boolean"}`                                                                                      |
| `fields`  | No       | RouterOS attribute=value pairs for add/update `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}` |

## get_aaa_settings

**Get AAA Settings (Dashboard)** · Risk: **read**

App-only helper for the RADIUS & User Manager dashboard: returns the singleton settings — RADIUS incoming/CoA listener (`/radius incoming`) and User Manager global settings (`/user-manager`) — for the Settings tab.

No tool-specific parameters.

## set_aaa_settings

**Set AAA Settings (Dashboard)** · Risk: **write**

App-only helper for the RADIUS & User Manager dashboard: writes a singleton setting and returns the refreshed settings. `target` is radius-incoming (CoA accept/port), um-settings (enabled, use-profiles, certificate, ports) or radius-reset-counters; `fields` carries the RouterOS attribute values.

| Parameter | Required | Definition                                                                                     |
| --------- | -------- | ---------------------------------------------------------------------------------------------- |
| `target`  | Yes      | `{"type":"string","enum":["radius-incoming","um-settings","radius-reset-counters"]}`           |
| `fields`  | No       | `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}` |
