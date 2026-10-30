---
title: "PPTP"
description: "PPTP server + clients (legacy) (`/interface pptp-*`)."
---

## Tools

- [Get PPTP Server Configuration](#get_pptp_server)
- [Configure PPTP Server](#set_pptp_server)
- [Create PPTP Client Interface](#create_pptp_client)
- [List PPTP Client Interfaces](#list_pptp_clients)
- [Get PPTP Client Interface Detail](#get_pptp_client)
- [Remove PPTP Client Interface](#remove_pptp_client)

## get_pptp_server

**Get PPTP Server Configuration** · Risk: **read**

Reads the PPTP server singleton configuration (`/interface pptp-server server print`) — shows enabled state, default PPP profile, allowed authentication methods (mschap2/mschap1/pap/chap), max-mtu, and max-mru. Use this to inspect current server state before calling set_pptp_server to change it. For dial-out client interfaces use list_pptp_clients. NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. Returns the raw server property block.

No tool-specific parameters.

## set_pptp_server

**Configure PPTP Server** · Risk: **write-idempotent**

Configures the PPTP server singleton (`/interface pptp-server server set`) — toggle the server on/off, change the default PPP profile, allowed authentication methods, and MTU/MRU limits. Use get_pptp_server first to inspect current values. For managing dial-out tunnels use create_pptp_client. `authentication` accepts a comma-separated list, e.g. 'mschap2,mschap1'. NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. Returns the updated server configuration.

| Parameter           | Required | Definition                                                                  |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `enabled`           | No       | Enable or disable the PPTP server `{"type":"boolean"}`                      |
| `default_profile`   | No       | `{"type":"string"}`                                                         |
| `authentication`    | No       | Comma-separated, e.g. 'mschap2,mschap1' `{"type":"string"}`                 |
| `max_mtu`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `max_mru`           | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `mrru`              | No       | Max packet size for MP reassembly, or 'disabled' `{"type":"string"}`        |
| `keepalive_timeout` | No       | Keepalive timeout in seconds, or 'disabled' `{"type":"string"}`             |

## create_pptp_client

**Create PPTP Client Interface** · Risk: **write**

Creates a PPTP dial-out client interface (`/interface pptp-client add`) — adds a new named tunnel that connects outward to a remote PPTP server. For L2TP dial-out use create_l2tp_client; for SSTP dial-out use create_sstp_client; for OpenVPN dial-out use create_ovpn_client. `name` sets the interface name; `connect_to` is the remote server address; `password` is redacted in returned output. `add_default_route` installs a default route via this tunnel when set to true. NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. Returns the created client's detail including its `.id`.

| Parameter                | Required | Definition                                                                                                                           |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | Yes      | Name for the new PPTP client interface `{"type":"string","pattern":"^\\S+$"}`                                                        |
| `connect_to`             | Yes      | Remote PPTP server address `{"type":"string"}`                                                                                       |
| `user`                   | Yes      | Username for authentication `{"type":"string"}`                                                                                      |
| `password`               | Yes      | Password for authentication `{"type":"string"}`                                                                                      |
| `profile`                | No       | `{"type":"string"}`                                                                                                                  |
| `add_default_route`      | No       | `{"type":"boolean"}`                                                                                                                 |
| `default_route_distance` | No       | Distance for the default route installed via this tunnel `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `allow`                  | No       | Allowed auth protocols, comma-separated, e.g. 'mschap2,mschap1' `{"type":"string"}`                                                  |
| `dial_on_demand`         | No       | Connect only when outbound traffic is generated `{"type":"boolean"}`                                                                 |
| `max_mtu`                | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                          |
| `max_mru`                | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                          |
| `mrru`                   | No       | Max packet size for MP reassembly, or 'disabled' `{"type":"string"}`                                                                 |
| `keepalive_timeout`      | No       | Keepalive timeout in seconds, or 'disabled' `{"type":"string"}`                                                                      |
| `comment`                | No       | `{"type":"string"}`                                                                                                                  |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                                                                                 |

## list_pptp_clients

**List PPTP Client Interfaces** · Risk: **read**

Lists all PPTP dial-out client interfaces (`/interface pptp-client print`) — shows name, connect-to address, enabled/disabled state, and profile for each tunnel; passwords are redacted. Optionally filters by partial name match via `name_filter`. Use get_pptp_client for full detail on a single entry. For L2TP, SSTP, or OpenVPN clients use the corresponding list_* tool for that VPN type. Returns the filtered client list or an empty notice if none match.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_pptp_client

**Get PPTP Client Interface Detail** · Risk: **read**

Fetches detailed properties of a single PPTP client interface (`/interface pptp-client print detail`) by exact name — shows all parameters including connect-to address, profile, enabled state, and run-time statistics; the password is redacted. Use list_pptp_clients to find the exact interface name first. For L2TP, SSTP, or OpenVPN client detail use the corresponding get_* tool for that VPN type. Returns the full detail block or a not-found message if the name does not match.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_pptp_client

**Remove PPTP Client Interface** · Risk: **destructive**

Permanently removes a PPTP dial-out client interface (`/interface pptp-client remove`) by exact name — first verifies the interface exists with a count-only check, then deletes it. Use list_pptp_clients to find the exact name before calling this. This is destructive and not reversible without recreating the interface with create_pptp_client. For L2TP, SSTP, or OpenVPN client removal use the corresponding remove_* tool for that VPN type. Returns a success confirmation or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
