---
title: "802.1X — Server"
description: "802.1X authenticator: port-based access control via RADIUS (`/interface dot1x server`)."
---

## Tools

- [Add 802.1X Server (Authenticator) Entry](#add_dot1x_server)
- [List 802.1X Server (Authenticator) Entries](#list_dot1x_servers)
- [Get 802.1X Server (Authenticator) Entry Detail](#get_dot1x_server)
- [Update 802.1X Server (Authenticator) Entry](#update_dot1x_server)
- [Remove 802.1X Server (Authenticator) Entry](#remove_dot1x_server)

## add_dot1x_server

**Add 802.1X Server (Authenticator) Entry** · Risk: **write**

Creates an 802.1X authenticator entry on an interface (`/interface dot1x server add`), enabling port-based network access control (IEEE 802.1X) enforced against a RADIUS server. Use this to require EAP supplicant authentication (`dot1x`), MAC-bypass authentication (`mac-auth`), or both on a physical port before granting network access. For viewing existing entries use `list_dot1x_servers`; for modifying use `update_dot1x_server`; for removal use `remove_dot1x_server`. Returns the created entry's full detail.

Notes:
auth_types: 'dot1x' (EAP supplicant), 'mac-auth' (MAC bypass), or
'dot1x,mac-auth' (both).
guest_vlan_id / reject_vlan_id / server_fail_vlan_id: VLAN to assign
when there is no supplicant, on auth failure, or when RADIUS is
unreachable (number, or 'none').
interim_update: RADIUS interim-accounting update interval, e.g. '5m' or '0s'.

| Parameter             | Required | Definition                                                                    |
| --------------------- | -------- | ----------------------------------------------------------------------------- |
| `interface`           | Yes      | `{"type":"string"}`                                                           |
| `auth_types`          | No       | `{"type":"string","enum":["dot1x","mac-auth","dot1x,mac-auth"]}`              |
| `accounting`          | No       | `{"type":"boolean"}`                                                          |
| `interim_update`      | No       | e.g. '5m' or '0s' `{"type":"string"}`                                         |
| `mac_auth_mode`       | No       | `{"type":"string","enum":["mac-as-username","mac-as-username-and-password"]}` |
| `guest_vlan_id`       | No       | VLAN id or 'none' `{"type":"string"}`                                         |
| `reject_vlan_id`      | No       | VLAN id or 'none' `{"type":"string"}`                                         |
| `server_fail_vlan_id` | No       | VLAN id or 'none' `{"type":"string"}`                                         |
| `reauth_timeout`      | No       | Re-auth period or 'none' `{"type":"string"}`                                  |
| `reauth_period`       | No       | RouterOS 7.25+ re-authentication period `{"type":"string"}`                   |
| `comment`             | No       | `{"type":"string"}`                                                           |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                          |

## list_dot1x_servers

**List 802.1X Server (Authenticator) Entries** · Risk: **read**

Lists all 802.1X authenticator entries (`/interface dot1x server print`). Optionally filter by interface name (`interface_filter`) or restrict output to disabled entries only (`disabled_only=true`). For full detail on a single entry use `get_dot1x_server`. Returns the tabular RouterOS print output including each entry's `.id`, interface, auth-types, and VLAN assignments.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_dot1x_server

**Get 802.1X Server (Authenticator) Entry Detail** · Risk: **read**

Retrieves full detail of a single 802.1X authenticator entry (`/interface dot1x server print detail`). Accepts either the RouterOS `.id` (e.g. `*1`, from `list_dot1x_servers`) or the interface name (e.g. `ether2`) as `server_id`; tries `.id` lookup first, then falls back to interface-name lookup. For a summary list of all entries use `list_dot1x_servers`. Returns the detailed entry or a not-found message if no match exists.

| Parameter   | Required | Definition                                                           |
| ----------- | -------- | -------------------------------------------------------------------- |
| `server_id` | Yes      | Interface name (e.g. 'ether2') or RouterOS '.id' `{"type":"string"}` |

## update_dot1x_server

**Update 802.1X Server (Authenticator) Entry** · Risk: **write-idempotent**

Modifies an existing 802.1X authenticator entry (`/interface dot1x server set`) identified by interface name or RouterOS `.id`. Pass `server_id` as a `.id` string (starts with `*`, e.g. `*1` — obtain from `list_dot1x_servers`) or as the interface name (e.g. `ether2`). Omit any optional field to leave it unchanged; pass `comment=""` to clear the comment. For creating a new entry use `add_dot1x_server`; for deletion use `remove_dot1x_server`. Returns the updated entry's full detail after the change.

| Parameter             | Required | Definition                                                                    |
| --------------------- | -------- | ----------------------------------------------------------------------------- |
| `server_id`           | Yes      | Interface name or RouterOS '.id' `{"type":"string"}`                          |
| `auth_types`          | No       | `{"type":"string","enum":["dot1x","mac-auth","dot1x,mac-auth"]}`              |
| `accounting`          | No       | `{"type":"boolean"}`                                                          |
| `interim_update`      | No       | `{"type":"string"}`                                                           |
| `mac_auth_mode`       | No       | `{"type":"string","enum":["mac-as-username","mac-as-username-and-password"]}` |
| `guest_vlan_id`       | No       | `{"type":"string"}`                                                           |
| `reject_vlan_id`      | No       | `{"type":"string"}`                                                           |
| `server_fail_vlan_id` | No       | `{"type":"string"}`                                                           |
| `reauth_timeout`      | No       | `{"type":"string"}`                                                           |
| `reauth_period`       | No       | RouterOS 7.25+ re-authentication period `{"type":"string"}`                   |
| `comment`             | No       | `{"type":"string"}`                                                           |
| `disabled`            | No       | `{"type":"boolean"}`                                                          |

## remove_dot1x_server

**Remove 802.1X Server (Authenticator) Entry** · Risk: **destructive**

Permanently removes an 802.1X authenticator entry (`/interface dot1x server remove`) identified by interface name or RouterOS `.id`. Pass `server_id` as a `.id` string (starts with `*`, e.g. `*1` — obtain from `list_dot1x_servers`) or as the interface name (e.g. `ether2`). Verifies the entry exists via a `count-only` check before deletion — returns a not-found message if absent. For creating an entry use `add_dot1x_server`; for non-destructive disabling use `update_dot1x_server` with `disabled=true`.

| Parameter   | Required | Definition                                           |
| ----------- | -------- | ---------------------------------------------------- |
| `server_id` | Yes      | Interface name or RouterOS '.id' `{"type":"string"}` |
