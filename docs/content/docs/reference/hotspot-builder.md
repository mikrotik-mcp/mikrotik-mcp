---
title: "Hotspot Builder"
description: "Stand up a guest hotspot with a captive portal (gateway, DHCP, /ip hotspot, per-guest cap, walled garden) and generate printable vouchers, with preview-before-apply."
---

## Tools

- [Build Guest Hotspot (Captive Portal)](#build_guest_hotspot)
- [Generate Hotspot Vouchers](#generate_hotspot_vouchers)

## build_guest_hotspot

**Build Guest Hotspot (Captive Portal)** · Risk: **dangerous**

Stands up a guest hotspot with a captive sign-in portal in one call: the gateway IP, an address pool, a DHCP server, the `/ip hotspot` server + profile (with a per-guest `rate_limit` bandwidth cap and optional `dns_name`), and a walled garden (the `walled_garden` domains reachable BEFORE sign-in, e.g. your payment/login pages). DEFAULTS TO A DRY RUN (`apply=false`) showing every command; set `apply=true` to build it. Generate printable guest codes with generate_hotspot_vouchers. Returns the plan or a build report.

| Parameter       | Required | Definition                                                                                           |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `interface`     | Yes      | Interface/bridge the hotspot runs on, e.g. 'guest-bridge' `{"type":"string"}`                        |
| `subnet`        | Yes      | Hotspot subnet `{"default":"10.5.50.0/24","type":"string"}`                                          |
| `gateway`       | Yes      | Router address in the hotspot subnet `{"default":"10.5.50.1","type":"string"}`                       |
| `pool_range`    | No       | DHCP/hotspot pool; defaults to .10–.254 `{"type":"string"}`                                          |
| `dns_name`      | No       | Captive-portal hostname, e.g. 'guest.wifi' `{"type":"string"}`                                       |
| `rate_limit`    | Yes      | Per-guest max-limit (rx/tx) `{"default":"5M/5M","type":"string"}`                                    |
| `walled_garden` | No       | Domains reachable before sign-in, e.g. ['*.stripe.com'] `{"type":"array","items":{"type":"string"}}` |
| `apply`         | Yes      | false = preview (default); true = build `{"default":false,"type":"boolean"}`                         |

## generate_hotspot_vouchers

**Generate Hotspot Vouchers** · Risk: **write**

Creates `count` random guest login codes as `/ip hotspot user` entries (username = password = code), each with an optional uptime limit and hotspot user profile — the printable vouchers you hand to guests. DEFAULTS TO A DRY RUN (`apply=false`) that just shows the codes it would create; set `apply=true` to add them. Returns the generated codes.

| Parameter      | Required | Definition                                                                          |
| -------------- | -------- | ----------------------------------------------------------------------------------- |
| `count`        | Yes      | `{"default":10,"type":"integer","minimum":1,"maximum":200}`                         |
| `uptime_limit` | No       | Per-voucher uptime, e.g. '1h', '1d' `{"type":"string"}`                             |
| `profile`      | No       | Hotspot user profile to assign `{"type":"string"}`                                  |
| `code_prefix`  | Yes      | Prefix for the generated codes `{"default":"g","type":"string"}`                    |
| `apply`        | Yes      | false = preview codes (default); true = create `{"default":false,"type":"boolean"}` |
