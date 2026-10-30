---
title: "Users"
description: "Users, groups, active sessions and SSH keys (`/user`)."
---

## Tools

- [Add Local User Account](#add_user)
- [List Local User Accounts](#list_users)
- [Get Local User Account Details](#get_user)
- [Update Local User Account](#update_user)
- [Remove Local User Account](#remove_user)
- [Disable Local User Account](#disable_user)
- [Enable Local User Account](#enable_user)
- [Add User Group](#add_user_group)
- [List User Groups](#list_user_groups)
- [Get User Group Details](#get_user_group)
- [Update User Group](#update_user_group)
- [Remove User Group](#remove_user_group)
- [List Active User Sessions](#get_active_users)
- [Disconnect Active User Session](#disconnect_user)
- [Export User Configuration to File](#export_user_config)
- [Import SSH Public Key for User](#set_user_ssh_keys)
- [List User SSH Keys](#list_user_ssh_keys)
- [Remove User SSH Key](#remove_user_ssh_key)

## add_user

**Add Local User Account** · Risk: **write**

Create a local user account (`/user add`) — grants interactive access to the router via SSH, Winbox, web, telnet, or API. The `group` parameter (default: `read`) sets permissions; built-in groups are `read`, `write`, `full`; use `add_user_group` to create custom groups. Use `address` to restrict login to a specific IP/subnet. For PPP/dial-in credentials use `create_ppp_secret` instead. Returns the created account's full detail including its `.id`.

| Parameter  | Required | Definition                           |
| ---------- | -------- | ------------------------------------ |
| `name`     | Yes      | `{"type":"string"}`                  |
| `password` | Yes      | `{"type":"string"}`                  |
| `group`    | Yes      | `{"default":"read","type":"string"}` |
| `address`  | No       | `{"type":"string"}`                  |
| `comment`  | No       | `{"type":"string"}`                  |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}` |

## list_users

**List Local User Accounts** · Risk: **read**

List local router user accounts (`/user print`) — shows each account's group, address restriction, and enabled/disabled state. Supports optional filters: `name_filter` (name substring match), `group_filter` (exact group name), `disabled_only`. Note: `active_only` is accepted by the schema but is not applied as a filter — it has no effect on the output. Passwords are redacted from output. For currently logged-in sessions use `get_active_users`. For PPP dial-in secrets use `create_ppp_secret`.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `group_filter`  | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |
| `active_only`   | Yes      | `{"default":false,"type":"boolean"}` |

## get_user

**Get Local User Account Details** · Risk: **read**

Fetch full detail for a single local user account (`/user print detail where name=...`). Identified by login `name`. Passwords are redacted from output. For all accounts use `list_users`; for currently active sessions use `get_active_users`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_user

**Update Local User Account** · Risk: **write-idempotent**

Modify a local user account (`/user set [find name=...]`). Can change login name (`new_name`), `password`, `group`, allowed source `address` (pass empty string to remove address restriction), `comment`, or `disabled` state. For toggling enabled/disabled state only, prefer `enable_user` or `disable_user`. Returns the updated user detail with passwords redacted.

| Parameter  | Required | Definition           |
| ---------- | -------- | -------------------- |
| `name`     | Yes      | `{"type":"string"}`  |
| `new_name` | No       | `{"type":"string"}`  |
| `password` | No       | `{"type":"string"}`  |
| `group`    | No       | `{"type":"string"}`  |
| `address`  | No       | `{"type":"string"}`  |
| `comment`  | No       | `{"type":"string"}`  |
| `disabled` | No       | `{"type":"boolean"}` |

## remove_user

**Remove Local User Account** · Risk: **destructive**

Permanently delete a local user account (`/user remove [find name=...]`). Refuses to remove the built-in `admin` account. Verifies the user exists before removing. To temporarily block access without deleting use `disable_user`. To end a live session without deleting the account use `disconnect_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_user

**Disable Local User Account** · Risk: **write-idempotent**

Disable a local user account (`/user set [find name=...] disabled=yes`), preventing new logins without deleting the account. To re-enable use `enable_user`. For a full attribute update use `update_user`. To permanently delete the account use `remove_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_user

**Enable Local User Account** · Risk: **write-idempotent**

Re-enable a previously disabled local user account (`/user set [find name=...] disabled=no`). To disable use `disable_user`. For a full attribute update use `update_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_user_group

**Add User Group** · Risk: **write**

Create a custom user group (`/user group add`) that defines a named permission policy for router access. `policy` is a list of permissions to grant from: local, telnet, ssh, ftp, reboot, read, write, policy, test, winbox, password, web, sniff, sensitive, api, romon, dude, tikapp, rest-api. The built-in groups (`read`, `write`, `full`) already exist on the device; this tool does not guard against those names — attempting to create a group with a duplicate name will be rejected by the device. Assign users to the new group via `add_user` or `update_user`. Returns the created group's full detail.

| Parameter | Required | Definition                                   |
| --------- | -------- | -------------------------------------------- |
| `name`    | Yes      | `{"type":"string"}`                          |
| `policy`  | Yes      | `{"type":"array","items":{"type":"string"}}` |
| `skin`    | No       | `{"type":"string"}`                          |
| `comment` | No       | `{"type":"string"}`                          |

## list_user_groups

**List User Groups** · Risk: **read**

List all user groups (`/user group print`), including built-in groups (`read`, `write`, `full`) and custom ones, showing their policy sets. Supports optional filters: `name_filter` (name substring), `policy_filter` (policy substring). To see individual user accounts use `list_users`; to see which users belong to a specific group use `list_users` with `group_filter`.

| Parameter       | Required | Definition          |
| --------------- | -------- | ------------------- |
| `name_filter`   | No       | `{"type":"string"}` |
| `policy_filter` | No       | `{"type":"string"}` |

## get_user_group

**Get User Group Details** · Risk: **read**

Fetch full detail for a single user group (`/user group print detail where name=...`), showing its complete policy list and skin setting. For all groups use `list_user_groups`. To see which users belong to this group use `list_users` with `group_filter`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_user_group

**Update User Group** · Risk: **write-idempotent**

Modify a custom user group (`/user group set [find name=...]`). Can change group name (`new_name`), `policy` list, `skin`, or `comment`. Refuses to modify built-in groups (`read`, `write`, `full`). Valid policies: local, telnet, ssh, ftp, reboot, read, write, policy, test, winbox, password, web, sniff, sensitive, api, romon, dude, tikapp, rest-api. Returns the updated group detail.

| Parameter  | Required | Definition                                   |
| ---------- | -------- | -------------------------------------------- |
| `name`     | Yes      | `{"type":"string"}`                          |
| `new_name` | No       | `{"type":"string"}`                          |
| `policy`   | No       | `{"type":"array","items":{"type":"string"}}` |
| `skin`     | No       | `{"type":"string"}`                          |
| `comment`  | No       | `{"type":"string"}`                          |

## remove_user_group

**Remove User Group** · Risk: **destructive**

Delete a custom user group (`/user group remove [find name=...]`). Refuses to remove built-in groups (`read`, `write`, `full`). Checks that no users are currently assigned to the group — reassign or remove those users first via `update_user` or `remove_user`. To remove individual user accounts use `remove_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## get_active_users

**List Active User Sessions** · Risk: **read**

List currently logged-in user sessions (`/user active print`), showing who is connected right now via SSH, Winbox, web, telnet, or API, with source address and session start time. For the full account list use `list_users`. To forcibly end a session use `disconnect_user` with the `.id` from this output.

No tool-specific parameters.

## disconnect_user

**Disconnect Active User Session** · Risk: **destructive**

Forcibly terminate an active user session (`/user active remove <user_id>`). `user_id` is the `.id` from `get_active_users`. Does NOT delete the user account — to delete the account use `remove_user`. To prevent future logins without deleting use `disable_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `user_id` | Yes      | `{"type":"string"}` |

## export_user_config

**Export User Configuration to File** · Risk: **read**

Export the router's user accounts and user-group configuration as a RouterOS script (`/user export file=<filename>`). The file is saved on the router's flash storage as `<filename>.rsc`. If `filename` is omitted, defaults to `user_config`. The exported script can be used to restore user accounts on another device.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `filename` | No       | `{"type":"string"}` |

## set_user_ssh_keys

**Import SSH Public Key for User** · Risk: **write**

Import an SSH public key for a user (`/user ssh-keys import user=... public-key-file=...`), enabling key-based SSH authentication in addition to password login. `key_file` must be the path to a public key file already present on the router's filesystem. To list a user's existing keys use `list_user_ssh_keys`; to remove a key use `remove_user_ssh_key`.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `username` | Yes      | `{"type":"string"}` |
| `key_file` | Yes      | `{"type":"string"}` |

## list_user_ssh_keys

**List User SSH Keys** · Risk: **read**

List SSH public keys registered for a specific user (`/user ssh-keys print where user=...`). Returns each key's `.id`, which is required by `remove_user_ssh_key`. To add a key use `set_user_ssh_keys`.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `username` | Yes      | `{"type":"string"}` |

## remove_user_ssh_key

**Remove User SSH Key** · Risk: **destructive**

Delete a specific SSH public key (`/user ssh-keys remove <key_id>`). `key_id` is the `.id` from `list_user_ssh_keys`. Does NOT disable the user's password-based login — to block all logins use `disable_user`; to delete the account use `remove_user`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `key_id`  | Yes      | `{"type":"string"}` |
