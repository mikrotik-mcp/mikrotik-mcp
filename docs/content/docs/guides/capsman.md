---
title: "CAPsMAN Orchestrator"
description: "Practical setup, operations and limits for CAPsMAN Orchestrator."
---

Enterprise CAPsMAN Wi-Fi control-plane **audit** for a multi-floor office with many
APs and hundreds of clients. It reads the controller's state and reports, in one
severity-ranked pass, five things that go wrong on a real fleet:

- **Coverage / co-channel** — adjacent APs sharing a channel (interference), with a
  proposed non-overlapping manual plan (2.4 GHz → 1/6/11; 5 GHz DFS-aware).
- **Weak-signal clients** — every client below a threshold (default −70 dBm) plus
  the **neighbor AP it would hear stronger** (the steer target).
- **Resource-aware load** — overloaded radios / CPU-constrained CAPs beside idle
  neighbors with spare capacity.
- **Fast-roaming (802.11r FT)** — is FT on, is 802.11k/v steering on, is the
  `ft-mobility-domain` consistent across all CAPs.
- **HA redundancy** — is there a backup manager (a single manager = the whole
  building's Wi-Fi drops if it reboots), and is peer-certificate enforcement on.

Supports **both** RouterOS stacks, auto-detected: v7 `/interface wifi` CAPsMAN and
legacy `/caps-man`.

> **Read-only in this release.** The tools and the dashboard page only read + report.
> Steering, channel-plan apply, FT enable and HA setup are phased in later (see
> `docs/capsman-orchestrator-plan.md`). RouterOS has **no force-move-client**
> primitive, so every steering/balancing recommendation is advisory — findings that
> depend on client behaviour are marked `needs_live_verification`, never `proven`.

## Tools (module: CAPsMAN Orchestrator)

| Tool                         | Purpose                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `run_capsman_audit`          | All five categories in one severity-ranked report (`finding_id`, `severity`, `confidence`). Narrow with `categories`. |
| `audit_capsman_coverage`     | Radio inventory + co-channel conflicts + a proposed manual channel plan.                                              |
| `report_weak_signal_clients` | Clients below the weak threshold + the recommended neighbor AP and dB gain. Custom `weak_dbm`.                        |
| `audit_capsman_load`         | Per-radio load + owning CAP CPU/mem; overloaded-beside-idle findings.                                                 |
| `audit_capsman_ft`           | 802.11r / k / v roam-readiness + mobility-domain consistency.                                                         |
| `audit_capsman_ha`           | Backup-manager / single-point-of-failure + cert enforcement.                                                          |

## Floor / topology model

RouterOS doesn't know which AP is on which floor, so the engine merges two sources:

- **Explicit tag** — a floor/zone parsed from the CAP identity (`AP-F3-E`) or a
  `floor=3 zone=east` comment.
- **Signal adjacency** — which radios are physically adjacent, inferred from clients
  visible on more than one radio. Fills gaps when a tag is missing and powers the
  "best neighbor AP" recommendation.

## Dashboard page

The **CAPsMAN** tab (Interfaces group) renders the fabric: managed APs grouped by
floor with per-radio health (client load × CPU × co-channel), a weak-signal client
table with the recommended AP, and a roaming/HA audit strip. Backed by
`GET /api/capsman/overview`, `/api/capsman/clients`, `/api/capsman/audit`.

## Architecture

Pure engine `src/core/capsman.ts` (+ `capsman-normalize.ts` for the wire→model
mapping) — zero device I/O, unit-tested (`tests/core/capsman.spec.ts`). Device reads
via `src/utils/wifi-query.ts`. Thin tools in `src/tools/capsman.ts`.
