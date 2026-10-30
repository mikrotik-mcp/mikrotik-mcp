---
title: "BFD"
description: "Bidirectional Forwarding Detection config + sessions (`/routing bfd`)."
---

## Tools

- [List BFD Configurations](#list_bfd_configurations)
- [Add BFD Configuration](#add_bfd_configuration)
- [Update BFD Configuration](#update_bfd_configuration)
- [Remove BFD Configuration](#remove_bfd_configuration)
- [Enable or Disable BFD Configuration](#set_bfd_configuration_enabled)
- [List BFD Sessions](#list_bfd_sessions)

## list_bfd_configurations

**List BFD Configurations** · Risk: **read**

Lists all BFD timer-profile entries (`/routing bfd configuration`) — each entry binds min-rx/min-tx intervals and a detection multiplier to one or more interfaces in a VRF, controlling how fast BFD detects a link failure so routing protocols (OSPF/BGP) can tear down sessions far faster than their own hold timers. Requires RouterOS v7 with the routing package. To see live BFD neighbor state use `list_bfd_sessions`. Returns all configuration entries with full detail.

No tool-specific parameters.

## add_bfd_configuration

**Add BFD Configuration** · Risk: **write**

Creates a BFD timer-profile entry (`/routing bfd configuration add`) that binds sub-second failure-detection parameters to an interface or interface-list in a VRF. `interfaces` names the interface or interface-list where BFD runs; `min_rx`/`min_tx` set the desired minimum receive/transmit intervals (e.g. "200ms"); `multiplier` sets how many missed packets declare a session down (detection time ≈ interval × multiplier). To view existing configurations use `list_bfd_configurations`; to see live session state use `list_bfd_sessions`. Returns the new entry's `.id`.

| Parameter    | Required | Definition                                                                                               |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `interfaces` | Yes      | Interface or interface-list name BFD runs on `{"type":"string"}`                                         |
| `vrf`        | No       | VRF (default 'main') `{"type":"string"}`                                                                 |
| `min_rx`     | No       | Desired min RX interval, e.g. "200ms" `{"type":"string"}`                                                |
| `min_tx`     | No       | Desired min TX interval, e.g. "200ms" `{"type":"string"}`                                                |
| `multiplier` | No       | Detection multiplier, e.g. 5 `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `forbid_bfd` | No       | Forbid BFD on the matched interfaces `{"type":"boolean"}`                                                |
| `comment`    | No       | `{"type":"string"}`                                                                                      |
| `disabled`   | Yes      | `{"default":false,"type":"boolean"}`                                                                     |

## update_bfd_configuration

**Update BFD Configuration** · Risk: **write-idempotent**

Updates an existing BFD timer-profile entry (`/routing bfd configuration set`) by its `.id` (obtain from `list_bfd_configurations`). Adjusts `interfaces`, `vrf`, `min_rx`/`min_tx` intervals (e.g. "200ms"), `multiplier`, `comment`, or `disabled` state. To toggle enabled state only use `set_bfd_configuration_enabled`. Returns the updated entry's full detail.

| Parameter    | Required | Definition                                                                  |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `config_id`  | Yes      | Configuration id, e.g. "*1" `{"type":"string"}`                             |
| `interfaces` | No       | `{"type":"string"}`                                                         |
| `vrf`        | No       | `{"type":"string"}`                                                         |
| `min_rx`     | No       | `{"type":"string"}`                                                         |
| `min_tx`     | No       | `{"type":"string"}`                                                         |
| `multiplier` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `forbid_bfd` | No       | `{"type":"boolean"}`                                                        |
| `comment`    | No       | `{"type":"string"}`                                                         |
| `disabled`   | No       | `{"type":"boolean"}`                                                        |

## remove_bfd_configuration

**Remove BFD Configuration** · Risk: **destructive**

Permanently removes a BFD timer-profile entry (`/routing bfd configuration remove`) by its `.id` (obtain from `list_bfd_configurations`). Any BFD sessions driven by this configuration will stop. To suspend BFD without deleting the configuration use `set_bfd_configuration_enabled`.

| Parameter   | Required | Definition                                      |
| ----------- | -------- | ----------------------------------------------- |
| `config_id` | Yes      | Configuration id, e.g. "*1" `{"type":"string"}` |

## set_bfd_configuration_enabled

**Enable or Disable BFD Configuration** · Risk: **write-idempotent**

Enables or disables a BFD configuration entry (`/routing bfd configuration set ... disabled=yes/no`) by its `.id` (obtain from `list_bfd_configurations`). Use this to suspend BFD on specific interfaces without removing the configuration. To change timer parameters use `update_bfd_configuration`; to delete the entry permanently use `remove_bfd_configuration`.

| Parameter   | Required | Definition                                      |
| ----------- | -------- | ----------------------------------------------- |
| `config_id` | Yes      | Configuration id, e.g. "*1" `{"type":"string"}` |
| `enabled`   | Yes      | `{"type":"boolean"}`                            |

## list_bfd_sessions

**List BFD Sessions** · Risk: **read**

Lists live BFD neighbor sessions (`/routing bfd session print detail`) — shows each peer's state (up/down), local/remote discriminators, and negotiated rx/tx intervals. Read-only runtime state; use it to verify BFD is actually up before relying on fast failover for OSPF/BGP. Filter to only up sessions with `up_only=true`. To manage the timer-profile entries that drive these sessions use `list_bfd_configurations`.

| Parameter | Required | Definition                                                           |
| --------- | -------- | -------------------------------------------------------------------- |
| `up_only` | Yes      | Show only sessions currently up `{"default":false,"type":"boolean"}` |
