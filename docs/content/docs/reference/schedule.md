---
title: "Scheduled Audits"
description: "Run the existing auditors on a cron with no human in the loop, keep every result as a timeline, and report only what CHANGED since the previous run — new, worsened, resolved."
---

## Tools

- [List Scheduled Audits](#list_schedules)
- [Add a Scheduled Audit](#add_schedule)
- [Remove a Scheduled Audit](#remove_schedule)
- [Run a Scheduled Audit Now](#run_schedule_now)
- [Audit Timeline](#get_audit_timeline)

## list_schedules

**List Scheduled Audits** · Risk: **read**

Lists every scheduled audit job with its cron in plain English, next run, last outcome and the current finding counts by severity. Use this to see what the server is watching on its own — these jobs run without anyone asking, and their value is the run-over-run comparison, not any single report. Shows which auditors can be scheduled when there are no jobs yet.

| Parameter | Required | Definition                         |
| --------- | -------- | ---------------------------------- |
| `job_id`  | No       | Only this job. `{"type":"string"}` |

## add_schedule

**Add a Scheduled Audit** · Risk: **write**

Schedules an audit to run on its own and report only what changed since the previous run. Only READ auditors can be scheduled — this is enforced, not advisory: an unattended loop that can write to a router is a footgun, so schedule the audit and wire the alert to a human instead. Cron is the restricted 5-field form (minute hour day-of-month month day-of-week) with *, ranges, lists and step syntax.

Schedulable auditors:
audit_service_contracts — Enrolled service contracts: live MCP-host probes, optional fresh-export simulation, explicit unknowns.
run_security_hardening_audit — Device security posture — services, firewall defaults, credentials, helpers.
run_compliance_audit — Scored pass/fail compliance checks across 10 categories.
firewall_audit — Shadowed, unreachable, overly-broad and dead firewall rules.
run_policy_check — Loaded policy-as-code rules against the device's live configuration.

| Parameter     | Required | Definition                                                                                                                                                 |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | Job id, e.g. 'nightly-security'. Letters, digits and hyphens. `{"type":"string"}`                                                                          |
| `cron`        | Yes      | 5-field cron, e.g. "0 3 * * *" for every day at 03:00. `{"type":"string"}`                                                                                 |
| `tool`        | Yes      | Auditor to run — one of the schedulable tools listed above. `{"type":"string"}`                                                                            |
| `devices`     | No       | Device names, or 'all' (the default) for every configured device. `{"anyOf":[{"type":"string","const":"all"},{"type":"array","items":{"type":"string"}}]}` |
| `notify_on`   | No       | Which deltas raise an alert. Default: new + worsened. `{"type":"array","items":{"type":"string","enum":["new","worsened","resolved","improved"]}}`         |
| `retain_days` | No       | How long run history is kept. Default 90. `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`                                             |

## remove_schedule

**Remove a Scheduled Audit** · Risk: **destructive**

Removes a scheduled audit and its run history. The history is the timeline — deleting it discards the record of how the posture changed over time, which cannot be rebuilt. To stop a job while keeping its history, add_schedule the same id with a cron that suits you, or disable it from the dashboard.

| Parameter | Required | Definition                                |
| --------- | -------- | ----------------------------------------- |
| `id`      | Yes      | The job id to remove. `{"type":"string"}` |

## run_schedule_now

**Run a Scheduled Audit Now** · Risk: **read**

Runs a scheduled audit immediately, off-schedule, and reports what changed against each device's previous successful run. Read-only — it runs the same READ auditor the schedule would. Use it after a change to check you did not make something worse, without waiting for the next window. Does not shift the schedule.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `id`      | Yes      | The job id to run. `{"type":"string"}` |

## get_audit_timeline

**Audit Timeline** · Risk: **read**

Findings over time for a job (optionally one device): each run with its severity counts and the new/worsened/resolved deltas, newest first, plus the change between the two most recent runs in detail. This is how you answer 'when did this start getting worse' — the single run an auditor prints cannot.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `job_id`  | Yes      | Which job's history to show. `{"type":"string"}`                                                        |
| `device`  | No       | Restrict to one device. `{"type":"string"}`                                                             |
| `limit`   | Yes      | How many runs to show. Default 20. `{"default":20,"type":"integer","exclusiveMinimum":0,"maximum":200}` |
