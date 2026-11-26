---
title: "OpenVPN"
description: "OpenVPN servers — legacy single + RouterOS 7.17 multi-server — clients (`/interface ovpn-*`), live sessions (`list_ovpn_sessions`), and historical/daily usage & traffic accounting analytics (`analyze_ovpn_usage`)."
---

## Tools

- [Analyze OpenVPN Usage & Session Accounting](#analyze_ovpn_usage)
- [List Active OpenVPN Connections](#list_ovpn_sessions)
- [Disconnect One OpenVPN Connection](#disconnect_ovpn_session)
- [Get OpenVPN Server Configuration](#get_ovpn_server)
- [Configure OpenVPN Server](#set_ovpn_server)
- [Add Named OpenVPN Server](#add_ovpn_server)
- [List Named OpenVPN Servers](#list_ovpn_servers)
- [Update Named OpenVPN Server](#update_ovpn_server)
- [Remove Named OpenVPN Server](#remove_ovpn_server)
- [Enable Named OpenVPN Server](#enable_ovpn_server)
- [Disable Named OpenVPN Server](#disable_ovpn_server)
- [Create OpenVPN Client Interface](#create_ovpn_client)
- [List OpenVPN Client Interfaces](#list_ovpn_clients)
- [Get OpenVPN Client Interface Detail](#get_ovpn_client)
- [Remove OpenVPN Client Interface](#remove_ovpn_client)
- [Enable OpenVPN Client Interface](#enable_ovpn_client)
- [Disable OpenVPN Client Interface](#disable_ovpn_client)

## analyze_ovpn_usage

**Analyze OpenVPN Usage & Session Accounting** · Risk: **read**

`analyze_ovpn_usage` — Compute exact OpenVPN historical and live usage, traffic (download, upload, total bytes), session durations, connection counts, client source IPs (`caller_id`), assigned internal tunnel IPs (`address`), and IP geolocation/ISP metadata (`country`, `city`, `asn_organization`, `asn`, `country_code` via `https://ipu.revue.ir/<ip>/json`) across any time window or filter set. Automatically collects RouterOS User Manager accounting (`/user-manager session`), live OpenVPN connections (`/ppp active where service=ovpn` + `<ovpn-*>` interface byte counters), local history, and cached `https://ipu.revue.ir/<ip>/json` GeoIP/ASN lookups in a single workflow, then performs all aggregations deterministically in TypeScript: (1) all-users grand totals, daily breakdown, and country/city/ISP distributions, (2) per-user aggregated totals, traffic shares, averages, peak sessions, unique client IPs, assigned tunnel IPs, countries/cities/ISPs, and per-source-IP traffic & duration breakdown, (3) per-user-per-day connection counts, byte/duration totals, IPs, and locations, and (4) paginated per-connection details showing exact download, upload, duration, client source IP, assigned tunnel IP, country, city, and `asn_organization`. Supports filtering by `from`/`to` dates or timestamps, `date` (single day), `days` (lookback window, default 7), `all_time`, `user`/`users` (exact or substring), `caller_id` (client public IP), `address` (tunnel IP), `country`, `city`, `asn_organization`/`isp`/`asn`, `status` (`all`/`active`/`closed`), `terminate_cause`, `exclude_zero_traffic`, and minimum bytes/duration.

| Parameter                 | Required | Definition                                                                                                                                                                                                                                                                    |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`                    | No       | Start of the analysis window in router local time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). Alias: `since`, `start_date`. When omitted, `days` (default 7) is used unless `all_time=true`. `{"type":"string"}`                                                                 |
| `since`                   | No       | Alias for `from` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). `{"type":"string"}`                                                                                                                                                                                                 |
| `start_date`              | No       | Alias for `from` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). `{"type":"string"}`                                                                                                                                                                                                 |
| `to`                      | No       | End of the analysis window in router local time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). A date-only value (`YYYY-MM-DD`) includes the full day through `23:59:59`. Alias: `until`, `end_date`. `{"type":"string"}`                                                           |
| `until`                   | No       | Alias for `to` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). `{"type":"string"}`                                                                                                                                                                                                   |
| `end_date`                | No       | Alias for `to` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). `{"type":"string"}`                                                                                                                                                                                                   |
| `date`                    | No       | Single calendar day shortcut (`YYYY-MM-DD`), equivalent to setting both `from` and `to` to that day. Alias: `day`. `{"type":"string"}`                                                                                                                                        |
| `day`                     | No       | Alias for `date` (`YYYY-MM-DD`). `{"type":"string"}`                                                                                                                                                                                                                          |
| `days`                    | No       | Number of calendar days ending today on the router's clock (1 = today only, 7 = today + previous 6 days). Default 7 when no date range is specified. `{"type":"integer","minimum":1,"maximum":366}`                                                                           |
| `all_time`                | No       | When true, analyze all retained accounting records without a start-date cutoff. Warning: on routers with tens of thousands of historical sessions this may take 15–20 seconds. `{"type":"boolean"}`                                                                           |
| `user`                    | No       | Filter to a specific OpenVPN username (exact match by default, or substring match when `user_match='contains'`; also accepts comma-separated usernames). Alias: `username`. `{"type":"string"}`                                                                               |
| `username`                | No       | Alias for `user`. `{"type":"string"}`                                                                                                                                                                                                                                         |
| `users`                   | No       | Filter to any of the listed OpenVPN usernames. `{"type":"array","items":{"type":"string","minLength":1}}`                                                                                                                                                                     |
| `user_match`              | Yes      | How to match `user` / `users`: `'exact'` (case-insensitive exact username match, default) or `'contains'` (case-insensitive substring match). `{"default":"exact","type":"string","enum":["exact","contains"]}`                                                               |
| `caller_id`               | No       | Filter by client public source IP (`calling-station-id` / `caller-id`). Matches exact IP or prefix/substring. Alias: `source_ip`, `client_ip`. `{"type":"string"}`                                                                                                            |
| `source_ip`               | No       | Alias for `caller_id`. `{"type":"string"}`                                                                                                                                                                                                                                    |
| `client_ip`               | No       | Alias for `caller_id`. `{"type":"string"}`                                                                                                                                                                                                                                    |
| `address`                 | No       | Filter by assigned OpenVPN tunnel IP (`user-address` / `address`, e.g. `10.10.6.215`). Alias: `tunnel_ip`. `{"type":"string"}`                                                                                                                                                |
| `tunnel_ip`               | No       | Alias for `address`. `{"type":"string"}`                                                                                                                                                                                                                                      |
| `country`                 | No       | Filter sessions by client IP country name or 2-letter ISO code (e.g. `'Iran'`, `'IR'`, `'Germany'`, `'DE'`), resolved via `https://ipu.revue.ir/<ip>/json`. `{"type":"string"}`                                                                                               |
| `city`                    | No       | Filter sessions by client IP city (e.g. `'Tehran'`, `'Shiraz'`), resolved via `https://ipu.revue.ir/<ip>/json`. `{"type":"string"}`                                                                                                                                           |
| `asn_organization`        | No       | Filter sessions by client IP ASN / ISP organization name or ASN number (e.g. `'Iran Telecommunication'`, `'Asiatech'`, `'Irancell'`, `'58224'`), resolved via `https://ipu.revue.ir/<ip>/json`. Alias: `isp`, `asn`. `{"type":"string"}`                                      |
| `isp`                     | No       | Alias for `asn_organization`. `{"type":"string"}`                                                                                                                                                                                                                             |
| `asn`                     | No       | Alias for `asn_organization`. `{"type":"string"}`                                                                                                                                                                                                                             |
| `enrich_ip_geo`           | Yes      | When true (default), resolve every unique client source IP via `https://ipu.revue.ir/<ip>/json` (cached locally in SQLite) to attach `country`, `city`, `asn`, and `asn_organization` to each session, daily breakdown, and user summary. `{"default":true,"type":"boolean"}` |
| `status`                  | Yes      | Filter by session state: `'all'` (both active and closed sessions, default), `'active'` (currently connected only), or `'closed'` (disconnected/completed only). `{"default":"all","type":"string","enum":["all","active","closed"]}`                                         |
| `active_only`             | No       | Shortcut for `status='active'` when true, or `status='closed'` when false. `{"type":"boolean"}`                                                                                                                                                                               |
| `terminate_cause`         | No       | Filter by RADIUS disconnect / terminate cause (e.g. `'lost-carrier'`, `'idle-timeout'`, `'user-request'`, `'session-timeout'`, `'admin-reset'`). Case-insensitive substring or exact match. `{"type":"string"}`                                                               |
| `exclude_zero_traffic`    | Yes      | When true, exclude 0-byte connection attempts (handshake/reconnect retries where download + upload = 0) from the primary aggregations. Even when false, the report separately counts `nonZeroTrafficSessions` vs `zeroTrafficSessions`. `{"default":false,"type":"boolean"}`  |
| `min_total_bytes`         | No       | Only include sessions whose combined download + upload bytes are at least this value. `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                             |
| `min_download_bytes`      | No       | Only include sessions whose client download bytes are at least this value. `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                                        |
| `min_upload_bytes`        | No       | Only include sessions whose client upload bytes are at least this value. `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                                          |
| `min_duration_seconds`    | No       | Only include sessions whose duration (uptime in seconds) is at least this value. `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                                  |
| `max_duration_seconds`    | No       | Only include sessions whose duration (uptime in seconds) is at most this value. `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                                   |
| `include_daily_breakdown` | Yes      | Include per-user-per-day and all-users-per-day connection counts, durations, and download/upload/total byte breakdowns. `{"default":true,"type":"boolean"}`                                                                                                                   |
| `include_sessions`        | Yes      | Include the paginated list of individual OpenVPN sessions with per-session download, upload, total bytes, duration, caller IP, tunnel IP, and timestamps. `{"default":true,"type":"boolean"}`                                                                                 |
| `include_inactive_users`  | Yes      | When true (and no user filter is active), include configured OpenVPN/User Manager accounts that had 0 matching connections in the window. `{"default":false,"type":"boolean"}`                                                                                                |
| `sort_users_by`           | Yes      | How to sort the per-user summary table. `{"default":"total_bytes","type":"string","enum":["total_bytes","download_bytes","upload_bytes","connections","duration","user"]}`                                                                                                    |
| `sort_sessions_by`        | Yes      | How to sort the individual sessions list. `{"default":"started_desc","type":"string","enum":["started_desc","started_asc","total_bytes_desc","duration_desc","download_desc","upload_desc"]}`                                                                                 |
| `session_limit`           | Yes      | Maximum number of individual session records to return in `sessions` (1–1000, default 100). Aggregations always cover 100% of matching sessions regardless of this limit. `{"default":100,"type":"integer","minimum":1,"maximum":1000}`                                       |
| `session_offset`          | Yes      | Pagination offset into the sorted `sessions` list. `{"default":0,"type":"integer","minimum":0,"maximum":9007199254740991}`                                                                                                                                                    |

## list_ovpn_sessions

**List Active OpenVPN Connections** · Risk: **read**

Read currently connected OpenVPN users on an explicit router, including assigned IP, caller address, uptime, encoding and RADIUS status. Reads only /ppp active where service=ovpn; does not read secrets, historical sessions, or outbound clients. Returns structured JSON and short-lived disconnect tokens for individual sessions. A cached read is at most two seconds old; errors are not an empty list.

No tool-specific parameters.

## disconnect_ovpn_session

**Disconnect One OpenVPN Connection** · Risk: **destructive**

Disconnect exactly one observed OpenVPN connection after explicit operator approval. First list_ovpn_sessions on the same explicit router, then supply its fresh disconnectToken. Rechecks internal ID, session ID, username, addresses and uptime before removal, then verifies absence. Does not disable or delete the account; clients can reconnect and PPP on-down hooks may run. Can interrupt your own management tunnel. Unknown outcomes must be reconciled by reading again, never automatically retried. Not available during Safe Mode.

| Parameter | Required | Definition                                                                                                                                                                                                                                                                                                                         |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`   | Yes      | Fresh disconnectToken from list_ovpn_sessions on this router; expires after 60 seconds and is single-use. `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | Explicit operator approval to terminate this one live connection. The client can reconnect. `{"type":"boolean","const":true}`                                                                                                                                                                                                      |

## get_ovpn_server

**Get OpenVPN Server Configuration** · Risk: **read**

`get_ovpn_server` — READ / get / show / inspect the OpenVPN (OVPN) server settings and status (`/interface ovpn-server server print`) — the singleton inbound-server instance: whether it is enabled/running, certificate, auth/cipher algorithms, port, protocol, netmask, mode, max_mtu, default_profile, require_client_certificate. Use set_ovpn_server to modify these settings. For outbound OVPN tunnels to a remote server use list_ovpn_clients or get_ovpn_client. For other VPN tunnel types use create_l2tp_client, create_pptp_client, or create_sstp_client. Returns the full server parameter block or a not-found message.

No tool-specific parameters.

## set_ovpn_server

**Configure OpenVPN Server** · Risk: **write-idempotent**

Apply settings to the OpenVPN server singleton (`/interface ovpn-server server set`) — enables or disables the inbound server, sets the TLS certificate, auth algorithms (comma-separated, e.g. 'sha256,sha1'), cipher suites (e.g. 'aes256-cbc,aes256-gcm'), TCP/UDP port, protocol (RouterOS 7 supports both tcp and udp), ip or ethernet mode, netmask, max_mtu, default_profile, and client certificate requirements. To read current settings use get_ovpn_server. For managing outbound OVPN client tunnels use create_ovpn_client. Returns the updated server parameter block on success.

| Parameter                    | Required | Definition                                                                  |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `enabled`                    | No       | `{"type":"boolean"}`                                                        |
| `certificate`                | No       | `{"type":"string"}`                                                         |
| `auth`                       | No       | Comma-separated, e.g. 'sha256,sha1' `{"type":"string"}`                     |
| `cipher`                     | No       | Comma-separated, e.g. 'aes256-cbc,aes256-gcm' `{"type":"string"}`           |
| `netmask`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `mode`                       | No       | `{"type":"string","enum":["ip","ethernet"]}`                                |
| `port`                       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `protocol`                   | No       | `{"type":"string","enum":["tcp","udp"]}`                                    |
| `tls_version`                | No       | Accepted TLS version `{"type":"string","enum":["any","only-1.2"]}`          |
| `default_profile`            | No       | `{"type":"string"}`                                                         |
| `require_client_certificate` | No       | `{"type":"boolean"}`                                                        |
| `max_mtu`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## add_ovpn_server

**Add Named OpenVPN Server** · Risk: **write**

Add a named inbound OpenVPN server instance (`/interface ovpn-server server add`) — the RouterOS 7.17+ multi-server model, where several OVPN servers can run side by side, each on its own port/certificate/profile. Provide a unique name; port defaults to 1194. Supports protocol (tcp/udp), ip or ethernet mode, certificate, auth/cipher algorithm lists, netmask, max_mtu, default_profile, mac_address (ethernet mode) and require_client_certificate. For the legacy single-server (selector-less) menu on older RouterOS use set_ovpn_server. To remove a named server use remove_ovpn_server; to list them use list_ovpn_servers. For outbound tunnels use create_ovpn_client. Returns the created server's detail including its name.

| Parameter                    | Required | Definition                                                                                 |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name`                       | Yes      | Unique name for the new OpenVPN server instance `{"type":"string","pattern":"^\\S+$"}`     |
| `port`                       | Yes      | `{"default":1194,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `protocol`                   | No       | `{"type":"string","enum":["tcp","udp"]}`                                                   |
| `mode`                       | No       | `{"type":"string","enum":["ip","ethernet"]}`                                               |
| `netmask`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `mac_address`                | No       | Server MAC for ethernet mode `{"type":"string"}`                                           |
| `certificate`                | No       | `{"type":"string"}`                                                                        |
| `auth`                       | No       | Comma-separated, e.g. 'sha256,sha1' `{"type":"string"}`                                    |
| `cipher`                     | No       | Comma-separated, e.g. 'aes256-cbc,aes256-gcm' `{"type":"string"}`                          |
| `tls_version`                | No       | Accepted TLS version `{"type":"string","enum":["any","only-1.2"]}`                         |
| `max_mtu`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `default_profile`            | No       | `{"type":"string"}`                                                                        |
| `require_client_certificate` | No       | `{"type":"boolean"}`                                                                       |
| `comment`                    | No       | `{"type":"string"}`                                                                        |
| `disabled`                   | Yes      | `{"default":false,"type":"boolean"}`                                                       |

## list_ovpn_servers

**List Named OpenVPN Servers** · Risk: **read**

`list_ovpn_servers` — READ / list / show / inspect all named OpenVPN server instances (`/interface ovpn-server server print detail`) on the RouterOS 7.17+ multi-server model, optionally filtered by partial name (name_filter). Returns each server's name, port, protocol, certificate, profile and disabled state. Pass a name_filter to fetch one server's full detail (this doubles as get-by-name). The `.id`/name values feed update_ovpn_server, remove_ovpn_server, enable_ovpn_server and disable_ovpn_server. For the legacy single-server menu use get_ovpn_server; for outbound tunnels use list_ovpn_clients.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## update_ovpn_server

**Update Named OpenVPN Server** · Risk: **write-idempotent**

Modify a named OpenVPN server instance (`/interface ovpn-server server set [find name=...]`) on the RouterOS 7.17+ multi-server model — change port, protocol, mode, certificate, auth/cipher, netmask, max_mtu, default_profile, mac_address, comment or require_client_certificate without recreating it. To toggle only the enabled state use enable_ovpn_server / disable_ovpn_server. To create a server use add_ovpn_server; to remove one use remove_ovpn_server. For the legacy single-server menu use set_ovpn_server. Returns the updated server's detail.

| Parameter                    | Required | Definition                                                                                                                                                                                                                                                   |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unset`                      | No       | Properties to UNSET (RouterOS `!prop`), so they no longer apply — e.g. ['dst-address'] removes the destination-address match. snake_case or kebab-case. Not for setting a value. `{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9_-]*$"}}` |
| `name`                       | Yes      | Existing OpenVPN server instance name `{"type":"string"}`                                                                                                                                                                                                    |
| `port`                       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                                                                                                                  |
| `protocol`                   | No       | `{"type":"string","enum":["tcp","udp"]}`                                                                                                                                                                                                                     |
| `mode`                       | No       | `{"type":"string","enum":["ip","ethernet"]}`                                                                                                                                                                                                                 |
| `netmask`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                                                                                                                  |
| `mac_address`                | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |
| `certificate`                | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |
| `auth`                       | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |
| `cipher`                     | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |
| `tls_version`                | No       | Accepted TLS version `{"type":"string","enum":["any","only-1.2"]}`                                                                                                                                                                                           |
| `max_mtu`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                                                                                                                  |
| `default_profile`            | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |
| `require_client_certificate` | No       | `{"type":"boolean"}`                                                                                                                                                                                                                                         |
| `comment`                    | No       | `{"type":"string"}`                                                                                                                                                                                                                                          |

## remove_ovpn_server

**Remove Named OpenVPN Server** · Risk: **destructive**

Permanently delete a named OpenVPN server instance (`/interface ovpn-server server remove [find name=...]`) on the RouterOS 7.17+ multi-server model — verifies existence with a count-only check before deleting. Use list_ovpn_servers to confirm the name. To stop a server without deleting it use disable_ovpn_server. This does not touch the legacy single-server menu (use set_ovpn_server with enabled=false for that) or any OVPN clients. Returns a success or not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_ovpn_server

**Enable Named OpenVPN Server** · Risk: **write-idempotent**

Enable a disabled named OpenVPN server instance (`/interface ovpn-server server enable [find name=...]`) on the RouterOS 7.17+ multi-server model, so it starts accepting clients. Use list_ovpn_servers to confirm the name. To deactivate use disable_ovpn_server; to delete use remove_ovpn_server. For the legacy single-server menu use set_ovpn_server with enabled=true. Returns a success or error message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_ovpn_server

**Disable Named OpenVPN Server** · Risk: **write-idempotent**

Disable an active named OpenVPN server instance (`/interface ovpn-server server disable [find name=...]`) on the RouterOS 7.17+ multi-server model, stopping it without deleting its configuration. Use list_ovpn_servers to confirm the name. To re-activate use enable_ovpn_server; to delete use remove_ovpn_server. For the legacy single-server menu use set_ovpn_server with enabled=false. Returns a success or error message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ovpn_client

**Create OpenVPN Client Interface** · Risk: **write**

Create an outbound OpenVPN client tunnel (`/interface ovpn-client add`) that connects this router to a remote OpenVPN server — use this to bring up a VPN uplink on a new interface. Provide a unique interface name and the remote server address (connect_to); port defaults to 1194. Supports username/password and/or certificate auth, cipher/auth algorithm overrides, ip or ethernet mode, tcp or udp protocol, and optional add_default_route. For other outbound VPN tunnel types use create_l2tp_client, create_pptp_client, or create_sstp_client. For inbound OVPN server configuration use set_ovpn_server. Returns the created interface detail including its name.

| Parameter                   | Required | Definition                                                                                 |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name`                      | Yes      | Name for the new OpenVPN client interface `{"type":"string","pattern":"^\\S+$"}`           |
| `connect_to`                | Yes      | Remote OpenVPN server address `{"type":"string"}`                                          |
| `port`                      | Yes      | `{"default":1194,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `user`                      | No       | `{"type":"string"}`                                                                        |
| `password`                  | No       | `{"type":"string"}`                                                                        |
| `certificate`               | No       | `{"type":"string"}`                                                                        |
| `cipher`                    | No       | `{"type":"string"}`                                                                        |
| `auth`                      | No       | `{"type":"string"}`                                                                        |
| `tls_version`               | No       | Accepted TLS version `{"type":"string","enum":["any","only-1.2"]}`                         |
| `mode`                      | No       | `{"type":"string","enum":["ip","ethernet"]}`                                               |
| `protocol`                  | No       | `{"type":"string","enum":["tcp","udp"]}`                                                   |
| `mac_address`               | No       | Client MAC for ethernet mode `{"type":"string"}`                                           |
| `max_mtu`                   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `profile`                   | No       | `{"type":"string"}`                                                                        |
| `add_default_route`         | No       | `{"type":"boolean"}`                                                                       |
| `route_nopull`              | No       | Ignore routes pushed by the server `{"type":"boolean"}`                                    |
| `use_peer_dns`              | No       | Use DNS servers pushed by the server `{"type":"boolean"}`                                  |
| `verify_server_certificate` | No       | `{"type":"boolean"}`                                                                       |
| `comment`                   | No       | `{"type":"string"}`                                                                        |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                       |

## list_ovpn_clients

**List OpenVPN Client Interfaces** · Risk: **read**

`list_ovpn_clients` — READ / list / show / inspect / enumerate all OpenVPN (OVPN) client interfaces (`/interface ovpn-client print`) and whether each tunnel is running/connected, optionally filtered by partial interface name (name_filter). Returns each client's name, running status, remote server (connect-to), port, mode and user. Use this to read existing OVPN uplinks and their status before calling get_ovpn_client, enable_ovpn_client, disable_ovpn_client, or remove_ovpn_client. For inbound server settings use get_ovpn_server. For L2TP, PPTP, or SSTP tunnels use the respective tools. Returns a redacted table of all matching OVPN client interfaces.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ovpn_client

**Get OpenVPN Client Interface Detail** · Risk: **read**

`get_ovpn_client` — READ / get / show / inspect one OpenVPN (OVPN) client interface's full detail and running status by name (`/interface ovpn-client print detail where name=...`): running/connected state, remote server (connect-to), port, mode, user, profile, certificate, cipher and auth. Use list_ovpn_clients first to enumerate available interface names. For the inbound OVPN server settings use get_ovpn_server. Returns the full interface detail with secrets redacted, or a not-found message if the name does not exist.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_ovpn_client

**Remove OpenVPN Client Interface** · Risk: **destructive**

Permanently delete a named OpenVPN client interface (`/interface ovpn-client remove [find name=...]`) — verifies existence with a count-only check before deleting. Use list_ovpn_clients to confirm the interface name. To temporarily stop the tunnel without deleting its config use disable_ovpn_client. Does not affect the inbound OVPN server — use set_ovpn_server with enabled=false to stop that. Returns a success or not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_ovpn_client

**Enable OpenVPN Client Interface** · Risk: **write-idempotent**

Enable a previously disabled OpenVPN client interface by name (`/interface ovpn-client enable [find name=...]`), causing it to initiate its tunnel connection. Use list_ovpn_clients to confirm the interface name. To deactivate without removing use disable_ovpn_client; to permanently delete use remove_ovpn_client. Does not affect the inbound OVPN server — use set_ovpn_server with enabled=true for that. Returns a success or error message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_ovpn_client

**Disable OpenVPN Client Interface** · Risk: **write-idempotent**

Disable an active OpenVPN client interface by name (`/interface ovpn-client disable [find name=...]`), dropping the tunnel without deleting its configuration. Use list_ovpn_clients to confirm the interface name. To re-activate use enable_ovpn_client; to permanently delete use remove_ovpn_client. Does not affect the inbound OVPN server — use set_ovpn_server with enabled=false for that. Returns a success or error message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
