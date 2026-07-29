---
name: fleet-rollout
title: Roll one change out across the fleet, safely
description: Apply the same change to many routers as canary → wave → fleet, with a health gate and soak between waves and automatic revert of everything already changed on the first failure.
arguments:
  - name: change
    description: What to change on every device (e.g. "set the NTP servers to 10.0.0.1 and 10.0.0.2", "add the management address-list entry", "disable the telnet service").
    required: true
  - name: targets
    description: Which devices — a list of names, "all", or a tag (e.g. "branch"). If omitted, ask before selecting anything.
    required: false
---

Roll this change out across the fleet: **{{change}}**

Targets: {{targets}}

This is the highest-blast-radius thing in the toolbox: one mistake, applied
automatically to every router. The structure that makes it safe is
canary → wave → fleet with a health gate between waves — use it, and show your
work before executing.

Follow these steps:

1. **Turn the request into exact commands.** Work out the RouterOS commands for
   the change and check them against one device's current config first (a `get_*`
   or `list_*` read). A rollout applies the same commands everywhere, so a
   command that depends on a device-specific name (an interface, a list) is a
   trap — say so rather than rolling it out.

2. **Preview with `plan_rollout`.** It contacts nothing. Show the human:
   - which devices matched (and, for a selector, which were excluded and why),
   - the wave split — the canary is the device that will find the problem,
   - the exact commands, and the estimated duration.
     Order matters for an explicit list: put the router you reach the others
     THROUGH **last**, so a change that severs its path cannot strand the rest.

3. **Get agreement before executing.** Do not call `start_rollout` on your own
   initiative for a fleet-wide change. Present the plan and ask.

4. **Execute with `start_rollout confirm=true`.** Defaults worth stating out
   loud when you do:
   - `soakSeconds=30` — the wait after each wave's health check. A change that
     breaks connectivity ten seconds later must not already be on every router.
   - `onFailure=halt-and-revert` — the first failed gate stops the rollout and
     restores every device it already changed, newest first.
     Raise the soak for anything touching routing, firewall or interfaces; those
     break with a delay.

5. **Read the terminal state out loud.** Each one means something different:
   - `COMPLETED` — every device applied the change.
   - `HALTED and REVERTED` — a gate failed; the fleet is back where it started.
     Report WHICH device and why, especially if the failure was on an untouched
     device (that means the change broke something fleet-wide).
   - `HALTED` (`halt-and-hold`) — changed devices are still changed, on purpose,
     for inspection.
   - `COMPLETED WITH FAILURES` — `continue` was set; list what failed.
   - `NEEDS ATTENTION` — **stop and tell the user immediately.** A revert itself
     failed; the report names the device and the snapshot id. The fix is a manual
     restore (`diff_config_snapshots <id> live`, then `config_reconcile`), not
     another rollout.

6. **Verify a sample afterwards.** Read the changed setting back from the canary
   and from one device in the last wave. A rollout that reports success and a
   device that actually has the setting are two different facts.

To stop a rollout in flight: `abort_rollout` — it reverts everything this
rollout changed, regardless of `onFailure`.
