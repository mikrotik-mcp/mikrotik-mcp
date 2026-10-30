---
title: "Alerting"
description: "Rules that watch this server and reach out when something changes — error spikes, a device going dark, drift, a destructive call on a named router — delivered to Slack, Discord, ntfy, a generic webhook, or the MCP client itself."
---

## Tools

- [List Alert Rules](#list_alert_rules)
- [Get Alert History](#get_alert_history)
- [Test Alert Channel](#test_alert_channel)
- [Add Alert Rule](#add_alert_rule)
- [Update Alert Rule](#update_alert_rule)
- [Remove Alert Rule](#remove_alert_rule)
- [Mute Alert Rule](#mute_alert_rule)

## list_alert_rules

**List Alert Rules** · Risk: **read**

Lists every configured alert rule with its trigger, severity, channels, timing (`for` / `cooldown`) and current live state (clear / pending / firing / suppressed / muted). Also reports the configured delivery channels — with webhook URLs masked to scheme and host, since the URL path is itself the credential. Use this to see what is being watched and what is firing right now. Contacts no RouterOS device.

No tool-specific parameters.

## get_alert_history

**Get Alert History** · Risk: **read**

Returns alerts that fired or resolved over a time window, newest first, with the per-channel delivery outcome for each. Use this to check whether an alert actually reached its destination, or to review what has been noisy. Contacts no RouterOS device.

| Parameter | Required | Definition                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------ |
| `hours`   | Yes      | Window in hours. `{"default":24,"type":"number","exclusiveMinimum":0,"maximum":720}` |
| `rule_id` | No       | Restrict to a single rule id. `{"type":"string"}`                                    |
| `limit`   | Yes      | `{"default":100,"type":"integer","exclusiveMinimum":0,"maximum":1000}`               |

## test_alert_channel

**Test Alert Channel** · Risk: **write**

Sends a test notification on one configured channel and reports the delivery outcome (HTTP status, attempts, duration). Use this to prove a webhook is reachable and correctly configured BEFORE relying on it for real alerts — a silently broken channel is worse than none. Sends a real message to the destination. Contacts no RouterOS device.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `channel` | Yes      | Which configured channel to test. `{"type":"string","enum":["slack","discord","ntfy","webhook","mcp"]}` |

## add_alert_rule

**Add Alert Rule** · Risk: **write**

Adds an alert rule at runtime. `trigger` is a JSON object of exactly one kind: a metric threshold `{"metric":"error_rate","window":"5m","above":0.15,"minCalls":20}`, an event `{"event":"tool_call","risk":["destructive"],"device":["core-rtr"]}`, or an absence `{"absence":"snapshot","within":"24h"}`. Set `for` so a condition must hold before firing, and `cooldown` (default 15m) to bound re-fires. The rule is added to the running engine; persist it in the config file to survive a restart.

| Parameter     | Required | Definition                                                                                                                    |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | Unique id — keys muting and history, so make it stable. `{"type":"string","minLength":1}`                                     |
| `trigger`     | Yes      | The trigger as a JSON object (see the description). `{"type":"string"}`                                                       |
| `channels`    | Yes      | Where to deliver. `{"minItems":1,"type":"array","items":{"type":"string","enum":["slack","discord","ntfy","webhook","mcp"]}}` |
| `severity`    | Yes      | `{"default":"medium","type":"string","enum":["low","medium","high","critical"]}`                                              |
| `description` | No       | Human-readable title used in the message. `{"type":"string"}`                                                                 |
| `for`         | No       | Hold time before firing, e.g. '2m'. `{"type":"string"}`                                                                       |
| `cooldown`    | Yes      | Minimum gap between fires. `{"default":"15m","type":"string"}`                                                                |

## update_alert_rule

**Update Alert Rule** · Risk: **write-idempotent**

Changes an existing alert rule in place. Only the fields you pass are modified; the rest are left as they are. Use to retune a noisy threshold, widen the cooldown, change channels, or enable/disable a rule without deleting it.

| Parameter     | Required | Definition                                                                                                  |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | `{"type":"string","minLength":1}`                                                                           |
| `trigger`     | No       | Replacement trigger, as a JSON object. `{"type":"string"}`                                                  |
| `channels`    | No       | `{"minItems":1,"type":"array","items":{"type":"string","enum":["slack","discord","ntfy","webhook","mcp"]}}` |
| `severity`    | No       | `{"type":"string","enum":["low","medium","high","critical"]}`                                               |
| `description` | No       | `{"type":"string"}`                                                                                         |
| `for`         | No       | `{"type":"string"}`                                                                                         |
| `cooldown`    | No       | `{"type":"string"}`                                                                                         |
| `enabled`     | No       | `{"type":"boolean"}`                                                                                        |

## remove_alert_rule

**Remove Alert Rule** · Risk: **destructive**

Deletes an alert rule from the running engine. Its live state is discarded, so a rule re-added with the same id starts clean rather than resuming a stale firing state. Consider mute_alert_rule instead if you only want quiet for a while.

| Parameter | Required | Definition                        |
| --------- | -------- | --------------------------------- |
| `id`      | Yes      | `{"type":"string","minLength":1}` |

## mute_alert_rule

**Mute Alert Rule** · Risk: **write-idempotent**

Silences one rule for a duration (e.g. '1h', '30m') without deleting it. A muted rule keeps tracking its condition but emits nothing — and un-muting does NOT replay alerts that fired and resolved while it was quiet. Use during planned maintenance, or to stop a known-noisy rule while you retune it. Pass duration '0s' to un-mute immediately.

| Parameter  | Required | Definition                                                                         |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `id`       | Yes      | `{"type":"string","minLength":1}`                                                  |
| `duration` | Yes      | How long to stay quiet, e.g. '1h', '30m', '0s'. `{"default":"1h","type":"string"}` |
