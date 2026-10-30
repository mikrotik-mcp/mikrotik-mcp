---
title: "802.1X — Client"
description: "802.1X supplicant: authenticate the device to an upstream port (`/interface dot1x client`)."
---

## Tools

- [Add 802.1X Supplicant Client](#add_dot1x_client)
- [List 802.1X Supplicant Clients](#list_dot1x_clients)
- [Get 802.1X Supplicant Client Detail](#get_dot1x_client)
- [Update 802.1X Supplicant Client](#update_dot1x_client)
- [Remove 802.1X Supplicant Client](#remove_dot1x_client)

## add_dot1x_client

**Add 802.1X Supplicant Client** · Risk: **write**

Adds an 802.1X supplicant client entry on a specific interface (`/interface dot1x client add`) so the router authenticates itself to an upstream 802.1X authenticator (e.g. a managed switch or wireless AP). Use this when the MikroTik device is the _supplicant_ (client) side of 802.1X — not the server/authenticator side. `eap_methods` is a comma-separated list, e.g. `'eap-tls'`, `'eap-peap'`, `'eap-mschapv2'`, `'eap-ttls'`; `certificate` is required for eap-tls; `identity`/`password` are required for password-based EAP methods. Returns the created entry's full detail (including its `.id`) which is used by update_dot1x_client, get_dot1x_client, and remove_dot1x_client.

| Parameter            | Required | Definition                                                                                 |
| -------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `interface`          | Yes      | `{"type":"string"}`                                                                        |
| `eap_methods`        | Yes      | Comma-separated EAP methods, e.g. 'eap-tls' or 'eap-peap,eap-mschapv2' `{"type":"string"}` |
| `identity`           | No       | EAP identity (username) `{"type":"string"}`                                                |
| `anonymous_identity` | No       | `{"type":"string"}`                                                                        |
| `certificate`        | No       | Client certificate name (required for eap-tls) `{"type":"string"}`                         |
| `password`           | No       | EAP password (password methods) `{"type":"string"}`                                        |
| `comment`            | No       | `{"type":"string"}`                                                                        |
| `disabled`           | Yes      | `{"default":false,"type":"boolean"}`                                                       |

## list_dot1x_clients

**List 802.1X Supplicant Clients** · Risk: **read**

Lists all 802.1X supplicant client entries configured on the device (`/interface dot1x client print`). Optionally filters by interface name (`interface_filter`), authentication status string (`status_filter`, e.g. `'authenticated'`, `'authenticating'`), or disabled state (`disabled_only`). Returns a table of all matching supplicant entries with their interface, EAP method, and status; for full detail on a single entry use get_dot1x_client.

| Parameter          | Required | Definition                                                               |
| ------------------ | -------- | ------------------------------------------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                                                      |
| `status_filter`    | No       | Match status, e.g. 'authenticated', 'authenticating' `{"type":"string"}` |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}`                                     |

## get_dot1x_client

**Get 802.1X Supplicant Client Detail** · Risk: **read**

Fetches full detail for a single 802.1X supplicant client entry (`/interface dot1x client print detail`). Accepts either an interface name (e.g. `'ether3'`) or a RouterOS `.id` string (e.g. `'*1'`) from list_dot1x_clients as `client_id` — tries `.id` lookup first, then falls back to interface name. Returns the complete supplicant configuration including EAP method, identity, certificate, and current authentication status. For a bulk view of all entries use list_dot1x_clients.

| Parameter   | Required | Definition                                                           |
| ----------- | -------- | -------------------------------------------------------------------- |
| `client_id` | Yes      | Interface name (e.g. 'ether3') or RouterOS '.id' `{"type":"string"}` |

## update_dot1x_client

**Update 802.1X Supplicant Client** · Risk: **write-idempotent**

Modifies an existing 802.1X supplicant client entry (`/interface dot1x client set`) identified by interface name or RouterOS `.id` from list_dot1x_clients. `client_id` accepts an interface name (e.g. `'ether3'`) or a `.id` string starting with `'*'`. Only supplied fields are changed; pass `comment=""` to clear the comment. Returns the updated entry's full detail after the change. To add a new supplicant entry use add_dot1x_client; to delete one use remove_dot1x_client.

| Parameter            | Required | Definition                                           |
| -------------------- | -------- | ---------------------------------------------------- |
| `client_id`          | Yes      | Interface name or RouterOS '.id' `{"type":"string"}` |
| `eap_methods`        | No       | `{"type":"string"}`                                  |
| `identity`           | No       | `{"type":"string"}`                                  |
| `anonymous_identity` | No       | `{"type":"string"}`                                  |
| `certificate`        | No       | `{"type":"string"}`                                  |
| `password`           | No       | `{"type":"string"}`                                  |
| `comment`            | No       | `{"type":"string"}`                                  |
| `disabled`           | No       | `{"type":"boolean"}`                                 |

## remove_dot1x_client

**Remove 802.1X Supplicant Client** · Risk: **destructive**

Removes an 802.1X supplicant client entry (`/interface dot1x client remove`) identified by interface name or RouterOS `.id` from list_dot1x_clients. `client_id` accepts an interface name (e.g. `'ether3'`) or a `.id` string starting with `'*'`. Verifies the entry exists with a count-only check before deletion and returns an error if not found. Permanently stops 802.1X authentication on that interface; to temporarily halt authentication without deleting the entry use update_dot1x_client with `disabled=true`.

| Parameter   | Required | Definition                                           |
| ----------- | -------- | ---------------------------------------------------- |
| `client_id` | Yes      | Interface name or RouterOS '.id' `{"type":"string"}` |
