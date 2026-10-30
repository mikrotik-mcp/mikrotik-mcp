---
title: "VLAN segmentation"
description: "Read-only discovery, staged planning and isolation verification."
---

The MCP includes a shared RouterOS VLAN guide adapted from the
`homelab-vlan-segmentation` skill. Read it with `get_vlan_segmentation_guide`
(`topic: "all"`, or `overview`, `discovery`, `layer2`, `policy`, `migration`,
`verification`) or the MCP resource `mikrotik://knowledge/vlan-segmentation`.
The tool belongs to `vlan-designer`; the reference resource remains available in
read-only/curated sessions and with Memory disabled. Reading it never contacts a router.

- **Audit:** `audit-vlan-segmentation` produces a read-only topology and prioritized
  cleanup report, with unknown evidence and client-test gaps made explicit.
- **Plan:** `setup-vlan-network` and `setup-guest-wifi` include the same guide in
  MCP, Dashboard → Prompts and Raycast → Prompts. They cover port/PVID/CPU membership,
  SSID/package differences, IPv4 **and** IPv6 isolation, protected management,
  remote routing, staged approval/rollback and real-client acceptance tests.
- **Remember:** store verified addresses/VLAN maps per Device. Share only intentionally
  reusable safeguards, or explicit Group policies. No private topology is seeded and
  the guide does not write Memory or grant authorization to change devices.

**Planner safety change:** `design_network_segment` is a partial IPv4 scaffold, not
an end-to-end isolation engine. It still defaults to `apply=false`. When
`internet=true`, `wan_interface` is now required to avoid unscoped NAT; use
`internet=false` when reusing existing NAT. `isolate_from` requires a reviewed
`isolation_before` forward-rule `.id`, checked again before writes. Non-/24 DHCP
requires an explicit valid `dhcp_range`; pools cannot include the gateway/network/
broadcast. Bridge/CPU tagged membership is deduplicated. Port admission/PVID,
filtering activation, SSIDs, INPUT/IPv6 policy and client verification remain separate
steps. Existing callers must supply these new prerequisites; incomplete requests
fail before writes. Apply is sequential, not idempotent, and has no automatic rollback.

Rebuild/redeploy the MCP version you actually run, then reconnect clients to refresh
their instructions/catalog. Editing this checkout alone does not upgrade an installed
service. No live router configuration is changed by loading these workflows.
