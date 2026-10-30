---
title: "PoE"
description: "Power-over-Ethernet status and configuration (`/interface ethernet poe`)."
---

## Tools

- [Read PoE Interface Live Metrics](#get_poe_monitor)
- [List PoE Interface Configuration](#list_poe)
- [Get PoE Interface Settings](#get_poe_settings)

## get_poe_monitor

**Read PoE Interface Live Metrics** · Risk: **read**

Read live Power-over-Ethernet monitor data (`/interface ethernet poe monitor <interfaces> once`) — returns a real-time snapshot of PoE-out status, voltage (V), current (mA), and power (W) for one or more interfaces. Use this to diagnose active power delivery on PoE ports or confirm a powered device is drawing current. For static PoE-out configuration (mode, priority, thresholds) use `get_poe_settings`; for a summary list of all PoE-capable interfaces use `list_poe`. The `interfaces` argument takes a comma-separated list of ethernet interface names, e.g. 'ether1' or 'ether9,ether10'.

| Parameter    | Required | Definition                                                                                        |
| ------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `interfaces` | Yes      | Comma-separated ethernet interface name(s), e.g. 'ether1' or 'ether9,ether10' `{"type":"string"}` |

## list_poe

**List PoE Interface Configuration** · Risk: **read**

List the Power-over-Ethernet configuration of all PoE-capable ethernet interfaces (`/interface ethernet poe print`) — returns PoE-out mode and priority for each port. Use this to see at a glance which ports have PoE-out enabled across the whole device. For detailed settings of one specific interface (voltage thresholds, etc.) use `get_poe_settings`; for real-time voltage/current/power readings use `get_poe_monitor`. Optionally narrow results by partial interface name via `interface_filter`, e.g. 'ether'.

| Parameter          | Required | Definition                                           |
| ------------------ | -------- | ---------------------------------------------------- |
| `interface_filter` | No       | Partial name match, e.g. 'ether' `{"type":"string"}` |

## get_poe_settings

**Get PoE Interface Settings** · Risk: **read**

Get detailed Power-over-Ethernet settings for a single ethernet interface (`/interface ethernet poe print detail where name=<name>`) — returns PoE-out mode, priority, voltage, and power thresholds for that port. Use this to inspect the full PoE-out configuration of one specific port. For a summary list across all PoE-capable interfaces use `list_poe`; for real-time voltage/current/power measurements use `get_poe_monitor`. The `name` argument takes the exact interface name, e.g. 'ether1'.

| Parameter | Required | Definition                                                       |
| --------- | -------- | ---------------------------------------------------------------- |
| `name`    | Yes      | Exact ethernet interface name, e.g. 'ether1' `{"type":"string"}` |
