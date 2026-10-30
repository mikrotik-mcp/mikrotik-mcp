---
title: "Routing Filters"
description: "Route filter rules, select-rules and num-lists (`/routing filter`)."
---

## Tools

- [List Routing Filter Rules](#list_routing_filter_rules)
- [Add Routing Filter Rule](#add_routing_filter_rule)
- [Update Routing Filter Rule](#update_routing_filter_rule)
- [Remove Routing Filter Rule](#remove_routing_filter_rule)
- [Enable or Disable Routing Filter Rule](#set_routing_filter_rule_enabled)
- [List Routing Filter Select-Rules](#list_routing_filter_select_rules)
- [List Routing Filter Num-Lists](#list_routing_filter_num_lists)
- [Add Routing Filter Num-List Entry](#add_routing_filter_num_list)
- [Remove Routing Filter Num-List Entry](#remove_routing_filter_num_list)

## list_routing_filter_rules

**List Routing Filter Rules** · Risk: **read**

Lists routing filter rules (`/routing filter rule`) — the script-expression match/action chains used as BGP/OSPF input and output filters on RouterOS v7. Each rule belongs to a named chain (e.g. `bgp-in`) and is written as a script-like expression such as `if (dst in 10.0.0.0/8) { set distance 30; accept }`. Returns all rules with their chain, expression, comment, and enabled state; narrow by chain with `chain_filter`. For structured chain-dispatch (select-rule) entries use list_routing_filter_select_rules; for IPv4 packet firewall rules use list_filter_rules; for routing policy rules use list_routing_rules.

| Parameter      | Required | Definition                                        |
| -------------- | -------- | ------------------------------------------------- |
| `chain_filter` | No       | Show only rules in this chain `{"type":"string"}` |

## add_routing_filter_rule

**Add Routing Filter Rule** · Risk: **write**

Adds a routing filter rule to a named chain (`/routing filter rule add`) — defines the match/action script expressions that BGP/OSPF consult as input/output filters on RouterOS v7. `rule` is the full script expression, e.g. `"if (dst-len <= 24) { accept } else { reject }"`. Specifying a new `chain` name implicitly creates that chain; reference it from a BGP/OSPF filter setting. `place_before` takes a `.id` from list_routing_filter_rules to control insertion order. Returns the new rule's `.id` on success. For structured chain-dispatch rules use list_routing_filter_select_rules.

| Parameter      | Required | Definition                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `chain`        | Yes      | Filter chain name, e.g. 'bgp-in' `{"type":"string"}`                                              |
| `rule`         | Yes      | Match/action expression, e.g. "if (dst-len <= 24) { accept } else { reject }" `{"type":"string"}` |
| `comment`      | No       | `{"type":"string"}`                                                                               |
| `disabled`     | Yes      | `{"default":false,"type":"boolean"}`                                                              |
| `place_before` | No       | Insert before this rule id to control ordering `{"type":"string"}`                                |

## update_routing_filter_rule

**Update Routing Filter Rule** · Risk: **write-idempotent**

Updates an existing routing filter rule's chain, script expression, comment, or enabled state (`/routing filter rule set`) on RouterOS v7. `rule_id` takes the `.id` from list_routing_filter_rules (e.g. `"*3"`). Returns the updated rule's full detail. To toggle only enabled/disabled state use set_routing_filter_rule_enabled.

| Parameter  | Required | Definition                             |
| ---------- | -------- | -------------------------------------- |
| `rule_id`  | Yes      | Rule id, e.g. "*3" `{"type":"string"}` |
| `chain`    | No       | `{"type":"string"}`                    |
| `rule`     | No       | `{"type":"string"}`                    |
| `comment`  | No       | `{"type":"string"}`                    |
| `disabled` | No       | `{"type":"boolean"}`                   |

## remove_routing_filter_rule

**Remove Routing Filter Rule** · Risk: **destructive**

Permanently removes a routing filter rule (`/routing filter rule remove`) on RouterOS v7. `rule_id` takes the `.id` from list_routing_filter_rules (e.g. `"*3"`). This is destructive — the rule cannot be recovered. To deactivate without deleting use set_routing_filter_rule_enabled.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `rule_id` | Yes      | Rule id, e.g. "*3" `{"type":"string"}` |

## set_routing_filter_rule_enabled

**Enable or Disable Routing Filter Rule** · Risk: **write-idempotent**

Enables or disables a routing filter rule (`/routing filter rule set disabled=`) on RouterOS v7 without removing it. `rule_id` takes the `.id` from list_routing_filter_rules (e.g. `"*3"`). Set `enabled=true` to activate or `enabled=false` to deactivate. To permanently delete a rule use remove_routing_filter_rule; to modify the rule's chain or expression use update_routing_filter_rule.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `rule_id` | Yes      | Rule id, e.g. "*3" `{"type":"string"}` |
| `enabled` | Yes      | `{"type":"boolean"}`                   |

## list_routing_filter_select_rules

**List Routing Filter Select-Rules** · Risk: **read**

Lists routing filter select-rules (`/routing filter select-rule`) — structured prefix/length matchers that dispatch into a named filter chain on RouterOS v7. Select-rules are the structured front-end to chain dispatch; the chain logic itself (script expressions) is defined via add_routing_filter_rule. Returns all select-rules with their match conditions and target chain. For the script-expression rules inside chains use list_routing_filter_rules.

No tool-specific parameters.

## list_routing_filter_num_lists

**List Routing Filter Num-Lists** · Risk: **read**

Lists routing filter num-lists (`/routing filter num-list`) — named sets of numeric ranges (AS numbers, BGP communities, prefix lengths) that routing filter rules can match against by name on RouterOS v7. Optionally filter to a specific named list with `list_filter`. Returns each entry's list name, range, and comment. To add entries use add_routing_filter_num_list; to view the rules that reference these lists use list_routing_filter_rules.

| Parameter     | Required | Definition                                               |
| ------------- | -------- | -------------------------------------------------------- |
| `list_filter` | No       | Show only entries of this named list `{"type":"string"}` |

## add_routing_filter_num_list

**Add Routing Filter Num-List Entry** · Risk: **write**

Adds a numeric range entry to a named num-list (`/routing filter num-list add`) on RouterOS v7. Num-lists hold AS numbers, BGP communities, or prefix lengths that routing filter rules match by list name. `list` is the target num-list name (created implicitly if new); `range` is a single value or hyphen-separated range (e.g. `"65000-65010"` or `"100"`). Returns the new entry's `.id`. To view existing entries use list_routing_filter_num_lists; to remove an entry use remove_routing_filter_num_list.

| Parameter | Required | Definition                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `list`    | Yes      | Num-list name to add to `{"type":"string"}`                                    |
| `range`   | Yes      | Numeric range or single value, e.g. "65000-65010" or "100" `{"type":"string"}` |
| `comment` | No       | `{"type":"string"}`                                                            |

## remove_routing_filter_num_list

**Remove Routing Filter Num-List Entry** · Risk: **destructive**

Permanently removes a numeric range entry from a num-list (`/routing filter num-list remove`) on RouterOS v7. `entry_id` takes the `.id` from list_routing_filter_num_lists (e.g. `"*3"`). Removing an entry affects any routing filter rule that matches against the parent list by name. To add entries use add_routing_filter_num_list.

| Parameter  | Required | Definition                              |
| ---------- | -------- | --------------------------------------- |
| `entry_id` | Yes      | Entry id, e.g. "*3" `{"type":"string"}` |
