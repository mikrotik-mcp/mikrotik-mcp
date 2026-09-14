---
name: build-tunnel-transactionally
title: Build a site-to-site tunnel as one cross-device transaction
description: Preferred coordinated workflow for both ends of an approved site-to-site tunnel — stage, verify, then commit with explicit approval; partial commits require manual recovery.
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
cross-device transaction, verifying both ends before issuing sequential commits.

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
   improves verification — `assertions` for the expected router-side state:
   - `{"kind": "ping", "from": "{{site_a}}", "to": "<{{site_b}} tunnel address>"}`
   - `{"kind": "wireguard-peer-handshake", "device": "{{site_a}}", "peer": "<{{site_b}} public key>"}`
     (WireGuard only)
   - `{"kind": "reachable", "device": "{{site_b}}"}` — evidence that the
     far end is still answering after its own changes.
     Set `jump_host` if one router is reached through the other; the tool warns
     when it is not committed last. Set `commit_order` explicitly with that
     participant last. Assertions do not prove client application health.

3. **Queue every command.** One `add_transaction_step` per RouterOS command,
   naming the participant it runs on. Nothing executes yet. Cover both ends
   completely: interface, addresses, peer/keys, the firewall rule that permits
   the tunnel port, and the route(s) over it.

4. **Prepare and verify.** Call `verify_transaction`. This snapshots each device,
   applies its steps inside Safe Mode, and runs the assertions against the
   still-uncommitted fleet. This changes live traffic and requires prior approval;
   it is not a read-only check. Failure triggers rollback attempts. Report every
   participant's state and rollback evidence before considering a revised plan.

5. **Commit.** Only after a clean verify and approval covering this exact commit,
   call `commit_transaction`. Read the
   terminal state out loud:
   - `COMMITTED` — both ends persisted; confirm with a final `ping` and
     `get_wireguard_status`.
   - `ABORTED` — no participant committed; inspect rollback results and live state
     before proposing a retry. Staged changes may already have affected traffic.
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
