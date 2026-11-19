---
title: "Change Plan & Dry-Run"
description: "Practical setup, operations and limits for Change Plan & Dry-Run."
---

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
> MAC-Telnet devices** (use SSH). See [Safe Mode](/docs/guides/safe-mode).

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
**[Staged Fleet Rollout](/docs/guides/fleet-rollout)** (`plan_rollout` / `start_rollout`).

## Configuration templates and provisioning

A template is a reviewed RouterOS configuration with `{{variable}}` places. It
is kept on the MCP host and applied to a new router, or to many, with each
router's values.

```text
# branch router
/system identity set name={{identity}}
/ip address
add address={{lan_ip}} interface={{lan_if|bridge}}
```

- A place stands for **one whole value**. `{{lan_if|bridge}}` gives a default.
- Do not put a place inside quotes. The value is written as a RouterOS value,
  with quotes when it needs them. That is also what stops a value from adding a
  parameter or a second command, so a template with a place inside quotes is
  refused.
- Both styles are read: full commands, and export style where a menu line
  (`/ip address`) applies to the `add …` lines under it.
- `device` and `host` are always set for you from the device list.

| Tool                     | Does                                                     |
| ------------------------ | -------------------------------------------------------- |
| `save_config_template`   | Saves or replaces a template. Changes no router.         |
| `list_config_templates`  | Lists templates and the variables each needs.            |
| `apply_config_template`  | Renders for each router and applies. Dry run by default. |
| `remove_config_template` | Deletes a template from the host.                        |

Applying is careful. For each router, in order:

1. The template is rendered with `variables` (for every router) and
   `per_device` (for one router, which wins).
2. Every command is parsed on that router. A command that is not valid there
   stops the router with the place of the problem; nothing is written to it.
3. A config snapshot is taken.
4. The commands are written in Safe Mode, so a change that cuts the connection
   is rolled back.

The run stops at the first router that fails; the routers after it are not
touched.

To provision a factory-default router, add it to the device list first: by its
MAC address (MAC-Telnet reaches it with no IP), or by its default address.

Limits to know:

- Templates live in `~/.mikrotik-mcp/templates` (or `MIKROTIK_TEMPLATE_DIR`) as
  plain `.rsc` files. Do not write a secret into a template; pass it as a
  variable.
- A MAC-Telnet router has no Safe Mode and is written directly.
- The check is syntax only. A value that is looked up when the command runs (an
  interface that does not exist) fails at apply time, inside Safe Mode.
- There is no loop or condition in a template. Use RouterOS script (`:if`,
  `:foreach`) in the template text for that.
