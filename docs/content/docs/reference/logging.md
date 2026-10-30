---
title: "Logging Config"
description: "Logging rules + actions: where each topic is logged (`/system logging`)."
---

## Tools

- [Add System Logging Rule](#add_logging_rule)
- [List System Logging Rules](#list_logging_rules)
- [Remove System Logging Rule](#remove_logging_rule)
- [Add System Logging Action](#add_logging_action)
- [List System Logging Actions](#list_logging_actions)
- [Remove System Logging Action](#remove_logging_action)

## add_logging_rule

**Add System Logging Rule** · Risk: **write**

Creates a system logging rule (`/system logging add`) that routes log messages matching specified topics to a named logging action — defines WHICH topics go WHERE. The `topics` field accepts comma-separated RouterOS topic strings (e.g. `"info"`, `"firewall,!debug"`). The referenced action must already exist; to define a physical log destination (memory, disk, remote syslog, email, echo) use `add_logging_action`. To inspect existing rules use `list_logging_rules`. Returns the created rule's detail.

| Parameter  | Required | Definition                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `topics`   | Yes      | Comma-separated log topics, e.g. "info", "firewall,!debug" `{"type":"string"}` |
| `action`   | No       | Logging action name (default 'memory') `{"type":"string"}`                     |
| `prefix`   | No       | Text prepended to each matching log message `{"type":"string"}`                |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}`                                           |

## list_logging_rules

**List System Logging Rules** · Risk: **read**

Lists system logging rules (`/system logging print`), optionally filtered by partial topics match or exact action name. Returns the topic-to-action routing table — each rule shows which log topics are forwarded to which named action. To see what each action does (its physical destination) use `list_logging_actions`. Returns matching rules or a 'no rules found' message.

| Parameter       | Required | Definition                               |
| --------------- | -------- | ---------------------------------------- |
| `topics_filter` | No       | Partial topics match `{"type":"string"}` |
| `action_filter` | No       | Exact action name `{"type":"string"}`    |

## remove_logging_rule

**Remove System Logging Rule** · Risk: **destructive**

Permanently removes a system logging rule (`/system logging remove`) by its `.id` — stops the matched topics from being routed to that action. Confirms the rule exists before deleting. `rule_id` is the `.id` value returned by `list_logging_rules` (e.g. `'*1'`). To remove a logging action (physical destination) instead use `remove_logging_action`.

| Parameter | Required | Definition                                                      |
| --------- | -------- | --------------------------------------------------------------- |
| `rule_id` | Yes      | Internal .id of the logging rule, e.g. '*1' `{"type":"string"}` |

## add_logging_action

**Add System Logging Action** · Risk: **write**

Creates a system logging action (`/system logging action add`) defining a physical log destination — the named target referenced by logging rules. `target` selects the destination type: `memory` (in-RAM buffer), `disk` (file), `echo` (terminal), `remote` (UDP syslog server), or `email`. Target-specific parameters: `remote`/`remote_port`/`bsd_syslog`/`syslog_facility`/`syslog_severity` for remote syslog; `disk_file_name`/`disk_lines_per_file` for disk; `memory_lines` for memory; `email_to` for email. Once created, reference this action by name in `add_logging_rule`. To list existing actions use `list_logging_actions`. Returns the created action's detail.

| Parameter             | Required | Definition                                                                                                                  |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`                | Yes      | Name for the new logging action `{"type":"string"}`                                                                         |
| `target`              | Yes      | Where log messages are written `{"type":"string","enum":["memory","disk","echo","remote","email"]}`                         |
| `remote`              | No       | Remote syslog server address (target=remote) `{"type":"string"}`                                                            |
| `remote_port`         | No       | Remote syslog UDP port `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                          |
| `src_address`         | No       | Source address used when sending to remote syslog (target=remote) `{"type":"string"}`                                       |
| `bsd_syslog`          | No       | Use BSD-style syslog format `{"type":"boolean"}`                                                                            |
| `syslog_facility`     | No       | `{"type":"string"}`                                                                                                         |
| `syslog_severity`     | No       | `{"type":"string"}`                                                                                                         |
| `syslog_time_format`  | No       | Syslog timestamp format, e.g. 'bsd' or 'iso8601' `{"type":"string"}`                                                        |
| `disk_file_name`      | No       | File name for target=disk `{"type":"string"}`                                                                               |
| `disk_lines_per_file` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                 |
| `disk_file_count`     | No       | Number of files used to store log (target=disk) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `disk_stop_on_full`   | No       | Stop saving once disk-lines-per-file is reached (target=disk) `{"type":"boolean"}`                                          |
| `memory_lines`        | No       | Lines kept for target=memory `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                    |
| `memory_stop_on_full` | No       | Stop saving once memory-lines is reached (target=memory) `{"type":"boolean"}`                                               |
| `remember`            | No       | Keep messages not yet displayed in console (target=memory) `{"type":"boolean"}`                                             |
| `email_to`            | No       | Recipient address for target=email `{"type":"string"}`                                                                      |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                                        |

## list_logging_actions

**List System Logging Actions** · Risk: **read**

Lists system logging actions (`/system logging action print`), optionally filtered by partial name match. Returns the named destinations available for use in logging rules — each entry shows target type (memory, disk, echo, remote, email) and its configuration. To see the topic-routing rules that reference these actions use `list_logging_rules`. Returns matching actions or a 'no actions found' message.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## remove_logging_action

**Remove System Logging Action** · Risk: **destructive**

Permanently removes a system logging action (`/system logging action remove`) by its name — deletes the physical log destination definition. Confirms the action exists before deleting. `name` is the action name from `list_logging_actions`. Warning: removing an action still referenced by active logging rules leaves those rules with an invalid target — remove or update dependent rules first using `remove_logging_rule`. To remove a logging rule (topic filter) instead use `remove_logging_rule`.

| Parameter | Required | Definition                                               |
| --------- | -------- | -------------------------------------------------------- |
| `name`    | Yes      | Name of the logging action to remove `{"type":"string"}` |
