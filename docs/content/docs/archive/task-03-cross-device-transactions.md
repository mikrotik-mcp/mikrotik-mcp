---
title: "03 \u2014 Cross-device two-phase commit"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 03 — Cross-device two-phase commit

> **Status:** implemented — all 5 phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §9 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Coordinate Safe Mode across **several routers at once**, so a multi-device change
(both ends of a tunnel, a routing peering, a fleet ACL) either lands everywhere or is
rolled back everywhere — never half-applied.

## 1. The failure this fixes

Safe Mode is per-device. Today "build a WireGuard tunnel between site-a and site-b"
runs as two independent sequences. If site-a commits and site-b fails, you own a
half-built tunnel — and if the failure was a firewall rule, possibly a router you can
no longer reach. The assistant cannot fix it, because the successful half already
committed.

This is the most distinctive feature in the backlog. Nothing else in the MCP
ecosystem does distributed network transactions.

## 2. Honest limits (state these in the tool descriptions)

This is **not** ACID. RouterOS Safe Mode gives per-device atomicity and an automatic
revert on session loss; a coordinator on top gives a _best-effort_ distributed
commit with these residual risks:

- **Commit is not simultaneous.** Commits are issued sequentially. If device 3's
  commit fails after 1 and 2 committed, the coordinator must issue _compensating_
  rollbacks to 1 and 2 — and a compensating rollback can itself fail.
- **The window is real but small.** Between first and last commit the fleet is
  inconsistent. Measured in seconds.
- **A device that dies mid-commit** reverts by itself (Safe Mode's own guarantee),
  which is the good case — the coordinator detects the dropped session and treats it
  as a vote to abort.

Design accordingly: **prepare-verify-commit**, with verification doing the heavy
lifting _before_ anyone commits, so the commit phase is as close to trivial as
possible.

## 3. Protocol

```
PREPARE   for each device: capture snapshot → enable Safe Mode → apply changes
          any failure here → rollback every prepared device → ABORT (clean)

VERIFY    run the plan's assertions while everything is still uncommitted
          (ping across the tunnel, peer state, route present, session count)
          any assertion fails → rollback all → ABORT (clean)

COMMIT    commit each device in the declared order
          a commit failure → compensating rollback of already-committed devices
          using their pre-change snapshot → PARTIAL (loud, needs a human)
```

Three terminal states, and the tool output must name which occurred: `COMMITTED`,
`ABORTED` (clean, nothing changed), `PARTIAL` (needs attention — list exactly which
devices are in which state, with the snapshot id to restore from).

**Commit order matters.** Commit the device you are _least_ likely to lose contact
with last — usually the one you are connected through. Expose `commitOrder` on the
transaction, defaulting to the declaration order, and warn if a jump-host device is
not last.

## 4. Architecture

```
src/txn/model.ts      PURE — transaction/participant/assertion types, state machine
src/txn/coordinator.ts  orchestration; uses executeMikrotikCommand + safe-mode
src/txn/store.ts      persistence (bun:sqlite, dynamic import) — txn log
src/tools/txn.ts      5 tools
```

The **state machine is pure and separately tested**: given a set of participant
outcomes, what is the next action and terminal state? That is where the risky logic
lives, and it must be exercised without any device.

Safe Mode sessions are SSH-only and already persistent
(`src/ssh/safe-mode.ts`). The coordinator holds one per participant for the whole
transaction — this is the one place in the codebase holding N concurrent Safe Mode
sessions, so connection-pool interaction needs care (see Blockers).

## 5. Tools (5)

| Tool                   | Risk      | Purpose                                                   |
| ---------------------- | --------- | --------------------------------------------------------- |
| `begin_transaction`    | WRITE     | Open a txn over N devices; returns a txn id               |
| `add_transaction_step` | WRITE     | Queue a change for one participant (command or plan ref)  |
| `verify_transaction`   | READ      | Run assertions against the prepared-but-uncommitted state |
| `commit_transaction`   | DANGEROUS | Commit all, with compensating rollback on partial failure |
| `abort_transaction`    | WRITE     | Roll back every participant, clean                        |

Module `src/tools/txn.ts`, label **"Transactions"**, group `System & Ops`.

`commit_transaction` is `DANGEROUS`, not `DESTRUCTIVE`: high blast radius and not
repeatable.

**Assertions** are declarative so they can be verified without shelling out:
`{kind: "ping", from: "site-a", to: "10.0.0.2"}`,
`{kind: "wireguard-peer-handshake", device, peer}`,
`{kind: "route-present", device, dst}`, `{kind: "reachable", device}`.
An unknown assertion kind is a hard error, never a silent pass.

## 6. Dashboard — new page **Transactions**

`ui/observability/transactions.tsx`. This page has to make an inherently confusing
process legible:

- **Live swimlane** — one lane per participant, columns PREPARE → VERIFY → COMMIT,
  each cell green/amber/red as it resolves. The whole point is seeing _where_ a
  distributed operation is.
- **Assertion panel** — every assertion with its result, expandable to the raw
  device output that decided it.
- **Terminal banner** — `COMMITTED` / `ABORTED` / `PARTIAL`, and for `PARTIAL`, a
  per-device restore action pointing at the pre-change snapshot.
- **History** — past transactions from the txn store, replayable as a timeline.

Routes: `GET /api/txn`, `GET /api/txn/:id`, `POST /api/txn/:id/abort`,
and a `txn` message type on the existing `/api/stream` socket for live lane updates.
Do not open a second socket.

## 7. Raycast — new command **transactions**

`raycast/src/transactions.tsx`, mode `view`. List of recent transactions with state
accessory; detail shows the swimlane as a Markdown table (Raycast has no rich
layout) plus the assertion results. Actions: **Abort** (with `lib/confirm.ts`),
**Open in dashboard**. A `PARTIAL` transaction fires a `lib/notify.ts` notification —
that is exactly the case a human must see immediately.

Add to `raycast/package.json` `commands[]`.

## 8. Testing

Everything above is testable offline because the coordinator takes an injected
executor. `tests/txn/coordinator.spec.ts` drives fake participants:

- happy path, 3 devices → `COMMITTED`
- prepare fails on device 2 → all rolled back → `ABORTED`, no commit issued
- assertion fails → `ABORTED`
- commit fails on device 3 of 3 → compensating rollback of 1 and 2 → `PARTIAL`
- compensating rollback _also_ fails → `PARTIAL` with both devices flagged
- session drops during prepare → treated as abort vote
- commit order respected; jump-host-not-last produces a warning

## 9. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Pure state machine

- [x] `src/txn/model.ts` — types + `nextAction(txn)` / `applyOutcome(txn, outcome)` + `classify()` terminal classification. Pure, no I/O.
- [x] `tests/txn/model.spec.ts` — the seven scenarios in §8 against the pure machine.
- **Exit gate:** global gate green (907 tests).

Decisions worth carrying into Phase 2:

- The coordinator loop is `nextAction` → perform → `applyOutcome`; the model never
  performs I/O and `nextAction` is idempotent until an outcome lands.
- A transaction that reached compensation is `PARTIAL` **even when every restore
  succeeded** — those devices did commit, and the inconsistency window was real.
  Only a fleet where nothing changed at all reports `ABORTED`.
- A commit failure with **no** device yet committed is `ABORTED`, not `PARTIAL`.
- Compensating restores run in **reverse** commit order.
- `sessionLost` on a prepare outcome means RouterOS already self-reverted: the
  device gets no rollback action and the run aborts (`Participant.sessionLost`).
- `beginTransaction` throws on an unknown assertion kind, duplicate/unknown
  devices, or an incomplete `commitOrder`; a jump host not committed last is a
  warning, not an error.

### [x] Phase 2 — Coordinator

- [x] `src/txn/coordinator.ts` — injected `TxnExecutor`; snapshot-per-participant
      before prepare; N concurrent Safe Mode sessions; declarative assertion runner
      (`runAssertion`); `busyDevices()` guard.
- [x] `src/txn/store.ts` — txn log + append-only event timeline in `snapshots.db`
      (reuse, no new DB file); `bun:sqlite` via dynamic import only.
- [x] `tests/txn/coordinator.spec.ts` — same scenarios end-to-end with fakes.
- **Exit gate:** global gate green (923 tests).

**Blocker resolved — connection pool.** `SafeModeManager.enable()` constructs its
own `MikroTikSSHClient` and holds it for the session; the pool
(`src/core/connection-pool.ts`) only owns the one-shot exec connections
`runOnce()` uses. N concurrent Safe Mode sessions are therefore N independent
connections the pool can neither reap nor hand out — no pool changes needed. The
real hazard was the per-device manager registry (one session per device), so the
coordinator refuses to enlist a device that already has an active session.

Also decided here: `restore` on a device that already COMMITTED is **not**
automated — replaying a full `/export` over a live router is a second
uncontrolled change, so the executor rejects with the exact snapshot id and the
manual recovery path, which surfaces as `PARTIAL` with the device flagged.

### [x] Phase 3 — Tools

- [x] `src/tools/txn.ts` (5 tools) + `src/tools/index.ts` (label **Transactions**,
      slug `txn`) + 5 schemas + `src/txn/session.ts` (live-transaction registry).
- [x] `prompts/build-tunnel-transactionally.md` — the flagship workflow.
- [x] `docs/transactions.md` + README + `docs/README.md` + `docs/safe-mode.md`
      cross-link.
- **Exit gate:** global gate + `bun run gen` (5 new schemas only).

**Deviation from §5:** `verify_transaction` is annotated **WRITE**, not READ. It
does prepare the fleet — Safe Mode sessions are opened and the queued steps are
applied (auto-reverted on any failure), which is not an inspection call, and a
READ annotation would let a host auto-approve it. `commit_transaction` stays
`DANGEROUS` as specified.

A transaction spans tool calls, so the open ones live in a process-local map
(`src/txn/session.ts`) and are mirrored best-effort into the txn log; a failed
log write never fails the transaction.

### [x] Phase 4 — Dashboard

- [x] `src/observability/txn-routes.ts` (`GET /api/txn`, `GET /api/txn/:id`,
      `POST /api/txn/:id/abort`) + `txn-hub.ts` and the `txn` message type on the
      existing `/api/stream` socket (no second socket).
- [x] `ui/observability/transactions.tsx` (swimlane, assertion panel, terminal
      banner with per-device recovery, history) + `main.tsx` wiring (ViewId, nav,
      icon, help) + `types.ts`.
- **Exit gate:** global gate + `bun run build:ui` (observability.html 1.27 MB).

UI note: `hooks.ts` grew a tiny `onTxnUpdate` emitter so any view can receive
push data over the one shared stream; the live `txn` frames come from
`publishTxn` in the tool layer. The SSE fallback still carries tool events only,
so the page also reloads on demand — a transaction is minutes long, not seconds.

### [x] Phase 5 — Raycast

- [x] `raycast/src/transactions.tsx` (list + Markdown swimlane detail, Abort via
      `lib/confirm.ts`, Open in Dashboard) + `package.json` command + `lib/types.ts`.
- [x] `PARTIAL` → notification via `lib/notify.ts`, announced once per id
      (LocalStorage), pruned to transactions still present.
- **Exit gate:** global gate + `npm run lint` (0 errors) + `tsc --noEmit`
  (0 errors in the new file; `src/lib/diff.tsx` has a pre-existing duplicate-React
  type error, and the root `node_modules` noise is likewise pre-existing).

### Blockers / notes

- ~~**Connection pool.**~~ Resolved in Phase 2: `SafeModeManager` opens its own
  `MikroTikSSHClient` and never borrows from `src/core/connection-pool.ts`, which
  only manages one-shot exec connections. N concurrent Safe Mode sessions are N
  independent connections the pool can neither reap nor reuse. The real hazard was
  the per-device manager registry, handled by `busyDevices()`.

**All phases complete.** Remaining known gaps, none blocking:

- The SSE fallback (`/api/sse`) carries tool events only, so a browser without
  WebSockets sees transaction updates on refresh/poll rather than push.
- Restoring an already-committed device is intentionally manual (see Phase 2).
- No test drives the live `createDeviceExecutor` against a device — by design,
  `tests/` are offline; the executor is the only untested seam.
