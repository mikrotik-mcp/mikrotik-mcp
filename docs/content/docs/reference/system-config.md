---
title: "System Config"
description: "Console, LEDs, license, note, NTP server, password, ports, regulatory, reset, special-login, watchdog."
---

## Tools

- [List System Console Sessions](#list_system_console)
- [List LED Triggers](#list_leds)
- [Get Global LED Settings](#get_leds_settings)
- [Set Global LED Settings](#set_leds_settings)
- [Get RouterOS License](#get_license)
- [Get System Login Note](#get_note)
- [Set System Login Note](#set_note)
- [Get Built-In NTP Server Configuration](#get_ntp_server)
- [Configure Built-In NTP Server](#set_ntp_server)
- [Change Current User Password](#change_password)
- [List Serial Ports](#list_ports)
- [Get Serial Port Details](#get_port)
- [Configure Serial Port Settings](#set_port)
- [Get Wireless Regulatory / Country Settings](#get_regulatory)
- [Factory Reset Device Configuration](#reset_configuration)
- [List Special Login Entries](#list_special_login)
- [Get Watchdog Configuration](#get_watchdog)
- [Configure Watchdog Timer](#set_watchdog)

## list_system_console

**List System Console Sessions** · Risk: **read**

Lists console sessions and virtual terminal entries (`/system console`). Use to see which physical or virtual consoles are registered on the device. For auto-login rules tied to a console port use `list_special_login`; for physical serial port line settings use `list_ports`. Returns all console entries or a message when none are configured.

No tool-specific parameters.

## list_leds

**List LED Triggers** · Risk: **read**

Lists all hardware LED entries and their configured trigger types (`/system leds`). Use to see per-LED assignments (interface-activity, wireless-signal, etc.). For the global all-LEDs-off (dark-mode) schedule use `get_leds_settings`. Returns each LED's name, type, and trigger settings.

No tool-specific parameters.

## get_leds_settings

**Get Global LED Settings** · Risk: **read**

Reads the global LED behaviour settings (`/system leds settings`). Use to check the dark-mode schedule (all-leds-off). For per-LED trigger assignments use `list_leds`; to change this setting use `set_leds_settings`. Returns the current all-leds-off value.

No tool-specific parameters.

## set_leds_settings

**Set Global LED Settings** · Risk: **write-idempotent**

Writes the global LED behaviour settings (`/system leds settings set`). Use to enable dark mode by scheduling all LEDs off. For per-LED trigger assignments use `list_leds`; to read current settings use `get_leds_settings`. Accepts `all_leds_off`: `never` | `immediate` | `after-1h` | `after-1min`. Returns the updated settings on success.

| Parameter      | Required | Definition                                                                                                     |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `all_leds_off` | No       | When to turn all LEDs off (dark mode) `{"type":"string","enum":["never","immediate","after-1h","after-1min"]}` |

## get_license

**Get RouterOS License** · Risk: **read**

Reads the RouterOS software license details (`/system license`). Use to check the license level and expiry — on CHR shows the level (free/P1/P10/etc.) and deadline; on RouterBOARD hardware the menu may be absent. For general system identity or resource info use the system identity/resource tools. Returns license info, or a friendly unavailable message on unsupported hardware.

No tool-specific parameters.

## get_note

**Get System Login Note** · Risk: **read**

Reads the system-wide login banner text (`/system note`). Use to retrieve the message shown to all users at login. To change the note use `set_note`. Returns the note text and the show-at-login flag.

No tool-specific parameters.

## set_note

**Set System Login Note** · Risk: **write-idempotent**

Writes the system-wide login banner text (`/system note set`). Use to set or clear the message displayed to users at login. To read the current note use `get_note`. Accepts optional `note` (text string) and `show_at_login` (boolean). Returns the updated note on success.

| Parameter       | Required | Definition                                   |
| --------------- | -------- | -------------------------------------------- |
| `note`          | No       | The note text to display `{"type":"string"}` |
| `show_at_login` | No       | Show the note on login `{"type":"boolean"}`  |

## get_ntp_server

**Get Built-In NTP Server Configuration** · Risk: **read**

Reads the device's built-in NTP _server_ configuration (`/system ntp server`, RouterOS 7+). Use to check whether the router is advertising time to LAN clients via broadcast/multicast/manycast. This tool reads the local NTP _server_ role; for the NTP _client_ (upstream time sources) use the NTP client tools in the system module. Falls back with a friendly message on RouterOS 6 where this menu is absent. Returns server enabled state and mode flags.

No tool-specific parameters.

## set_ntp_server

**Configure Built-In NTP Server** · Risk: **write-idempotent**

Writes the device's built-in NTP _server_ settings (`/system ntp server set`, RouterOS 7+). Use to enable the router as a time server for LAN clients via broadcast, multicast, or manycast. This tool configures the local NTP _server_ role; to set upstream NTP _client_ sources use the NTP client tools in the system module. Accepts `enabled`, `broadcast`, `multicast`, `manycast` (booleans) and `broadcast_address` (string). Returns the updated server configuration on success.

| Parameter             | Required | Definition                                                                                                                       |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | No       | Enable or disable the NTP server `{"type":"boolean"}`                                                                            |
| `broadcast`           | No       | `{"type":"boolean"}`                                                                                                             |
| `multicast`           | No       | `{"type":"boolean"}`                                                                                                             |
| `manycast`            | No       | `{"type":"boolean"}`                                                                                                             |
| `broadcast_address`   | No       | Broadcast address for NTP broadcasts `{"type":"string"}`                                                                         |
| `use_local_clock`     | No       | Serve time from the device's local clock as reference `{"type":"boolean"}`                                                       |
| `local_clock_stratum` | No       | Stratum advertised when using the local clock (1-15) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## change_password

**Change Current User Password** · Risk: **write**

Changes the password of the currently authenticated user (`/password`). Use to rotate the login credential without touching other user accounts; passwords are never echoed in the response. To manage other users' accounts or create new users use `add_user`. Requires `old_password` and `new_password`; returns success or a rejection message (no credentials logged).

| Parameter      | Required | Definition                                  |
| -------------- | -------- | ------------------------------------------- |
| `old_password` | Yes      | The current password `{"type":"string"}`    |
| `new_password` | Yes      | The new password to set `{"type":"string"}` |

## list_ports

**List Serial Ports** · Risk: **read**

Lists the physical serial ports registered on the device (`/port print`). Use to discover available serial ports and their current line settings before reconfiguring. For auto-login rules tied to a serial port use `list_special_login`; for console session entries use `list_system_console`. Accepts optional `name_filter` for partial name match. Returns port entries or an empty message when none match.

| Parameter     | Required | Definition                                  |
| ------------- | -------- | ------------------------------------------- |
| `name_filter` | No       | Partial port name match `{"type":"string"}` |

## get_port

**Get Serial Port Details** · Risk: **read**

Reads detailed settings for a named serial port (`/port print detail where name=...`). Use to inspect baud rate, parity, data/stop bits, and flow control for a specific port. For an overview of all ports use `list_ports`; to change settings use `set_port`. Requires `name` (e.g. `serial0`). Returns full detail for the named port.

| Parameter | Required | Definition                                           |
| --------- | -------- | ---------------------------------------------------- |
| `name`    | Yes      | Serial port name, e.g. 'serial0' `{"type":"string"}` |

## set_port

**Configure Serial Port Settings** · Risk: **write-idempotent**

Writes line settings for a named serial port (`/port set [find name=...]`). Use to change baud rate, data bits, parity, stop bits, or flow control on a serial port. To read current settings first use `get_port`; for a list of all ports use `list_ports`. Requires `name` (e.g. `serial0`), plus optional `baud_rate` (e.g. `115200` or `auto`), `data_bits`, `parity` (`none`|`odd`|`even`), `stop_bits`, `flow_control` (`none`|`hardware`|`xon-xoff`). Returns the updated port detail on success.

| Parameter      | Required | Definition                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `name`         | Yes      | Serial port name to update `{"type":"string"}`                              |
| `baud_rate`    | No       | e.g. '115200' or 'auto' `{"type":"string"}`                                 |
| `data_bits`    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `parity`       | No       | `{"type":"string","enum":["none","odd","even"]}`                            |
| `stop_bits`    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `flow_control` | No       | `{"type":"string","enum":["none","hardware","xon-xoff"]}`                   |

## get_regulatory

**Get Wireless Regulatory / Country Settings** · Risk: **read**

Reads wireless radio country and regulatory domain settings (`/interface wifi radio print`). Use to check which country code and regulatory profile the Wi-Fi radios are operating under (requires the wifiwave2 package — RouterOS 7). RouterOS has no `/system regulatory` menu; the country/regulatory data lives on the radio interface. Returns regulatory/country info per radio, or a not-available message when no wifiwave2 interface is present or a legacy wireless package is installed.

No tool-specific parameters.

## reset_configuration

**Factory Reset Device Configuration** · Risk: **dangerous**

Sends a factory-reset command to the device (`/system reset-configuration`). Use ONLY to wipe the entire configuration and reboot into defaults — the SSH connection will drop immediately after and all config will be lost. Requires `confirm=true`; without it the command is blocked. Optional: `keep_users` (preserve user accounts), `no_defaults` (skip loading default config), `skip_backup` (skip automatic pre-reset backup), `caps_mode` (reset into CAPsMAN-managed CAP mode), `run_after_reset` (script to execute post-reboot). This operation is irreversible — there is no undo.

| Parameter         | Required | Definition                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------ |
| `confirm`         | Yes      | Must be true to actually ERASE the configuration `{"type":"boolean"}`          |
| `keep_users`      | No       | Keep existing user accounts after reset `{"type":"boolean"}`                   |
| `no_defaults`     | No       | Do not load the default configuration `{"type":"boolean"}`                     |
| `skip_backup`     | No       | Skip the automatic backup before reset `{"type":"boolean"}`                    |
| `caps_mode`       | No       | Reset into CAPsMAN-managed CAP mode instead of standalone `{"type":"boolean"}` |
| `run_after_reset` | No       | Script file to run after reset `{"type":"string"}`                             |

## list_special_login

**List Special Login Entries** · Risk: **read**

Lists special-login entries (`/system special-login`). Use to see auto-login rules that map a serial/console port to a user account (e.g. serial-console auto-login without a password prompt). For general console session entries use `list_system_console`; for serial port line settings use `list_ports`. Returns entries or a not-available message on hardware that lacks this feature.

No tool-specific parameters.

## get_watchdog

**Get Watchdog Configuration** · Risk: **read**

Reads the hardware/software watchdog timer settings (`/system watchdog`). Use to check whether the watchdog is enabled, which address it pings to detect hangs, and how the supout diagnostic report is configured. To change watchdog settings use `set_watchdog`. Returns the current watchdog configuration.

No tool-specific parameters.

## set_watchdog

**Configure Watchdog Timer** · Risk: **write-idempotent**

Writes the hardware/software watchdog timer settings (`/system watchdog set`). Use to enable automatic reboots when the device becomes unresponsive (triggered when pings to `watch_address` fail). To read current settings use `get_watchdog`. Accepts `watchdog_timer` (enable HW watchdog), `watch_address` (IP to ping), `ping_timeout` (e.g. `1m`), `no_ping_delay` (e.g. `5m`), `automatic_supout` (generate diagnostic file on crash), `auto_send_supout` (email the diagnostic). Returns the updated watchdog configuration on success.

| Parameter          | Required | Definition                                                     |
| ------------------ | -------- | -------------------------------------------------------------- |
| `watchdog_timer`   | No       | Enable the hardware watchdog timer `{"type":"boolean"}`        |
| `watch_address`    | No       | Address to ping; reboot if unreachable `{"type":"string"}`     |
| `ping_timeout`     | No       | e.g. '1m' `{"type":"string"}`                                  |
| `no_ping_delay`    | No       | e.g. '5m' `{"type":"string"}`                                  |
| `automatic_supout` | No       | Generate a supout.rif on software failure `{"type":"boolean"}` |
| `auto_send_supout` | No       | Email the generated supout.rif `{"type":"boolean"}`            |
