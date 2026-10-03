---
name: audit-routeros-containers
title: Audit RouterOS container readiness and isolation
description: Read-only container architecture, storage, lifecycle, network policy and security audit with an evidence-based cleanup plan.
arguments:
  - name: device
    description: Exact configured router; omit to discover and ask.
    required: false
  - name: requirements
    description: Intended workloads, trusted clients and restrictions.
    required: false
---

Audit {{device}} against the shared container guide below. Requirements: {{requirements}}.
This is READ-ONLY: no package installation, device-mode updates, container restart,
network changes, disk formatting or file deletion. Any implementation needs separate approval.

Resolve the device exactly. Inventory architecture/version/package/device-mode,
resource headroom, disks, container metadata/status, VETHs, bridge/VLAN membership,
IPv4/IPv6 routes, firewall and NAT. Inspect env KEY metadata, never values.
Use bounded filtered reads. Separate unsupported menus, failed transport and unknown state.

Produce a prioritized table: finding, observed evidence, affected workload, risk,
recommended change, backup/recovery requirements and verification. Distinguish
readiness, process running and application health. Flag shared lists/volumes,
management-path dependencies and physical/reboot steps. Do not claim benchmarks
or successful client tests without measurements. Offer a staged plan, not automatic cleanup.
