---
title: "Firewall — Audit"
description: "Plain-language firewall audit: shadowed/unreachable rules, broad accepts, missing default-drop, duplicates and dead rules, with a risk score (`firewall_audit`)."
---

## Tools

- [Audit IPv4 Firewall Rulesets](#firewall_audit)

## firewall_audit

**Audit IPv4 Firewall Rulesets** · Risk: **read**

Audits IPv4 firewall rulesets (`/ip firewall filter print detail`; optionally `/ip firewall nat print detail` when include_nat=true (default on); `/ip firewall mangle print detail` when include_mangle=true (default off)) — use to review, harden, or understand a router's full firewall posture in one pass. Detects unreachable/shadowed rules, overly-broad accepts, a missing default-drop, duplicate rules, and dead rules with zero packet hits. For browsing individual rules without analysis use list_filter_rules, list_nat_rules; for IPv6 filter rules use list_ipv6_filter_rules; for IPv6 NAT use list_ipv6_nat_rules; for IPv6 mangle use list_ipv6_mangle_rules. Returns a risk score and a prioritised list of plain-language findings with suggested per-rule fixes; in MCP App hosts also renders an interactive findings table with one-click disable. Scoped to IPv4 paths only — no IPv6 audit twin exists.

| Parameter        | Required | Definition                                                             |
| ---------------- | -------- | ---------------------------------------------------------------------- |
| `include_nat`    | Yes      | Also audit `/ip firewall nat`. `{"default":true,"type":"boolean"}`     |
| `include_mangle` | Yes      | Also audit `/ip firewall mangle`. `{"default":false,"type":"boolean"}` |
