# Change Plan & Dry-Run

RouterOS has no native `terraform plan`. This server adds one: preview a set of
intended commands, see what they'd add/modify/remove and how risky they are,
then apply them inside **Safe Mode** with the exact `/export` diff — and an
automatic rollback if the change would lock you out.

Two tools, in the **Change Plan** module (`/ip` · System & Ops):

| Tool           | Risk      | What it does                                                        |
| -------------- | --------- | ------------------------------------------------------------------- |
| `plan_changes` | READ      | Static, read-only preview — never touches the device.               |
| `apply_plan`   | DANGEROUS | Executes under Safe Mode, shows the exact diff, commits or reverts. |

## `plan_changes` — the dry-run

Give it the commands you intend to run (as an array, or a newline `script`):

```
plan_changes commands=[
  "/ip address remove [find address=192.168.88.1/24]",
  "/ip firewall filter add chain=input action=drop",
  "/ip address add address=10.0.0.1/24 interface=ether1",
  "/ip firewall filter add chain=input action=accept src-address=10.0.0.0/24"
]
```

returns a terraform-style plan:

```
CHANGE PLAN

Plan: +2 to add, ~0 to modify, -1 to remove
Risk: 60/100 (high) · reordered for safety

  + [low]  /ip address add address=10.0.0.1/24 interface=ether1
  + [low]  /ip firewall filter add chain=input action=accept src-address=10.0.0.0/24
  ~ ...
  - [high] /ip address remove [find address=192.168.88.1/24]   ⚠ lock-out risk
  ! [high] /ip firewall filter add chain=input action=drop      ⚠ lock-out risk

WARNINGS:
  • Steps were reordered into a safe sequence: additive changes run before destructive ones …
  • Step 2 (… chain=input action=drop): adds an input-chain drop — your management traffic must be accepted first.
```

What it computes, purely from the commands (no device I/O):

- **Counts** — ADD / MODIFY / REMOVE buckets.
- **Per-step risk** — `low`/`medium`/`high`, aggregated to a 0–100 score and grade.
- **Lock-out detection** — flags the steps that could sever your own access: an
  input-chain `drop`, disabling an `/ip service` (ssh/api/www), removing the
  management IP, removing/disabling your user, disabling the management
  interface, or a factory reset.
- **Safe ordering** — reorders steps so additive ones (add an accept rule, add
  the new IP, enable a service) run **before** destructive ones (drop, remove,
  disable, reset). This is "never tear down the old management path before the
  new one is up", applied automatically.

## `apply_plan` — execute with a safety net

```
apply_plan script="...same commands..." confirm=false
```

`apply_plan`:

1. Enters RouterOS **Safe Mode** (every change is held in memory, auto-reverted
   on disconnect).
2. Captures `/export terse` as the _before_.
3. Runs the plan **in safe order**. If any step errors, it rolls back everything.
4. Captures `/export terse` as the _after_ and returns the **exact unified diff**
   (via the snapshot diff engine).
5. Runs a reachability probe.

- **`confirm=false` (default)** — rolls everything back. A true dry-run that
  shows precisely what _would_ change, with zero lasting effect.
- **`confirm=true`** — commits, **but only if the device still answers**. If the
  change made the router unreachable, it auto-reverts instead of sticking — so a
  bad firewall rule can't lock you out.

> Safe Mode rides a persistent SSH shell, so `apply_plan` is **not available on
> MAC-Telnet devices** (use SSH). See [Safe Mode](./safe-mode.md).

## Typical flow

```
plan_changes script="<my changes>"     # review the plan + warnings
apply_plan   script="<my changes>"      # confirm=false → see the exact diff, reverted
apply_plan   script="<my changes>" confirm=true   # commit (auto-reverts on lock-out)
```

## Across the fleet

`apply_plan` changes **one** device. To roll the same commands out across many —
canary first, a health gate and soak between waves, and automatic revert of
everything already changed if a gate fails — see
**[Staged Fleet Rollout](./fleet-rollout.md)** (`plan_rollout` / `start_rollout`).
