---
title: "Profile"
description: "CPU usage profiler by subsystem (`/tool profile`)."
---

## Tools

- [Sample CPU Usage by Process](#profile_cpu)

## profile_cpu

**Sample CPU Usage by Process** · Risk: **read**

Sample CPU usage by RouterOS process/classifier over a bounded window (`/tool profile`) — identifies which subsystem (firewall, routing, wireless, bridging, etc.) is consuming CPU during a spike or slowdown. Runs for exactly `duration` seconds then returns; it is a one-shot sample, not a streaming monitor. This tool measures CPU load breakdown across internal RouterOS classifiers; for throughput measurement between endpoints use `bandwidth_test` instead. Optionally scope the sample to a single core via `cpu` (e.g. '0'); omit or pass 'all' for aggregate totals across all cores. Returns a table of process names with their CPU-time percentage for the sampling window.

| Parameter  | Required | Definition                                                                                                            |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `duration` | Yes      | Sampling duration in seconds (bounds the run) `{"default":5,"type":"integer","minimum":1,"maximum":9007199254740991}` |
| `cpu`      | No       | Limit to a specific CPU core (e.g. '0'), or 'all' `{"type":"string"}`                                                 |
