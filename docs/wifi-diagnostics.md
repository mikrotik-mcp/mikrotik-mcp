# Wi-Fi security and channel diagnostics

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
