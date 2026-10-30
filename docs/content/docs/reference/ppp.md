---
title: "PPP"
description: "Shared PPP backend: profiles, secrets, active sessions (`/ppp`)."
---

## Tools

- [Create PPP Profile](#create_ppp_profile)
- [List PPP Profiles](#list_ppp_profiles)
- [Get PPP Profile Details](#get_ppp_profile)
- [Update PPP Profile](#update_ppp_profile)
- [Remove PPP Profile](#remove_ppp_profile)
- [Create PPP Secret (VPN User Account)](#create_ppp_secret)
- [List PPP Secrets (VPN User Accounts)](#list_ppp_secrets)
- [Get PPP Secret Details](#get_ppp_secret)
- [Update PPP Secret (VPN User Account)](#update_ppp_secret)
- [Remove PPP Secret (VPN User Account)](#remove_ppp_secret)
- [List Active PPP Sessions](#get_ppp_active)
- [Disconnect Active PPP Session](#disconnect_ppp_active)

## create_ppp_profile

**Create PPP Profile** · Risk: **write**

Creates a reusable PPP profile (`/ppp profile add`) — a named template that defines local/remote address assignment, DNS push, TCP-MSS clamping, encryption policy, rate-limit, bridge, and single-session enforcement shared across L2TP, PPTP, SSTP, OpenVPN, and PPPoE sessions. Use this to standardise connection parameters without repeating them per-user; the profile name is then referenced in create_ppp_secret (`profile` field) and in tunnel client tools (create_l2tp_client, create_pptp_client, create_sstp_client, create_ovpn_client). For managing VPN user credentials themselves use create_ppp_secret. Returns the created profile's full detail including all fields. Rate-limit format example: '10M/10M'.

| Parameter              | Required | Definition                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`                 | Yes      | Name for the new PPP profile `{"type":"string"}`                                                       |
| `local_address`        | No       | Server-side tunnel IP or pool name `{"type":"string"}`                                                 |
| `remote_address`       | No       | Client IP or address pool name `{"type":"string"}`                                                     |
| `dns_server`           | No       | `{"type":"string"}`                                                                                    |
| `wins_server`          | No       | WINS server IP(s) pushed to clients `{"type":"string"}`                                                |
| `address_list`         | No       | Address list to add the remote address to `{"type":"string"}`                                          |
| `incoming_filter`      | No       | Firewall chain for incoming packets `{"type":"string"}`                                                |
| `outgoing_filter`      | No       | Firewall chain for outgoing packets `{"type":"string"}`                                                |
| `rate_limit`           | No       | Rate limit, e.g. '10M/10M' `{"type":"string"}`                                                         |
| `session_timeout`      | No       | Max session duration, e.g. '1h' `{"type":"string"}`                                                    |
| `idle_timeout`         | No       | Disconnect after this idle time, e.g. '5m' `{"type":"string"}`                                         |
| `use_encryption`       | No       | `{"type":"string","enum":["default","yes","no","required"]}`                                           |
| `use_mpls`             | No       | MPLS over the link policy `{"type":"string","enum":["default","yes","no","required"]}`                 |
| `use_compression`      | No       | Compression policy `{"type":"string","enum":["default","yes","no"]}`                                   |
| `change_tcp_mss`       | No       | `{"type":"string","enum":["default","yes","no"]}`                                                      |
| `only_one`             | No       | Allow only one session per user `{"type":"string","enum":["default","yes","no"]}`                      |
| `bridge`               | No       | `{"type":"string"}`                                                                                    |
| `bridge_horizon`       | No       | Bridge split-horizon group `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `bridge_path_cost`     | No       | Bridge port path cost `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`      |
| `bridge_port_priority` | No       | Bridge port priority `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`       |
| `dhcpv6_pd_pool`       | No       | IPv6 prefix delegation pool name `{"type":"string"}`                                                   |
| `on_up`                | No       | Script to run when the session connects `{"type":"string"}`                                            |
| `on_down`              | No       | Script to run when the session disconnects `{"type":"string"}`                                         |
| `comment`              | No       | `{"type":"string"}`                                                                                    |

## list_ppp_profiles

**List PPP Profiles** · Risk: **read**

Lists all PPP profiles (`/ppp profile print`) — reusable connection templates shared by L2TP, PPTP, SSTP, OpenVPN, and PPPoE sessions. Use this to discover available profile names before referencing them in create_ppp_secret or tunnel client tools. For full detail on a single profile use get_ppp_profile. For VPN user accounts use list_ppp_secrets. Supports optional partial-name filter. Returns a table of profiles with their address, DNS, rate-limit, and encryption settings.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ppp_profile

**Get PPP Profile Details** · Risk: **read**

Fetches full detail for a single named PPP profile (`/ppp profile print detail where name=...`). Use list_ppp_profiles to enumerate available profile names first. For VPN user accounts (secrets) use get_ppp_secret instead. Returns all profile fields: local/remote address, DNS, rate-limit, encryption, TCP-MSS, bridge, only-one, and comment.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ppp_profile

**Update PPP Profile** · Risk: **write-idempotent**

Modifies an existing PPP profile's settings (`/ppp profile set [find name=...]`). Targets the profile by its current name; supply `new_name` to rename it. Any combination of fields can be updated — local/remote address, DNS, rate-limit (e.g. '10M/10M'), encryption, TCP-MSS, bridge, only-one. For updating VPN user credentials use update_ppp_secret instead. Returns the profile's updated detail after the change.

| Parameter              | Required | Definition                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`                 | Yes      | Current name of the PPP profile to update `{"type":"string"}`                                          |
| `new_name`             | No       | `{"type":"string"}`                                                                                    |
| `local_address`        | No       | `{"type":"string"}`                                                                                    |
| `remote_address`       | No       | `{"type":"string"}`                                                                                    |
| `dns_server`           | No       | `{"type":"string"}`                                                                                    |
| `wins_server`          | No       | WINS server IP(s) pushed to clients `{"type":"string"}`                                                |
| `address_list`         | No       | Address list to add the remote address to `{"type":"string"}`                                          |
| `incoming_filter`      | No       | Firewall chain for incoming packets `{"type":"string"}`                                                |
| `outgoing_filter`      | No       | Firewall chain for outgoing packets `{"type":"string"}`                                                |
| `rate_limit`           | No       | `{"type":"string"}`                                                                                    |
| `session_timeout`      | No       | Max session duration, e.g. '1h' `{"type":"string"}`                                                    |
| `idle_timeout`         | No       | Disconnect after this idle time, e.g. '5m' `{"type":"string"}`                                         |
| `use_encryption`       | No       | `{"type":"string","enum":["default","yes","no","required"]}`                                           |
| `use_mpls`             | No       | MPLS over the link policy `{"type":"string","enum":["default","yes","no","required"]}`                 |
| `use_compression`      | No       | Compression policy `{"type":"string","enum":["default","yes","no"]}`                                   |
| `change_tcp_mss`       | No       | `{"type":"string","enum":["default","yes","no"]}`                                                      |
| `only_one`             | No       | `{"type":"string","enum":["default","yes","no"]}`                                                      |
| `bridge`               | No       | `{"type":"string"}`                                                                                    |
| `bridge_horizon`       | No       | Bridge split-horizon group `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `bridge_path_cost`     | No       | Bridge port path cost `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`      |
| `bridge_port_priority` | No       | Bridge port priority `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`       |
| `dhcpv6_pd_pool`       | No       | IPv6 prefix delegation pool name `{"type":"string"}`                                                   |
| `on_up`                | No       | Script to run when the session connects `{"type":"string"}`                                            |
| `on_down`              | No       | Script to run when the session disconnects `{"type":"string"}`                                         |
| `comment`              | No       | `{"type":"string"}`                                                                                    |

## remove_ppp_profile

**Remove PPP Profile** · Risk: **destructive**

Deletes a named PPP profile (`/ppp profile remove [find name=...]`) — the connection template shared by L2TP/PPTP/SSTP/OpenVPN/PPPoE sessions. Performs a count-only existence check first; returns not-found if the profile does not exist. Does NOT delete VPN user accounts — for that use remove_ppp_secret. Any secret or tunnel client that references this profile will fall back to the router default profile after removal.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ppp_secret

**Create PPP Secret (VPN User Account)** · Risk: **write**

Creates a PPP secret — a VPN user credential (`/ppp secret add`) — used by the router's L2TP, PPTP, SSTP, OpenVPN, and PPPoE servers to authenticate incoming clients. A secret stores username, password, the service it applies to (any/l2tp/pptp/sstp/ovpn/pppoe), an optional profile reference (create_ppp_profile), and per-user address overrides. This creates the server-side user account; for creating the tunnel client interface itself use create_l2tp_client, create_pptp_client, create_sstp_client, or create_ovpn_client. For connection template settings shared across users use create_ppp_profile. Returns the created secret's detail (password redacted in output).

| Parameter         | Required | Definition                                                                                                            |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Username for the secret `{"type":"string"}`                                                                           |
| `password`        | Yes      | Password for the secret `{"type":"string"}`                                                                           |
| `service`         | Yes      | Service this secret applies to `{"default":"any","type":"string","enum":["any","l2tp","pptp","sstp","ovpn","pppoe"]}` |
| `profile`         | No       | `{"type":"string"}`                                                                                                   |
| `local_address`   | No       | `{"type":"string"}`                                                                                                   |
| `remote_address`  | No       | `{"type":"string"}`                                                                                                   |
| `routes`          | No       | Routes added while this client is connected `{"type":"string"}`                                                       |
| `caller_id`       | No       | `{"type":"string"}`                                                                                                   |
| `limit_bytes_in`  | No       | Max bytes the client may upload `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`           |
| `limit_bytes_out` | No       | Max bytes the client may download `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`         |
| `comment`         | No       | `{"type":"string"}`                                                                                                   |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                                                  |

## list_ppp_secrets

**List PPP Secrets (VPN User Accounts)** · Risk: **read**

Lists PPP secrets — VPN user credentials (`/ppp secret print`) — configured on the router's L2TP/PPTP/SSTP/OpenVPN/PPPoE servers. Passwords are redacted in all output. Supports optional partial-name filter and exact service filter (any/l2tp/pptp/sstp/ovpn/pppoe). For full detail on a single user account use get_ppp_secret. For connection templates use list_ppp_profiles. Returns a table of secrets with username, service, profile, and address assignments.

| Parameter        | Required | Definition                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name_filter`    | No       | Partial name match `{"type":"string"}`                                                     |
| `service_filter` | No       | Exact service match `{"type":"string","enum":["any","l2tp","pptp","sstp","ovpn","pppoe"]}` |

## get_ppp_secret

**Get PPP Secret Details** · Risk: **read**

Fetches full detail for a single named PPP secret — a VPN user credential (`/ppp secret print detail where name=...`). Password is redacted in the returned output. Use list_ppp_secrets to enumerate available usernames first. For PPP connection templates use get_ppp_profile instead. Returns all secret fields: service, profile, local/remote address, caller-id, disabled state, and comment.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ppp_secret

**Update PPP Secret (VPN User Account)** · Risk: **write-idempotent**

Modifies an existing PPP secret — a VPN user credential (`/ppp secret set [find name=...]`). Targets the account by its current username; supply `new_name` to rename it. Any combination of fields can be changed — password, service restriction (any/l2tp/pptp/sstp/ovpn/pppoe), profile, local/remote address, caller-id, comment, or disabled state. For updating connection templates (rate-limit, encryption, DNS) use update_ppp_profile instead. Password is redacted in the returned output. Returns the account's updated detail after the change.

| Parameter         | Required | Definition                                                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Current username of the secret to update `{"type":"string"}`                                                  |
| `new_name`        | No       | `{"type":"string"}`                                                                                           |
| `password`        | No       | `{"type":"string"}`                                                                                           |
| `service`         | No       | `{"type":"string","enum":["any","l2tp","pptp","sstp","ovpn","pppoe"]}`                                        |
| `profile`         | No       | `{"type":"string"}`                                                                                           |
| `local_address`   | No       | `{"type":"string"}`                                                                                           |
| `remote_address`  | No       | `{"type":"string"}`                                                                                           |
| `routes`          | No       | Routes added while this client is connected `{"type":"string"}`                                               |
| `caller_id`       | No       | `{"type":"string"}`                                                                                           |
| `limit_bytes_in`  | No       | Max bytes the client may upload `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`   |
| `limit_bytes_out` | No       | Max bytes the client may download `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`         | No       | `{"type":"string"}`                                                                                           |
| `disabled`        | No       | `{"type":"boolean"}`                                                                                          |

## remove_ppp_secret

**Remove PPP Secret (VPN User Account)** · Risk: **destructive**

Deletes a named PPP secret — a VPN user credential (`/ppp secret remove [find name=...]`). Performs a count-only existence check first; returns not-found if the username does not exist. This removes only the user account — it does NOT disconnect any currently active session for that user; use disconnect_ppp_active for that. For removing the connection template use remove_ppp_profile instead.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## get_ppp_active

**List Active PPP Sessions** · Risk: **read**

Lists currently connected PPP sessions (`/ppp active print`) — L2TP, PPTP, SSTP, OpenVPN, and PPPoE clients that are live on the router right now. Use this to monitor active VPN connections; supports optional partial-username filter. Active sessions are read-only runtime state — to force-disconnect one use disconnect_ppp_active; to manage the underlying user account use list_ppp_secrets. Returns session entries showing username, service type, assigned IP, uptime, and encoding.

| Parameter     | Required | Definition                                 |
| ------------- | -------- | ------------------------------------------ |
| `name_filter` | No       | Partial username match `{"type":"string"}` |

## disconnect_ppp_active

**Disconnect Active PPP Session** · Risk: **destructive**

Force-disconnects a currently active PPP session by username (`/ppp active remove [find name=...]`). Use get_ppp_active to find the exact username of a live session before calling this. This terminates the live connection only — it does NOT delete the underlying user account; use remove_ppp_secret for that. The client may immediately reconnect if its credentials remain valid in /ppp secret.

| Parameter | Required | Definition                                                       |
| --------- | -------- | ---------------------------------------------------------------- |
| `name`    | Yes      | Username of the active session to disconnect `{"type":"string"}` |
