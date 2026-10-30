---
title: "CAPsMAN Orchestrator"
description: "Enterprise CAPsMAN Wi-Fi control-plane audit: coverage/co-channel, weak-signal clients + neighbor steering, resource-aware load, 802.11r fast-roaming (FT) and HA redundancy — one severity-ranked report (read-only; steering/apply land in later phases). Supports v7 `/interface wifi` CAPsMAN and legacy `/caps-man`."
---

## Tools

- [Run CAPsMAN Audit](#run_capsman_audit)
- [Audit CAPsMAN Coverage & Channels](#audit_capsman_coverage)
- [Report Weak-Signal Clients](#report_weak_signal_clients)
- [Audit CAPsMAN Load & Resources](#audit_capsman_load)
- [Audit CAPsMAN Fast-Roaming (802.11r)](#audit_capsman_ft)
- [Audit CAPsMAN High-Availability](#audit_capsman_ha)
- [Steer a Weak-Signal Client](#steer_client)
- [Apply CAPsMAN Load Balance](#apply_capsman_load_balance)
- [Apply CAPsMAN Channel Plan](#apply_capsman_channel_plan)
- [Enable CAPsMAN Fast-Roaming (802.11r)](#enable_capsman_ft)
- [Set Up CAPsMAN High-Availability](#setup_capsman_ha)
- [Apply CAPsMAN Fixes](#apply_capsman_fixes)

## run_capsman_audit

**Run CAPsMAN Audit** · Risk: **read**

Read-only. Audits the device's CAPsMAN Wi-Fi fabric across coverage/co-channel, weak-signal clients, resource-aware load, 802.11r (FT) roaming, and HA (backup-manager) redundancy — one severity-ranked report with per-finding id, severity and confidence (proven vs needs_live_verification; steering/balancing are advisory since RouterOS has no force-move). Supports both the v7 `/interface wifi` CAPsMAN and legacy `/caps-man`. Narrow with `categories`. For a single dimension use audit_capsman_coverage / report_weak_signal_clients / audit_capsman_load / audit_capsman_ft / audit_capsman_ha.

| Parameter    | Required | Definition                                                                                                                                             |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `categories` | No       | Narrow to specific categories. Omit to audit all five. `{"type":"array","items":{"type":"string","enum":["coverage","weak_signal","load","ft","ha"]}}` |
| `weak_dbm`   | No       | Weak-signal threshold in dBm (negative; default -70). `{"type":"integer","minimum":-9007199254740991,"maximum":-1}`                                    |

## audit_capsman_coverage

**Audit CAPsMAN Coverage & Channels** · Risk: **read**

Read-only. Inventories every managed CAP radio (band, manual channel/width, tx-power, client count), detects CO-CHANNEL overlap between physically-adjacent radios (adjacency inferred from clients seen on more than one radio), and proposes a non-overlapping manual channel plan (2.4 GHz → 1/6/11; 5 GHz DFS-aware). Preview only — apply is a later, confirm-gated tool.

No tool-specific parameters.

## report_weak_signal_clients

**Report Weak-Signal Clients** · Risk: **read**

Read-only. Merges every CAP's registration-table and lists clients below the weak-signal threshold (default -70 dBm), each with its current AP, signal, band, and — when a neighbor radio hears it meaningfully stronger — the recommended AP to steer toward and the dB gain. Steering itself is a later, confirm-gated tool (soft 802.11k/v or hard signal-range).

| Parameter  | Required | Definition                                                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `weak_dbm` | No       | Weak-signal threshold in dBm (negative; default -70). `{"type":"integer","minimum":-9007199254740991,"maximum":-1}` |

## audit_capsman_load

**Audit CAPsMAN Load & Resources** · Risk: **read**

Read-only. Reports per-radio client load and the owning CAP's CPU/mem, flags overloaded or resource-constrained radios that have an adjacent radio with spare capacity, and recommends a resource-aware rebalance (offload toward the idle neighbor; steer dual-band clients to 5 GHz). Advisory — apply is a later, confirm-gated tool.

No tool-specific parameters.

## audit_capsman_ft

**Audit CAPsMAN Fast-Roaming (802.11r)** · Risk: **read**

Read-only. Checks 802.11r fast-transition per SSID: is `ft` enabled, is 802.11k/v steering on, and is the `ft-mobility-domain` CONSISTENT across all CAPs (fast roaming only works within one domain). Reports roam-readiness. Enabling FT is a later, confirm-gated tool.

No tool-specific parameters.

## audit_capsman_ha

**Audit CAPsMAN High-Availability** · Risk: **read**

Read-only. Checks CAPsMAN redundancy: is there a backup manager, are the CAPs pointed at both managers, and is require-peer-certificate on? Flags single points of failure (one manager = the whole building's Wi-Fi drops if it reboots). Setting up HA is a later, confirm-gated tool.

No tool-specific parameters.

## steer_client

**Steer a Weak-Signal Client** · Risk: **dangerous**

Steers ONE weak client toward a better AP. `mode=hard` installs an access-list signal-range REJECT on the client's current radio so it re-associates on a neighbor it hears stronger (can briefly disconnect it). `mode=soft` is 802.11k/v-only and installs no rule (advisory — enable steering via enable_capsman_ft). ADVISORY: RouterOS has no force-move, so the client ultimately decides. DRY RUN unless confirm=true. Snapshots first and applies inside Safe Mode (auto-revert on lockout). Idempotent — a re-run for the same MAC adds nothing.

| Parameter          | Required | Definition                                                                                                                |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mac`              | Yes      | Client MAC address to steer. `{"type":"string","minLength":1}`                                                            |
| `mode`             | Yes      | hard = signal-range reject; soft = k/v only (no write). `{"default":"hard","type":"string","enum":["soft","hard"]}`       |
| `reject_above_dbm` | No       | dBm ceiling of the reject band for hard mode (default -70). `{"type":"integer","minimum":-9007199254740991,"maximum":-1}` |
| `confirm`          | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}`                                      |

## apply_capsman_load_balance

**Apply CAPsMAN Load Balance** · Risk: **dangerous**

Applies a resource-aware rebalance: for each overloaded / CPU-constrained radio that has an adjacent radio with spare capacity, installs a connect-priority nudge so NEW clients prefer the idle neighbor (gentle — does not disconnect existing clients). ADVISORY. DRY RUN unless confirm=true. Snapshots first, applies inside Safe Mode. Idempotent. Preview the plan with audit_capsman_load first.

| Parameter | Required | Definition                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------ |
| `confirm` | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}` |

## apply_capsman_channel_plan

**Apply CAPsMAN Channel Plan** · Risk: **dangerous**

Applies the proposed non-overlapping manual channel plan (from audit_capsman_coverage) to the managed radios by setting each radio's frequency — resolving co-channel conflicts. Optionally scope to specific radios with `radio_ids`. DRY RUN unless confirm=true. Snapshots first, applies inside Safe Mode; idempotent (radios already on the target channel are skipped). v7 `/interface wifi` only — on legacy `/caps-man` the channel lives in named channel objects, so edit those manually (the audit still shows the plan).

| Parameter   | Required | Definition                                                                                                  |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `radio_ids` | No       | Only re-channel these radio ids. Omit to apply the whole plan. `{"type":"array","items":{"type":"string"}}` |
| `confirm`   | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}`                        |

## enable_capsman_ft

**Enable CAPsMAN Fast-Roaming (802.11r)** · Risk: **dangerous**

Enables 802.11r fast-transition on the CAPsMAN security configs, converging every one on a SINGLE shared `ft-mobility-domain` (so roaming between floors is seamless and consistent) — fixing the ft-off and ft-domain-mismatch findings. Scope with `config_names`; set the domain with `mobility_domain` (default: the existing domain, else 0001). Note: enabling FT changes the SSID's roaming behaviour and briefly re-keys clients. DRY RUN unless confirm=true. Snapshots first, applies inside Safe Mode; idempotent. 802.11k/v steering is configured separately.

| Parameter         | Required | Definition                                                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `config_names`    | No       | Only enable FT on these security configs. Omit for all. `{"type":"array","items":{"type":"string"}}`    |
| `mobility_domain` | No       | Shared ft-mobility-domain to converge on. Omit to adopt the existing one (or 0001). `{"type":"string"}` |
| `confirm`         | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}`                    |

## setup_capsman_ha

**Set Up CAPsMAN High-Availability** · Risk: **dangerous**

Hardens CAPsMAN redundancy. Applies what THIS manager can safely do — enable require-peer-certificate (so a rogue manager can't adopt your CAPs) — and returns the exact manual, multi-device steps to finish HA (stand up a second manager with the same certificate, point every CAP at both managers). Standing up the backup + editing each CAP is inherently multi-device, so it is NOT auto-applied. HIGHEST blast radius — DRY RUN unless confirm=true; snapshots first, applies inside Safe Mode. Requires a `reason`.

| Parameter                | Required | Definition                                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `backup_manager_address` | No       | Address of the (planned) backup manager, woven into the guidance. `{"type":"string"}` |
| `confirm`                | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}`  |

## apply_capsman_fixes

**Apply CAPsMAN Fixes** · Risk: **dangerous**

Applies specific finding_ids from a prior run_capsman_audit, dispatching each to its remediation in a SAFE order (coverage/channel-plan → load-balance → steer → FT → HA), all wrapped in ONE snapshot + ONE Safe-Mode session. Returns the applied commands + snapshot id. DRY RUN unless confirm=true. NEVER a blanket 'fix everything' — pass explicit finding_ids from an audit. Steering/balancing remain advisory; HA require-cert is applied but the multi-device HA steps are not.

| Parameter     | Required | Definition                                                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Explicit finding_id(s) from a prior run_capsman_audit. No blanket apply. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | No       | Must be true to write; omit for a dry-run preview. `{"type":"boolean","const":true}`                                               |
