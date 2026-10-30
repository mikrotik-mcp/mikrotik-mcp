---
title: "Logs"
description: "Log retrieval, search, statistics and export (`/log`)."
---

## Tools

- [Fetch System Log Entries](#get_logs)
- [Fetch Log Entries by Severity](#get_logs_by_severity)
- [Fetch Log Entries by Topic](#get_logs_by_topic)
- [Search Log Messages by Keyword](#search_logs)
- [Fetch System Event Log Entries](#get_system_events)
- [Fetch Security-Related Log Entries](#get_security_logs)
- [Clear Router Log Buffer](#clear_logs)
- [Get Log Entry Statistics](#get_log_statistics)
- [Export Log Entries to a Device File](#export_logs)
- [Fetch Log Entries Within a Recent Time Window](#monitor_logs)

## get_logs

**Fetch System Log Entries** · Risk: **read**

Fetch RouterOS log entries (`/log print`) with any combination of topic, severity, message, prefix, time, and action filters — the general-purpose log reader for arbitrary filter combinations. For a single severity level use `get_logs_by_severity`; for a single named facility use `get_logs_by_topic`; for full-text message search use `search_logs`; for security-keyword presets spanning multiple topics use `get_security_logs`; for login/reboot/config events use `get_system_events`. Returns matching lines in `value`, `detail`, or `terse` format; `limit` caps to the N most recent lines. `time_filter` is a RouterOS duration string (e.g. `1h`, `30m`, `2d`); `topics` accepts comma-separated RouterOS topic names (e.g. `system,firewall`).

| Parameter        | Required | Definition                                                                  |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `topics`         | No       | `{"type":"string"}`                                                         |
| `action`         | No       | `{"type":"string"}`                                                         |
| `time_filter`    | No       | `{"type":"string"}`                                                         |
| `message_filter` | No       | `{"type":"string"}`                                                         |
| `prefix_filter`  | No       | `{"type":"string"}`                                                         |
| `limit`          | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `follow`         | Yes      | `{"default":false,"type":"boolean"}`                                        |
| `print_as`       | Yes      | `{"default":"value","type":"string","enum":["value","detail","terse"]}`     |

## get_logs_by_severity

**Fetch Log Entries by Severity** · Risk: **read**

Fetch RouterOS log entries (`/log print where topics~"<level>"`) filtered by severity level — maps each choice to the corresponding RouterOS topic(s): debug→debug, info→info, warning→warning, error→error,critical, critical→critical. Use when you know the severity but not a specific topic or message keyword. For combined topic+message filtering use `get_logs`; for a named facility use `get_logs_by_topic`; for security keywords across multiple topics use `get_security_logs`. Returns matching log lines; `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration string (e.g. `1h`, `30m`).

| Parameter     | Required | Definition                                                                  |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `severity`    | Yes      | `{"type":"string","enum":["debug","info","warning","error","critical"]}`    |
| `time_filter` | No       | `{"type":"string"}`                                                         |
| `limit`       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## get_logs_by_topic

**Fetch Log Entries by Topic** · Risk: **read**

Fetch RouterOS log entries (`/log print where topics~"<topic>"`) for a single named RouterOS topic/facility (e.g. `system`, `dhcp`, `firewall`, `interface`, `wireless`). Use when you need all entries for one facility regardless of severity or message content. For multiple topics or message filtering use `get_logs`; for severity-level filtering use `get_logs_by_severity`; for security-keyword presets use `get_security_logs`. Returns matching log lines; `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration string (e.g. `1h`).

| Parameter     | Required | Definition                                                                  |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `topic`       | Yes      | `{"type":"string"}`                                                         |
| `time_filter` | No       | `{"type":"string"}`                                                         |
| `limit`       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## search_logs

**Search Log Messages by Keyword** · Risk: **read**

Search RouterOS log entries (`/log print where message~"<term>"`) for lines containing a keyword or substring — case-insensitive full-text search across all log message bodies. Use when you have a string to match in the log body (e.g. an IP address, MAC address, username, or error text). For topic-scoped reads use `get_logs_by_topic`; for severity-scoped reads use `get_logs_by_severity`; for security-keyword presets use `get_security_logs`. Returns matching log lines; `limit` caps to the N most recent matches; `time_filter` is a RouterOS duration string (e.g. `1h`).

| Parameter        | Required | Definition                                                                  |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `search_term`    | Yes      | `{"type":"string"}`                                                         |
| `time_filter`    | No       | `{"type":"string"}`                                                         |
| `case_sensitive` | Yes      | `{"default":false,"type":"boolean"}`                                        |
| `limit`          | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## get_system_events

**Fetch System Event Log Entries** · Risk: **read**

Fetch RouterOS log entries (`/log print where topics~"system"`) for system-level events, optionally narrowed by `event_type` (login, logout, reboot, config-change, backup, restore, upgrade) which maps to a `message~` keyword filter. Use for auditing administrative actions such as logins and configuration changes. For security events spanning multiple topics (firewall, error, warning) use `get_security_logs`; for arbitrary message keyword searches use `search_logs`; for full filter control use `get_logs`. Returns matching system-topic log lines; `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration string (e.g. `1h`).

| Parameter     | Required | Definition                                                                  |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `event_type`  | No       | `{"type":"string"}`                                                         |
| `time_filter` | No       | `{"type":"string"}`                                                         |
| `limit`       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## get_security_logs

**Fetch Security-Related Log Entries** · Risk: **read**

Fetch RouterOS log entries (`/log print where (topics~"system" or topics~"firewall" or topics~"warning" or topics~"error") and message~"(login|logout|failed|denied|blocked|attack|invalid|unauthorized)"`) — a preset multi-topic security keyword search. Use to investigate login failures, blocked connections, and potential attacks without manually specifying individual filters. For single-topic reads use `get_logs_by_topic`; for system admin events only use `get_system_events`; for arbitrary keyword searches use `search_logs`; for full filter control use `get_logs`. Returns matching entries; `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration string (e.g. `1h`).

| Parameter     | Required | Definition                                                                  |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `time_filter` | No       | `{"type":"string"}`                                                         |
| `limit`       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## clear_logs

**Clear Router Log Buffer** · Risk: **destructive**

Runs `/log print follow-only` as a non-interactive SSH exec — because the session is non-interactive, the command skips all pre-existing entries and exits immediately, returning no output. The tool treats an empty response as success and returns 'Logs cleared successfully.' Note: this does NOT delete entries from the RouterOS in-memory log buffer; existing entries remain in the device buffer until it cycles on its own. Entries already sent to a remote syslog or written to an export file are unaffected. For reading entries before running this command use `get_logs`; to save entries to a device file first use `export_logs`.

No tool-specific parameters.

## get_log_statistics

**Get Log Entry Statistics** · Risk: **read**

Summarize RouterOS log volume by running `/log print count-only` — reports total entry count, per-topic counts for info/warning/error/system/dhcp/firewall/interface, entries in the last hour, and entries in the last 24 hours. Use to get a quick activity overview without retrieving all log lines. For reading actual log content use `get_logs`; for exporting entries to a device file use `export_logs`. Returns a formatted statistics block with totals per topic and recency counts.

No tool-specific parameters.

## export_logs

**Export Log Entries to a Device File** · Risk: **read**

Export RouterOS log entries to a file on the device filesystem (`/log print file=<name>`) with optional topic and time filters. Use when you need a persistent log file on the router for later retrieval (e.g. via FTP or SCP). For reading log entries directly to the MCP client use `get_logs`; for a quick count summary use `get_log_statistics`. `filename` defaults to `logs_export_<unix-timestamp>`; `time_filter` is a RouterOS duration string (e.g. `1h`); `topics` accepts a single RouterOS topic name. Returns the filename on success (file is written as `<filename>.txt` on the device).

| Parameter     | Required | Definition                                                   |
| ------------- | -------- | ------------------------------------------------------------ |
| `filename`    | No       | `{"type":"string"}`                                          |
| `topics`      | No       | `{"type":"string"}`                                          |
| `time_filter` | No       | `{"type":"string"}`                                          |
| `format`      | Yes      | `{"default":"plain","type":"string","enum":["plain","csv"]}` |

## monitor_logs

**Fetch Log Entries Within a Recent Time Window** · Risk: **read**

Fetch RouterOS log entries (`/log print where time > ([:timestamp] - <duration>s)`) recorded within the last N seconds (1–60, capped at 60) — a snapshot of recent activity rather than a true streaming tail (non-interactive SSH exec cannot block on `follow`). Use to observe what was logged during a short recent window without a full `get_logs` query. For persistent reads with broader filter options use `get_logs`; for full-text message search use `search_logs`. Optional `topics` and `action` filters narrow results. Returns up to 100 of the most recent matching log lines.

| Parameter  | Required | Definition                                                                               |
| ---------- | -------- | ---------------------------------------------------------------------------------------- |
| `topics`   | No       | `{"type":"string"}`                                                                      |
| `action`   | No       | `{"type":"string"}`                                                                      |
| `duration` | Yes      | `{"default":10,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
