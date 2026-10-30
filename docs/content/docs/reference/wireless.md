---
title: "Wireless"
description: "Wi-Fi SSID/security profiles, non-disruptive runtime channel monitoring and approved RF surveys (wifi, wifiwave2 and legacy wireless). Legacy access-list tools are stubs."
---

## Tools

- [Create Wireless Interface](#create_wireless_interface)
- [List Wireless Interfaces](#list_wireless_interfaces)
- [Get Wireless Interface Details](#get_wireless_interface)
- [Get Actual Wi-Fi Channel and Runtime Status](#get_wireless_interface_status)
- [Remove Wireless Interface](#remove_wireless_interface)
- [Enable Wireless Interface](#enable_wireless_interface)
- [Disable Wireless Interface](#disable_wireless_interface)
- [Scan for Nearby Wireless Networks](#scan_wireless_networks)
- [Survey Modern Wi-Fi Channel Load (Disruptive)](#scan_wifi_channels)
- [Get Wireless Registration Table (Connected Clients)](#get_wireless_registration_table)
- [Check Wireless Support and Detected Interface Type](#check_wireless_support)
- [Create Wireless Security Profile (Not Implemented)](#create_wireless_security_profile)
- [List Wi-Fi Security Profiles (Modern and Legacy)](#list_wireless_security_profiles)
- [Get Wi-Fi Security Profile (Modern and Legacy)](#get_wireless_security_profile)
- [Remove Wireless Security Profile (Not Implemented)](#remove_wireless_security_profile)
- [Assign Security Profile to Wireless Interface (Not Implemented)](#set_wireless_security_profile)
- [Create Wireless Access List Entry (Legacy v6 Only — Not Implemented)](#create_wireless_access_list)
- [List Wireless Access List Entries (Legacy v6 Only — Not Implemented)](#list_wireless_access_list)
- [Remove Wireless Access List Entry (Legacy v6 Only — Not Implemented)](#remove_wireless_access_list_entry)
- [Update Wireless Interface Settings](#update_wireless_interface)
- [List Wi-Fi Regulatory Countries](#list_wifi_countries)

## create_wireless_interface

**Create Wireless Interface** · Risk: **write**

Creates a wireless interface (`/interface wifi`, `/interface wifiwave2`, `/interface wireless`, or `/interface wlan` — auto-detected per device). Use to add a new AP or station interface to the device. On RouterOS v7 accepts name, ssid, disabled, and comment; on v6/legacy also requires radio_name (e.g. `wlan1`) and optionally accepts mode (default `ap-bridge`), frequency, band, channel_width, and security_profile. To modify an existing interface use update_wireless_interface; to see current interfaces use list_wireless_interfaces. Returns the created interface's full detail print including its `.id`.

| Parameter                | Required | Definition                                                                                                                                         |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Yes      | Name for the new wireless interface (no spaces). `{"type":"string","pattern":"^\\S+$"}`                                                            |
| `ssid`                   | No       | `{"type":"string"}`                                                                                                                                |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                                                                                               |
| `comment`                | No       | `{"type":"string"}`                                                                                                                                |
| `radio_name`             | No       | Required for legacy wireless systems, e.g. 'wlan1' `{"type":"string"}`                                                                             |
| `mode`                   | No       | `{"type":"string","enum":["ap-bridge","bridge","station","station-pseudobridge","station-bridge","station-wds","ap-bridge-wds","alignment-only"]}` |
| `frequency`              | No       | `{"type":"string"}`                                                                                                                                |
| `band`                   | No       | `{"type":"string","enum":["2ghz-b","2ghz-b/g","2ghz-b/g/n","5ghz-a","5ghz-a/n","5ghz-a/n/ac","2ghz-g","2ghz-n","5ghz-n","5ghz-ac"]}`               |
| `channel_width`          | No       | `{"type":"string","enum":["20mhz","40mhz","80mhz","160mhz","20/40mhz-eC","20/40mhz-Ce"]}`                                                          |
| `security_profile`       | No       | `{"type":"string"}`                                                                                                                                |
| `mtu`                    | No       | Interface MTU in bytes `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                 |
| `arp`                    | No       | ARP mode for the interface `{"type":"string","enum":["disabled","enabled","proxy-arp","reply-only","local-proxy-arp"]}`                            |
| `hide_ssid`              | No       | Legacy: do not broadcast the SSID in beacons (AP modes) `{"type":"boolean"}`                                                                       |
| `wireless_protocol`      | No       | Legacy: wireless protocol, e.g. '802.11', 'nv2', 'nstreme' `{"type":"string"}`                                                                     |
| `scan_list`              | No       | Legacy: frequencies/ranges to scan (e.g. 'default' or '5180-5320') `{"type":"string"}`                                                             |
| `frequency_mode`         | No       | Legacy: regulatory frequency mode `{"type":"string","enum":["manual-txpower","regulatory-domain","superchannel"]}`                                 |
| `country`                | No       | Legacy: regulatory country setting (e.g. 'united states') `{"type":"string"}`                                                                      |
| `antenna_gain`           | No       | Legacy: antenna gain in dBi used for tx-power calculations `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`             |
| `wds_mode`               | No       | Legacy: WDS mode `{"type":"string","enum":["disabled","dynamic","dynamic-mesh","static","static-mesh"]}`                                           |
| `wds_default_bridge`     | No       | Legacy: bridge that dynamic WDS interfaces are added to `{"type":"string"}`                                                                        |
| `default_authentication` | No       | Legacy: allow clients not in the access-list to authenticate `{"type":"boolean"}`                                                                  |
| `default_forwarding`     | No       | Legacy: allow client-to-client forwarding by default `{"type":"boolean"}`                                                                          |
| `tx_power`               | No       | Legacy: manual transmit power in dBm `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                   |
| `tx_power_mode`          | No       | Legacy: how tx-power is determined `{"type":"string","enum":["default","card-rates","all-rates-fixed","manual-table"]}`                            |
| `distance`               | No       | Legacy: link distance ('dynamic', 'indoors', or a km value) `{"type":"string"}`                                                                    |
| `disconnect_timeout`     | No       | Legacy: time before a non-responding client is disconnected `{"type":"string"}`                                                                    |

## list_wireless_interfaces

**List Wireless Interfaces** · Risk: **read**

Lists all wireless interfaces (`/interface wifi`, `/interface wifiwave2`, `/interface wireless`, `/interface wlan`) — probes every supported command path and aggregates results. Returns detail including SSID, security/authentication types and configured channel settings, with secrets redacted. Filters by name_filter (RouterOS regular expression), disabled_only, or running_only. Configured frequencies are NOT proof of the current operating channel; use get_wireless_interface_status. For full property detail on a single interface use get_wireless_interface; to see currently connected clients use get_wireless_registration_table. Falls back to `/interface print` with debugging info when no wireless interfaces match, to help identify the correct path on the device.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |
| `running_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_wireless_interface

**Get Wireless Interface Details** · Risk: **read**

Retrieves the full detail of one named wireless interface (`<auto-detected path> print detail where name=...`), probing `/interface wifi`, `/interface wifiwave2`, `/interface wireless`, and `/interface wlan` in order. Use to inspect SSID, security.authentication-types (allowed WPA2/WPA3 methods), profile references, country and channel settings. On modern Wi-Fi since RouterOS 7.15 print detail includes inherited values; on older releases also read actual-configuration. Allowed authentication types do not prove which method a client negotiated; missing values do not prove an open network. For the ACTUAL operating channel use get_wireless_interface_status, not the configured frequency list. Secrets are redacted.

| Parameter | Required | Definition                        |
| --------- | -------- | --------------------------------- |
| `name`    | Yes      | `{"type":"string","minLength":1}` |

## get_wireless_interface_status

**Get Actual Wi-Fi Channel and Runtime Status** · Risk: **read**

Reads one non-disruptive runtime snapshot (`<auto-detected Wi-Fi path> monitor <interface> once`). Supports modern /interface wifi, older wifiwave2 and legacy wireless. Returns actual channel/frequency/width, state and radio statistics when reported by the driver; disabled/inactive radios may not have a current channel. Does NOT scan, disconnect clients or change settings. Pair with get_wireless_interface and get_wireless_security_profile for SSID and configured WPA2/WPA3 security; never invent unavailable runtime fields.

| Parameter   | Required | Definition                        |
| ----------- | -------- | --------------------------------- |
| `interface` | Yes      | `{"type":"string","minLength":1}` |

## remove_wireless_interface

**Remove Wireless Interface** · Risk: **destructive**

Permanently deletes a named wireless interface (`<auto-detected path> remove [find name=...]`). Verifies the interface exists first (count-only check) and returns an error if not found. This action is irreversible — to keep the interface but stop traffic use disable_wireless_interface; for property changes only use update_wireless_interface.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_wireless_interface

**Enable Wireless Interface** · Risk: **write-idempotent**

Enables a named wireless interface that is currently disabled (`<auto-detected path> enable [find name=...]`). Idempotent — safe to call on an already-enabled interface. For the reverse operation use disable_wireless_interface; to change other settings at the same time use update_wireless_interface. Obtain the interface name from list_wireless_interfaces.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_wireless_interface

**Disable Wireless Interface** · Risk: **write-idempotent**

Disables a named wireless interface without removing it (`<auto-detected path> disable [find name=...]`). Idempotent — safe to call on an already-disabled interface. For the reverse operation use enable_wireless_interface; to delete the interface permanently use remove_wireless_interface. Obtain the interface name from list_wireless_interfaces.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## scan_wireless_networks

**Scan for Nearby Wireless Networks** · Risk: **write**

Scans for visible nearby wireless networks/SSIDs/APs in range (`<auto-detected path> scan <interface> duration=<n>`). DISRUPTIVE: scanning can temporarily disconnect clients. Requires explicit user approval (confirm=true). Use to discover external networks — not to list connected clients or read the actual channel without disruption. For non-disruptive current-channel evidence use get_wireless_interface_status; for modern RF channel load use scan_wifi_channels. For currently associated client stations use get_wireless_registration_table instead. `interface` is the local wireless interface name to scan from (e.g. `wlan1`); `duration` is scan time in seconds (default 5). Returns raw scan output from the device.

| Parameter   | Required | Definition                                                                                                |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `interface` | Yes      | `{"type":"string","minLength":1}`                                                                         |
| `duration`  | Yes      | `{"default":5,"type":"integer","minimum":1,"maximum":30}`                                                 |
| `confirm`   | Yes      | Explicit user approval for a scan that can disconnect Wi-Fi clients. `{"default":false,"type":"boolean"}` |

## scan_wifi_channels

**Survey Modern Wi-Fi Channel Load (Disruptive)** · Risk: **write**

Runs a bounded /interface wifi (or wifiwave2) frequency-scan to measure channel load, networks, noise floor and signal levels. Modern Wi-Fi equivalent of a legacy frequency survey, NOT /interface wireless frequency-monitor. DISCONNECTS associated clients/station during the scan; obtain explicit user approval and set confirm=true. Runs once as a router-owned background job so temporary SSH loss does not stop the scan; retries only result reads for up to duration + 60 seconds. Never use during a strictly read-only/non-disruptive audit; get_wireless_interface_status reads the current channel safely. Captures results through unique temporary report/status files (requires file/test permissions), then removes them after recovery; on timeout reports their paths for later retrieval. Does not auto-tune or modify configuration, and never automatically retries a disruptive scan; frequency-scan availability depends on RouterOS/driver.

| Parameter   | Required | Definition                                                                                           |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `interface` | Yes      | `{"type":"string","minLength":1}`                                                                    |
| `duration`  | Yes      | `{"default":5,"type":"integer","minimum":1,"maximum":30}`                                            |
| `confirm`   | Yes      | Explicit user approval to temporarily disconnect Wi-Fi clients. `{"default":false,"type":"boolean"}` |

## get_wireless_registration_table

**Get Wireless Registration Table (Connected Clients)** · Risk: **read**

Retrieves the wireless registration table — the list of client stations currently associated to this AP (`<auto-detected path> registration-table print [where interface=...]`). Each row is an actively connected wireless client with its MAC address, signal strength, and statistics. To discover nearby external APs/SSIDs instead use scan_wireless_networks. Optionally filter by interface name; omit to return all clients across all wireless interfaces.

| Parameter   | Required | Definition          |
| ----------- | -------- | ------------------- |
| `interface` | No       | `{"type":"string"}` |

## check_wireless_support

**Check Wireless Support and Detected Interface Type** · Risk: **read**

Diagnoses which wireless subsystem the device supports by running `/system resource print`, `/system package print`, `/interface print`, and probing each wireless command path in priority order (`/interface wifi` → `/interface wifiwave2` → `/interface wireless` → `/interface wlan`). Returns RouterOS version, installed packages, all interfaces, and the detected wireless command path. Use this before other wireless tools when the device's wireless capability is unknown, or when wireless tools are returning unsupported/bad-command errors.

No tool-specific parameters.

## create_wireless_security_profile

**Create Wireless Security Profile (Not Implemented)** · Risk: **write**

Not implemented: creating modern wifi/wifiwave2 security or legacy wireless security-profiles presets. For read-only security inspection use list_wireless_security_profiles, get_wireless_security_profile and get_wireless_interface.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## list_wireless_security_profiles

**List Wi-Fi Security Profiles (Modern and Legacy)** · Risk: **read**

Reads modern /interface wifi security (or wifiwave2 security) and legacy /interface wireless security-profiles, auto-detected. Returns authentication-types (allowed WPA2/WPA3 methods), ciphers, management protection, WPS and EAP settings where available. Passwords, passphrases and pre-shared keys are redacted. Profiles are presets, not proof of effective interface settings; pair with get_wireless_interface to see assigned profiles and overrides. Does not modify the router.

No tool-specific parameters.

## get_wireless_security_profile

**Get Wi-Fi Security Profile (Modern and Legacy)** · Risk: **read**

Reads one named modern wifi/wifiwave2 security profile or legacy wireless security-profiles entry. Shows configured WPA2/WPA3 authentication methods, encryption, WPS and management protection where available; secrets are redacted. Use the profile name returned by list_wireless_security_profiles or get_wireless_interface. An interface override takes precedence over a profile; missing authentication fields do not prove an open network.

| Parameter | Required | Definition                        |
| --------- | -------- | --------------------------------- |
| `name`    | Yes      | `{"type":"string","minLength":1}` |

## remove_wireless_security_profile

**Remove Wireless Security Profile (Not Implemented)** · Risk: **destructive**

Not implemented: deleting modern wifi/wifiwave2 security or legacy wireless security-profiles presets. Use list_wireless_security_profiles or get_wireless_security_profile for read-only inspection.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## set_wireless_security_profile

**Assign Security Profile to Wireless Interface (Not Implemented)** · Risk: **write**

Not implemented: assigning a modern wifi/wifiwave2 security profile. For legacy wireless only, update_wireless_interface supports security_profile. Use get_wireless_interface and get_wireless_security_profile to inspect settings without changes.

| Parameter          | Required | Definition          |
| ------------------ | -------- | ------------------- |
| `interface_name`   | Yes      | `{"type":"string"}` |
| `security_profile` | Yes      | `{"type":"string"}` |

## create_wireless_access_list

**Create Wireless Access List Entry (Legacy v6 Only — Not Implemented)** · Risk: **write**

Stub for creating a `/interface wireless access-list` MAC-address filtering entry — a RouterOS v6 concept. On RouterOS v7 devices always returns a not-supported message; use firewall rules or other access-control methods instead. On v6 also not implemented. For v7 client filtering use create_filter_rule targeting the wireless interface.

No tool-specific parameters.

## list_wireless_access_list

**List Wireless Access List Entries (Legacy v6 Only — Not Implemented)** · Risk: **read**

Stub for listing `/interface wireless access-list` entries — a RouterOS v6 MAC-based client filtering concept. On RouterOS v7 devices always returns a not-supported message; on v6 also not implemented. For connected client visibility use get_wireless_registration_table; for firewall-based access control use list_filter_rules.

No tool-specific parameters.

## remove_wireless_access_list_entry

**Remove Wireless Access List Entry (Legacy v6 Only — Not Implemented)** · Risk: **destructive**

Stub for removing a `/interface wireless access-list` entry by ID — a RouterOS v6 concept. On RouterOS v7 devices always returns a not-supported message; on v6 also not implemented. The entry_id would take the `.id` from list_wireless_access_list if that were implemented. For v7 access control use list_filter_rules and remove_filter_rule instead.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `entry_id` | Yes      | `{"type":"string"}` |

## update_wireless_interface

**Update Wireless Interface Settings** · Risk: **write-idempotent**

Updates settings on an existing named wireless interface (`<auto-detected path> set [find name=...] ...`). Supports renaming (new_name), changing SSID, toggling disabled state, and updating comment. Verifies the interface exists before applying; returns 'No updates specified.' if no optional fields are provided. To only enable or disable the interface prefer enable_wireless_interface or disable_wireless_interface; to create a new interface use create_wireless_interface; to delete one use remove_wireless_interface. Returns the updated interface's full detail print.

| Parameter                | Required | Definition                                                                                                                             |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Yes      | `{"type":"string"}`                                                                                                                    |
| `new_name`               | No       | Rename the interface to this (no spaces). `{"type":"string","pattern":"^\\S+$"}`                                                       |
| `ssid`                   | No       | `{"type":"string"}`                                                                                                                    |
| `disabled`               | No       | `{"type":"boolean"}`                                                                                                                   |
| `comment`                | No       | `{"type":"string"}`                                                                                                                    |
| `mtu`                    | No       | Interface MTU in bytes `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                     |
| `arp`                    | No       | ARP mode for the interface `{"type":"string","enum":["disabled","enabled","proxy-arp","reply-only","local-proxy-arp"]}`                |
| `hide_ssid`              | No       | Legacy: do not broadcast the SSID in beacons (AP modes) `{"type":"boolean"}`                                                           |
| `wireless_protocol`      | No       | Legacy: wireless protocol, e.g. '802.11', 'nv2', 'nstreme' `{"type":"string"}`                                                         |
| `scan_list`              | No       | Legacy: frequencies/ranges to scan (e.g. 'default' or '5180-5320') `{"type":"string"}`                                                 |
| `frequency`              | No       | Legacy: operating frequency in MHz `{"type":"string"}`                                                                                 |
| `band`                   | No       | Legacy: band, e.g. '2ghz-b/g/n' or '5ghz-a/n/ac' `{"type":"string"}`                                                                   |
| `channel_width`          | No       | Legacy: channel width `{"type":"string","enum":["20mhz","40mhz","80mhz","160mhz","20/40mhz-eC","20/40mhz-Ce"]}`                        |
| `frequency_mode`         | No       | Legacy: regulatory frequency mode `{"type":"string","enum":["manual-txpower","regulatory-domain","superchannel"]}`                     |
| `country`                | No       | Legacy: regulatory country setting (e.g. 'united states') `{"type":"string"}`                                                          |
| `antenna_gain`           | No       | Legacy: antenna gain in dBi used for tx-power calculations `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `wds_mode`               | No       | Legacy: WDS mode `{"type":"string","enum":["disabled","dynamic","dynamic-mesh","static","static-mesh"]}`                               |
| `wds_default_bridge`     | No       | Legacy: bridge that dynamic WDS interfaces are added to `{"type":"string"}`                                                            |
| `default_authentication` | No       | Legacy: allow clients not in the access-list to authenticate `{"type":"boolean"}`                                                      |
| `default_forwarding`     | No       | Legacy: allow client-to-client forwarding by default `{"type":"boolean"}`                                                              |
| `tx_power`               | No       | Legacy: manual transmit power in dBm `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                       |
| `tx_power_mode`          | No       | Legacy: how tx-power is determined `{"type":"string","enum":["default","card-rates","all-rates-fixed","manual-table"]}`                |
| `distance`               | No       | Legacy: link distance ('dynamic', 'indoors', or a km value) `{"type":"string"}`                                                        |
| `disconnect_timeout`     | No       | Legacy: time before a non-responding client is disconnected `{"type":"string"}`                                                        |
| `security_profile`       | No       | Legacy: name of the security profile to apply `{"type":"string"}`                                                                      |

## list_wifi_countries

**List Wi-Fi Regulatory Countries** · Risk: **read**

Lists all available regulatory country codes for wireless configuration (`<auto-detected path> country print`). Each entry shows the country name/code and the regulatory constraints it implies (allowed frequencies, max TX power, DFS rules, etc.). Use this to discover valid values before setting a country on a wireless interface.

| Parameter | Required | Definition                                                                      |
| --------- | -------- | ------------------------------------------------------------------------------- |
| `search`  | No       | Optional search string to filter countries by name or code. `{"type":"string"}` |
