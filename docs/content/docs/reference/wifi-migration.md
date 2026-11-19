---
title: "Wireless to WiFi Migration"
description: "Plans the move from the legacy `wireless` package to the new `wifi` driver: translates every setting to its new name, and lists what the new driver cannot do. Read-only."
---

## Tools

- [Plan the Move From 'wireless' to 'wifi'](#plan_wireless_to_wifi_migration)
- [Apply a Saved 'wireless' to 'wifi' Plan](#apply_wireless_to_wifi_migration)

## plan_wireless_to_wifi_migration

**Plan the Move From 'wireless' to 'wifi'** · Risk: **read**

Plans the migration of a router from the legacy `wireless` package (`/interface wireless`) to the new `wifi` driver (`/interface wifi`, formerly wifiwave2). It reads the wireless interfaces, their security profiles and the access list, and returns the equivalent `/interface wifi` commands with every setting translated to its new name (ssid, mode, band, channel width, frequency, country, hidden SSID, client isolation, VLAN, WPS, authentication types, virtual APs, access-list entries). It also reads a legacy CAPsMAN (`/caps-man`: security, channel, datapath, configuration, provisioning, the manager and the CAP setting) and returns the commands for the wifi CAPsMAN. It lists BLOCKERS that the new driver cannot do (Nv2 or Nstreme links, WDS, modes with no equivalent, legacy CAPs under a wifi manager) and notes for a person. It changes NOTHING on the router and does not read Wi-Fi passwords: the plan has a CHANGE-ME placeholder for each one. With `save=true` the plan is also stored on the MCP host, which you MUST do before the package is changed: afterwards the legacy menus are gone and cannot be read. The move is then: install the new package, reboot, `apply_wireless_to_wifi_migration`. Fails with a clear message when the router has no `wireless` menu.

| Parameter | Required | Definition                                                                                               |
| --------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `save`    | Yes      | Store the plan on the MCP host for apply_wireless_to_wifi_migration `{"default":false,"type":"boolean"}` |

## apply_wireless_to_wifi_migration

**Apply a Saved 'wireless' to 'wifi' Plan** · Risk: **write**

Applies the plan that `plan_wireless_to_wifi_migration save=true` stored for this router, AFTER you installed the new `wifi` package and rebooted. It refuses to run while the router still has no `/interface wifi` menu. Wi-Fi passwords do not pass through this call: `passwords_from` maps each security profile name to a secret reference (`env:NAME`, `file:/path` or `keyring:service/account`), which the server reads on the host. A profile with no reference stops the run. A plan with blockers is refused unless `ignore_blockers=true`. DEFAULTS TO A DRY RUN (`apply=false`) that shows the commands with passwords hidden. Every command is first parsed on the router; if one is not valid, nothing is written. Applying takes a config snapshot and writes in Safe Mode, so a setting that cuts your connection is rolled back. Wireless clients reconnect when the radios are configured. It does not install a package, does not reboot, and does not change bridge ports, DHCP or firewall rules that still name the old interfaces.

| Parameter         | Required | Definition                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passwords_from`  | Yes      | For each security profile: where its password is (a secret reference) `{"default":{},"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string","pattern":"^(?:env:[A-Za-z_][A-Za-z0-9_]*\|file:.+\|keyring:[A-Za-z0-9][A-Za-z0-9._@-]{0,63}\\/[A-Za-z0-9][A-Za-z0-9._@-]{0,63})$"}}` |
| `ignore_blockers` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                 |
| `apply`           | Yes      | false = show the commands; true = apply `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                         |
