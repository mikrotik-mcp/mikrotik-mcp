---
title: "RADIUS & UM"
description: "User accounting, session insights & RADIUS management"
---

## Choose a router and a task

**RADIUS Servers** configures the selected router as a RADIUS client. The User Manager tabs manage its built-in RADIUS server and require the User Manager package. The two roles have different secrets and settings.

| Tab                | What it provides                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports & insights | All-user or per-user accounting, period/date filters, daily/cumulative traffic, session-start charts, distributions and a calendar. Export a JSON statistical report; individual session records are excluded.       |
| RADIUS Servers     | Add/edit a server address and secret, services, authentication/accounting ports, timeout, source address, realm/domain, UDP or RadSec, certificate and accounting backup. Enable, disable or remove entries.         |
| Users              | Filter accounts; add, edit, duplicate, enable/disable and remove through the row action menu or context menu. Read cumulative time, download/upload and latest retained connection date.                             |
| Profiles           | Set names, user-facing names, validity, price, activation timing, shared-user override and comments.                                                                                                                 |
| Limitations        | Define upload/download rates, minimum rates, bursts, thresholds/times, priority, traffic caps, uptime caps and reset timing. The list presents rates in MB/s; input examples such as `10M` use RouterOS rate syntax. |
| NAS Clients        | Register a NAS name/address, shared secret, CoA port, protocol and status. This is not the RADIUS Servers client list.                                                                                               |
| Assignments        | Add or remove a user's profile assignment and inspect its state/end time.                                                                                                                                            |
| Settings           | Configure incoming CoA, reset RADIUS counters, enable User Manager/use-profiles, set certificate and ports, and adjust the host's usage-sampling interval.                                                           |

## Create or edit a user

1. Open **Users → Add**, or open the row menu and choose **Edit**.
2. Enter the username, group, concurrent-user allowance, optional RADIUS attributes, Caller ID, OTP secret and comment. Enter a password or use the password generator; leaving it blank while editing keeps the current password.
3. Choose the profile. **Keep existing assignments** explicitly leaves profile assignments alone. When changing profiles, review the displayed current assignments and validity note.
4. Save and read the resulting status. Previous assignment history is retained; queued profiles can become eligible later. Existing VPN sessions may need to reconnect before new limits take effect.

**Duplicate** creates a draft with copied non-secret fields; supply the new account's credentials and review its profile before saving.

## Read reports accurately

Counters depend on NAS accounting and are cumulative across sessions. Refresh does not reset them. Latest connection is the start of the latest retained accounting session in **router local time**, refreshed separately from live counters.

Reports show the last collected timestamp and whether a cached snapshot is refreshing, stale, partial or unavailable. A blank or unavailable value is not zero usage. The host sampling setting accepts 30 seconds to six hours; it does not change the router's accounting interval.

See [last-connection semantics](/docs/guides/user-manager-last-connections) and [all RADIUS/User Manager tool contracts](/docs/reference/user-manager).

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/aaa.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.

## Additional screens

### RADIUS servers

![RADIUS servers; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-radius-servers.jpg)

### Users and accounting

![Users and accounting; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-users.jpg)

### Profiles

![Profiles; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-profiles.jpg)

### Rate and usage limits

![Rate and usage limits; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-limitations.jpg)

### NAS clients

![NAS clients; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-nas-clients.jpg)

### Profile assignments

![Profile assignments; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-assignments.jpg)

### Settings and sampling

![Settings and sampling; full-page capture with IPs and snapshot/backup names blurred](/screenshots/aaa-settings.jpg)
