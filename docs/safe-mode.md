# Safe Mode

RouterOS **Safe Mode** is a transactional configuration window. While it's
active, every change you make is held **in memory only**. If the session drops —
a dropped connection, a reboot, a crash — RouterOS automatically reverts every
uncommitted change. This is the single best defense against locking yourself out
of a remote device with a bad firewall rule.

This server exposes Safe Mode as four tools and routes commands through a
persistent SSH session while it's active.

## How it works

Under the hood, Safe Mode is activated by sending **Ctrl+X** (`0x18`) to an
interactive RouterOS shell. Sending Ctrl+X a second time commits the pending
changes and exits Safe Mode. The prompt changes to mark the state:

```
[admin@MikroTik] >            normal
[admin@MikroTik] <SAFE> >     safe mode active
```

The server keeps **one long-lived SSH shell** open for the duration of a Safe
Mode window. This matters: a normal tool call opens a fresh one-shot SSH channel,
runs its command, and closes it — such channels can't share Safe Mode state.
So while Safe Mode is active, the [connector](./architecture.md) detects it and
funnels every command through that single persistent session, so all your
changes accumulate inside the same transactional context. Concurrent tool calls
are serialized onto the channel so their I/O never interleaves.

## The tools

| Tool                 | Risk  | What it does                                                                       |
| -------------------- | ----- | ---------------------------------------------------------------------------------- |
| `safe_mode_status`   | read  | Reports whether Safe Mode is currently active.                                     |
| `enable_safe_mode`   | write | Opens the persistent shell and activates Safe Mode (Ctrl+X).                       |
| `commit_safe_mode`   | write | Sends Ctrl+X again to persist all pending changes, then closes the session.        |
| `rollback_safe_mode` | write | Closes the session **without** committing, triggering RouterOS's automatic revert. |

## Typical workflow

1. **Enable** — call `enable_safe_mode`. The server connects, opens an
   interactive shell, waits for the prompt, sends Ctrl+X, and confirms the
   `<SAFE>` prompt appeared.
2. **Make changes** — call any write/destructive tools as usual (e.g. firewall
   rules). The connector automatically routes them through the Safe Mode
   session. Nothing is persisted yet.
3. **Verify** — confirm you still have connectivity and the change behaves as
   intended. This is the moment Safe Mode exists for: if your firewall edit just
   cut your own access, you simply stop and the change reverts on its own.
4. **Commit or roll back**:
   - `commit_safe_mode` — persists everything and exits Safe Mode.
   - `rollback_safe_mode` — discards everything by closing the session.

## The auto-revert guarantee

If the connection to the device is lost for **any** reason while Safe Mode is
active — you call `rollback_safe_mode`, the process exits, the network drops, or
the router reboots — RouterOS reverts **all** uncommitted changes back to the
last committed state. You can only make a change permanent by explicitly calling
`commit_safe_mode`.

This is why the built-in [prompts](./prompts.md) (`harden-router`,
`setup-guest-wifi`, `setup-wireguard-vpn`) instruct the model to wrap risky
firewall edits in Safe Mode: apply, verify connectivity, then commit.

## When to use it

- Before editing the firewall **input** or **forward** chains on a remote device.
- Before changing the interface/IP you're managing the device through.
- Any multi-step change where a partial/wrong result could orphan your access.

For low-risk, single read-only or clearly safe changes, Safe Mode is unnecessary
overhead — `safe_mode_status` will confirm it's inactive and changes apply
immediately.

## Across several devices

Safe Mode is **per device**. A change that must land on more than one router
(both ends of a tunnel, a peering, a fleet ACL) needs the coordinator on top of
it: see **[Cross-Device Transactions](./transactions.md)**, which holds one Safe
Mode session per participant, verifies while everything is still uncommitted, and
then commits in a declared order — reporting `COMMITTED`, `ABORTED` or `PARTIAL`.
