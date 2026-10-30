---
title: "Wi-Fi Optimizer"
description: "Survey RF channel usage and tune a wireless radio to the least-congested frequency, with preview-before-apply (legacy `/interface wireless`)."
---

## Tools

- [Survey & Tune Wi-Fi Channel](#tune_wifi_channel)

## tune_wifi_channel

**Survey & Tune Wi-Fi Channel** · Risk: **write**

Runs an RF survey on a wireless radio (`/interface wireless frequency-monitor`, blocking for `duration`), finds the least-congested channel, and reports a before/after. DEFAULTS TO A DRY RUN (`apply=false`) — it surveys and recommends; set `apply=true` to set the radio to the best frequency (`/interface wireless set`). Targets ONLY the LEGACY wireless stack, including legacy drivers on v7; for modern wifi/wifiwave2 use get_wireless_interface_status for a non-disruptive current-channel read or scan_wifi_channels for an explicitly approved, disruptive channel-load survey (no auto-tuning). Returns the per-channel usage finding and the chosen frequency.

| Parameter   | Required | Definition                                                                               |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `interface` | Yes      | Wireless interface, e.g. 'wlan1' `{"type":"string"}`                                     |
| `duration`  | Yes      | Survey duration in seconds `{"default":"5","type":"string"}`                             |
| `apply`     | Yes      | false = survey & recommend (default); true = set it `{"default":false,"type":"boolean"}` |
