---
title: "Scheduler / Scripts"
description: "Scheduled jobs and scripts (`/system scheduler`, `/system script`)."
---

## Tools

- [Create Scheduler Entry](#create_scheduler)
- [List Scheduler Entries](#list_schedulers)
- [Get Scheduler Entry Details](#get_scheduler)
- [Remove Scheduler Entry](#remove_scheduler)
- [Enable Scheduler Entry](#enable_scheduler)
- [Disable Scheduler Entry](#disable_scheduler)
- [Add Script to Repository](#add_script)
- [List Scripts in Repository](#list_scripts)
- [Remove Script from Repository](#remove_script)
- [Run Script from Repository](#run_script)

## create_scheduler

**Create Scheduler Entry** · Risk: **write**

Creates a scheduler entry (`/system scheduler add`) — time-driven automation that runs an inline script or calls a named script at a fixed interval or date/time. Use this to trigger recurring or one-shot tasks without an interactive session. For storing reusable scripts by name use add_script; to reference a stored script set on_event to its name. interval accepts RouterOS duration strings like '00:05:00' (every 5 minutes); '0' means run once. start_time accepts 'startup' or a wall-clock time like '12:00:00'; start_date accepts 'jan/01/2026'. Returns the created entry's detail. To suspend without deleting use disable_scheduler; to re-activate use enable_scheduler.

| Parameter    | Required | Definition                                                                        |
| ------------ | -------- | --------------------------------------------------------------------------------- |
| `name`       | Yes      | Name for the scheduler entry `{"type":"string"}`                                  |
| `on_event`   | Yes      | Script source to run on event (may contain spaces/semicolons) `{"type":"string"}` |
| `interval`   | No       | Run interval, e.g. '00:05:00' (0 = run once) `{"type":"string"}`                  |
| `start_time` | No       | Start time, e.g. '12:00:00' or 'startup' `{"type":"string"}`                      |
| `start_date` | No       | Start date, e.g. 'jan/01/2026' `{"type":"string"}`                                |
| `policy`     | No       | Permission policy list, e.g. 'read,write,test,policy' `{"type":"string"}`         |
| `comment`    | No       | `{"type":"string"}`                                                               |
| `disabled`   | Yes      | `{"default":false,"type":"boolean"}`                                              |

## list_schedulers

**List Scheduler Entries** · Risk: **read**

Lists all scheduler entries (`/system scheduler print`) — every time-driven task configured on the device. Optionally filters by partial name match via name_filter. To retrieve full detail for a single entry use get_scheduler. To list stored scripts (not schedulers) use list_scripts.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_scheduler

**Get Scheduler Entry Details** · Risk: **read**

Retrieves full detail for a single scheduler entry (`/system scheduler print detail where name=...`). Use this to inspect the on-event script, interval, next-run time, and run-count of one specific entry. For all entries use list_schedulers. To look up stored system scripts use list_scripts.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_scheduler

**Remove Scheduler Entry** · Risk: **destructive**

Permanently removes a scheduler entry (`/system scheduler remove`) by name after verifying it exists. Use this to delete a time-driven task from the device. To suspend without deleting use disable_scheduler. To remove a stored script (not a scheduler) use remove_script.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_scheduler

**Enable Scheduler Entry** · Risk: **write-idempotent**

Enables a disabled scheduler entry (`/system scheduler enable`) by name, allowing it to fire again on its configured interval or schedule. Idempotent — safe to call when already enabled. To pause without deleting use disable_scheduler. To permanently delete use remove_scheduler.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_scheduler

**Disable Scheduler Entry** · Risk: **write-idempotent**

Disables an active scheduler entry (`/system scheduler disable`) by name, preventing it from firing without removing it. Idempotent — safe to call when already disabled. To resume use enable_scheduler. To permanently delete use remove_scheduler.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_script

**Add Script to Repository** · Risk: **write**

Stores a named script in the system script repository (`/system script add`) — reusable RouterOS code callable by name. Use this to keep logic out of on-event fields and share it across multiple schedulers or trigger on demand. To execute a stored script immediately use run_script. To schedule a script to run periodically use create_scheduler (set on_event to the script name). dont_require_permissions skips policy-permission checks of the caller. Returns the added script's detail including its name and source.

| Parameter                  | Required | Definition                                                                                                                                                                                                                                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                     | Yes      | Name for the script `{"type":"string"}`                                                                                                                                                                                                                                              |
| `source`                   | Yes      | Script source code, VERBATIM (may contain spaces/semicolons/quotes — they are quoted and escaped for the console automatically). Never HTML-escape it: pass `<`, `>`, `&` as themselves, since `&lt;`/`&gt;`/`&amp;` are stored literally and break comparisons. `{"type":"string"}` |
| `policy`                   | No       | Permission policy list, e.g. 'read,write,test,policy' `{"type":"string"}`                                                                                                                                                                                                            |
| `comment`                  | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                  |
| `dont_require_permissions` | Yes      | Run without checking the policy permissions of the caller `{"default":false,"type":"boolean"}`                                                                                                                                                                                       |

## list_scripts

**List Scripts in Repository** · Risk: **read**

Lists all stored scripts in the system script repository (`/system script print`). Optionally filters by partial name match via name_filter. Use this to see what named scripts are available for run_script or for referencing in a scheduler's on_event. To list scheduled tasks (not stored scripts) use list_schedulers.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## remove_script

**Remove Script from Repository** · Risk: **destructive**

Permanently removes a named script from the system script repository (`/system script remove`) after verifying it exists. Use this to clean up scripts no longer needed. Verify nothing references it via list_schedulers before removing — schedulers whose on-event names a deleted script will fail silently. To remove a scheduler entry (not a script) use remove_scheduler.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## run_script

**Run Script from Repository** · Risk: **write**

Executes a named script from the system script repository immediately (`/system script run`). Use this to trigger a stored script on demand without waiting for a scheduler. The script must already exist in the repository — to add one use add_script; to see available scripts use list_scripts. For recurring or time-based execution use create_scheduler. Returns the script's console output.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
