# Scheduled Audits

This repo already has good auditors. Every one of them only ever runs because a
human asked, and no result is ever compared with the last one — so "this got
worse" is invisible.

Scheduled audits run them on a cron with nobody in the loop, keep every result,
and report **only what changed**.

Five tools, in the **Scheduled Audits** module (System & Ops):

| Tool                 | Risk        | What it does                                           |
| -------------------- | ----------- | ------------------------------------------------------ |
| `list_schedules`     | READ        | Jobs, cron in English, next run, last outcome, posture |
| `add_schedule`       | WRITE       | Define a job (refuses non-READ auditors)               |
| `remove_schedule`    | DESTRUCTIVE | Remove a job **and its history**                       |
| `run_schedule_now`   | READ        | Run one immediately, off-schedule                      |
| `get_audit_timeline` | READ        | Findings over time, with the deltas                    |

## The design decision that matters

A nightly audit that reports 40 findings is muted by week two. So the unit of
notification is the **delta**, not the report:

| Change                | Notify?                                           |
| --------------------- | ------------------------------------------------- |
| **New** finding       | yes                                               |
| **Worsened** severity | yes                                               |
| **Resolved**          | yes, quietly — people deserve the win             |
| **Unchanged**         | **no.** Visible in the timeline, silent otherwise |

That only works if a finding has the same identity on every run. Ids are
**content-derived** — the rule that fired plus the subject it fired about,
hashed — never a row index. A firewall rule that moves from position 3 to
position 5 is the same rule; if the id were positional, every config reorder
would read as a full set of new findings and the feature would be noise.

## Getting started

```
add_schedule id=nightly-security cron="0 3 * * *" tool=run_security_hardening_audit
```

The first run establishes the baseline. Comparisons start with the second — so
the useful output arrives on night two, not night one.

Or from the config file:

```json
{
  "devices": { "edge": { "host": "10.0.0.1", "username": "admin" } },
  "schedules": {
    "enabled": true,
    "jobs": [
      {
        "id": "nightly-security",
        "cron": "0 3 * * *",
        "tool": "run_security_hardening_audit",
        "devices": "all",
        "notifyOn": ["new", "worsened"]
      },
      {
        "id": "weekly-policy",
        "cron": "0 8 * * 1",
        "tool": "run_policy_check",
        "notifyOn": ["new", "worsened", "resolved"]
      }
    ]
  }
}
```

Config jobs are **seeded** into the store, not re-applied: a job you later
disable from the dashboard stays disabled across restarts.

## Which auditors can be scheduled

| Tool                           | What it watches                                       |
| ------------------------------ | ----------------------------------------------------- |
| `run_security_hardening_audit` | Services, firewall defaults, credentials, helpers     |
| `run_compliance_audit`         | Scored pass/fail checks across 10 categories          |
| `firewall_audit`               | Shadowed, unreachable, overly-broad and dead rules    |
| `run_policy_check`             | Your own policy-as-code rules against the live config |

A job names an MCP tool, but the runner does not use that tool's text renderer —
it reuses the tool's own fetch helper and pure engine one layer earlier, because
what it needs is a comparable finding **set**, not prose.

Scheduling anything else is refused. A tool with no adapter would produce a run
with zero findings every night and a timeline that looks healthy because nothing
is being measured — worse than refusing the job.

## READ only, enforced

Only READ auditors can be scheduled, checked against the tool's own risk
annotation at definition time and again at fire time. An unattended loop that can
write to a router is a footgun this server does not hand out. If you want
scheduled remediation: schedule the audit, and wire the alert to a human.

## Execution discipline

These exist because nobody is watching when they matter:

- **Bounded concurrency (default 4) and jitter.** Fifty devices starting in the
  same second is a thundering herd of SSH sessions on hardware with four CPUs.
- **Skip if the previous run has not finished.** A slow fleet audit is never
  queued behind itself; the skip is logged.
- **Per-device timeout (default 10 min),** after which that device is marked
  timed out — distinct from failed, because they mean different things.
- **No backfill.** A host asleep through six occurrences runs **once** at wake,
  and the miss is logged. Six identical audits back to back is six times the load
  for one answer.
- **The baseline is the last _successful_ run, per device.** A failed run has no
  trustworthy finding set, so it never becomes a baseline — otherwise one SSH
  timeout makes the next run report the whole device as new.

One unreachable router does not invalidate the other forty-nine: outcomes are per
device.

## Where the alerts go

Regressions are emitted into the existing [alerting](./alerting.md) bus as
`audit` events, so they reach whatever channels you already configured rather
than a second notification path. Route them with a rule:

```yaml
alerts:
  rules:
    - id: audit-regression
      when: { event: audit, isError: true }
      channels: [slack]
```

## Cron

A restricted five-field parser: `minute hour day-of-month month day-of-week`,
with `*`, ranges (`1-5`), lists (`1,15`) and step syntax (`*/15`). No `@yearly`,
no seconds, no `L`/`W`. That covers every realistic audit schedule without taking
on a dependency whose whole surface would then have to be trusted.

`list_schedules` prints it back in English ("every day at 03:00") — a small touch
that removes a whole class of misconfiguration.

Times are **local** to the MCP host, matching cron itself.

## Config

```json
{
  "schedules": {
    "enabled": false,
    "jobs": [],
    "concurrency": 4,
    "timeoutMs": 600000,
    "jitterMs": 3000,
    "tickSeconds": 30,
    "retainDays": 90
  }
}
```

Off by default; nothing is armed and no job runs until `enabled` is set. The
limits are also settable per run via `--schedules-concurrency`,
`--schedules-timeout-ms`, `--schedules-tick-seconds`, `--schedules-retain-days`.

History lives in the dashboard database (`~/.mikrotik-mcp/events.db`), not a new
file.

## Not the same as `/system/scheduler`

RouterOS has its own scheduler; this is not it. These jobs run on the **MCP
host** and call MCP tools — several of which are fleet-wide and host-side (drift,
policy) and could never be invoked by a router. Use `create_scheduler` for
on-device scripts.
