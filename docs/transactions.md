# Cross-Device Transactions

[Safe Mode](./safe-mode.md) makes a change to **one** router reversible. A
transaction extends that across **several** routers: a change that spans devices
— both ends of a tunnel, a routing peering, a fleet-wide ACL — either lands
everywhere or is rolled back everywhere.

The failure it removes: configured device-by-device, a change whose second half
fails leaves the first half live. A half-built tunnel, or worse, a firewall rule
committed on the router you were reaching the others through.

Five tools, in the **Transactions** module (System & Ops):

| Tool                   | Risk      | What it does                                              |
| ---------------------- | --------- | --------------------------------------------------------- |
| `begin_transaction`    | WRITE     | Opens a transaction over N devices; returns its id        |
| `add_transaction_step` | WRITE     | Queues one command for one participant (nothing runs yet) |
| `verify_transaction`   | WRITE     | Prepares every device, asserts against uncommitted state  |
| `commit_transaction`   | DANGEROUS | Commits all, compensating on a partial failure            |
| `abort_transaction`    | WRITE     | Rolls every participant back, clean                       |

## Honest limits — read this first

This is **not** ACID. RouterOS gives per-device atomicity and an automatic revert
on session loss; a coordinator on top gives a _best-effort_ distributed commit:

- **Commits are sequential.** Between the first and the last commit the fleet is
  inconsistent. The window is real, measured in seconds.
- **A commit failure after something committed cannot be undone cleanly.** The
  coordinator reports `PARTIAL` and names the snapshot to restore each affected
  device from. Restoring a committed device is **not** automated — replaying a
  full `/export` over a live router is itself a high-risk change, so the tool
  hands you the exact restore point instead of improvising.
- **A device that dies mid-transaction is the good case.** Its Safe Mode session
  drops, RouterOS reverts it by itself, and the coordinator counts that as a vote
  to abort.

The design compensates by doing the hard work **before** anyone commits.

## The protocol

```
PREPARE   per device: capture /export snapshot → enable Safe Mode → apply steps
          any failure → roll every prepared device back → ABORTED (clean)

VERIFY    run the declared assertions while everything is still uncommitted
          any assertion fails → roll all back → ABORTED (clean)

COMMIT    commit each device in commit order
          a failure after the first commit → compensating restore of the
          committed ones (reverse order) → PARTIAL (loud, needs a human)
```

Three terminal states, and every tool names which one occurred:

| State       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `COMMITTED` | Every participant persisted its changes.                               |
| `ABORTED`   | **Nothing changed anywhere.** The clean failure — safe to retry.       |
| `PARTIAL`   | Some devices committed. Needs a human; the report names each snapshot. |

A transaction that reached compensation reports `PARTIAL` **even when every
restore succeeded** — those devices really did commit, and the fleet really was
inconsistent for that window. Only a fleet that never changed reports `ABORTED`.

## Commit order

Commit the device you are **least likely to lose contact with last** — usually
the one you reach the others through. `commit_order` sets it (defaulting to the
declaration order), and passing `jump_host` gets you a warning when that device
is not last.

## Assertions

Verification is declarative, so it runs without free-form commands. Four kinds:

| Assertion                                                                 | Passes when                       |
| ------------------------------------------------------------------------- | --------------------------------- |
| `{"kind":"ping","from":"site-a","to":"10.0.0.2"}`                         | the ping gets at least one reply  |
| `{"kind":"wireguard-peer-handshake","device":"site-a","peer":"<pubkey>"}` | the peer shows a `last-handshake` |
| `{"kind":"route-present","device":"site-b","dst":"10.0.0.0/30"}`          | the route exists in `/ip route`   |
| `{"kind":"reachable","device":"site-b"}`                                  | the device still answers          |

An unknown assertion kind is a hard error at `begin_transaction`, never a silent
pass — an assertion nobody evaluates would let a broken change commit while
reporting that it was verified.

## Example — a WireGuard tunnel across two sites

```
begin_transaction devices=["site-a","site-b"] jump_host="site-a" label="a↔b wg" \
  assertions=[{"kind":"ping","from":"site-a","to":"10.99.0.2"}]
→ txn_1730900000000_ab12cd

add_transaction_step txn_id=… target_device=site-a command="/interface wireguard add name=wg-b listen-port=13231"
add_transaction_step txn_id=… target_device=site-a command="/ip address add address=10.99.0.1/30 interface=wg-b"
add_transaction_step txn_id=… target_device=site-b command="/interface wireguard add name=wg-a listen-port=13231"
add_transaction_step txn_id=… target_device=site-b command="/ip address add address=10.99.0.2/30 interface=wg-a"
…peers, firewall rule, routes…

verify_transaction txn_id=…
→ PREPARED and VERIFIED — assertions passed, nothing committed

commit_transaction txn_id=…
→ COMMITTED
```

The `build-tunnel-transactionally` [prompt](./prompts.md) walks the model through
exactly this, including what to do on each terminal state.

## What happens on your devices

- Each participant gets **its own Safe Mode session**, held open for the whole
  transaction. Those sessions are independent SSH connections (Safe Mode never
  borrows from the connection pool), so N participants means N connections.
- A device whose Safe Mode session is **already open** cannot be enlisted —
  sharing it would commit changes the transaction never staged. Close it first
  (`safe_mode_status`, `commit_safe_mode`, `rollback_safe_mode`).
- Every participant is snapshotted with `/export terse` **before** it is touched,
  into the same store `capture_config_snapshot` uses. That snapshot id is what a
  `PARTIAL` report hands you.
- Transactions and their timelines are logged to `~/.mikrotik-mcp/snapshots.db`
  and shown on the dashboard's **Transactions** page.

## Architecture

```
src/txn/model.ts        PURE state machine — nextAction / applyOutcome / classify
src/txn/coordinator.ts  the loop + the live Safe Mode executor + assertion runner
src/txn/store.ts        the txn log (bun:sqlite, dynamic import)
src/txn/session.ts      open transactions (in-process) + best-effort persistence
src/tools/txn.ts        the five tools
```

Every risky decision lives in the pure model, so all seven failure scenarios —
including "the compensating rollback itself failed" — are exercised offline in
`tests/txn/`. Nothing in the test suite touches a router.
