---
title: "09 \u2014 Scheduled autonomous audits"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 09 — Scheduled autonomous audits

> **Status:** implemented — all six phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Run the existing auditors on a schedule with no human in the loop, store every result
as a timeline, and alert **only on regression against the previous run** — so the
server watches the network instead of waiting to be asked.

## 1. Why

The repo already has excellent auditors: `audit_fleet`, `run_security_hardening_audit`,
`run_compliance_audit`, `firewall_audit`, `audit_certificate_expiry`,
`config_check_drift`, `run_capsman_audit`. Every one of them only ever runs because a
human asked. Findings are never compared over time, so "this got worse" is invisible.

Scheduling them is a small amount of code over a large amount of existing value —
the best effort-to-value ratio in the backlog after task 02.

## 2. The design decision that matters: report regressions, not findings

A nightly audit that emails 40 findings is ignored by week two. The unit of
notification is the **delta**:

- **New** finding that was not in the previous run → notify.
- **Resolved** finding → notify (quietly; people deserve the win).
- **Unchanged** finding → do not notify. Visible in the dashboard, silent otherwise.
- **Worsened** severity on an existing finding → notify.

That requires stable finding identity across runs. The existing auditors emit
`finding_id` (see the CAPsMAN engine's typed findings) — audit the others and add
one where missing. A finding id must be **content-derived and stable**: hash the rule
plus the subject (device, section, record identity), not a row index, or every
reordering of the config reads as a full set of new findings.

## 3. Architecture

```
src/schedule/model.ts    PURE — cron parsing, next-run calc, diff of two result sets
src/schedule/runner.ts   executes a job: calls the auditor tool, stores the result
src/schedule/store.ts    job defs + run history + findings (reuse events.db)
src/tools/schedule.ts    5 tools
```

**Do not use RouterOS `/system/scheduler`.** These jobs run on the MCP host, not on
the router — they call MCP tools, several of which are fleet-wide and host-side
(drift, policy). Confusing the two would be a real design error.

Cron parsing: implement a **restricted** parser (five fields, `*`, `*/n`, ranges,
lists — no `@yearly`, no seconds, no `L`/`W`) rather than adding a dependency. That
covers every realistic schedule and is ~80 lines with clear tests.

## 4. Job definition

```yaml
schedules:
  - id: nightly-security
    cron: "0 3 * * *"
    tool: run_security_hardening_audit
    devices: all # or a list, or a selector (task 05's selectors)
    notifyOn: [new, worsened]
    retain: 90d

  - id: cert-expiry
    cron: "0 8 * * 1"
    tool: audit_certificate_expiry
    devices: all
    notifyOn: [new, worsened, resolved]
```

Only **READ** tools may be scheduled. This is enforced in code, not by convention:
the runner checks the tool's risk annotation and refuses anything above `READ`. An
autonomous loop that can write to a router unattended is a footgun the repo should
not hand out — if someone wants scheduled remediation, they can schedule the audit
and wire an alert to a human.

## 5. Execution discipline

- **Stagger.** Jobs starting at the same minute across 50 devices produce a
  thundering herd of SSH sessions. Apply a bounded concurrency (default 4) and a
  small jitter.
- **Skip if still running.** A job whose previous run has not finished is skipped
  with a logged warning, never queued up behind itself.
- **Timeout per job** (default 10 m), after which it is marked failed.
- **Missed runs are not backfilled.** If the host was asleep for six hours, run once
  at wake, not six times. Record the miss.

## 6. Tools (5)

| Tool                 | Risk        | Purpose                                                                    |
| -------------------- | ----------- | -------------------------------------------------------------------------- |
| `list_schedules`     | READ        | Jobs, last run, next run, last outcome                                     |
| `add_schedule`       | WRITE       | Add a job (rejects non-READ tools)                                         |
| `remove_schedule`    | DESTRUCTIVE | Remove one                                                                 |
| `run_schedule_now`   | READ        | Trigger immediately, off-schedule                                          |
| `get_audit_timeline` | READ        | Findings over time for a device/job, with the new/resolved/worsened deltas |

Module `src/tools/schedule.ts`, label **"Scheduled Audits"**, group `System & Ops`.

## 7. Dashboard — new page **Schedules**

`ui/observability/schedules.tsx`:

- **Job board** — each job as a card: cron in plain English ("every day at 03:00"),
  last outcome, next run countdown, **Run now**. Plain-English cron is a small touch
  that removes a whole class of misconfiguration.
- **Posture timeline** — the centrepiece: findings-over-time as a stacked area by
  severity, per device or fleet-wide. Watching critical findings trend to zero is the
  most motivating thing this project could show anyone.
- **Regression feed** — new / worsened / resolved since the last run, each expandable
  to the finding detail and the run it first appeared in.
- **Run history** — per job, with duration, device count, failures.
- **Heat calendar** — a GitHub-style grid, one cell per day per job, coloured by
  finding count. Instantly shows "it started getting worse three weeks ago".

Routes: `GET /api/schedules`, `POST /api/schedules`, `DELETE /api/schedules/:id`,
`POST /api/schedules/:id/run`, `GET /api/schedules/timeline`,
`GET /api/schedules/regressions`. Sub-router `src/observability/schedule-routes.ts`.

## 8. Raycast — extends **menubar**

- `menubar.tsx` — a compact posture indicator (critical finding count) and the last
  regression, with **Run now** on the nightly job.
- `monitor-devices.ts` — regressions surface as native notifications, reusing task
  07's channel if present, otherwise directly via `lib/notify.ts`.

No new command. The whole point is that this is ambient.

## 9. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Cron + diff engine

- [x] `src/schedule/model.ts` — restricted five-field cron parser, `nextRun`,
      `describeCron`, `diffFindings` → `{added, resolved, worsened, improved,
unchanged}`, plus `shouldNotify`, `describeDiff`, `worstSeverity`,
      `severityCounts`. Pure: `now` is always a parameter.
- [x] `tests/schedule/model.spec.ts` — **38 cases**, including the reordering case
      that the feature rests on.
- **Exit gate:** global gate green (1284 tests).

Decisions carried forward:

- **`improved` is its own category**, not folded into `unchanged`. A finding whose
  severity dropped is a quiet win worth being able to report, and lumping it with
  "no change" would hide the only good news an audit ever produces.
- **POSIX's day-of-month / day-of-week OR is implemented deliberately.** `0 0 1 * 1`
  means "the 1st, AND every Monday" — a test pins it, because the intuitive reading
  (AND) silently halves how often a job runs.
- **An unknown severity sorts LAST**, so an auditor emitting something this model
  does not know can never fake a regression to critical.
- **Local time, on purpose.** "03:00 nightly" means 03:00 where the operator lives;
  a DST shift moves the wall clock, which is what everyone expects from cron. A
  60-day walk across a DST boundary asserts exactly one run per date.
- `nextRun` returns **null** rather than looping forever on `0 0 30 2 *`.

### [x] Phase 2 — Finding identity audit

Survey of what already existed:

| Auditor              | Identity before                          | Action                                     |
| -------------------- | ---------------------------------------- | ------------------------------------------ |
| `security-hardening` | `finding_id`, content-derived            | **one index-based id fixed** (below)       |
| `capsman`            | `finding_id` keyed by MAC / radio / name | none needed                                |
| `compliance-checks`  | stable `check.id`                        | `complianceFindingId(check, device)` added |
| `firewall-audit`     | **no id at all**, only `ruleIndex`       | `findingId` added, content-derived         |
| `policy` (task 06)   | rule id + line                           | `policyFindingId` uses evidence, not line  |
| drift                | report-level, not findings               | out of scope                               |

- [x] `src/schedule/identity.ts` — `stableId`, `ruleFingerprint` and one helper per
      auditor. An id hashes the rule's MATCH CONDITIONS (sorted, so key order cannot
      matter) plus the subject — never an ordinal.
- [x] **`disabled_enforcement:${chain}:${index}` in security-hardening was
      index-based** and is now keyed by `ruleSignature(drop)`. A rule moving from #3
      to #5 was reading as a brand-new critical finding.
- [x] **`firewall-audit` findings now carry `findingId`**, assigned centrally in
      `auditFirewall` rather than at each push site, so a future finding cannot
      forget one.
- [x] `tests/schedule/identity.spec.ts` — 18 cases, incl. a reordered config diffing
      as **all-unchanged** end-to-end through `diffFindings`.
- **Exit gate:** global gate green (1302 tests).

### [x] Phase 3 — Runner + store

- [x] `src/schedule/runner.ts` — READ-only enforcement via risk annotation,
      concurrency cap, jitter, skip-if-running, timeout, no backfill.
- [x] `src/schedule/store.ts` — job defs, run history, findings per run
      (`events.db`, dynamic `bun:sqlite`).
- [x] Config block + `schemas/config.schema.json`.
- [x] `tests/schedule/runner.spec.ts` — non-READ tool refused; overlapping run
      skipped; timeout marks failed; missed window runs once.
- **Exit gate:** global gate green.

### [x] Phase 4 — Tools

- [x] `src/tools/schedule.ts` (5 tools) + `src/tools/index.ts` + 5 schemas.
- [x] `docs/scheduled-audits.md` + README.
- **Exit gate:** global gate + `bun run gen` (new schemas only).

### [x] Phase 5 — Dashboard

- [x] `src/observability/schedule-routes.ts` (6 routes).
- [x] `ui/observability/schedules.tsx` + `main.tsx` wiring: job board, posture
      timeline, regression feed, run history, heat calendar.
- **Exit gate:** global gate + `bun run build:ui`.

### [x] Phase 6 — Raycast

- [x] `menubar.tsx` posture indicator + Run now.
- [x] `monitor-devices.ts` regression notifications.
- **Exit gate:** global gate + Raycast lint/typecheck.

### Blockers / notes

- Emit regressions into **task 07**'s event bus if it exists, rather than building a
  second notification path. If 07 is not done, notify directly and leave a TODO
  naming the integration point.

_(no other blockers)_
