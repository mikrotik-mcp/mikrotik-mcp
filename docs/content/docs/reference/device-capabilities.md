---
title: "Device Capabilities"
description: "What a device can actually do: RouterOS version and channel, board and architecture, wireless stack, enabled packages, and device-mode permissions — the facts that decide which tools are usable on it."
---

## Tools

- [Get Device Capabilities](#get_device_capabilities)
- [Refresh Device Capabilities](#refresh_device_capabilities)

## get_device_capabilities

**Get Device Capabilities** · Risk: **read**

Reports what this RouterOS device can actually do — version and release channel, board and architecture, whether it is a RouterBOARD, which wireless stack it answers on (`/interface wifi` vs legacy `/interface wireless` vs `/caps-man`), enabled optional packages, and RouterOS 7.13+ device-mode permissions. Also states what those facts unlock or block. Use this when a tool reported that it is 'not available on this device' and you need to know exactly what is missing, or before suggesting a feature that needs a package. Probed once per device and cached for 6 hours; call refresh_device_capabilities to force a reprobe. Read-only.

No tool-specific parameters.

## refresh_device_capabilities

**Refresh Device Capabilities** · Risk: **read**

Discards the cached capability probe for this device and probes again immediately, bypassing the 6-hour TTL. Use after installing or enabling a RouterOS package, upgrading firmware, or changing device-mode — anything that changes what the router supports. Returns the freshly probed capabilities. Read-only: it runs `/system` print commands and changes nothing on the device.

No tool-specific parameters.
