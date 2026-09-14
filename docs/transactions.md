# Cross-Device Transactions

[Safe Mode](./safe-mode.md) makes a change to **one** router reversible. A
transaction extends that across **several** routers: a change that spans devices
— both ends of a tunnel, a routing peering, a fleet-wide ACL — is staged and
verified before sequential commits. This reduces half-applied changes; it cannot
guarantee all-or-nothing outcomes across routers.

## When the assistant should choose it

Transactions are the preferred workflow for **authorized, related writes on two
or more managed SSH routers**: both VPN endpoints, dependent routes, routing
peering, or coordinated firewall/NAT/VLAN/ACL edits. They are not a reason to
change more devices or create artificial dashboard activity.

| Task                                                    | Preferred workflow                      |
| ------------------------------------------------------- | --------------------------------------- |
| Inspect or diagnose devices                             | Dedicated read tools; no transaction    |
| Change one router                                       | Single-device change plan / Safe Mode   |
| Coordinate related writes across routers                | Transactions with meaningful assertions |
| Independent canary/wave deployment                      | Staged fleet rollout                    |
| Reboot, firmware upgrade, irreversible external effects | Separate approved workflow              |

The MCP initialization instructions recommend this workflow only when at least
two enabled SSH devices and all five transaction tools are exposed in a writable
session. `find_tools` explicitly points coordinated changes to `begin_transaction`;
its searchable title/description include multi-router change, VPN, peering and ACL
intent. The prompt loader adds the same execution guidance to cross-device tunnel,
BGP/OSPF peering and safe-change recipes, without changing diagnostic prompts.
Recipe commands become queued steps, not independent writes or per-device commits.

The recommendation is guidance, **not new execution permission or a runtime
approval gate**. Present the exact participant list, commands, assertions, backups
and commit order first. `begin_transaction` and `add_transaction_step` touch no
router; **`verify_transaction` changes live configuration**. Commit only after a
clean verification and approval covering that exact plan. Empty assertions prove
nothing. Do not take over another operator's Safe Mode session. Resolve required
keys/addresses before preparing; adding steps after preparation is not supported.

Report the transaction id and refer to the dashboard's **Transactions** timeline.
On `PARTIAL` or uncertain rollback, stop and report every participant and snapshot
id; obtain direction for recovery rather than retrying or restoring automatically.
Reconnect the MCP client after deploying an updated server to receive refreshed
initialization instructions and tool descriptions. Prompt guidance is shared by
`prompts/get` and the dashboard's prompt catalog. Model adoption is not guaranteed.

The failure it removes: configured device-by-device, a change whose second half
fails leaves the first half live. A half-built tunnel, or worse, a firewall rule
committed on the router you were reaching the others through.

Five tools, in the **Transactions** module (System & Ops):

| Tool                   | Risk      | What it does                                              |
| ---------------------- | --------- | --------------------------------------------------------- |
| `begin_transaction`    | WRITE     | Opens a transaction over N devices; returns its id        |
| `add_transaction_step` | WRITE     | Queues one command for one participant (nothing runs yet) |
| `verify_transaction`   | WRITE     | Prepares every device, asserts against uncommitted state  |
| `commit_transaction`   | DANGEROUS | Commits sequentially; reports manual recovery on PARTIAL  |
| `abort_transaction`    | WRITE     | Requests rollback of staged, uncommitted participants     |

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
          any failure → attempt rollback of prepared devices → inspect report

VERIFY    run the declared assertions while everything is still uncommitted
          any assertion fails → attempt rollback → inspect report

COMMIT    commit each device in commit order
          a failure after the first commit → report snapshots for manual restore
          of committed devices → PARTIAL (needs a human)
```

Three terminal states, and every tool names which one occurred:

| State       | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `COMMITTED` | Every participant persisted its changes.                                            |
| `ABORTED`   | No participant committed; inspect rollback evidence and live state before retrying. |
| `PARTIAL`   | Some devices committed. Needs a human; the report names each snapshot.              |

A transaction that reached compensation reports `PARTIAL` **even when every
restore succeeded** in a test executor — those devices really did commit. The
production executor does not replay snapshots automatically. Staged changes may
affect traffic even when the transaction never commits.

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
