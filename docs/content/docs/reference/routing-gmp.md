---
title: "GMP"
description: "Group Management Protocol (IGMP/MLD) interfaces and memberships (`/routing gmp`)."
---

## Tools

- [List GMP Interfaces](#list_gmp_interfaces)
- [List GMP Group Memberships](#list_gmp_group_memberships)

## list_gmp_interfaces

**List GMP Interfaces** · Risk: **read**

Lists GMP interface records (`/routing gmp interface`) — returns per-interface querier role, protocol version, and timer state for RouterOS's Group Management Protocol layer (IGMP for IPv4, MLD for IPv6), which PIM-SM and IGMP-proxy use to discover downstream receiver group memberships. For the actual multicast groups joined on each interface use list_gmp_group_memberships. Read-only; requires RouterOS v7 with the routing/multicast package.

No tool-specific parameters.

## list_gmp_group_memberships

**List GMP Group Memberships** · Risk: **read**

Lists GMP group membership records (`/routing gmp group`) — returns the multicast groups currently joined per interface as learned from downstream IGMP (IPv4) or MLD (IPv6) reports; the source of truth for which segments want which groups, used by PIM-SM and IGMP-proxy for forwarding decisions. For per-interface querier role and timer state use list_gmp_interfaces. Accepts optional filters: interface_filter (exact interface name) and group_filter (regex match on multicast group address). Read-only; requires RouterOS v7 with the routing/multicast package.

| Parameter          | Required | Definition                                                     |
| ------------------ | -------- | -------------------------------------------------------------- |
| `interface_filter` | No       | Show only memberships on this interface `{"type":"string"}`    |
| `group_filter`     | No       | Regex match on the multicast group address `{"type":"string"}` |
