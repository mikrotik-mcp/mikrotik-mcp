---
name: audit-vlan-segmentation
title: Audit VLAN isolation and migration readiness
description: Read-only topology, IPv4/IPv6 isolation and management-path review with a prioritized cleanup plan; never applies changes.
arguments:
  - name: requirements
    description: Desired zones, allowed services, remote sites and constraints. If omitted, discover facts and ask about policy rather than inventing it.
    required: false
---

Audit VLAN segmentation on the explicitly selected device. Requirements: {{requirements}}
This workflow is READ-ONLY. Do not create backups on routers, start/verify transactions,
change configuration, enable filtering, write memory, or run disruptive load tests.

Use bounded dedicated read tools discovered with `find_tools`. If another managed
router is in scope, resolve and inspect it separately; otherwise report its
dependencies as unknown. Never substitute the default router for an unknown name.

Produce:

1. Observed topology: port roles, VLAN/PVID/CPU map, SSIDs, subnets, IPv6 and tunnels.
2. Intended vs observed IPv4/IPv6 INPUT/FORWARD policy, including shadowed rules,
   management exposure, guest peers and remote return routing. Mark unsupported,
   incomplete or timed-out evidence unknown; static policy analysis is not a live test.
3. Prioritized findings with evidence, risk, affected devices, proposed correction,
   dependency/lockout impact, rollback requirements and a concrete acceptance test.
4. A staged migration and cleanup proposal, separating necessary fixes, optional
   improvements and choices that need the operator. Never assume disabled means unused.
5. Known limits: what could not be verified from actual wired/wireless clients.

Stop with the report. Any future implementation needs separate approval.
