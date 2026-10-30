---
title: "User Manager"
description: "Built-in RADIUS server: users, profiles, routers (NAS), limitations, sessions (`/user-manager`)."
---

## Tools

- [Get User Manager Global Settings](#get_user_manager_settings)
- [Set User Manager Global Settings](#set_user_manager_settings)
- [Add User Manager RADIUS User](#add_user_manager_user)
- [List User Manager RADIUS Users](#list_user_manager_users)
- [Get User Manager RADIUS User Detail](#get_user_manager_user)
- [Update User Manager RADIUS User](#update_user_manager_user)
- [Remove User Manager RADIUS User](#remove_user_manager_user)
- [Add User Manager Service Profile](#add_user_manager_profile)
- [List User Manager Service Profiles](#list_user_manager_profiles)
- [Remove User Manager Service Profile](#remove_user_manager_profile)
- [Assign Service Profile to User Manager User](#assign_user_manager_profile)
- [List User Manager User-Profile Assignments](#list_user_manager_user_profiles)
- [Add User Manager RADIUS Client (Router/NAS)](#add_user_manager_router)
- [List User Manager RADIUS Clients (Routers/NAS)](#list_user_manager_routers)
- [Remove User Manager RADIUS Client (Router/NAS)](#remove_user_manager_router)
- [Add User Manager Limitation Template](#add_user_manager_limitation)
- [List User Manager Limitation Templates](#list_user_manager_limitations)
- [Remove User Manager Limitation Template](#remove_user_manager_limitation)
- [List User Manager Accounting Sessions](#list_user_manager_sessions)

## get_user_manager_settings

**Get User Manager Global Settings** · Risk: **read**

Reads the global User Manager daemon configuration (`/user-manager print`) — the top-level `enabled` flag, TLS certificate, and whether the profile/payment subsystem is active (`use-profiles`). Use this to inspect whether the built-in RADIUS server is running before calling any other user-manager tools. Returns the current settings block, or a NOT_AVAILABLE message if the user-manager package is not installed on the device.

No tool-specific parameters.

## set_user_manager_settings

**Set User Manager Global Settings** · Risk: **write-idempotent**

Updates the global User Manager daemon configuration (`/user-manager set`) — toggle the built-in RADIUS server on/off (`enabled`), set the TLS certificate, or enable the profile/payment subsystem (`use_profiles`). Applies changes idempotently to the single global settings entry; returns the full updated settings after applying. For per-user changes use update_user_manager_user; for profile creation use add_user_manager_profile.

| Parameter             | Required | Definition                                                                                                     |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled`             | No       | Enable or disable the User Manager server `{"type":"boolean"}`                                                 |
| `certificate`         | No       | TLS certificate name for RADIUS over TLS `{"type":"string"}`                                                   |
| `radsec_certificate`  | No       | Certificate name for RadSec (RADIUS over TLS) `{"type":"string"}`                                              |
| `accounting_port`     | No       | UDP port for RADIUS accounting `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`     |
| `authentication_port` | No       | UDP port for RADIUS authentication `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_profiles`        | No       | Enable the profile/payment subsystem `{"type":"boolean"}`                                                      |

## add_user_manager_user

**Add User Manager RADIUS User** · Risk: **write**

Creates a new user in the User Manager RADIUS database (`/user-manager user add`) — for hotspot, PPP, or 802.1X authentication managed by the built-in RADIUS server. Not for local router login accounts; for those use add_user. Supply `name` and `password`; optionally set `group`, `shared_users` (max simultaneous sessions), and custom RADIUS `attributes`. Returns the created user's detail with secrets redacted.

| Parameter      | Required | Definition                                                                                            |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `name`         | Yes      | Login name for the user `{"type":"string"}`                                                           |
| `password`     | Yes      | Login password for the user `{"type":"string"}`                                                       |
| `group`        | No       | `{"type":"string"}`                                                                                   |
| `shared_users` | No       | Max simultaneous sessions `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `attributes`   | No       | Custom RADIUS attributes `{"type":"string"}`                                                          |
| `caller_id`    | No       | Caller ID the user is restricted to (e.g. MAC) `{"type":"string"}`                                    |
| `otp_secret`   | No       | Base32 OTP shared secret for two-factor auth `{"type":"string"}`                                      |
| `comment`      | No       | `{"type":"string"}`                                                                                   |
| `disabled`     | Yes      | `{"default":false,"type":"boolean"}`                                                                  |

## list_user_manager_users

**List User Manager RADIUS Users** · Risk: **read**

Returns all users in the User Manager RADIUS database (`/user-manager user print`) — the accounts that authenticate against the built-in RADIUS server for hotspot, PPP, or 802.1X. Optionally filter by partial `name_filter`. Not for local router login accounts; for those use list_users. Returns user list with secrets redacted; for full single-user detail use get_user_manager_user.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_user_manager_user

**Get User Manager RADIUS User Detail** · Risk: **read**

Returns full detail for a single User Manager RADIUS user (`/user-manager user print detail where name=`) — all fields including group, shared-users limit, RADIUS attributes, and status, with secrets redacted. Use when you need the complete record for one user by exact name. To browse all users use list_user_manager_users; to modify the record use update_user_manager_user.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_user_manager_user

**Update User Manager RADIUS User** · Risk: **write-idempotent**

Modifies an existing User Manager RADIUS user (`/user-manager user set [find name=...]`) — change name, password, group, shared-users limit, RADIUS attributes, comment, or enabled/disabled state. Locate the user by its current `name` (from list_user_manager_users or get_user_manager_user). Returns the updated record with secrets redacted. To permanently delete the user use remove_user_manager_user.

| Parameter      | Required | Definition                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `name`         | Yes      | Current name of the user to update `{"type":"string"}`                      |
| `new_name`     | No       | `{"type":"string"}`                                                         |
| `password`     | No       | `{"type":"string"}`                                                         |
| `group`        | No       | `{"type":"string"}`                                                         |
| `shared_users` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `attributes`   | No       | `{"type":"string"}`                                                         |
| `caller_id`    | No       | Caller ID the user is restricted to (e.g. MAC) `{"type":"string"}`          |
| `otp_secret`   | No       | Base32 OTP shared secret for two-factor auth `{"type":"string"}`            |
| `comment`      | No       | `{"type":"string"}`                                                         |
| `disabled`     | No       | `{"type":"boolean"}`                                                        |

## remove_user_manager_user

**Remove User Manager RADIUS User** · Risk: **destructive**

Permanently deletes a User Manager RADIUS user (`/user-manager user remove [find name=...]`) — verifies the user exists via count-only check first, then removes them. Does NOT automatically remove the user's profile assignments; check list_user_manager_user_profiles first. To disable without deleting use update_user_manager_user with `disabled=true`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_user_manager_profile

**Add User Manager Service Profile** · Risk: **write**

Creates a new User Manager service/billing profile (`/user-manager profile add`) — a named plan template that defines validity period (e.g. '30d'), price, and session override limits (`starts_when`, `override_shared_users`) that can be assigned to users. Profiles are templates only; to link a profile to a specific user use assign_user_manager_profile. For rate/quota constraints attach a limitation (add_user_manager_limitation). Returns the created profile's detail.

| Parameter               | Required | Definition                                           |
| ----------------------- | -------- | ---------------------------------------------------- |
| `name`                  | Yes      | Profile name `{"type":"string"}`                     |
| `name_for_users`        | No       | Display name shown to users `{"type":"string"}`      |
| `validity`              | No       | Validity period, e.g. '30d' `{"type":"string"}`      |
| `price`                 | No       | `{"type":"number"}`                                  |
| `starts_when`           | No       | `{"type":"string","enum":["assigned","first-auth"]}` |
| `override_shared_users` | No       | `{"type":"string"}`                                  |
| `comment`               | No       | `{"type":"string"}`                                  |

## list_user_manager_profiles

**List User Manager Service Profiles** · Risk: **read**

Returns all User Manager service/billing profile templates (`/user-manager profile print`) — the named plans defining validity, price, and session limits. Optionally filter by partial `name_filter`. Not the same as user-profile assignments; to see which profiles are linked to which users use list_user_manager_user_profiles. Returns profile list.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## remove_user_manager_profile

**Remove User Manager Service Profile** · Risk: **destructive**

Permanently deletes a User Manager service/billing profile (`/user-manager profile remove [find name=...]`) — verifies existence via count-only check first, then removes the plan template. Does NOT automatically remove existing user-profile assignments that reference this profile; check list_user_manager_user_profiles before removing to avoid orphaned assignments. For creating a profile use add_user_manager_profile.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## assign_user_manager_profile

**Assign Service Profile to User Manager User** · Risk: **write**

Creates a user-profile assignment in User Manager (`/user-manager user-profile add`) — links an existing service profile plan to a specific user so the user inherits the plan's limits (rate, transfer, validity). Both `user` and `profile` must already exist; to create a user use add_user_manager_user; to create a profile use add_user_manager_profile. To view existing assignments use list_user_manager_user_profiles.

| Parameter | Required | Definition                                        |
| --------- | -------- | ------------------------------------------------- |
| `user`    | Yes      | User to assign the profile to `{"type":"string"}` |
| `profile` | Yes      | Profile to assign `{"type":"string"}`             |

## list_user_manager_user_profiles

**List User Manager User-Profile Assignments** · Risk: **read**

Returns all User Manager user-to-profile assignment records (`/user-manager user-profile print`) — shows which service profile plan is linked to each user. Optionally filter by partial `user_filter`. Not the same as listing profile definitions; for the plan templates themselves use list_user_manager_profiles. To create an assignment use assign_user_manager_profile.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `user_filter` | No       | Partial user match `{"type":"string"}` |

## add_user_manager_router

**Add User Manager RADIUS Client (Router/NAS)** · Risk: **write**

Registers a new RADIUS client (router or NAS device) in User Manager (`/user-manager router add`) — the network device that forwards authentication requests to this built-in RADIUS server. Requires a friendly `name`, the client's IP `address`, and a `shared_secret`; optionally set the CoA port. Not related to IP routing; for routing table entries use add_route. Returns the created entry with secrets redacted.

| Parameter       | Required | Definition                                                                                               |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | Friendly name for the RADIUS client `{"type":"string"}`                                                  |
| `address`       | Yes      | IP address of the RADIUS client `{"type":"string"}`                                                      |
| `shared_secret` | Yes      | Shared secret for the RADIUS client `{"type":"string"}`                                                  |
| `coa_port`      | No       | Change-of-Authorization port `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `protocol`      | No       | RADIUS transport protocol for this client (e.g. radius, radsec) `{"type":"string"}`                      |
| `comment`       | No       | `{"type":"string"}`                                                                                      |
| `disabled`      | Yes      | `{"default":false,"type":"boolean"}`                                                                     |

## list_user_manager_routers

**List User Manager RADIUS Clients (Routers/NAS)** · Risk: **read**

Returns all RADIUS clients (routers/NAS devices) registered in User Manager (`/user-manager router print`) — the devices authorized to forward authentication requests to this built-in RADIUS server. Optionally filter by partial `name_filter`. Not related to IP routing; for routing table entries use list_routes. Returns entries with secrets redacted.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## remove_user_manager_router

**Remove User Manager RADIUS Client (Router/NAS)** · Risk: **destructive**

Permanently removes a RADIUS client (router/NAS) from User Manager (`/user-manager router remove [find name=...]`) — verifies existence via count-only check first, then deletes the entry. The device will no longer be able to forward authentication requests to this RADIUS server after removal. Not related to IP routing; for routing table management use remove_route.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_user_manager_limitation

**Add User Manager Limitation Template** · Risk: **write**

Creates a new User Manager limitation template (`/user-manager limitation add`) — a reusable named set of rate and quota constraints: download rate (`rate_limit_rx`, e.g. '10M'), upload rate (`rate_limit_tx`), total transfer cap (`transfer_limit`, e.g. '10G'), and uptime cap (`uptime_limit`, e.g. '1d'). Limitations are templates attached to profiles, not users directly; for service plan templates use add_user_manager_profile. Returns the created limitation's detail.

| Parameter                       | Required | Definition                                                                                       |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`                          | Yes      | Limitation name `{"type":"string"}`                                                              |
| `rate_limit_rx`                 | No       | Download rate limit, e.g. '10M' `{"type":"string"}`                                              |
| `rate_limit_tx`                 | No       | Upload rate limit, e.g. '10M' `{"type":"string"}`                                                |
| `rate_limit_min_rx`             | No       | Guaranteed (CIR) download rate, e.g. '2M' `{"type":"string"}`                                    |
| `rate_limit_min_tx`             | No       | Guaranteed (CIR) upload rate, e.g. '2M' `{"type":"string"}`                                      |
| `rate_limit_burst_rx`           | No       | Download burst rate, e.g. '20M' `{"type":"string"}`                                              |
| `rate_limit_burst_tx`           | No       | Upload burst rate, e.g. '20M' `{"type":"string"}`                                                |
| `rate_limit_burst_threshold_rx` | No       | Download burst threshold rate `{"type":"string"}`                                                |
| `rate_limit_burst_threshold_tx` | No       | Upload burst threshold rate `{"type":"string"}`                                                  |
| `rate_limit_burst_time_rx`      | No       | Download burst time, e.g. '10s' `{"type":"string"}`                                              |
| `rate_limit_burst_time_tx`      | No       | Upload burst time, e.g. '10s' `{"type":"string"}`                                                |
| `rate_limit_priority`           | No       | Queue priority (1-8) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `download_limit`                | No       | Download transfer cap in bytes, e.g. '5G' `{"type":"string"}`                                    |
| `upload_limit`                  | No       | Upload transfer cap in bytes, e.g. '5G' `{"type":"string"}`                                      |
| `transfer_limit`                | No       | Total transfer cap, e.g. '10G' `{"type":"string"}`                                               |
| `uptime_limit`                  | No       | Uptime cap, e.g. '1d' `{"type":"string"}`                                                        |
| `reset_counters_interval`       | No       | Interval to auto-reset usage counters `{"type":"string"}`                                        |
| `reset_counters_start_time`     | No       | Start time for counter reset interval `{"type":"string"}`                                        |
| `comment`                       | No       | `{"type":"string"}`                                                                              |

## list_user_manager_limitations

**List User Manager Limitation Templates** · Risk: **read**

Returns all User Manager limitation templates (`/user-manager limitation print`) — the named rate/quota constraint definitions (rate-limit-rx/tx, transfer-limit, uptime-limit) that can be attached to service profiles. Optionally filter by partial `name_filter`. Limitations are distinct from profile plan templates; for those use list_user_manager_profiles.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## remove_user_manager_limitation

**Remove User Manager Limitation Template** · Risk: **destructive**

Permanently deletes a User Manager limitation template (`/user-manager limitation remove [find name=...]`) — verifies existence via count-only check first, then removes the constraint definition. Does NOT check whether the limitation is still referenced by any profiles; verify with list_user_manager_profiles before removing to avoid orphaned references. For listing limitations use list_user_manager_limitations.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## list_user_manager_sessions

**List User Manager Accounting Sessions** · Risk: **read**

Returns User Manager RADIUS accounting session records (`/user-manager session print`) — the log of authentication and accounting events for users connecting through registered RADIUS clients. Optionally filter by partial `user_filter` or restrict to currently active sessions with `active_only=true`. Returns session data including bytes transferred, uptime, and status. For the user accounts themselves use list_user_manager_users; for registered RADIUS clients use list_user_manager_routers.

| Parameter     | Required | Definition                                                               |
| ------------- | -------- | ------------------------------------------------------------------------ |
| `user_filter` | No       | Partial user match `{"type":"string"}`                                   |
| `active_only` | Yes      | Only show currently active sessions `{"default":false,"type":"boolean"}` |
