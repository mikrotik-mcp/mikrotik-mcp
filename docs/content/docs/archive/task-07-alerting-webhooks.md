---
title: "07 \u2014 Event-driven alerting + webhooks"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 07 — Event-driven alerting + webhooks

> **Status:** ✅ COMPLETE — all 5 phases landed.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Turn the recorder choke point into a rule engine that fires on conditions worth
knowing about — error spikes, drift, a device going dark, config changed by someone
who is not you — and delivers them to Slack / Discord / ntfy / a generic webhook, and
to the assistant itself via MCP notifications.

## 1. Why

`recordToolCall()` already sees every call across every transport. The dashboard
turns that into charts you have to be _looking at_. Nothing ever reaches out.

This is what converts the project from "a tool the AI calls" into something that
watches your network. Paired with task 09 it is the whole monitoring story.

## 2. Event sources

| Source                      | Emits                                                   |
| --------------------------- | ------------------------------------------------------- |
| Recorder (`recorder.ts`)    | every tool call: name, risk, device, duration, ok/error |
| Health prober (`health.ts`) | device up/down transitions, latency                     |
| Drift engine (`src/drift/`) | drift detected / resolved on a baselined device         |
| Rollout (task 05)           | wave halted, rollout failed                             |
| Transactions (task 03)      | `PARTIAL` outcome                                       |
| Policy (task 06)            | new critical finding                                    |
| Scheduled audits (task 09)  | audit regression vs the previous run                    |

Later tasks are **optional inputs**: the engine consumes a generic `AlertEvent`, so
07 ships standalone and later tasks just emit into it. Do not couple to them.

## 3. Rule model

```yaml
alerts:
  - id: error-spike
    when: { metric: error_rate, window: 5m, above: 0.15, minCalls: 20 }
    severity: high
    channels: [slack, mcp]

  - id: device-down
    when: { event: device_state, to: offline, for: 2m }
    severity: critical
    channels: [slack, ntfy, mcp]

  - id: destructive-on-prod
    when: { event: tool_call, risk: [destructive, dangerous], device: [core-rtr] }
    severity: medium
    channels: [slack]

  - id: drift-detected
    when: { event: drift, state: detected }
    severity: high
    channels: [slack, mcp]
```

Three trigger kinds only — `metric` (threshold over a window), `event` (a state
change or occurrence), `absence` (expected thing did not happen, e.g. no snapshot in
24 h). Keep it closed, same reasoning as task 06.

**Deduplication and flap suppression are mandatory, not polish.** Every rule carries
`cooldown` (default 15 m) and `for` (condition must hold this long before firing). An
alerting system that fires 400 times for one flapping link is worse than no alerting
— people mute it and then miss the real one. Also emit a **resolve** notification when
a fired condition clears, or every alert becomes permanent noise.

## 4. Channels

| Channel   | Config                                   | Notes                                     |
| --------- | ---------------------------------------- | ----------------------------------------- |
| `slack`   | incoming webhook URL                     | Block Kit formatting                      |
| `discord` | webhook URL                              | embeds                                    |
| `ntfy`    | topic URL (+ optional token)             | simplest self-hosted path                 |
| `webhook` | URL, method, headers, JSON body template | the escape hatch for everything else      |
| `mcp`     | —                                        | `notifications/message` to the MCP client |

**Security requirements, non-negotiable:**

- Webhook URLs are **secrets**. They pass through the existing `redact()` before any
  logging, storage or `/api/config` response — a Slack webhook URL in a screenshot is
  a live write primitive for anyone who sees it.
- Outbound requests get a **5 s timeout**, at most **2 retries** with backoff, and a
  cap on payload size. A hung webhook must never stall the recorder — delivery is
  fire-and-forget on a queue, never inline with a tool call.
- No SSRF guard is claimed: the user configures these URLs deliberately. Say so in
  the docs rather than pretending to validate.

The `mcp` channel is the interesting one — it lets the assistant _proactively_ raise
"site-b just went offline" mid-conversation.

## 5. Architecture

```
src/alerts/model.ts     PURE — rule schema, condition evaluation, dedup/cooldown state
src/alerts/engine.ts    subscribes to event sources, evaluates, enqueues
src/alerts/channels.ts  delivery adapters + retry/timeout
src/alerts/store.ts     alert history (reuse events.db)
src/tools/alerts.ts     7 tools
```

The engine is a consumer of events, never a producer of device I/O. It must not be
able to slow down or fail a tool call — assert this with a test that runs the
recorder with a channel that always throws.

## 6. Tools (7)

| Tool                 | Risk             | Purpose                                   |
| -------------------- | ---------------- | ----------------------------------------- |
| `list_alert_rules`   | READ             | Configured rules + current state          |
| `get_alert_history`  | READ             | Fired/resolved alerts over a window       |
| `test_alert_channel` | WRITE            | Send a test message (proves config works) |
| `add_alert_rule`     | WRITE            | Add a rule                                |
| `update_alert_rule`  | WRITE_IDEMPOTENT | Change one                                |
| `remove_alert_rule`  | DESTRUCTIVE      | Remove one                                |
| `mute_alert_rule`    | WRITE_IDEMPOTENT | Mute for a duration — the humane feature  |

Module `src/tools/alerts.ts`, label **"Alerting"**, group `System & Ops`.

## 7. Dashboard — new page **Alerts**

`ui/observability/alerts.tsx`:

- **Active alerts banner** — firing right now, severity-sorted, each with a
  **Mute 1 h** and **Acknowledge** action. This should be visible from every page,
  not just this one: a small badge in the nav when anything is firing.
- **Timeline** — fired/resolved over 24 h as a swimlane per rule, so flapping is
  visually obvious.
- **Rule editor** — the trigger schema as a form with a **live preview** that
  evaluates the rule against the last 24 h of stored events and reports "this would
  have fired 6 times". That preview is what stops people writing noisy rules.
- **Channel panel** — configured channels, last delivery status, **Test** button.
  Never render a stored webhook URL; show the host and a masked tail.
- **Delivery log** — recent attempts with status, latency and retry count.

Routes: `GET /api/alerts`, `/api/alerts/history`, `/api/alerts/rules`,
`POST /api/alerts/rules`, `PATCH /api/alerts/rules/:id`,
`DELETE /api/alerts/rules/:id`, `POST /api/alerts/test`, `POST /api/alerts/preview`.
Use a sub-router `src/observability/alert-routes.ts`.

Plus an `alert` message type on the existing `/api/stream`.

## 8. Raycast — extends **menubar**, plus notifications

The Raycast surface is the best fit in the whole backlog: `lib/notify.ts` already
exists and a menu bar is exactly where ambient alerts belong.

- `raycast/src/menubar.tsx` — icon reflects worst active severity (green / amber /
  red); dropdown lists active alerts with Mute and Open actions.
- `raycast/src/monitor-devices.ts` — this background command already polls; extend it
  to surface new alerts as native Raycast notifications.
- Optional `alerts.tsx` view command for history. Add only if the menubar proves
  cramped — do not build both up front.

## 9. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Pure rule engine

- [x] `src/alerts/model.ts` — Zod rule schema (all three trigger kinds), duration
      parsing, `metricMet`/`eventMet`/`absenceMet`, and the `step()` fire/resolve
      state machine. Pure: `now` is always a parameter, so every temporal behaviour
      is testable without wall-clock waits.
- [x] `tests/alerts/model.spec.ts` — 34 cases including all the blueprint's named
      scenarios.
- **Exit gate:** ✅ global gate green — `test:types` clean, **837 tests / 75 files
  pass**, `lint` exit 0. **PHASE 1 COMPLETE.**

**Decisions taken during Phase 1:**

- **A four-state machine, because three is not enough.** `clear → pending → firing`
  handles the happy path, but the flap case needs a fourth: `suppressed`, entered
  when the condition is re-met inside the cooldown. It emits nothing on the way in
  **or** the way out. Without it, a link bouncing ten times produces ten resolves —
  the machine would suppress re-fires but still announce every clear. The
  ten-bounce test pins exactly one fire and one resolve.
- **A metric rule with neither `above` nor `below` never fires.** The alternative
  reading — no bound means no constraint means always true — would page continuously
  from a typo.
- **`minCalls` guards the tiny-sample case.** One failure on an idle server is a 100%
  error rate; alerting on that is the fastest route to a muted system.
- **A muted rule holds its state but emits nothing**, so un-muting does not replay a
  backlog of alerts that already resolved while it was quiet.
- **Risk matching is case-insensitive** — the risk presets are upper-case
  (`DESTRUCTIVE`) and config is naturally written lower-case.
- **Duplicate rule ids are rejected at parse.** Ids key muting and history; two rules
  sharing one makes both meaningless.

### [x] Phase 2 — Engine + channels

- [x] `src/alerts/engine.ts` — `AlertEngine` with per-rule state, a serial
      delivery queue, `notify()`/`sample()` entry points, `snapshot()`/`active()`,
      and a process-wide instance behind `emitAlertEvent()` (a no-op when unset).
- [x] `src/alerts/channels.ts` — slack (Block Kit), discord (embed), ntfy, generic
      webhook, mcp. 5 s timeout, ≤2 retries with backoff, 16 KB payload cap,
      **4xx not retried** (a revoked webhook will not become valid on attempt three).
- [x] `src/alerts/store.ts` — alert history in `events.db` (shared, not a second
      file), `bun:sqlite` via dynamic import only.
- [x] **Emitted from `registry.ts`, not from inside `recordToolCall`** — see below.
- [x] `redactChannels()` + `maskUrl()`; `toAlertRecord()` drops everything but
      channel and outcome, so a URL cannot reach the store by construction.
- [x] `tests/alerts/isolation.spec.ts` — 8 cases: throwing sender, throwing
      evaluation, synchronous return, slow channel, no engine, failure-as-data,
      plus engine bookkeeping.
- [x] `tests/alerts/redact.spec.ts` — 10 cases, including one that **documents the
      gap in the generic `redact()`** so a future change there is noticed.
- **Exit gate:** ✅ global gate green — `test:types` clean, **855 tests / 77 files
  pass**, `lint` exit 0. **PHASE 2 COMPLETE.**

**Decisions taken during Phase 2:**

- **Alerts are emitted from the registry, not the recorder.** `recordToolCall()`
  early-returns unless the dashboard is enabled, so hanging alerting off it would
  have made alerts silently depend on `--dashboard`. `emitAlertEvent()` is called
  unconditionally and is a no-op with no engine installed.
- **The drain is deferred with `queueMicrotask`, not merely un-awaited.** The
  isolation test caught this: calling `drain()` directly runs synchronously up to
  its first `await`, and the `mcp` channel has no await before the sender — so a
  sender executed _inline on the tool-call path_. A microtask guarantees nothing
  runs before `notify()` returns, for every channel.
- **A generic `redact()` was not enough.** Its `SENSITIVE_KEY` pattern has no
  `url`/`webhook` term, and widening it would mask the many legitimate non-secret
  URLs elsewhere in the config. `maskUrl()` keeps scheme+host and drops the path,
  which for Slack/Discord/ntfy _is_ the credential. A test pins the gap so nobody
  later assumes `redact()` covers it.
- **Delivery is serial, not parallel.** A burst of alerts must not open fifty
  concurrent sockets to one webhook and earn a rate-limit.
- **4xx is not retried.** It means the request is wrong, not unlucky.

### [x] Phase 3 — Tools

- [x] `src/tools/alerts.ts` — all 7 tools, every one `noDevice` (nothing here
      contacts a router). `list_alert_rules` reports channels through
      `redactChannels`, so no tool in this module can leak a webhook URL.
- [x] `src/tools/index.ts` — "Alerting" catalog entry, group `System & Ops`.
      **835 → 842 tools.**
- [x] `AlertsConfigSchema` + `AlertChannelsSchema` in `src/config.ts`; rules kept
      as `unknown[]` there and validated by `parseRules` at startup — see below.
- [x] Engine installed in `cli.ts serve`, before tools register, so a rule can fire
      on the very first call. History wired to `dashboard.dbPath`.
- [x] `AlertEngine.history()` + persistence added (the tools needed it and Phase 2
      had built the store but not connected it).
- [x] **`mcp` channel wired on stdio** (`transport/stdio.ts`), resolving the
      blocker — see below.
- [x] `docs/alerting.md` + README doc-table row + `bun run gen` (7 new schemas,
      catalog, config schema).
- **Exit gate:** ✅ global gate green — `test:types` clean, **855 tests / 76 files
  pass**, `lint` exit 0. **PHASE 3 COMPLETE.**

**Decisions taken during Phase 3:**

- **Rules are `unknown[]` in the config schema, validated separately.** A malformed
  alert rule must not stop the server from booting: its job is managing routers, and
  it should keep doing that with alerting disabled and a clear log line. Validating
  in `AlertsConfigSchema` would have made one bad rule fatal to the whole config.
- **The blocker is resolved: the `mcp` channel is stdio-only.** Only
  `transport/stdio.ts` has a `sendLoggingMessage` path; the HTTP transport wires no
  unprompted push. Rather than silently dropping, an `mcp` delivery with no sender
  registered returns `{ok: false, error: "no MCP client connected"}` — a visible
  failure in the delivery log. Documented in `docs/alerting.md`, which tells HTTP
  users to pair `mcp` with a second channel.
- **`test_alert_channel` is WRITE, not READ.** It sends a real message to a real
  destination. Annotating it READ would let a client auto-approve posting to a
  team's Slack.

### [x] Phase 4 — Dashboard

- [x] `src/observability/alert-routes.ts` — GET `/api/alerts` (rules + live state +
      redacted channels), history, rule POST/PATCH/DELETE, channel test, and
      **`POST /api/alerts/preview`** which replays the real state machine over stored
      events to answer "this would have fired N times".
- [x] `ui/observability/alerts.tsx` — **ordered by urgency, not by data model**:
      firing banner with inline Mute at the top, then channels with a Test button,
      then rules, then history. `main.tsx` wired (ViewId, nav, icon, help).
- [x] **Nav badge visible from every page** when anything is firing — polled at 15 s
      rather than given a socket message type for a single integer.
- [x] Device-down now actually fires: `health.ts` emits `device_state` **only on a
      transition**, never per probe.
- **Exit gate:** ✅ global gate + `bun run build:ui` (8 views). **PHASE 4 COMPLETE.**

### [x] Phase 5 — Raycast

- [x] `menubar.tsx` — icon switches to a bell tinted by the **worst live severity**;
      a Firing section lists active alerts, each muting for 1 h on click.
- [x] `lib/types.ts` — `AlertsPayload` / `AlertRuleRow` / `AlertSeverity`.
- [x] The optional `alerts.tsx` view command was **not** built: the blueprint says
      add it only if the menubar proves cramped, and it does not.
- **Exit gate:** ✅ global gate + Raycast `tsc` clean in `src/`. **PHASE 5 COMPLETE
  — TASK 07 DONE.**

**Decisions taken during Phases 4-5:**

- **The preview replays the state machine, it does not count matches.** A raw match
  count would report 400 for a rule that, with its `for` and `cooldown`, actually
  fires twice — which is precisely the number that decides whether a rule is worth
  having.
- **The page is ordered by urgency.** Someone opening this under pressure wants one
  thing: what is firing and how to silence it. Configuration is below.
- **`suppressed` is presented as reassurance, not alarm** ("held quiet so a flap
  cannot spam"), because it is the machine working, not a problem.
- **Device-state emits only on transition.** The engine dedups, but feeding it one
  "still offline" per probe cycle would trivially satisfy every `for` window and
  defeat the setting.
- **The menu bar shows only the worst severity.** One glyph; spending it on anything
  less than the most urgent thing wastes it.

### Blockers / notes

- ~~Confirm `notifications/message` reaches the client on every transport~~ —
  **resolved in Phase 3.** Only stdio has a push path wired. The `mcp` channel
  degrades to a visible delivery failure elsewhere, and `docs/alerting.md` says so.
- ~~`metric` rules do not fire~~ — **wired** in `src/alerts/sampler.ts`, started
  from `cli.ts serve` on a 30 s tick. Fixing this surfaced a **bug shipped in Phase
  2**: `sample()` took a single `MetricSample` and applied it to every rule, so a
  `5m` rule and a `1h` rule were evaluated against identical numbers. It now takes a
  `(windowMs) => MetricSample` function and computes each distinct window once.
  10 tests in `tests/alerts/sampler.spec.ts`.
- ~~`absence` rules do not fire~~ — **wired**. `lastSeen()` in the sampler answers
  from **durable** sources only (event store, `snapshots.db`, the health cache), not
  an in-memory tally: a tally seeded empty would mark everything absent on restart
  and fire every absence rule at boot. `sampleAbsence` is async because the snapshot
  store is; the tick awaits it. All three trigger kinds are now live.
- ~~Health does not emit~~ — done in Phase 4 (`device_state`, transition-only).
- ~~Drift does not emit~~ — **wired** via `src/drift/alert.ts`, called from both
  check sites (the `config_check_drift` tool and `/api/drift/check`).
  Transition-only, so re-running a check while investigating does not re-alert.
  8 tests in `tests/alerts/drift-emit.spec.ts`.
- ~~Rule state keyed by rule id~~ — **fixed.** `AlertState` is now keyed by
  `(ruleId, subject)`, where subject is the event's device (`*` for fleet-wide
  metric/absence rules). A fleet rule fires per device and resolves per device.
  `snapshot()`/`active()` return one row per pair, `configuredRules()` was added
  for callers that only want the rule list, and the subject is surfaced in the
  tool output, the API, the dashboard cards and the Raycast menu bar. The
  `KNOWN LIMITATION` test became an assertion of the fixed behaviour.
- ~~An event rule without a `to` filter never resolves.~~ **Fixed — it now warns.**
  `ruleWarnings()` in `src/alerts/model.ts` flags a rule on a stateful event kind
  (`device_state`, `drift`) that omits `to`, naming the `to:` value to add. It is a
  WARNING rather than a schema error because rejecting it would break configs that
  already exist, and it is surfaced everywhere a rule is listed: `list_alert_rules`,
  `GET /api/alerts` (a `warnings` field per row) and the dashboard rule card. A rule
  that can never resolve looks identical to a healthy one until it has been stuck
  red for a week.
- ~~No test covers the preview replay.~~ **Fixed** — `tests/alerts/preview.spec.ts`,
  18 cases. What they pin, beyond the obvious: `matched` ≫ `fires` (the whole point
  of the preview — 20 matches collapse to 1 fire), a condition that never clears
  fires exactly ONCE, a burst → clear → burst is two incidents, a longer cooldown
  suppresses the second, replay is oldest-first regardless of input order, and a
  metric/absence rule previews as zero rather than inventing a number from the event
  log alone.
- **Still untested: the route handlers themselves.** `previewRule` is now covered;
  `alertRoutes` request/response plumbing is not.
