---
name: build-tunnel-transactionally
title: Build a site-to-site tunnel as one cross-device transaction
description: Configure both ends of a tunnel under coordinated Safe Mode — verified while still uncommitted, then committed everywhere or rolled back everywhere. Never a half-built tunnel.
arguments:
  - name: site_a
    description: Configured device name of the first router (one end of the tunnel).
    required: true
  - name: site_b
    description: Configured device name of the second router (the other end).
    required: true
  - name: tunnel
    description: What to build (e.g. "WireGuard 10.99.0.0/30", "GRE over the existing WAN", "IPsec site-to-site"). If omitted, WireGuard is a good default.
    required: false
---

Build a tunnel between **{{site_a}}** and **{{site_b}}** as a single
cross-device transaction, so it either works on both ends or exists on neither.

Tunnel to build: {{tunnel}}

The failure this avoids: configured end-by-end, a tunnel whose second half fails
leaves the first half live — and if the failing change was a firewall rule, a
router you can no longer reach. Under a transaction each device stages its
changes in its own Safe Mode session; nothing persists until every end has been
verified.

Follow these steps:

1. **Look before you write.** Read both ends: `list_interfaces`,
   `list_ip_addresses`, and for WireGuard `list_wireguard_interfaces` /
   `list_wireguard_peers`. Pick addresses and a port that do not collide with
   anything already configured, and note which device you reach the other
   THROUGH (that one must commit last).

2. **Open the transaction.** Call `begin_transaction` with
   `devices=["{{site_a}}", "{{site_b}}"]`, a `label`, and — this is the part that
   makes it safe — `assertions` that prove the tunnel actually works:
   - `{"kind": "ping", "from": "{{site_a}}", "to": "<{{site_b}} tunnel address>"}`
   - `{"kind": "wireguard-peer-handshake", "device": "{{site_a}}", "peer": "<{{site_b}} public key>"}`
     (WireGuard only)
   - `{"kind": "reachable", "device": "{{site_b}}"}` — cheap insurance that the
     far end is still answering after its own changes.
     Set `jump_host` if one router is reached through the other; the tool warns
     when it is not committed last.

3. **Queue every command.** One `add_transaction_step` per RouterOS command,
   naming the participant it runs on. Nothing executes yet. Cover both ends
   completely: interface, addresses, peer/keys, the firewall rule that permits
   the tunnel port, and the route(s) over it.

4. **Prepare and verify.** Call `verify_transaction`. This snapshots each device,
   applies its steps inside Safe Mode, and runs the assertions against the
   still-uncommitted fleet. If anything fails, everything is rolled back
   automatically and the result is `ABORTED` — nothing changed anywhere. Report
   which assertion failed and fix the plan before retrying.

5. **Commit.** Only after a clean verify, call `commit_transaction`. Read the
   terminal state out loud:
   - `COMMITTED` — both ends persisted; confirm with a final `ping` and
     `get_wireguard_status`.
   - `ABORTED` — nothing changed; safe to retry.
   - `PARTIAL` — **tell the user immediately and stop**. Name each device's state
     and the snapshot id in the report; the fix is a manual restore
     (`diff_config_snapshots <id> live`, then `config_reconcile` or
     `restore_backup`), not another blind attempt.

6. **If you need to back out** at any point before commit, call
   `abort_transaction` — it closes every Safe Mode session and RouterOS reverts
   the staged changes.

Be explicit about the limits when you report: this is a best-effort distributed
commit, not a database transaction. Commits are sequential, so there is a
seconds-long window where one end is committed and the other is not.
