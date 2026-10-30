---
title: "SSTP"
description: "SSTP (TLS) server + clients (`/interface sstp-*`)."
---

## Tools

- [Get SSTP Server Configuration](#get_sstp_server)
- [Set SSTP Server Configuration](#set_sstp_server)
- [Create SSTP Client Interface](#create_sstp_client)
- [List SSTP Client Interfaces](#list_sstp_clients)
- [Get SSTP Client Interface Detail](#get_sstp_client)
- [Remove SSTP Client Interface](#remove_sstp_client)
- [Enable SSTP Client Interface](#enable_sstp_client)
- [Disable SSTP Client Interface](#disable_sstp_client)

## get_sstp_server

**Get SSTP Server Configuration** · Risk: **read**

Read the global SSTP server listener settings (`/interface sstp-server server print`) — enabled state, TLS certificate, TCP port, authentication methods, default PPP profile, TLS version, and client-certificate verification flag. Use this to inspect the server-side VPN endpoint before making changes. To modify these settings use `set_sstp_server`. For outbound SSTP client tunnel interfaces use `list_sstp_clients`. Returns the full singleton server block.

No tool-specific parameters.

## set_sstp_server

**Set SSTP Server Configuration** · Risk: **write-idempotent**

Configure the global SSTP server listener (`/interface sstp-server server set`) — accepts/rejects incoming TLS VPN connections on this router. Use to enable the server, bind a TLS certificate, change the TCP port, restrict authentication methods (comma-separated, e.g. `'mschap2,mschap1'`), set the default PPP profile, pin TLS version (`any` or `only-1.2`), or enforce client certificate verification. This is a singleton write that modifies the server block, not a client interface. To read the current server config use `get_sstp_server`. To create outbound SSTP tunnels (this router dials out) use `create_sstp_client`; for L2TP outbound use `create_l2tp_client`, for OpenVPN use `create_ovpn_client`, for PPTP use `create_pptp_client`. Returns the updated server block on success.

| Parameter                   | Required | Definition                                                                                                                       |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | No       | `{"type":"boolean"}`                                                                                                             |
| `default_profile`           | No       | `{"type":"string"}`                                                                                                              |
| `authentication`            | No       | Comma-separated, e.g. 'mschap2,mschap1' `{"type":"string"}`                                                                      |
| `certificate`               | No       | TLS certificate name `{"type":"string"}`                                                                                         |
| `port`                      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                      |
| `tls_version`               | No       | `{"type":"string","enum":["any","only-1.2"]}`                                                                                    |
| `verify_client_certificate` | No       | `{"type":"boolean"}`                                                                                                             |
| `pfs`                       | No       | Enable Perfect Forward Secrecy `{"type":"boolean"}`                                                                              |
| `force_aes`                 | No       | Require clients to use AES ciphers `{"type":"boolean"}`                                                                          |
| `max_mtu`                   | No       | Maximum transmission unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                            |
| `max_mru`                   | No       | Maximum receive unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                 |
| `mrru`                      | No       | Max receive reconstructed unit for MP `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `keepalive_timeout`         | No       | Seconds before an idle connection is considered down `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## create_sstp_client

**Create SSTP Client Interface** · Risk: **write**

Create an outbound SSTP client tunnel interface (`/interface sstp-client add`) so this router dials out to a remote SSTP server over TLS. Use when this device must act as a VPN client, not the VPN server — for server-side settings use `set_sstp_server`. `connect_to` is the remote server address (IP or DNS name); the TCP port is separate. You may pass the port in `port` or inline as `host:port` in `connect_to` (it is split out automatically — RouterOS rejects a port embedded in connect-to). SSTP defaults to 443. For L2TP outbound tunnels use `create_l2tp_client`, for OpenVPN use `create_ovpn_client`, for PPTP use `create_pptp_client`. Credentials are accepted but redacted from return values. Returns the created interface detail (name, status, remote address); use the interface `name` with `get_sstp_client` or `remove_sstp_client`.

| Parameter                   | Required | Definition                                                                                                                       |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | Yes      | Name for the new SSTP client interface `{"type":"string","pattern":"^\\S+$"}`                                                    |
| `connect_to`                | Yes      | Remote SSTP server address (IP or DNS name; host:port also accepted) `{"type":"string"}`                                         |
| `port`                      | No       | TCP port (default 443 if omitted) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                    |
| `user`                      | Yes      | `{"type":"string"}`                                                                                                              |
| `password`                  | Yes      | `{"type":"string"}`                                                                                                              |
| `profile`                   | No       | `{"type":"string"}`                                                                                                              |
| `certificate`               | No       | Client TLS certificate name `{"type":"string"}`                                                                                  |
| `verify_server_certificate` | No       | `{"type":"boolean"}`                                                                                                             |
| `authentication`            | No       | Comma-separated, e.g. 'mschap2,mschap1' `{"type":"string"}`                                                                      |
| `tls_version`               | No       | `{"type":"string","enum":["any","only-1.2"]}`                                                                                    |
| `pfs`                       | No       | Enable Perfect Forward Secrecy `{"type":"boolean"}`                                                                              |
| `add_default_route`         | No       | `{"type":"boolean"}`                                                                                                             |
| `default_route_distance`    | No       | Distance of the auto-added default route `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`             |
| `dial_on_demand`            | No       | Connect only when traffic is sent over the tunnel `{"type":"boolean"}`                                                           |
| `max_mtu`                   | No       | Maximum transmission unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                            |
| `max_mru`                   | No       | Maximum receive unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                 |
| `mrru`                      | No       | Max receive reconstructed unit for MP `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `keepalive_timeout`         | No       | Seconds before an idle connection is considered down `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `http_proxy`                | No       | `{"type":"string"}`                                                                                                              |
| `comment`                   | No       | `{"type":"string"}`                                                                                                              |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                             |

## list_sstp_clients

**List SSTP Client Interfaces** · Risk: **read**

List all outbound SSTP client tunnel interfaces (`/interface sstp-client print`), optionally narrowed by partial name match via `name_filter`. Use to discover existing SSTP tunnels and their connection status before creating or removing one. Passwords are redacted in the output. For full detail on a single client use `get_sstp_client` with the interface name. To inspect the inbound SSTP server config use `get_sstp_server`. Returns a summary list of all matching SSTP client entries.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_sstp_client

**Get SSTP Client Interface Detail** · Risk: **read**

Return full detail for one SSTP client interface (`/interface sstp-client print detail where name=...`) by interface name — includes status, remote server address, TLS certificate, PPP profile, and connection options; passwords are redacted. Use when you need the complete property set for a single tunnel rather than the summary list. Use `list_sstp_clients` first to discover valid interface names. For the inbound server configuration use `get_sstp_server`. Returns the full detail block for the named interface, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_sstp_client

**Remove SSTP Client Interface** · Risk: **destructive**

Permanently delete an SSTP client tunnel interface (`/interface sstp-client remove [find name=...]`) by interface name. First verifies the interface exists (count-only check), then removes it; the tunnel is torn down immediately and the action is irreversible. Use `list_sstp_clients` to confirm the interface name before calling this tool. For L2TP, OpenVPN, or PPTP client interfaces see their respective tool scopes (`create_l2tp_client`, `create_ovpn_client`, `create_pptp_client`). To deactivate the interface without deleting it use `disable_sstp_client` (re-activate with `enable_sstp_client`). Returns a confirmation message on success or a not-found message if the name does not exist.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_sstp_client

**Enable SSTP Client Interface** · Risk: **write-idempotent**

Enables a disabled SSTP client interface (`/interface sstp-client enable [find name=...]`), causing the router to dial out and attempt the TLS connection to the remote SSTP server. Use to activate a tunnel that was created disabled or stopped with `disable_sstp_client`. For L2TP/PPTP/OpenVPN tunnels use their own enable tools. Identifies the interface by name — create one with `create_sstp_client`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_sstp_client

**Disable SSTP Client Interface** · Risk: **write-idempotent**

Disables an active SSTP client interface (`/interface sstp-client disable [find name=...]`), tearing down the tunnel without removing its configuration. Use to temporarily stop a tunnel while preserving its settings for later reuse. To re-enable use `enable_sstp_client`; to permanently remove use `remove_sstp_client`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
