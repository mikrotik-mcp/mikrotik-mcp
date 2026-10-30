---
title: "Security Shield"
description: "Harden the firewall against DDoS, SSH/Winbox brute-force, port scans, floods and spoofing from a chosen preset/toggles, with anti-lockout, Safe-Mode apply and preview-before-apply."
---

## Tools

- [Harden Firewall (Security Shield)](#harden_firewall)
- [Audit Firewall Hardening](#audit_firewall_hardening)
- [Remove Firewall Hardening](#remove_firewall_hardening)

## harden_firewall

**Harden Firewall (Security Shield)** · Risk: **dangerous**

Hardens the IPv4 firewall against common attacks by applying a chosen set of best-practice rules (DDoS/connection-rate, SSH/Winbox brute-force ladder, SYN-flood and ICMP rate limits, port-scan detection, anti-spoof/bogon, raw pre-conntrack drops, management lock-down). Pick a `preset` (basic · standard · paranoid) and/or toggle individual `protections`. DEFAULTS TO A DRY RUN (`apply=false`) that returns the exact commands grouped by protection. Applying defaults to SAFE MODE (`safe_mode=true`) so a rule that cuts your own access auto-reverts. Anti-lockout: set `trusted_sources` (an address or address-list always accepted first); input-drop protections are refused without it unless `i_accept_lockout_risk=true`. Every rule is tagged with a 'security-shield:' comment — audit with audit_firewall_hardening, undo with remove_firewall_hardening. Rules are appended; review order for an existing ruleset.

| Parameter               | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                | Yes      | Bundle to apply; 'custom' uses only the `protections` toggles `{"default":"standard","type":"string","enum":["basic","standard","paranoid","custom"]}`                                                                                                                                                                                                                                                                                         |
| `protections`           | No       | Per-protection on/off, overriding/extending the preset `{"type":"object","propertyNames":{"type":"string","enum":["state_hygiene","ssh_bruteforce","ddos_conn_limit","syn_flood","icmp_limit","port_scan","anti_spoof","raw_drops","mgmt_lockdown"]},"additionalProperties":{"type":"boolean"},"required":["state_hygiene","ssh_bruteforce","ddos_conn_limit","syn_flood","icmp_limit","port_scan","anti_spoof","raw_drops","mgmt_lockdown"]}` |
| `trusted_sources`       | No       | Address or address-list name always accepted first (anti-lockout) `{"type":"string"}`                                                                                                                                                                                                                                                                                                                                                          |
| `wan_interface`         | No       | WAN interface (required for anti_spoof) `{"type":"string"}`                                                                                                                                                                                                                                                                                                                                                                                    |
| `mgmt_ports`            | Yes      | Management TCP ports `{"default":"22,8291,8728","type":"string"}`                                                                                                                                                                                                                                                                                                                                                                              |
| `ssh_ports`             | Yes      | Ports watched by the brute-force ladder `{"default":"22","type":"string"}`                                                                                                                                                                                                                                                                                                                                                                     |
| `conn_limit`            | Yes      | Per-source TCP connection cap `{"default":100,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                                                                                                                                                                                                                                                        |
| `syn_rate`              | Yes      | `{"default":"200,50:packet","type":"string"}`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `icmp_rate`             | Yes      | `{"default":"50,10:packet","type":"string"}`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apply`                 | Yes      | false = preview only (default); true = apply `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                              |
| `safe_mode`             | Yes      | Apply through Safe Mode (auto-revert on lockout) `{"default":true,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                           |
| `i_accept_lockout_risk` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                                                                           |

## audit_firewall_hardening

**Audit Firewall Hardening** · Risk: **read**

Reports which Security Shield protections are present on the firewall by scanning for the 'security-shield:' tagged rules (`/ip firewall filter` + `/ip firewall raw`), and notes the foundational checks (accept established/related, drop invalid) regardless of tag. Use to see coverage and gaps before/after harden_firewall. Complements the broader firewall-audit tools. Returns a per-protection present/absent summary.

No tool-specific parameters.

## remove_firewall_hardening

**Remove Firewall Hardening** · Risk: **destructive**

Removes every firewall rule that Security Shield installed — all `/ip firewall filter` and `/ip firewall raw` entries tagged with the 'security-shield:' comment (the shield's own address-lists are left, since they may be referenced elsewhere). Use to roll back harden_firewall. Does NOT touch rules you created by hand. Returns how many rules were removed.

No tool-specific parameters.
