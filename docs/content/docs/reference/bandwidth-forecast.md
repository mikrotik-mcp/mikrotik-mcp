---
title: "Bandwidth Forecast"
description: "Sample an interface's throughput and project when it will saturate at an assumed growth rate (capacity planning)."
---

## Tools

- [Forecast Link Saturation](#forecast_link_saturation)

## forecast_link_saturation

**Forecast Link Saturation** · Risk: **read**

Estimates when an interface will saturate. Samples its current throughput (`/interface monitor-traffic ... once`), computes utilization against `capacity_mbps` (the link's rated speed), and projects the trend forward at `monthly_growth_pct` to a saturation date. Note: this is a single live sample projected at an ASSUMED growth rate — feed a realistic growth figure (or watch the trend over time) for a better forecast. Returns current load, utilization, and the projected days/date to saturation.

| Parameter            | Required | Definition                                                                        |
| -------------------- | -------- | --------------------------------------------------------------------------------- |
| `interface`          | Yes      | Interface to sample, e.g. 'ether1-wan' `{"type":"string"}`                        |
| `capacity_mbps`      | Yes      | Link rated speed in Mbit/s (e.g. 1000 for gig) `{"default":1000,"type":"number"}` |
| `monthly_growth_pct` | Yes      | Assumed month-over-month traffic growth % `{"default":10,"type":"number"}`        |
