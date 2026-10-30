---
title: "Traffic Monitor"
description: "Run scripts when interface traffic crosses a threshold (`/tool traffic-monitor`)."
---

## Tools

- [Add Traffic Monitor Entry](#add_traffic_monitor)
- [List Traffic Monitor Entries](#list_traffic_monitors)
- [Get Traffic Monitor Entry Detail](#get_traffic_monitor)
- [Update Traffic Monitor Entry](#update_traffic_monitor)
- [Remove Traffic Monitor Entry](#remove_traffic_monitor)
- [Enable Traffic Monitor Entry](#enable_traffic_monitor)
- [Disable Traffic Monitor Entry](#disable_traffic_monitor)

## add_traffic_monitor

**Add Traffic Monitor Entry** · Risk: **write**

Creates a traffic-monitor entry (`/tool traffic-monitor add`) that fires a RouterOS script when an interface's receive or transmit rate crosses a threshold — for event-driven automation such as alerting, logging, or triggering throttling. Not for real-time bandwidth measurement (use `/tool bandwidth-test`) or traffic shaping (use `create_simple_queue` or `create_queue_tree`). Returns the created entry's full detail.

Args:
name: unique name for this entry.
interface: name of the interface to watch.
traffic: direction to watch — `received` or `transmitted`.
trigger: fire when rate goes `above`, `below`, or `always` relative to the threshold.
threshold: rate in bits/second.
on_event: RouterOS script source or script name to execute when the trigger fires.

| Parameter   | Required | Definition                                                                                                |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `name`      | Yes      | `{"type":"string"}`                                                                                       |
| `interface` | Yes      | `{"type":"string"}`                                                                                       |
| `traffic`   | Yes      | `{"type":"string","enum":["received","transmitted"]}`                                                     |
| `trigger`   | Yes      | `{"type":"string","enum":["above","below","always"]}`                                                     |
| `threshold` | Yes      | Rate threshold in bits/second `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `on_event`  | No       | Script source/name to run on trigger `{"type":"string"}`                                                  |
| `comment`   | No       | `{"type":"string"}`                                                                                       |
| `disabled`  | Yes      | `{"default":false,"type":"boolean"}`                                                                      |

## list_traffic_monitors

**List Traffic Monitor Entries** · Risk: **read**

Lists all traffic-monitor entries (`/tool traffic-monitor print`) — for auditing which interface thresholds and on-event scripts are configured on the device. Optionally filter by `name_filter` (substring match on name), `interface_filter` (exact interface name), or `disabled_only`. Returns all matching entries with their threshold, trigger direction, and script. To inspect a single entry in full detail use `get_traffic_monitor`.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `name_filter`      | No       | `{"type":"string"}`                  |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_traffic_monitor

**Get Traffic Monitor Entry Detail** · Risk: **read**

Fetches the full detail of one traffic-monitor entry by name (`/tool traffic-monitor print detail where name=...`) — for inspecting the watched interface, traffic direction, trigger condition, threshold, on-event script, and enabled/disabled state of a specific monitor. To see all entries use `list_traffic_monitors`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_traffic_monitor

**Update Traffic Monitor Entry** · Risk: **write-idempotent**

Modifies an existing traffic-monitor entry by name (`/tool traffic-monitor set [find name=...]`) — for changing the watched interface, traffic direction (`received`/`transmitted`), trigger condition (`above`/`below`/`always`), threshold (bits/second), or on-event script without removing and re-adding. Supply only the fields to change; omitted fields are left unchanged. Pass `comment=""` to clear the comment. Returns the updated entry's full detail. To create a new entry use `add_traffic_monitor`.

| Parameter   | Required | Definition                                                                  |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `name`      | Yes      | `{"type":"string"}`                                                         |
| `interface` | No       | `{"type":"string"}`                                                         |
| `traffic`   | No       | `{"type":"string","enum":["received","transmitted"]}`                       |
| `trigger`   | No       | `{"type":"string","enum":["above","below","always"]}`                       |
| `threshold` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `on_event`  | No       | `{"type":"string"}`                                                         |
| `comment`   | No       | `{"type":"string"}`                                                         |
| `disabled`  | No       | `{"type":"boolean"}`                                                        |

## remove_traffic_monitor

**Remove Traffic Monitor Entry** · Risk: **destructive**

Permanently deletes a traffic-monitor entry by name (`/tool traffic-monitor remove [find name=...]`). Performs a count-only existence check first and returns an error if the name is not found. Use `disable_traffic_monitor` instead to keep the entry inactive without deleting it. Returns confirmation on success.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_traffic_monitor

**Enable Traffic Monitor Entry** · Risk: **write-idempotent**

Enables a disabled traffic-monitor entry by name (`/tool traffic-monitor enable [find name=...]`) — resumes threshold checking and on-event script execution without modifying any parameters. To suspend monitoring temporarily without deleting use `disable_traffic_monitor`; to delete permanently use `remove_traffic_monitor`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_traffic_monitor

**Disable Traffic Monitor Entry** · Risk: **write-idempotent**

Disables an active traffic-monitor entry by name (`/tool traffic-monitor disable [find name=...]`) — suspends threshold checking and on-event script execution without removing the entry. To resume monitoring use `enable_traffic_monitor`; to delete the entry permanently use `remove_traffic_monitor`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
