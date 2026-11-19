---
title: "Wireless to WiFi Migration"
description: "Plans the move from the legacy `wireless` package to the new `wifi` driver: translates every setting to its new name, and lists what the new driver cannot do. Read-only."
---

## Tools

- [Plan the Move From 'wireless' to 'wifi'](#plan_wireless_to_wifi_migration)

## plan_wireless_to_wifi_migration

**Plan the Move From 'wireless' to 'wifi'** · Risk: **read**

Plans the migration of a router from the legacy `wireless` package (`/interface wireless`) to the new `wifi` driver (`/interface wifi`, formerly wifiwave2). It reads the wireless interfaces, their security profiles and the access list, and returns the equivalent `/interface wifi` commands with every setting translated to its new name (ssid, mode, band, channel width, frequency, country, hidden SSID, client isolation, VLAN, WPS, authentication types, virtual APs, access-list entries). It also lists BLOCKERS that the new driver cannot do (Nv2 or Nstreme links, WDS, modes with no equivalent) and notes for a person. It changes NOTHING and does not read Wi-Fi passwords: the plan has a CHANGE-ME placeholder for each one. The move itself is manual: install the new package, reboot, then run the reviewed commands; wireless clients drop while you do it. Use this before you decide to migrate, to see what the result would be and whether anything stands in the way. Fails with a clear message when the router has no `wireless` menu.

No tool-specific parameters.
