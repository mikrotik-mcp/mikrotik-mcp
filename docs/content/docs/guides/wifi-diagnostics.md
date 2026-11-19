---
title: "Wi-Fi security and channel diagnostics"
description: "Practical setup, operations and limits for Wi-Fi security and channel diagnostics."
---

The Wireless module supports `/interface wifi`, pre-7.13 `/interface wifiwave2`,
and legacy `/interface wireless` (including RouterOS v7 legacy drivers).
All calls use the selected MCP `device`; no external shell or transport is required.

## Non-disruptive LLM workflow

1. Call `check_wireless_support` if the driver's command path is unknown.
2. Call `list_wireless_interfaces`, then `get_wireless_interface(name)` for the
   SSID, profile references, country, configured channels and security overrides.
   Modern `print detail` includes inherited values from RouterOS 7.15 onward;
   the tool also reads `actual-configuration` when older releases expose it.
3. Read `list_wireless_security_profiles` or `get_wireless_security_profile(name)`
   for allowed WPA2/WPA3 methods, encryption, WPS and management protection.
   Passphrases, EAP passwords and encryption keys are masked.
4. Call `get_wireless_interface_status(interface)` for a bounded `monitor once`
   snapshot of the **actual operating channel**, state and driver statistics.
5. Call `get_wireless_registration_table(interface)` for detailed client evidence.

Report only fields returned by the router. A configured frequency list is not the
current operating channel. Allowed authentication methods are not proof of each
client's negotiated WPA version. A profile is not necessarily effective: interface
overrides take precedence. Missing fields mean unavailable evidence, not an open
network or a zero value; disabled/inactive radios may have no current channel.
Permission and transport failures are errors, not a reason to guess another stack.

## RF surveys require approval

`scan_wifi_channels(interface, duration=5, confirm=true)` uses modern
`frequency-scan`; output may include channel frequency in MHz, networks, load (%),
noise floor and signal levels. `scan_wireless_networks` discovers nearby APs.
Both can disconnect Wi-Fi clients and require explicit user approval via
`confirm=true`, with a duration of 1–30 seconds. They are not read-only-safe.
Driver/version support varies; unsupported scan commands are reported as errors.

`tune_wifi_channel` remains **legacy-only** and must not be used on modern Wi-Fi.
Modern RF surveys do not automatically tune or modify configuration.
Security-profile creation/removal/modern assignment remain unimplemented;
the inspection tools are implemented independently of those write operations.

See the [official MikroTik Wi-Fi documentation](https://manual.mikrotik.com/docs/wireless/wifi/).

## Moving from `wireless` to `wifi`

RouterOS has two wireless drivers. The legacy `wireless` package uses
`/interface wireless`; the new `wifi` driver (first called wifiwave2) uses
`/interface wifi` and names almost every setting differently.

`plan_wireless_to_wifi_migration` reads the legacy configuration and returns the
commands for the new driver. It changes nothing.

| Legacy (`wireless`)                      | New (`wifi`)                     |
| ---------------------------------------- | -------------------------------- |
| `ssid`                                   | `configuration.ssid`             |
| `mode=ap-bridge`                         | `configuration.mode=ap`          |
| `band=2ghz-b/g/n`, `5ghz-a/n/ac`         | `channel.band=2ghz-n`, `5ghz-ac` |
| `channel-width=20/40/80mhz-Ceee`         | `channel.width=20/40/80mhz`      |
| `frequency=2437`                         | `channel.frequency=2437`         |
| `hide-ssid`                              | `configuration.hide-ssid`        |
| `default-forwarding=no`                  | `datapath.client-isolation=yes`  |
| `vlan-mode=use-tag` + `vlan-id`          | `datapath.vlan-id`               |
| security profile, `authentication-types` | `security.authentication-types`  |
| security profile, pre-shared key         | `security.passphrase`            |
| `wlan1`, `wlan2`                         | `wifi1`, `wifi2`                 |
| access-list `authentication=no`          | access-list `action=reject`      |

The plan also lists **blockers**: things the new driver cannot do. An Nv2 or
Nstreme link, a WDS link, and modes with no equivalent are named, not dropped
in silence.

Limits to know:

- The plan does not read Wi-Fi passwords. Each one is a `CHANGE-ME` placeholder
  that you replace.
- It does not check the hardware. The new driver needs `wifi-qcom-ac`
  (802.11ac ARM devices) or `wifi-qcom` (802.11ax devices); MIPS devices and
  devices with 16 MB of storage cannot run it. Check the product page.
- The tools do not install a package and do not reboot. You do those two
  steps; wireless clients drop while you do, so have a wired or console way in.
- Bridge ports, the DHCP server and firewall rules still name the old
  interfaces afterwards. Point them at the new names.

### Saving and applying the plan

After the package is changed, the legacy menus are gone and cannot be read. So
the order is fixed:

1. `plan_wireless_to_wifi_migration save=true` stores the plan on the MCP host
   (`~/.mikrotik-mcp/wifi-migrations`, or `MIKROTIK_WIFI_MIGRATION_DIR`).
2. Install the `wifi` package and reboot. This is your step.
3. `apply_wireless_to_wifi_migration` applies the saved plan.

Wi-Fi passwords do not pass through the call. `passwords_from` maps each
security profile to a secret reference that the server reads on the host:

```text
apply_wireless_to_wifi_migration passwords_from={"home":"keyring:mikrotik-mcp/home-wifi"}
```

The tool refuses to run while the router has no `/interface wifi` menu, when a
profile has no reference, and when the plan has blockers (unless
`ignore_blockers=true`). It shows a dry run first with passwords hidden. Every
command is parsed on the router before anything is written; then a snapshot is
taken and the commands go in Safe Mode.

### CAPsMAN

The plan also covers a legacy CAPsMAN. The named profiles keep their names:

| Legacy (`/caps-man`)                                     | New (`/interface wifi`)            |
| -------------------------------------------------------- | ---------------------------------- |
| `security`                                               | `security`                         |
| `channel`, `control-channel-width` + `extension-channel` | `channel`, `width`                 |
| `datapath`, `client-to-client-forwarding=no`             | `datapath`, `client-isolation=yes` |
| `configuration`                                          | `configuration` with `mode=ap`     |
| `provisioning`, `hw-supported-modes`                     | `provisioning`, `supported-bands`  |
| `manager enabled=yes`                                    | `capsman set enabled=yes`          |
| `/interface wireless cap`                                | `/interface wifi cap`              |

Limits to know:

- A wifi CAPsMAN manages only CAPs that run the wifi driver. The plan lists
  this as a blocker when a manager is enabled: keep both managers running and
  move the CAPs one at a time.
- Settings written inline in a configuration (`security.encryption=…`) are not
  carried over; the plan names them. Certificates are set by hand.
- In the wifi driver a CAP always bridges traffic itself. A legacy setup that
  sent client traffic through the manager changes its traffic path.
