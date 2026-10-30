---
title: "11 \u2014 Attack detection & response"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 11 — Attack detection & response

> **Status:** implemented — all seven phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §12 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Watch every configured device's logs and connection state, correlate what it sees into
named **incidents** with evidence, and — only when the operator has opted in — stop the
attacker with a timed, reversible, rate-limited block, all of it visible on a new
**Attacks** dashboard page.

## 1. Why

This is not hypothetical. Reading one of the fleet's live logs while writing this
blueprint turned up an attack in progress: a single source hammering the API service
roughly once a second for hours, and a second source walking usernames over SSH. The
box was doing exactly what it was configured to do — logging each failure and moving
on. Nobody was going to read those logs.

The repo already has excellent **preventive** security: hardening presets, port-scan
signatures, threat feeds, policy linting, compliance audits. Every one of them answers
"is this box configured well?" None of them answers **"is someone attacking it right
now, and what did they do?"** — which is the question you have when it is happening.

Task 07 (alerting) can notify. Task 09 (scheduled audits) can compare posture over
time. Neither one has any notion of an _attacker_: a source address with a history, a
pattern of behaviour across several devices, and a decision to make about it.

## 2. What already exists — do NOT rebuild it

This is the most crowded area of the repo. Read this table before writing any code;
several obvious-looking detectors are already solved on-device and belong nowhere near
the host.

| Already there                                                       | What it does                                                         | This task's relationship                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `add_port_scan_detection_rules` (`src/core/port-scan-detection.ts`) | Six scan signatures, tags the source into an address list, on-device | **Consume its address list as a signal source.** Never re-detect scans on the host — the router sees every packet, we see none.    |
| `harden_firewall` / Security Shield                                 | Rate-limits SSH/Winbox brute force, DDoS, spoofing, in the firewall  | **The right place for volumetric defence.** Recommend it from an incident; do not duplicate it.                                    |
| `subscribe_threat_feed`                                             | External blocklists → dynamic address list                           | Cross-reference: an attacker already on a feed is higher confidence.                                                               |
| `block_device` / address-list tools                                 | The blocking primitives                                              | **Response builds on these.** No new blocking mechanism.                                                                           |
| `get_security_logs`, `search_logs`, `correlate_events`              | Log reads and ad-hoc grouping                                        | Detection consumes the same `/log print`, but on a schedule and with a memory. `correlate_events` stays the human-driven one-shot. |
| Alerting (task 07)                                                  | Rules → Slack/Discord/ntfy/webhook/MCP                               | **Incidents emit into that bus** as a new `attack` event kind. No second notification path.                                        |
| Traffic Flow (task 04)                                              | NetFlow/IPFIX top talkers                                            | Optional volumetric signal when the collector is enabled. Detection must work without it.                                          |
| `config_check_drift` (Drift Guard)                                  | Golden config vs live                                                | A drift hit on a security-relevant menu becomes a _post-compromise_ signal.                                                        |
| `src/observability/geo.ts`                                          | IP → country                                                         | Attacker origin on the map. Already written; just call it.                                                                         |

**The new thing is memory and correlation.** A single failed login is noise. Two
hundred from one address, then a success, then a new user appearing in `/user`, is an
incident with a story — and nothing in the repo can currently tell those apart.

## 3. What this is NOT

Say this in the docs, plainly, the way task 08 says UNKNOWN:

- **Not an IDS.** No packet inspection, no payload signatures, no rule database to keep
  current. It reasons over what RouterOS already writes down.
- **Not a WAF, and not DDoS mitigation.** A volumetric flood is stopped by the
  router's own rate limiting (`harden_firewall`) or upstream, not by a host that finds
  out thirty seconds later.
- **Not a replacement for hardening.** Detecting a brute force against a Winbox port
  open to the internet is worth less than closing it. Every incident links to the
  hardening tool that would have prevented it.

A feature that overclaims here is worse than none: someone will trust it to be an IDS.

## 4. The design decision that matters: detection is free, response is not

Auto-blocking is the single most dangerous thing this repo could ship. The failure
modes are specific and each has killed a production network somewhere:

1. **Locking the operator out.** The attacker's pattern and the admin's VPN reconnect
   loop can look similar from a log line.
2. **Blocking a spoofed source.** A SYN flood with forged source addresses turns any
   auto-blocker into a weapon aimed at whoever the attacker names — including the
   upstream gateway, the DNS resolver, or a customer.
3. **Blocking the monitoring itself.** Discovered on the live device while writing
   this: the MCP server's own health probe logs a successful SSH login every few
   seconds. A naive "unusual successful login" detector alerts on _us_, forever.

So:

- **Detect-only is the default.** `mode: "detect"` ships as the default and the docs
  never suggest otherwise as a starting point. Response is opt-in, per detector.
- **Every block is timed**, via an address-list `timeout`. A wrong block expires on its
  own. Permanent blocks require `confirm: true` and a written reason.
- **A never-block list is enforced in code, not configured by convention** — and it is
  seeded automatically with: every configured device's own host, the MCP host's source
  address as the device sees it, RFC1918 + CGNAT + loopback, the device's default
  gateway, and its configured DNS servers.
- **Responses are rate-limited** (default 6 per device per hour). Hitting the cap
  raises a critical alert saying the cap was hit and what was _not_ blocked. Silence
  there would be the worst outcome of all.
- **Every response is recorded with the evidence that caused it** and is reversible by
  one call, with the original incident id.
- **Spoofable signals may never auto-respond.** A detector whose evidence is a source
  address on a connectionless protocol (UDP floods, ICMP) is marked
  `spoofable: true` in the detector table, and the response engine refuses to act on it
  regardless of configuration. This is a code-level refusal, like task 09's READ check.

## 5. Architecture

```
src/attack/parse.ts       PURE — /log print detail → structured LogEvent[]
src/attack/detectors.ts   PURE — LogEvent[] + device state → Signal[]
src/attack/correlate.ts   PURE — Signal[] → Incident[] (grouping, scoring, narrative)
src/attack/respond.ts     PURE — Incident + policy + guards → ResponsePlan (decides only)
src/attack/execute.ts     the ONLY module that writes: applies a ResponsePlan
src/attack/store.ts       incidents, signals, responses (events.db, dynamic bun:sqlite)
src/attack/session.ts     the poll loop, device fan-out, config
src/tools/attack.ts       7 tools
```

The split between `respond.ts` (decides) and `execute.ts` (acts) is deliberate and
load-bearing: **the decision to block must be unit-testable offline**, including every
refusal, without a router in the loop. Mirrors `src/rollout/model.ts` vs `runner.ts`.

## 6. Log parsing — grounded, not guessed

RouterOS 7 writes a structured `extra-info` field that is far more robust than the
message text:

```
message:    login failure for user admin from 203.0.113.7 via api
extra-info: app=api duser=admin outcome=failure src=203.0.113.7
```

```
message:    user admin logged in from 198.51.100.4 via ssh
extra-info: app=ssh duser=admin outcome=success src=198.51.100.4
```

**Parse `extra-info` first; fall back to the message regex only when it is absent**
(older releases, and some topics never emit it). A parser that only knows the prose
form breaks on the next wording change; one that only knows `extra-info` finds nothing
on RouterOS 6.

Two implementation traps found on a live device:

- Fetch with **`print_as: "detail"`**. The `value` format transposes into columns and
  is unparseable at any real line count.
- `/log` is a **ring buffer with no cursor**. Poll with a time filter, and de-duplicate
  on `(device, time, message)` — overlapping windows will re-deliver lines, and
  counting one brute-force attempt twice inflates every threshold.

## 7. Detectors (v1)

Each declares its evidence, its threshold, whether it may auto-respond, and — required
— **the false positive it will produce**. A detector without a written false-positive
story does not ship.

| Detector                | Evidence                                                                                                               | Default threshold  | Spoofable | The false positive                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------ | :-------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `brute-force`           | `outcome=failure` login events grouped by `src`                                                                        | 10 in 5 min        |    no     | An admin with a stale saved password, or a script with an expired key.                                                                       |
| `credential-spray`      | failures from one `src` across ≥3 distinct `duser`                                                                     | 3 users in 10 min  |    no     | A shared jump host several people use badly.                                                                                                 |
| `successful-after-fail` | `outcome=success` from a `src` with recent failures                                                                    | any, within 15 min |    no     | The admin who mistyped twice. **Never auto-responds — this is the one you page a human for.**                                                |
| `new-admin-source`      | `outcome=success` from a public IP not seen in the learned baseline                                                    | first sight        |    no     | A genuine new office/VPN. Needs the 7-day learning window below.                                                                             |
| `port-scan`             | membership of the on-device `detect-portscan` address list                                                             | list membership    |    no     | A monitoring system or an ISP scanner.                                                                                                       |
| `firewall-drop-storm`   | logged drops from one `src` (requires `log=yes` on the rule)                                                           | 100 in 5 min       |  **yes**  | Backscatter, or a misconfigured client retrying.                                                                                             |
| `service-exposure-hit`  | any input-chain hit from a WAN source to a management port                                                             | any                |    no     | The operator's own admin session — see the never-block list.                                                                                 |
| `post-compromise`       | user added, SSH key added, service enabled, scheduler/script created, firewall rule disabled, drift on a security menu | any                |    no     | A legitimate change made outside the MCP server. Correlate with the tool-call event stream: a change _this server_ made is not a compromise. |

**The learning window.** `new-admin-source` and the baselines are worthless on day one
and dangerous if trusted then. The engine keeps a 7-day rolling baseline per device and
reports every detector that depends on it as `learning` until it has the data. It says
so in the UI rather than emitting confident nonsense.

## 8. Correlation → incidents

Signals group into an `Incident` keyed by `(device, source)` within a rolling window
(default 1 h, extended by each new signal). An incident carries:

- `stage` — `recon` → `attempt` → `breach` → `persistence`, inferred from which
  detectors fired. This is what turns a list into a story: scan, then brute force, then
  a success, then a new user, is a sentence a human can act on.
- `confidence` — `low` / `medium` / `high` / `confirmed`. `confirmed` requires a
  post-compromise signal or a success-after-failure; nothing else may claim it.
- `evidence[]` — every contributing signal with its raw log line and timestamp. An
  incident that cannot show its work is unactionable.
- `geo` — country/city via the existing `geo.ts`, when the source is public.
- `recommendation` — the _existing_ tool that addresses it (`harden_firewall`,
  `harden_ip_service_exposure`, `add_port_scan_detection_rules`, …), never freeform
  advice.

Correlation is cross-device: the same source hitting three routers is **one** incident
with three affected devices, not three incidents. That is the thing no single router
can ever see, and the strongest argument for doing this on the host at all.

## 9. Response

`respond.ts` turns an incident plus the policy into a `ResponsePlan`, or a documented
refusal. The plan is one of:

| Action       | What it does                                                                                                                          | Risk gate |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `watch`      | Record only. The default for everything.                                                                                              | —         |
| `block`      | Add `src` to a dedicated `mcp-attack-block` address list **with a timeout**, and ensure one raw/filter drop rule references that list | `WRITE`   |
| `quarantine` | For a LAN source: `block_device` by MAC, so it survives a DHCP change                                                                 | `WRITE`   |
| `escalate`   | No config change — raise a critical alert and name the human                                                                          | —         |

Rules the executor enforces regardless of configuration:

1. Never act on a `spoofable` detector.
2. Never act on an address in the never-block list (§4).
3. Never exceed the per-device rate cap; log and alert what was skipped.
4. Never create a permanent entry without `confirm: true`.
5. Snapshot before the first rule creation on a device (`capture_config_snapshot`), so
   the whole mechanism is one `diff_config_snapshots` away from being undone.
6. The drop rule is created **once**, referencing the list; blocking an address after
   that is an address-list insert, never a new firewall rule. A responder that adds a
   rule per attacker builds an unreviewable thousand-rule chain — the exact mess
   `firewall_audit` exists to complain about.

## 10. Tools (7)

| Tool                        | Risk        | Purpose                                                             |
| --------------------------- | ----------- | ------------------------------------------------------------------- |
| `scan_for_attacks`          | READ        | Run every detector over a window, now — the on-demand entry point   |
| `list_attack_incidents`     | READ        | Open/recent incidents: source, stage, confidence, devices, geo      |
| `get_attack_incident`       | READ        | One incident in full: evidence, timeline, recommendation            |
| `block_attacker`            | WRITE       | Apply a block; **dry-run unless `confirm: true`**; timed by default |
| `unblock_attacker`          | DESTRUCTIVE | Remove a block, by address or incident id                           |
| `list_attack_responses`     | READ        | What is blocked, why, by which incident, when it expires            |
| `configure_attack_response` | WRITE       | Per-detector mode, thresholds, never-block additions, rate cap      |

Module `src/tools/attack.ts`, label **"Attack Detection"**, group `Security`.

`block_attacker` refuses, with the reason, when the address is in the never-block list
or the incident's only evidence is spoofable — the same shape as task 09's READ-only
refusal. A tool that quietly declines to do what it was asked is worse than one that
explains itself.

## 11. Dashboard — new page **Attacks**

`ui/observability/attacks.tsx`:

- **Live incident feed** — newest first, coloured by confidence, streaming over the
  existing `/api/stream` socket as a new `attack` message type. **Do not open a second
  socket.**
- **Incident detail** — the kill-chain stages as a horizontal timeline, every piece of
  evidence with its raw log line, the affected devices, and one-click **Block** /
  **Escalate** / **Dismiss**.
- **Attacker map** — sources by country using the existing `geo.ts` and the circle-flags
  assets already vendored for the Devices page. No new mapping dependency; a table with
  flags beats a world map nobody can click.
- **Top sources** — address, country, attempts, first/last seen, whether blocked, with
  a cross-device count.
- **Response log** — every block: what, why, by which incident, expiry, and an
  **Unblock** action.
- **Posture strip** — which detectors are enabled, which are still `learning`, and a
  loud banner when the whole feature is in detect-only mode, so nobody believes they
  are protected when they are only watched.

Routes: `GET /api/attacks`, `GET /api/attacks/:id`, `POST /api/attacks/:id/respond`,
`DELETE /api/attacks/responses/:address`, `GET /api/attacks/sources`,
`GET /api/attacks/config`, `POST /api/attacks/config`. Sub-router
`src/observability/attack-routes.ts`.

## 12. Raycast — extends **menubar** + `monitor-devices`

- `menubar.tsx` — an incident count with the worst confidence as the tint, and the most
  recent incident with **Block** on it. Ambient, like the audit posture indicator.
- `monitor-devices.ts` — new incidents as native notifications, reusing task 07's
  channel and the same seed-silently rule so a backlog never arrives at once.

No new command. An attack you have to go and look for is an attack you find tomorrow.

## 13. Implementation progress (loop state — source of truth)

> **Prerequisites:** task 07 (alerting) for the event bus — done. Task 04 (flows) is
> **optional**; every detector must work without the collector running.

### [x] Phase 1 — Log parsing

- [x] `src/attack/parse.ts` — `/log print detail` → `LogEvent[]`; `extra-info` key=value
      first, message regex fallback; stable de-duplication key.
- [x] `tests/attack/parse.spec.ts` — **27 cases** from anonymised real fixtures: failure
      and success forms, `via api|ssh|winbox|telnet|ftp`, missing `extra-info`, IPv6
      sources, a message containing a quoted `=`, an overlapping-window replay that must
      de-duplicate, and a garbage line that must be reported not dropped.
- **Exit gate:** global gate green.

### [x] Phase 2 — Detectors + correlation

- [x] `src/attack/detectors.ts` — the eight §7 detectors, each pure, each declaring
      `spoofable` and its threshold.
- [x] `src/attack/correlate.ts` — grouping by `(device, source)`, cross-device merge,
      `stage`, `confidence`, `evidence[]`, `recommendation`.
- [x] 7-day rolling baseline + the `learning` state.
- [x] `tests/attack/detect.spec.ts` — **52 cases**: each detector fires at its threshold
      and NOT one event below it; the MCP server's own health-probe logins never produce
      a signal; a spoofable detector is marked as such; one source across three devices
      is one incident; `confirmed` cannot be reached without post-compromise or
      success-after-failure evidence.
- **Exit gate:** global gate green.

### [x] Phase 3 — Response decisions (pure)

- [x] `src/attack/respond.ts` — `Incident` + policy + guards → `ResponsePlan` | refusal.
- [x] Never-block list, auto-seeded per §4.
- [x] `tests/attack/respond.spec.ts` — **28 cases**, refusals first: never-block address,
      spoofable evidence, rate cap reached (and the alert it raises), permanent without
      `confirm`, LAN source → quarantine not block, detect-only mode refuses everything,
      and every timed block carries a timeout.
- **Exit gate:** global gate green. **No device I/O may exist in this phase's diff.**

### [x] Phase 4 — Store, executor, poller

- [x] `src/attack/store.ts` — incidents, signals, responses (`events.db`, dynamic
      `bun:sqlite`), with retention.
- [x] `src/attack/execute.ts` — applies a plan: snapshot, ensure the list-referencing
      drop rule exists once, insert the timed address-list entry.
- [x] `src/attack/session.ts` — poll loop with bounded concurrency, jitter, skip-if-
      running and no backfill (**reuse the task 09 runner's shape**), plus config block
      and `schemas/config.schema.json`.
- [x] Emit incidents into task 07's bus as the `attack` event kind.
- [x] `tests/attack/execute.spec.ts` — the drop rule is created once and only once
      across many blocks; a failed device does not abort the others; the store
      round-trips an incident with its evidence.
- **Exit gate:** global gate green.

### [x] Phase 5 — Tools

- [x] `src/tools/attack.ts` (7 tools) + `src/tools/index.ts` + 7 schemas.
- [x] `docs/attack-detection.md` + README, including the §3 "what this is not".
- **Exit gate:** global gate + `bun run gen` (new schemas only).

### [x] Phase 6 — Dashboard

- [x] `src/observability/attack-routes.ts` (7 routes).
- [x] `ui/observability/attacks.tsx` + `main.tsx` wiring; `attack` message type on the
      existing stream.
- **Exit gate:** global gate + `bun run build:ui`. **Bundle: 1362728 → 1375396 bytes
  (+12.7 KB, +0.93%)** — the page itself; the attacker table uses the existing geo
  cache rather than a mapping dependency.

### [x] Phase 7 — Raycast

- [x] `menubar.tsx` incident indicator + Block action.
- [x] `monitor-devices.ts` incident notifications.
- **Exit gate:** global gate + Raycast lint/typecheck.

### Blockers / notes

- **Fixtures must be anonymised.** The parser fixtures come from a real fleet's logs.
  Rewrite every address into the documentation ranges (RFC 5737 / RFC 1918) before
  committing, as `tests/sim/fixtures/configs.ts` did — preserve the _shape_ that caught
  the bug, never someone's network.
- **`firewall-drop-storm` needs `log=yes` on the rules.** Most fleets do not have it,
  and turning it on is a config change this feature must not make silently. The
  detector reports itself as `unavailable` with the one-line fix rather than silently
  finding nothing.
- **RouterOS 6 has no `extra-info`.** The fallback regex is not optional.
- **RouterOS does not audit configuration changes to the log** — confirmed against a
  live device in Phase 2; the `system` topic carries account events only. So
  `post-compromise` takes its input from **Drift Guard** (`config_check_drift`), which
  already computes exactly this against the golden baseline, and reports itself
  unavailable when no baseline is set rather than reporting a clean device.
- The tool-call event stream is the correlation key that separates "an admin changed
  this" from "an attacker changed this". If `post-compromise` cannot read it for any
  reason, that detector must degrade to `medium` confidence, never `confirmed`.
