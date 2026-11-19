---
title: "Hotspot Builder"
description: "Stand up a guest hotspot with a captive portal (gateway, DHCP, /ip hotspot, per-guest cap, walled garden) and generate printable vouchers, with preview-before-apply."
---

## Tools

- [Build Guest Hotspot (Captive Portal)](#build_guest_hotspot)
- [Generate Hotspot Vouchers](#generate_hotspot_vouchers)
- [List Hotspot Voucher Batches](#list_voucher_batches)
- [Remove a Hotspot Voucher Batch](#remove_voucher_batch)

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

Creates `count` random guest login codes as `/ip hotspot user` entries (username = password = code), each with an optional uptime limit and hotspot user profile — the printable vouchers you hand to guests. DEFAULTS TO A DRY RUN (`apply=false`) that just shows the codes it would create; set `apply=true` to add them. Every voucher of one call belongs to a batch (the `batch` name, or one made from the date), so `list_voucher_batches` can count how many were used and `remove_voucher_batch` can clear the unused ones. With `print=true` the tool also writes a print-ready HTML sheet (cards with cut lines, three across) and a CSV file to a folder on the MCP host and returns the paths; `title`, `validity`, `price` and `note` are printed on each card, and `login_url` adds a QR code that signs the guest in when scanned. Returns the generated codes.

| Parameter      | Required | Definition                                                                                               |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `count`        | Yes      | `{"default":10,"type":"integer","minimum":1,"maximum":200}`                                              |
| `batch`        | No       | Batch name, e.g. 'hotel-2026-11' `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$"}`        |
| `print`        | Yes      | Write a printable HTML sheet and a CSV file `{"default":false,"type":"boolean"}`                         |
| `title`        | Yes      | Printed on each card `{"default":"Guest Wi-Fi","type":"string","maxLength":60}`                          |
| `validity`     | No       | Printed text, e.g. '1 day' `{"type":"string","maxLength":40}`                                            |
| `price`        | No       | Printed text, e.g. '5 EUR' `{"type":"string","maxLength":20}`                                            |
| `note`         | No       | Small print, e.g. how to connect `{"type":"string","maxLength":120}`                                     |
| `login_url`    | No       | Hotspot login address, e.g. 'http://hotspot.lan/login', for a QR code `{"type":"string","format":"uri"}` |
| `uptime_limit` | No       | Per-voucher uptime, e.g. '1h', '1d' `{"type":"string"}`                                                  |
| `profile`      | No       | Hotspot user profile to assign `{"type":"string"}`                                                       |
| `code_prefix`  | Yes      | Prefix for the generated codes `{"default":"g","type":"string"}`                                         |
| `apply`        | Yes      | false = preview codes (default); true = create `{"default":false,"type":"boolean"}`                      |

## list_voucher_batches

**List Hotspot Voucher Batches** · Risk: **read**

Lists the batches of vouchers made by generate_hotspot_vouchers: for each batch the number of vouchers, how many were used (the guest signed in at least once) and how many are still unused. Use it to see how a batch sells, or before you clear old unused codes with remove_voucher_batch. Hotspot users that were added another way are not listed.

No tool-specific parameters.

## remove_voucher_batch

**Remove a Hotspot Voucher Batch** · Risk: **destructive**

Removes the vouchers of one batch made by generate_hotspot_vouchers. By default only the UNUSED vouchers go (codes nobody signed in with), so a guest who is using one keeps access; `include_used=true` removes every voucher of the batch. DEFAULTS TO A DRY RUN (`apply=false`) that counts what would be removed. Use it to retire codes that were printed and not sold. A removed code can never sign in again.

| Parameter      | Required | Definition                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------- |
| `batch`        | Yes      | The batch name `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$"}` |
| `include_used` | Yes      | Also remove vouchers that were used `{"default":false,"type":"boolean"}`        |
| `apply`        | Yes      | false = count only; true = remove `{"default":false,"type":"boolean"}`          |
