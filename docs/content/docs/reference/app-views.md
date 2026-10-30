---
title: "Apps — Dashboards"
description: "Tools that render interactive UI views inline (MCP Apps): the device dashboard, the interfaces overview and the firewall-rules table. Every read tool (list_*/get_*) additionally renders in the generic records viewer."
---

## Tools

- [Show System Dashboard](#show_system_dashboard)
- [Show Interfaces Overview](#show_interfaces)
- [Show IPv4 Firewall Filter Rules](#show_firewall_filter)

## show_system_dashboard

**Show System Dashboard** · Risk: **read**

Render an interactive device-health dashboard (`/system identity print`, `/system resource print`, `/system health print`, `/system routerboard print`) showing CPU load %, memory and disk usage (used/total/%), uptime, temperature, voltage, board model and RouterOS version. Use this when the user wants a single-screen overview of a MikroTik device's current resource state. For interface-level port status use show_interfaces; for the firewall ruleset use show_firewall_filter. Returns structuredContent with all raw resource fields, derived percentages (cpuLoadPct, memUsedPct, hddUsedPct), and a plain-text fallback for text-only clients.

No tool-specific parameters.

## show_interfaces

**Show Interfaces Overview** · Risk: **read**

List all interfaces with running/disabled status, type, MTU and MAC address (`/interface print detail`) as an interactive overview. Use this when the user wants to see all ports and their current states on the device at a glance. For device-wide resource metrics (CPU, memory, uptime) use show_system_dashboard; for the IPv4 firewall ruleset use show_firewall_filter. Returns structuredContent with one row per interface including flag characters (R=running, X=disabled), interface type and name, plus a text summary of running vs disabled counts.

No tool-specific parameters.

## show_firewall_filter

**Show IPv4 Firewall Filter Rules** · Risk: **read**

Render IPv4 firewall FILTER rules (`/ip firewall filter print detail`) as an interactive ordered table showing chain (input/forward/output), action, key matchers and packet/byte counters with enabled/disabled state. Use this when the user wants a visual review of the IPv4 packet-filter ruleset. For IPv6 filter rules use list_ipv6_filter_rules; for NAT rules use list_nat_rules; for mangle or raw rules use the respective mangle/raw tools; for per-rule editing use list_filter_rules or get_filter_rule. Returns structuredContent with one row per rule and a text summary with per-chain rule counts.

No tool-specific parameters.
