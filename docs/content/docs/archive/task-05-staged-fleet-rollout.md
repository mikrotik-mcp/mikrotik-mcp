---
title: "05 \u2014 Staged fleet rollout"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 05 — Staged fleet rollout

> **Status:** implemented — all 5 phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Apply one change plan across N devices as **canary → wave → fleet**, halting on the
first failure and automatically reverting everything already applied — so the same
change can be trusted against 50 routers, not just 3.

## 1. Relationship to task 03

Task 03 (cross-device transactions) makes a change **atomic across devices that must
agree** — both ends of a tunnel. This task makes a change **safe across devices that
are independent** — the same NTP server on every router.

Different guarantees, different shapes: 03 is all-or-nothing and simultaneous, 05 is
sequential and progressive with a halt. They share the snapshot + Safe Mode
primitives but not the state machine. **Do not merge them.** 05 can ship first and
does not depend on 03.

## 2. Rollout model

```
plan            an existing change plan (docs/change-plan.md), device-agnostic
targets         a device set: explicit list, or a selector (all, by tag, by version)
waves           [1 canary] → [25% of remaining] → [rest]   (configurable)
gate            after each wave: health check + soak, then continue or halt
onFailure       halt-and-revert (default) | halt-and-hold | continue
```

**The gate is the feature.** After each wave the coordinator runs a health check
against the devices it just changed _and_ a reachability check against the ones it
has not touched yet, then soaks for `soakSeconds` (default 30) before proceeding.
Without a soak, a change that breaks connectivity 10 seconds later rolls straight
through the whole fleet.

Health checks reuse `src/observability/health.ts` (SSH probe) plus the plan's own
assertions if it declares any.

**`halt-and-revert` is the default.** On failure, every device already changed in
this rollout is restored from its pre-change snapshot, newest first. Devices not yet
touched are simply skipped. The tool reports three sets: reverted, untouched, and —
if a revert itself failed — **needs-attention**, which is the only outcome requiring
a human.

## 3. Architecture

```
src/rollout/model.ts     PURE — wave planning, gate evaluation, next-action machine
src/rollout/runner.ts    orchestration over executeMikrotikCommand + snapshots
src/rollout/store.ts     rollout history (reuse snapshots.db)
src/tools/rollout.ts     4 tools
```

Same discipline as 03: the decision logic (which wave next, does the gate pass, what
to revert) is pure and tested against fake outcomes; the runner only performs I/O.

## 4. Tools (4)

| Tool             | Risk      | Purpose                                                                                  |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `plan_rollout`   | READ      | Preview: waves, device order, what each device will run, estimated duration — no changes |
| `start_rollout`  | DANGEROUS | Execute with gates; returns a rollout id and streams progress                            |
| `rollout_status` | READ      | Current wave, per-device state, gate results                                             |
| `abort_rollout`  | WRITE     | Halt now; revert what this rollout applied                                               |

Module `src/tools/rollout.ts`, label **"Fleet Rollout"**, group `System & Ops`.

`plan_rollout` being `READ` and genuinely side-effect-free is what lets the assistant
show a fleet-wide change to a human before anything happens. Keep it that way.

## 5. Device selectors

`targets` accepts either an explicit array or a selector object:

```ts
{
  all: true;
}
{
  tags: ["branch"];
} // requires a `tags` field on device config
{
  versionBelow: "7.14";
} // uses task 02's capability cache
{
  exclude: ["core-rtr"];
} // composable with any of the above
```

`tags` is a small addition to the device config schema and is broadly useful beyond
this task. `versionBelow` depends on **task 02** — if 02 is not done, implement the
selector but have it error clearly rather than probing inline.

## 6. Dashboard — extends **Change Plan**

No new page; `ui/observability/change-plan.tsx` grows a **Rollout** tab:

- **Wave board** — devices as cards grouped by wave, each card cycling
  pending → applying → gated → done / failed / reverted. The canary is visually
  distinct because it is the one that matters.
- **Gate strip** between waves — health results and a live soak countdown, with a
  **Hold** button so a human can freeze the rollout mid-flight. That button is the
  difference between a demo and something people trust.
- **Failure drawer** — which device, the device output, and the revert outcome per
  device.
- **History** — past rollouts, filterable by plan and outcome.

Routes: `GET /api/rollout`, `GET /api/rollout/:id`, `POST /api/rollout/:id/hold`,
`POST /api/rollout/:id/resume`, `POST /api/rollout/:id/abort`, plus a `rollout`
message type on the existing `/api/stream`.

## 7. Raycast — extends **change-plan**

`raycast/src/change-plan.tsx` gains a rollout section: active rollout with wave
progress in the subtitle, actions **Hold** / **Resume** / **Abort** (all through
`lib/confirm.ts`). A halted rollout raises a `lib/notify.ts` notification — a
stopped fleet change is exactly what someone needs to know about immediately.

`menubar.tsx` shows a compact indicator while a rollout is in flight.

## 8. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Pure wave/gate model

- [x] `src/rollout/model.ts` — `planWaves`, `evaluateGate`, `nextAction`/`applyEvent`,
      `revertSet`, `requestHold`/`resume`/`requestAbort`, `estimateSeconds`. Pure.
- [x] `tests/rollout/model.spec.ts` — **35 cases**, covering every listed scenario
      plus: a device already offline BEFORE the rollout must not fail the gate, a
      device that cannot be applied at all halts before any gate, abort overrides
      `onFailure`, and a revert that itself fails → `needs-attention`.
- **Exit gate:** global gate green (1026 tests).

Decisions carried forward:

- The gate compares reachability against a **baseline captured at start**. Halting
  every fleet change because one router has been off since yesterday is how a
  safety feature earns itself a `--force`.
- A gate failure on an **untouched** device sets `collateral` and is reported
  differently — that is the signal that the change broke something fleet-wide, not
  just on the device that received it.
- `onFailure: "continue"` still records the failure: a rollout whose gate failed
  reports `completed-with-failures`, never `completed`.
- Hold parks at the next decision point, never mid-device — pausing half-way
  through applying one router is the one place a pause makes things worse.
- Abort is unconditional and always reverts; `onFailure` describes what to do
  about a broken wave, not about a human deciding to stop.

### [x] Phase 2 — Runner

- [x] `src/rollout/runner.ts` — injected `RolloutExecutor`; snapshot per device
      before its wave; Safe-Mode apply with a reachability check before commit;
      soak; health via `probeDevice`; revert newest-first by replaying the
      snapshot (the `config_reconcile` mechanism).
- [x] `src/rollout/store.ts` — rollout history + event timeline in `snapshots.db`.
- [x] Device `tags` in the config schema + regenerated `schemas/config.schema.json`.
- [x] `tests/rollout/runner.spec.ts` — 17 end-to-end cases with fakes, incl. a
      snapshot that cannot be taken, a health check that throws, and a revert that
      itself fails → `needs-attention`.
- **Exit gate:** global gate green (1043 tests).

Two model corrections the runner tests forced, both kept:

- **The revert set is `applied` devices only, never `failed` ones.** The runner
  applies each device inside Safe Mode, so a device that failed mid-change was
  already reverted by RouterOS, and one whose snapshot failed was never touched.
  Replaying a full export over a router that is already in its original state is
  the most dangerous possible no-op.
- **Hold means "start nothing new".** A wave already in flight finishes (its
  devices are independent and each apply is atomic), but a gate, a soak, or the
  first device of the next wave all park. Holding before the rollout starts
  applies nothing at all.

### [x] Phase 3 — Tools

- [x] `src/tools/rollout.ts` (4 tools, incl. the `all`/`tags`/`versionBelow`/`exclude`
      selectors) + `src/tools/index.ts` (label **Fleet Rollout**, slug `rollout`) +
      4 schemas + `src/rollout/session.ts` + `src/observability/rollout-hub.ts`.
- [x] `prompts/fleet-rollout.md`.
- [x] `docs/fleet-rollout.md` + README + `docs/README.md` + `docs/change-plan.md`
      cross-link.
- **Exit gate:** global gate + `bun run gen` (4 new schemas only).

Decisions:

- `plan_rollout` contacts **nothing** — the selector reads the capability cache
  rather than probing, so the preview a human approves can never itself change or
  even touch a device.
- `versionBelow` reuses `compareVersions`/`parseVersion` from firmware lifecycle.
  A second version comparator in this codebase would eventually disagree with the
  first about `7.14` vs `7.14rc1`, and the selector deciding which routers get
  changed is the worst place for that.
- Devices with no cached version are **excluded and named** in the plan output,
  never silently included (the blocker's "error clearly" requirement, softened to
  a per-device note now that task 02 has shipped).
- `start_rollout` takes `confirm` and returns the wave plan when it is false.

### [x] Phase 4 — Dashboard

- [x] `src/observability/rollout-routes.ts` — `GET /api/rollout`, `GET /api/rollout/:id`,
      `POST /api/rollout/:id/hold|resume|abort` — plus `rollout-hub.ts` and the
      `rollout` message type on the existing `/api/stream` socket.
- [x] `ui/observability/rollout.tsx` (wave board with the canary marked, per-wave
      gate result incl. the collateral case, failure drawer with the restore line,
      commands, timeline, history) surfaced as a **Rollout tab** on the Change Plan
      page + `types.ts` + an `onRolloutUpdate` emitter in `hooks.ts`.
- **Exit gate:** global gate + `bun run build:ui` (observability.html 1.29 MB).

Tabs rather than a new nav entry: a rollout IS the change plan applied N times
with gates, and splitting them across pages would hide that.

### [x] Phase 5 — Raycast

- [x] `raycast/src/lib/rollouts.tsx` — rollout list section + Markdown wave-board
      detail, Hold / Resume / Abort (abort behind `lib/confirm.ts`), and a
      `lib/notify.ts` alert on a `halted` / `needs-attention` rollout, announced once
      per id.
- [x] `change-plan.tsx` root is now a list: the dry-run form plus the rollout
      section (a rollout IS the plan applied N times with gates).
- [x] `menubar.tsx` in-flight indicator — a `⟳` in the title, a Rollouts section
      with wave progress, and a red row for a halted / needs-attention rollout.
- **Exit gate:** global gate + `npm run lint` (0 errors) + `tsc --noEmit`
  (0 errors in the new files; `src/lib/diff.tsx` keeps its pre-existing
  duplicate-React type error).

### Blockers / notes

- ~~`versionBelow` depends on task 02.~~ **Resolved:** task 02 has shipped, so the
  selector reads the capability cache (`peekCapabilities`) and reuses
  `compareVersions`/`parseVersion` from firmware lifecycle. A device with no cached
  version is excluded and named in the plan output — no inline probe, so
  `plan_rollout` still contacts nothing.

**All phases complete.** Known gaps, none blocking:

- The soak is real wall-clock time inside `start_rollout`, so a long fleet rollout
  can outlast an MCP client's patience for a single tool call. The dashboard/Raycast
  Hold + Resume path exists precisely for that; a fully detached background runner
  would be the next step.
- The gate uses reachability plus (when a plan declares them) assertions; there is
  no per-plan assertion authoring surface yet — `HealthResult.assertionsPassed` is
  wired through the model and runner but only the SSH probe populates it today.
- Wave count is fixed at three (canary / percentage / rest) by design; a
  "keep taking 25% until done" mode was deliberately not built.
