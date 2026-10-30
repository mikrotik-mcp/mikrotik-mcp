---
title: "L2TP"
description: "L2TP server + clients, incl. L2TP/IPsec (`/interface l2tp-*`)."
---

## Tools

- [Get L2TP Server Configuration](#get_l2tp_server)
- [Configure L2TP Server Settings](#set_l2tp_server)
- [Create L2TP Client Interface](#create_l2tp_client)
- [List L2TP Client Interfaces](#list_l2tp_clients)
- [Get L2TP Client Interface Detail](#get_l2tp_client)
- [Remove L2TP Client Interface](#remove_l2tp_client)
- [Enable L2TP Client Interface](#enable_l2tp_client)
- [Disable L2TP Client Interface](#disable_l2tp_client)

## get_l2tp_server

**Get L2TP Server Configuration** · Risk: **read**

Reads the global L2TP server settings (`/interface l2tp-server server`). Use to inspect whether the server is enabled, which authentication methods are accepted, and whether IPsec is required. For outbound dial-out tunnels use `list_l2tp_clients`; for PPP user credentials use `list_ppp_secrets`. Returns the current server-wide settings: enabled flag, authentication, use-ipsec, ipsec-secret, MTU/MRU, and default-profile.

No tool-specific parameters.

## set_l2tp_server

**Configure L2TP Server Settings** · Risk: **write-idempotent**

Applies global L2TP server settings (`/interface l2tp-server server set`). Use to enable or disable the inbound L2TP server, change accepted authentication methods (comma-separated, e.g. `mschap2,mschap1`), or configure L2TP/IPsec road-warrior mode by setting `use_ipsec='required'` and supplying `ipsec_secret`. For creating outbound dial-out tunnels use `create_l2tp_client`; for managing PPP user accounts use `create_ppp_secret`. Returns the updated server configuration after applying changes.

| Parameter              | Required | Definition                                                                                                                      |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`              | No       | Enable or disable the L2TP server `{"type":"boolean"}`                                                                          |
| `default_profile`      | No       | `{"type":"string"}`                                                                                                             |
| `authentication`       | No       | Comma-separated, e.g. 'mschap2,mschap1' `{"type":"string"}`                                                                     |
| `use_ipsec`            | No       | `{"type":"string","enum":["yes","no","required"]}`                                                                              |
| `ipsec_secret`         | No       | Pre-shared key for L2TP/IPsec `{"type":"string"}`                                                                               |
| `max_mtu`              | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `max_mru`              | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                     |
| `mrru`                 | No       | Max receive reconstructed unit for MRRU (multilink) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `keepalive_timeout`    | No       | Seconds before an idle tunnel is considered down `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`    |
| `max_sessions`         | No       | Maximum simultaneous client sessions `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                |
| `one_session_per_host` | No       | Allow only one active session per host `{"type":"boolean"}`                                                                     |
| `caller_id_type`       | No       | Caller ID format: ip-address or number `{"type":"string","enum":["ip-address","number"]}`                                       |

## create_l2tp_client

**Create L2TP Client Interface** · Risk: **write**

Creates an L2TP dial-out client interface (`/interface l2tp-client add`) that connects this router to a remote L2TP server. Use when this router is the tunnel initiator (client side). For PPTP tunnels use `create_pptp_client`, for SSTP use `create_sstp_client`, for OpenVPN use `create_ovpn_client`. `connect_to` takes the remote server address; set `use_ipsec='yes'` and `ipsec_secret` to layer IPsec on top. Returns the created interface details with passwords redacted.

| Parameter                | Required | Definition                                                                                                                      |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Yes      | Name for the new L2TP client interface `{"type":"string","pattern":"^\\S+$"}`                                                   |
| `connect_to`             | Yes      | Remote L2TP server address `{"type":"string"}`                                                                                  |
| `user`                   | Yes      | Username for authentication `{"type":"string"}`                                                                                 |
| `password`               | Yes      | Password for authentication `{"type":"string"}`                                                                                 |
| `profile`                | Yes      | `{"default":"default-encryption","type":"string"}`                                                                              |
| `add_default_route`      | No       | `{"type":"boolean"}`                                                                                                            |
| `default_route_distance` | No       | Distance of the auto-added default route `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`            |
| `use_ipsec`              | No       | `{"type":"string","enum":["yes","no"]}`                                                                                         |
| `ipsec_secret`           | No       | Pre-shared key for L2TP/IPsec `{"type":"string"}`                                                                               |
| `allow`                  | No       | Allowed auth protocols, comma-separated (pap,chap,mschap1,mschap2) `{"type":"string"}`                                          |
| `use_peer_dns`           | No       | Use DNS servers offered by the remote peer `{"type":"boolean"}`                                                                 |
| `dial_on_demand`         | No       | Connect only when traffic is present `{"type":"boolean"}`                                                                       |
| `keepalive_timeout`      | No       | Seconds before an idle tunnel is considered down `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`    |
| `max_mtu`                | No       | Maximum transmission unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                           |
| `max_mru`                | No       | Maximum receive unit `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                |
| `mrru`                   | No       | Max receive reconstructed unit for MRRU (multilink) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`                | No       | `{"type":"string"}`                                                                                                             |
| `disabled`               | Yes      | `{"default":false,"type":"boolean"}`                                                                                            |

## list_l2tp_clients

**List L2TP Client Interfaces** · Risk: **read**

Lists all L2TP dial-out client interfaces (`/interface l2tp-client print`) configured on this router. Use to discover existing L2TP tunnels and their connection state. For PPTP tunnels use `list_pptp_clients`, for SSTP use `list_sstp_clients`, for OpenVPN use `list_ovpn_clients`. Supports optional `name_filter` for partial name matching. Returns interface names, connection status, and remote addresses — passwords are redacted.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_l2tp_client

**Get L2TP Client Interface Detail** · Risk: **read**

Retrieves full detail of a single named L2TP client interface (`/interface l2tp-client print detail where name=...`). Use to inspect the full configuration of a specific tunnel after finding its name with `list_l2tp_clients`. For PPTP tunnel detail use `get_pptp_client`, for SSTP use `get_sstp_client`. Returns all interface properties; the password field is redacted.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_l2tp_client

**Remove L2TP Client Interface** · Risk: **destructive**

Permanently deletes a named L2TP client interface (`/interface l2tp-client remove [find name=...]`). First verifies the interface exists via `count-only` and returns an error if not found. For PPTP tunnel removal use `remove_pptp_client`, for SSTP use `remove_sstp_client`. This is destructive and cannot be undone — use `disable_l2tp_client` to deactivate without deleting.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_l2tp_client

**Enable L2TP Client Interface** · Risk: **write-idempotent**

Enables a disabled L2TP client interface (`/interface l2tp-client enable [find name=...]`), causing the router to attempt connection to the remote server. Use to reactivate a tunnel previously stopped with `disable_l2tp_client`. For OpenVPN tunnel enable/disable use `enable_ovpn_client`. Identifies the interface by name — use `create_l2tp_client` to create a new one.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_l2tp_client

**Disable L2TP Client Interface** · Risk: **write-idempotent**

Disables an active L2TP client interface (`/interface l2tp-client disable [find name=...]`), tearing down the tunnel without removing its configuration. Use to temporarily stop a tunnel while preserving its settings for later reuse. To re-enable use `enable_l2tp_client`; to permanently remove use `remove_l2tp_client`. For OpenVPN tunnel enable/disable use `disable_ovpn_client`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
