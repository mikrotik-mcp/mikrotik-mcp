# Staged Fleet Rollout

Applying one change to fifty routers is not fifty independent changes. The point
is to find out on device 1 what you would otherwise discover on device 50.

A rollout runs **canary → wave → fleet**, and between waves it stops at a gate:
health-check what just changed, health-check what hasn't, wait, then continue —
or halt and put everything back.

Four tools, in the **Fleet Rollout** module (System & Ops):

| Tool             | Risk      | What it does                                                 |
| ---------------- | --------- | ------------------------------------------------------------ |
| `plan_rollout`   | READ      | Preview: waves, order, commands, duration — contacts nothing |
| `start_rollout`  | DANGEROUS | Execute with gates; returns a rollout id                     |
| `rollout_status` | READ      | Current wave, per-device state, gate results                 |
| `abort_rollout`  | WRITE     | Halt now and revert what this rollout applied                |

## Not the same as a transaction

[Cross-device transactions](./transactions.md) make a change atomic across
devices that must **agree** — both ends of a tunnel. A rollout makes a change
safe across devices that are **independent** — the same NTP server everywhere.

|            | Transaction (03)             | Rollout (05)                       |
| ---------- | ---------------------------- | ---------------------------------- |
| Guarantee  | all-or-nothing               | progressive, halts on failure      |
| Shape      | simultaneous                 | sequential, wave by wave           |
| Failure    | rollback everywhere          | revert what was applied, skip rest |
| Use it for | tunnels, peerings, fleet ACL | NTP, DNS, syslog, hardening        |

They share the snapshot and Safe Mode primitives, deliberately not the state
machine.

## The gate is the feature

After each wave the coordinator checks:

1. **The devices just changed** — are they still reachable, and do the plan's
   assertions still hold?
2. **The devices NOT yet touched** — did any of them go dark? This is the check
   people forget, and the only one that catches a change which breaks routing or
   a shared firewall path for the rest of the fleet. When it fires, the report
   says so explicitly (`collateral`).

Then it **soaks** (30 s by default) before the next wave. Without a soak, a
change that breaks connectivity ten seconds later has already reached every
router by the time anything notices.

A device that was **already unreachable when the rollout started** does not count
against any gate. Halting every fleet change because one router has been off
since yesterday is how a safety feature earns itself a `--force`.

## Failure modes

`onFailure` decides what a failed gate means:

| Mode                        | Behaviour                                                              |
| --------------------------- | ---------------------------------------------------------------------- |
| `halt-and-revert` (default) | Restore every device this rollout changed, newest first; skip the rest |
| `halt-and-hold`             | Stop; change nothing back (for inspecting the broken device)           |
| `continue`                  | Press on; report `completed-with-failures`                             |

Terminal outcomes, and what each actually means:

| Outcome                   | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `completed`               | Every device applied the change.                                |
| `completed-with-failures` | Finished, but a gate failed along the way (`continue`).         |
| `halted`                  | Stopped; changed devices left changed.                          |
| `reverted`                | Stopped and put back — the fleet is where it started.           |
| `needs-attention`         | **A revert itself failed.** The only outcome requiring a human. |
| `aborted`                 | A human stopped it; whatever was applied has been reverted.     |

## How a device is changed, and put back

Each device is snapshotted (`/export terse`), changed **inside Safe Mode**,
verified still reachable, and only then committed. A change that fails part-way
is reverted by RouterOS as the session closes — so a failed apply leaves that
router untouched rather than half-changed, and the rollout's own revert only ever
deals with devices that committed cleanly.

Reverting replays the device's pre-change snapshot, the same mechanism
[`config_reconcile`](./config-snapshots.md) uses. That is what lets
`halt-and-revert` be the default — but it is not free, so a revert that fails is
surfaced as `needs-attention` with the snapshot id rather than retried into a
worse state.

## Selecting devices

```jsonc
targets: ["branch-01", "branch-02", "core-rtr"]   // explicit; ORDER IS THE WAVE ORDER
targets: { "all": true }
targets: { "tags": ["branch"] }                    // device config `tags`
targets: { "versionBelow": "7.14" }                // uses the capability cache
targets: { "all": true, "exclude": ["core-rtr"] }  // composable
```

With an explicit list, **put the router you reach the others through last** —
wave order follows the order given, and the plan never reshuffles it.

`versionBelow` reads the capability cache rather than probing: probing inline
would duplicate [device capabilities](./capabilities.md) and would make
`plan_rollout` touch devices, which it must never do. Devices with no cached
version are **excluded and named** in the plan output, never silently included.

Tag devices in the config:

```jsonc
{
  "devices": {
    "branch-01": { "host": "10.1.0.1", "tags": ["branch", "eu"] },
  },
}
```

## Example

```
plan_rollout \
  commands='["/system ntp client set enabled=yes primary-ntp=10.0.0.1"]' \
  targets='{"tags":["branch"]}' label="ntp servers"
→ 12 devices in 3 waves (1 / 3 / 8), ~6 min including a 30s soak per wave

start_rollout … confirm=true
→ COMPLETED — every device applied the change.
```

The [`fleet-rollout` prompt](./prompts.md) walks the model through this,
including getting agreement before executing and what to do on each outcome.

## Architecture

```
src/rollout/model.ts    PURE — wave planning, gate evaluation, next-action machine
src/rollout/runner.ts   the loop + the live Safe-Mode executor + health probes
src/rollout/store.ts    rollout history (shares snapshots.db)
src/rollout/session.ts  in-flight rollouts + best-effort persistence
src/tools/rollout.ts    the four tools
```

Every decision — which wave next, does the gate pass, what to revert — is pure
and exercised offline in `tests/rollout/` (52 cases), including the ones that
only exist when things go wrong: a snapshot that cannot be taken, a health check
that throws, an untouched device going dark, and a revert that itself fails.
