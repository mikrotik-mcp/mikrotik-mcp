---
title: "OpenVPN"
description: "OpenVPN servers — legacy single + RouterOS 7.17 multi-server — and clients (`/interface ovpn-*`)."
---

## Tools

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

| Parameter                    | Required | Definition                                                                  |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `name`                       | Yes      | Existing OpenVPN server instance name `{"type":"string"}`                   |
| `port`                       | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `protocol`                   | No       | `{"type":"string","enum":["tcp","udp"]}`                                    |
| `mode`                       | No       | `{"type":"string","enum":["ip","ethernet"]}`                                |
| `netmask`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `mac_address`                | No       | `{"type":"string"}`                                                         |
| `certificate`                | No       | `{"type":"string"}`                                                         |
| `auth`                       | No       | `{"type":"string"}`                                                         |
| `cipher`                     | No       | `{"type":"string"}`                                                         |
| `tls_version`                | No       | Accepted TLS version `{"type":"string","enum":["any","only-1.2"]}`          |
| `max_mtu`                    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `default_profile`            | No       | `{"type":"string"}`                                                         |
| `require_client_certificate` | No       | `{"type":"boolean"}`                                                        |
| `comment`                    | No       | `{"type":"string"}`                                                         |

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
