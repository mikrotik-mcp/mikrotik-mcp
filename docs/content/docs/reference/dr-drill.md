---
title: "DR Drill"
description: "Chaos engineering: rehearse a failure in Safe Mode (disable a WAN/tunnel/route), verify the backup path with a ping, then auto-revert — proving failover works."
---

## Tools

- [Run Failover DR Drill](#run_failover_drill)

## run_failover_drill

**Run Failover DR Drill** · Risk: **dangerous**

Rehearses a disaster: disables a target (a WAN/tunnel interface, or a route), pings `verify_host` to check the backup path actually carries traffic, then RE-ENABLES the target. Prefers Safe Mode (auto-revert on disconnect) but falls back to direct commands when Safe Mode is unavailable. Proves your failover works without a real outage. Requires `confirm=true` to run (it briefly disrupts traffic on the target); with confirm=false it just describes the drill. Returns whether connectivity held during the simulated failure.

| Parameter     | Required | Definition                                                                                    |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `target_type` | Yes      | `{"default":"interface","type":"string","enum":["interface","route"]}`                        |
| `target`      | Yes      | Interface name (e.g. 'ether1-wan') or, for route, a find expression / .id `{"type":"string"}` |
| `verify_host` | Yes      | Host to ping during the outage to confirm the backup path, e.g. '8.8.8.8' `{"type":"string"}` |
| `ping_count`  | Yes      | `{"default":5,"type":"integer","minimum":1,"maximum":50}`                                     |
| `confirm`     | Yes      | Must be true to actually run the drill `{"default":false,"type":"boolean"}`                   |
