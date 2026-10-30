---
title: "Security Hardening"
description: "Practical setup, operations and limits for Security Hardening."
---

A **Security Hardening** module (Security group) that turns a manual RouterOS
security review into repeatable, evidence-based tooling. It ships one
`audit_*` (read-only) + `harden_*`/`fix_*` (scoped write) pair per risk category,
plus an orchestrator that runs every category and applies fixes by ID.

The checks were distilled from a manual audit of a real production router (hAP
ax3, dual-WAN, RouterOS 7.23) but are written to run against **any** RouterOS 7.x
device this MCP manages.

- Engine (pure, no device I/O): `src/core/security-hardening.ts`
- Tools: `src/tools/security-hardening.ts`
- Tests: `tests/core/security-hardening.spec.ts`

## Safety model

Every tool in the suite obeys the same contract:

- **Read-only audits.** `audit_*` and `run_security_hardening_audit` issue only
  `print`/`export`-class commands. They never `add`/`set`/`remove`.
- **Explicit scoped writes.** Every fix tool takes specific `finding_id`s (from a
  prior audit) plus `confirm: true`. There is no "fix everything" flag; a fix
  tool can never widen its own scope.
- **Dry-run default.** `confirm=false` (the default) returns the exact commands
  and writes nothing — it is silently ignored, never an error.
- **Snapshot before write.** Every apply captures a pre-change configuration
  snapshot (same local store as `capture_config_snapshot`) and returns the
  `snapshot_id` so you can `diff_config_snapshots from=<id> to=live` or roll back.
- **Safe Mode.** Any write that could cut management access (firewall/NAT/IP
  service/SSH/DNS/IPv6) runs inside `enable_safe_mode` → `commit_safe_mode`, so a
  rule that drops your own session auto-reverts. MAC-Telnet devices (no SSH) skip
  Safe Mode.
- **Evidence-based findings.** Every finding carries the exact `.id`/rule
  signature it applies to, the literal current value, the proposed action, and a
  `confidence`: **`proven`** (settled by static config) vs
  **`needs_live_verification`** (latent, or dependent on runtime chain/NAT
  interaction the config can't fully prove). The two are never blended.

## The audit → apply lifecycle

```
run_security_hardening_audit / audit_<category>        (read-only: print/export)
        │
        ▼   findings[]  — each with a stable finding_id + fix[]
        │
        ▼   caller picks finding_ids
apply_security_hardening_fixes(finding_ids, confirm)  /  harden_<category>(finding_ids, confirm)
        │
        ├─ confirm=false ─▶ DRY RUN: echo commands, write nothing
        │
        └─ confirm=true
               │
               ▼  capture snapshot   → snapshot_id (rollback point)
               ▼  enable Safe Mode   (SSH devices; skipped for MAC-Telnet)
               ▼  execute each finding's fix[] in safe order
               │       ├─ a command errors ─▶ rollback Safe Mode, report partial
               │       ▼
               ▼  commit Safe Mode
               │       └─ commit fails ─▶ changes revert; report NOT saved
               ▼
          per-finding results + snapshot_id
```

Apply order is fixed and safe: firewall default-deny and address-list
enforcement land **before** service-exposure changes **before** helper/hygiene
changes, so structural protection is in place before anything narrows reachability.

## Categories

| Category                    | Audit tool                          | Fix tool                             | Detects                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firewall default-deny       | `audit_firewall_default_deny`       | `add_firewall_default_deny`          | Chains with no enforced final drop; the **accept-then-disabled-drop** trap (chain looks protected but the drop is `disabled=yes`) as a distinct critical finding.                                                             |
| Address-list enforcement    | `audit_address_list_enforcement`    | `enforce_address_list_blocking`      | Lists populated by `add-*-to-address-list` but never matched by a drop — while correctly **not** flagging staged `stage1→…→blacklist` ladders whose final list is dropped.                                                    |
| Kernel IP hardening         | `audit_kernel_ip_hardening`         | `harden_kernel_ip_settings`          | `tcp-syncookies`, `rp-filter` (strict single-WAN / loose multi-WAN), `accept-source-route`, `accept-redirects`, and IPv6 equivalents.                                                                                         |
| IPv6 firewall baseline      | `audit_ipv6_firewall_baseline`      | `bootstrap_ipv6_firewall_baseline`   | IPv6 forwarding with no default-deny. Two mutually-exclusive options: bootstrap a safe filter (keeps RFC 4890 ICMPv6) **or** disable IPv6. `needs_live_verification` when no IPv6 address is assigned yet (latent).           |
| SSH hardening               | `audit_ssh_hardening`               | `harden_ssh_service`                 | `strong-crypto=no` (auto-fix); sub-2048 RSA host key & ed25519 migration (report-only — regeneration invalidates known_hosts); password-login.                                                                                |
| IP service exposure         | `audit_ip_service_exposure`         | `harden_ip_service_exposure`         | Enabled services with `address=""` **not** already firewall-scoped (avoids the Winbox false positive); telnet (always); 7.15+ reverse-proxy with a multi-WAN caveat.                                                          |
| Connection-tracking helpers | `audit_connection_tracking_helpers` | `harden_connection_tracking_helpers` | Enabled `service-port` helpers (h323, sip, pptp, …) with no matching service.                                                                                                                                                 |
| Management-plane exposure   | `audit_management_plane_exposure`   | `harden_management_plane_exposure`   | mac-server/mac-winbox `=all`, unrestricted bandwidth-server, RoMON, neighbor-discovery scope, default-named SNMP communities.                                                                                                 |
| Account hygiene             | `audit_account_hygiene`             | `fix_password_policy` _(narrow)_     | Password policy (`minimum-password-length`/`-categories` — auto-fixable); suspicious usernames and broad read-tier group policy (manual review only — never auto-deleted).                                                    |
| Certificate hygiene         | `audit_certificate_hygiene`         | `fix_certificate_crl_policy`         | `crl-use`/`crl-download` off while cert-based services (OpenVPN/SSTP) are in use.                                                                                                                                             |
| Network segmentation        | `audit_network_segmentation`        | _(report-only)_                      | One physical interface carrying a server subnet and a DHCP client pool with no VLAN isolation. Topology fact is `proven`; isolation-absence is `needs_live_verification`. Includes a suggested VLAN plan. Never auto-applied. |
| DNS resolver exposure       | `audit_dns_resolver_exposure`       | `harden_dns_resolver_exposure`       | `allow-remote-requests=yes` with port 53 not restricted on **both** TCP and UDP (catches the one-transport-only field trap).                                                                                                  |

### Orchestrator

- `run_security_hardening_audit` — runs every category (or a `categories`
  subset), returns one severity-ranked report with a summary count. Pure read.
- `apply_security_hardening_fixes` — applies explicit `finding_id`s in safe
  order inside one snapshot + Safe-Mode session; returns per-finding results and
  the `snapshot_id`. Requires `confirm: true`; never accepts a blanket flag.

## Confidence: proven vs needs_live_verification

Some findings are unambiguous from static config (`tcp-syncookies=no`). Others
are latent or depend on runtime behaviour: an IPv6 stack that forwards but has no
address assigned yet, a reverse-proxy whose per-interface reachability a static
config can't settle, or whether a firewall rule actually shadows a service. Those
are labelled `needs_live_verification` in both the finding output and the code,
and are never presented with the same certainty as a proven finding. Verify them
against the live device before acting.

## Example

```
run_security_hardening_audit
# → findings, each with a finding_id, e.g.:
#   [CRIT] disabled_enforcement:input:3   (re-enable a disabled Winbox drop)
#   [HIGH] unenforced_list:port scanners  (list populated but never dropped)
#   [MED ] kernel:rp-filter               (rp-filter=no → loose on this multi-WAN box)

apply_security_hardening_fixes finding_ids=["unenforced_list:port scanners","kernel:rp-filter"]
# → DRY RUN preview (confirm defaulted false)

apply_security_hardening_fixes finding_ids=["unenforced_list:port scanners","kernel:rp-filter"] confirm=true
# → snapshot captured, Safe Mode enabled, fixes applied in safe order, committed
#   diff_config_snapshots from=<snapshot_id> to=live   # to review/rollback
```

## Relationship to the other Security tools

- `firewall_audit` — shadowed/broad/duplicate/dead rule analysis + risk score.
- `run_compliance_audit` — scored A+–F posture across SSH/services/users/etc.
- `harden_firewall` (Security Shield) — applies a chosen preset of protective
  firewall rules.

Security Hardening is the **granular, per-finding, remediate-by-ID** layer: it
tells you exactly which specific misconfiguration to fix and lets you apply just
that one, safely.
