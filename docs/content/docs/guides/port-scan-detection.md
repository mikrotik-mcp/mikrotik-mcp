---
title: "Port-Scan Detection"
description: "Practical setup, operations and limits for Port-Scan Detection."
---

Two tools that **detect and tag** port-scan attempts on any device in the fleet —
they never block. A scan source is added to an address list (default
`port scanners`); enforcing/blocking that list is deliberately a separate concern.

- Catalog + planner (pure): `src/core/port-scan-detection.ts`
- Shared chain helper: `src/core/firewall-chain.ts`
- Tools: `src/tools/port-scan-detection.ts`
- Tests: `tests/core/port-scan-detection.spec.ts`

## Tools

| Tool                                  | Risk      | Purpose                                                                                                                                                                                                   |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_port_scan_detection_signatures` | read      | Catalog of the six signatures (id, display name, description, exact RouterOS match). With a device in context, also reports which are already present. **Call this first and get an explicit selection.** |
| `add_port_scan_detection_rules`       | dangerous | Installs the user-selected signatures inside the `detect-portscan` sub-chain behind a trust-excluding jump. Snapshot + Safe-Mode. Idempotent.                                                             |

### Mandatory explicit selection

`add_port_scan_detection_rules` takes `rule_types` as a **required, non-empty
array** of specific signature IDs — there is no default and no select-all. An
empty array, an unknown value, or an `"all"` shortcut is rejected. Always present
the catalog (`list_port_scan_detection_signatures`) and let the human choose which
signatures to enable, every time.

## The six signatures

All six are `/ip firewall filter` rules with `action=add-src-to-address-list`,
`protocol=tcp`, `chain=detect-portscan`, `address-list=<default "port scanners">`,
`address-list-timeout=<default "2w">`, and `comment=<the display name>`.

| id                 | comment (display name)  | match                                     | what it catches                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psd_generic`      | `Port scanners to list` | `psd=21,3s,3,1`                           | RouterOS's built-in Port Scan Detection heuristic — one source touching many ports fast (weight 3/privileged, 1/high, trips at 21 within 3 s). Catches ordinary `nmap -sT/-sS` sweeps whose individual packets look like valid handshakes, which the flag signatures can't see. |
| `nmap_fin_stealth` | `NMAP FIN Stealth scan` | `tcp-flags=fin,!syn,!rst,!psh,!ack,!urg`  | Lone FIN (`nmap -sF`). No real handshake/teardown starts with a bare FIN; used to fingerprint port state and slip past SYN-only firewalls.                                                                                                                                      |
| `syn_fin_scan`     | `SYN/FIN scan`          | `tcp-flags=fin,syn`                       | SYN+FIN together — logically impossible (opening and closing at once); only a crafted packet, historically bypassing firewalls that classify "new" purely on SYN.                                                                                                               |
| `syn_rst_scan`     | `SYN/RST scan`          | `tcp-flags=syn,rst`                       | SYN+RST together — open and abort never coexist in a real stack.                                                                                                                                                                                                                |
| `fin_psh_urg_scan` | `FIN/PSH/URG scan`      | `tcp-flags=fin,psh,urg,!syn,!rst,!ack`    | Nmap's `-sX` "Xmas tree" scan — an alternate fingerprint against stacks that special-case the plain FIN.                                                                                                                                                                        |
| `nmap_null_scan`   | `NMAP NULL scan`        | `tcp-flags=!fin,!syn,!rst,!psh,!ack,!urg` | Nmap's `-sN` scan — an empty TCP flag byte; same purpose as FIN/Xmas via the absence of flags.                                                                                                                                                                                  |

## Architecture — a jump-gated sub-chain, not per-rule exclusion

```
chain=input
  … management-access accepts (SSH/Winbox/…) …
  action=jump  jump-target=detect-portscan  src-address-list=!<trusted_list>   ← the ONE exclusion
  … (before the final default-deny, if any) …
  action=drop            ← default-deny (if present)

chain=detect-portscan
  <selected signature rules>  → action=add-src-to-address-list address-list="port scanners"
```

**Why a single jump gate instead of `src-address-list=!<trusted>` on each of the
six rules?** These rules only tag; they can't disconnect a session by themselves.
The real risk is _forward-looking_: if any enforcement rule — now or later, on this
device or added by another tool in the fleet — blocks the `port scanners` list, a
false positive that tagged the operator's own management IP becomes a silent
lockout the next time that rule runs. Expressing the trust exclusion **once**, as a
negative match on the jump, means a trusted source never enters `detect-portscan`
at all and can never be tagged — and there is no per-rule condition to forget on a
future edit. Defensive by construction.

### Positioning

The jump is placed **before** the input chain's final unconditional `drop`/`reject`
(a rule after a default-deny is dead code). If there is no default-deny, the jump is
appended after the existing management-access accepts so ordering stays predictable,
and the missing default-deny is reported as an out-of-scope observation (not fixed
here). The default-deny is located with the shared `findFinalUnconditionalDrop`
helper (reused elsewhere). Because a chain-filtered `print` renumbers rows, the tool
resolves the jump's `place-before` to the rule's actual `.id`, never the filtered
ordinal.

## Safety

- **Explicit trust list, validated pre-flight.** `trusted_list_name` is required
  (no default). Before any write the tool confirms it exists and is non-empty —
  an empty trust list protects nothing, so the call is refused rather than
  silently continuing. The tool never auto-creates or populates it.
- **Human acknowledgement.** `confirmed_trusted_list_includes_my_ip: true` is
  required — the tool cannot know which IP you connect from, so it cannot infer
  that your management address is actually in the trust list. This is a human
  decision, not a list read.
- **Snapshot + Safe Mode (with a direct fallback).** Every successful run captures a
  config snapshot first (returned as `snapshot_id`) and prefers to apply all writes
  inside Safe Mode, so a dropped session auto-reverts. But Safe Mode over SSH is flaky
  on some RouterOS builds (the interactive session can go silent). Because these rules
  only tag and ride a trust-excluding jump — they **cannot** lock out management access
  — the tool does **not** hard-fail when Safe Mode is unavailable or wedges: it falls
  back to applying the writes **directly**, with the pre-change snapshot as the rollback
  point, and says so in its output. A rejected request performs no snapshot and no writes.
- **Building the rules by hand.** `create_filter_rule` accepts a custom `chain` name
  (e.g. `detect-portscan`) and the `add-src-to-address-list` / `add-dst-to-address-list`
  actions, so the detection/jump rules can be built with the dedicated tool rather than
  a raw command if you ever need to do it manually.
- **Idempotent.** Each rule is keyed on chain + comment (+ its `psd`/`tcp-flags`
  value); a second identical run adds nothing and reports items as already present.
- **Verify from a fresh connection.** The result text always instructs the operator
  to confirm management access from a separate, fresh session before considering
  the change final.

## Out of scope (by design)

No drop/enforcement rule for `port scanners`; no seventh "ALL flags" signature; no
DDoS/brute-force/default-deny/IPv6 changes. This tool touches exactly these six
detection signatures and their jump gate.
