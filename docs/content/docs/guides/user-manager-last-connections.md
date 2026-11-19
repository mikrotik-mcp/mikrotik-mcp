---
title: "User Manager: last connection"
description: "Practical setup, operations and limits for User Manager: last connection."
---

**RADIUS & UM → Users → Last connection** shows the start of the latest retained
User Manager accounting session for each configured user, including closed and
active sessions. It is not the last accounting packet, disconnection time, profile
activation date, or a router administrator's login time.

The date and time are shown in two compact lines using **router-local wall-clock
time**, without shifting them into the browser's timezone. This is the `started`
property documented in [MikroTik User Manager sessions](https://help.mikrotik.com/docs/spaces/ROS/pages/2555940/User+Manager#UserManager-Sessions).

## Performance and unavailable data

- Traffic and uptime counters keep their existing five-second refresh.
- The latest-session summary refreshes separately in the background, with a
  30-second per-device cache and one in-flight request shared across viewers.
- An existing private report snapshot seeds the dates after a restart. Native
  RouterOS JSON reads fetch session IDs and missing records in 2,000-record pages;
  MCP compares normalized dates, rather than running a slow reduction on the router.
  Only identity, username and start time are retained in this summary, and only
  the latest date per user is sent to the table.
- Each poll removes deleted records and fetches new or unknown start dates. A full
  reconciliation every 15 minutes also handles restored databases and reused IDs.
  Dates are published atomically after all requested pages pass validation.
- Collection has a 180-second total deadline, a 60-second per-command deadline,
  a 100,000-session ceiling and a 2 MiB per-response limit. Cached dates remain
  visible during collection; its failure does not prevent counters loading.
- `Loading…` means the first summary is pending. `Unknown` means no valid retained
  start date is available; it does **not** assert that the user has never connected.
- A failed revalidation preserves the previous date with a `cached` marker. Missing
  permission/connectivity is reported independently of traffic counters.

Accounting must be enabled on the NAS. Purged sessions, missed accounting packets,
incorrect router clocks or unavailable User Manager data limit what can be reported.
No sessions are disconnected, and no RouterOS configuration is changed.

The summary checks `list_user_manager_sessions` read access before serving cached
history. Caches are isolated by device and discarded on configuration changes.

## Hotspot vouchers: batches and printing

`generate_hotspot_vouchers` creates guest codes as hotspot users. Every call
makes one **batch**: pass `batch=hotel-nov`, or the tool names it from the date.

With `print=true` the tool also writes two files to `~/.mikrotik-mcp/vouchers`
(or `MIKROTIK_VOUCHER_DIR`) on the MCP host:

| File           | For                                                                          |
| -------------- | ---------------------------------------------------------------------------- |
| `<batch>.html` | Printing. Cards three across with cut lines. Open it in a browser and print. |
| `<batch>.csv`  | A spreadsheet or a billing system: code, batch, validity, price.             |

`title`, `validity`, `price` and `note` are printed on each card. With
`login_url` (the hotspot's login address) each card gets a QR code that signs
the guest in when scanned.

`list_voucher_batches` counts, for each batch, how many vouchers were used and
how many are not. `remove_voucher_batch` retires a batch: by default only the
unused vouchers, so a guest who is online keeps access.

Limits to know:

- The codes are passwords. The folder and the files are readable by the owner
  only; treat a printed sheet the same way.
- "Used" means the hotspot user has uptime. A router reboot does not reset it,
  but removing and adding a user does.
- The CSV is the hand-over for vouchers you print. For vouchers sold online,
  see "Selling a voucher from a payment system" below.
- The HTML holds no script and loads nothing from the network.

## Selling a voucher from a payment system

The usual flow: a guest pays, the payment provider tells your billing system,
and that system asks this server for a voucher to show the guest.

```json
{
  "vouchers": {
    "issue": { "tokenFrom": "env:VOUCHER_TOKEN", "device": "hotel", "uptimeLimit": "1d" }
  }
}
```

```bash
curl -X POST http://127.0.0.1:9090/api/vouchers/issue -H "Authorization: Bearer $VOUCHER_TOKEN" -H "Content-Type: application/json" -d '{"reference":"pay_123"}'
```

The answer holds the code, which is also the user name and the password:

```json
{
  "code": "g3f9a1c2b",
  "username": "g3f9a1c2b",
  "password": "g3f9a1c2b",
  "batch": "sold",
  "reference": "pay_123",
  "repeated": false,
  "validity": "1d"
}
```

- **Its own token.** The route does not use the dashboard token. The billing
  system holds one credential that can only issue vouchers.
- **Safe to repeat.** Send the payment id as `reference`. A second call with
  the same reference returns the same code and creates nothing, because
  payment providers do resend a notification.
- **Limited.** `maxPerMinute` (default 30) bounds new vouchers. Each issue
  reaches the audit feed, without the code.
- The route does not exist until `vouchers.issue` is configured.

This server does not talk to a payment provider. It does not verify a payment:
your billing system does that and calls the route only after the payment is
confirmed. Send the request over a network you trust or behind TLS; the answer
carries the code.

## Limiting the hotspot login

`protect_hotspot_login` slows down and then blocks a client that tries many
codes. It adds rules in `pre-hs-input`, the chain RouterOS runs before its own
hotspot rules: a client that opens more than `per_minute` new connections to
the login ports is dropped for `block_minutes`. `unprotect_hotspot_login`
removes the rules.

It limits connections for each client address, not attempts for each user
name. It cannot tell a wrong code from a page reload, so keep the limit well
above normal use.
