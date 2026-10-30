---
title: "Routing Rules"
description: "Policy routing rules selecting a table by src/dst/interface/mark (`/routing rule`)."
---

## Tools

- [List Policy Routing Rules](#list_routing_rules)
- [Get Policy Routing Rule](#get_routing_rule)
- [Add Policy Routing Rule](#add_routing_rule)
- [Update Policy Routing Rule](#update_routing_rule)
- [Remove Policy Routing Rule](#remove_routing_rule)
- [Enable or Disable Policy Routing Rule](#set_routing_rule_enabled)

## list_routing_rules

**List Policy Routing Rules** · Risk: **read**

List policy routing rules (`/routing rule`) — the ordered table that steers packets into specific routing tables based on src/dst prefix, incoming interface, or routing-mark. Rules are evaluated top-down; requires RouterOS v7 with the routing package. For static routes in the main table use `list_routes`; for IPv6 static routes use `list_ipv6_routes`. Returns all matching rules with full detail, including `.id` values needed by `get_routing_rule`, `update_routing_rule`, `remove_routing_rule`, and `set_routing_rule_enabled`.

| Parameter       | Required | Definition                                           |
| --------------- | -------- | ---------------------------------------------------- |
| `table_filter`  | No       | Match rules targeting this table `{"type":"string"}` |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}`                 |

## get_routing_rule

**Get Policy Routing Rule** · Risk: **read**

Fetch full detail for a single policy routing rule (`/routing rule`) by its `.id` (obtain the `.id` from `list_routing_rules`). Requires RouterOS v7 with the routing package. For static route details use `get_route`. Returns the rule's complete property set, or a not-found message if the id does not exist.

| Parameter | Required | Definition                                              |
| --------- | -------- | ------------------------------------------------------- |
| `rule_id` | Yes      | Rule id from list output, e.g. "*3" `{"type":"string"}` |

## add_routing_rule

**Add Policy Routing Rule** · Risk: **write**

Add a policy routing rule (`/routing rule add`) to steer matched packets into a specific routing table. Rules are evaluated top-down: `action=lookup` consults `table` then falls through to lower-priority tables on no match; `lookup-only-in-table` stops at that table; `drop`/`unreachable` discard the packet. Match on `src_address` (e.g. `"192.168.10.0/24"`), `dst_address`, `routing_mark`, or incoming `interface`. Use `place_before` with a rule `.id` to control insertion order. Requires RouterOS v7 with the routing package. For static routes in the main or a named table use `add_route`; for IPv6 static routes use `add_ipv6_route`. Returns the new rule's `.id`.

| Parameter      | Required | Definition                                                                                           |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `action`       | Yes      | `{"default":"lookup","type":"string","enum":["lookup","lookup-only-in-table","drop","unreachable"]}` |
| `table`        | No       | Target routing table for lookup actions `{"type":"string"}`                                          |
| `src_address`  | No       | Source prefix, e.g. "192.168.10.0/24" `{"type":"string"}`                                            |
| `dst_address`  | No       | Destination prefix `{"type":"string"}`                                                               |
| `routing_mark` | No       | Match packets carrying this routing-mark `{"type":"string"}`                                         |
| `interface`    | No       | Match this incoming interface `{"type":"string"}`                                                    |
| `min_prefix`   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                          |
| `comment`      | No       | `{"type":"string"}`                                                                                  |
| `disabled`     | Yes      | `{"default":false,"type":"boolean"}`                                                                 |
| `place_before` | No       | Insert before this rule id to control ordering `{"type":"string"}`                                   |

## update_routing_rule

**Update Policy Routing Rule** · Risk: **write-idempotent**

Modify an existing policy routing rule (`/routing rule set`) by its `.id` (obtain from `list_routing_rules`). Pass `""` for `src_address`, `dst_address`, `routing_mark`, `interface`, or `table` to clear that field. Requires RouterOS v7 with the routing package. For updating static routes use `update_route`. Returns the rule's updated detail after applying changes.

| Parameter      | Required | Definition                                                                        |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `rule_id`      | Yes      | Rule id, e.g. "*3" `{"type":"string"}`                                            |
| `action`       | No       | `{"type":"string","enum":["lookup","lookup-only-in-table","drop","unreachable"]}` |
| `table`        | No       | `{"type":"string"}`                                                               |
| `src_address`  | No       | `{"type":"string"}`                                                               |
| `dst_address`  | No       | `{"type":"string"}`                                                               |
| `routing_mark` | No       | `{"type":"string"}`                                                               |
| `interface`    | No       | `{"type":"string"}`                                                               |
| `min_prefix`   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`       |
| `comment`      | No       | `{"type":"string"}`                                                               |
| `disabled`     | No       | `{"type":"boolean"}`                                                              |

## remove_routing_rule

**Remove Policy Routing Rule** · Risk: **destructive**

Delete a policy routing rule (`/routing rule remove`) by its `.id` (obtain from `list_routing_rules`). This is irreversible — confirm the correct rule with `get_routing_rule` before removing. Requires RouterOS v7 with the routing package. For removing static routes use `remove_route`. Returns a confirmation message on success.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `rule_id` | Yes      | Rule id, e.g. "*3" `{"type":"string"}` |

## set_routing_rule_enabled

**Enable or Disable Policy Routing Rule** · Risk: **write-idempotent**

Enable or disable a policy routing rule (`/routing rule set disabled=yes/no`) by its `.id` (obtain from `list_routing_rules`). Set `enabled=true` to activate or `enabled=false` to temporarily suspend the rule without deleting it. Requires RouterOS v7 with the routing package. To permanently delete a rule use `remove_routing_rule`. Returns a confirmation of the new enabled/disabled state.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `rule_id` | Yes      | Rule id, e.g. "*3" `{"type":"string"}`                |
| `enabled` | Yes      | true to enable, false to disable `{"type":"boolean"}` |
