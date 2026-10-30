---
title: "Switch — Rules"
description: "Hardware switch ACL/redirect rules (`/interface ethernet switch rule`)."
---

## Tools

- [Add Switch Chip ACL Rule](#add_switch_rule)
- [List Switch Chip ACL Rules](#list_switch_rules)
- [Get Switch Chip ACL Rule Detail](#get_switch_rule)
- [Update Switch Chip ACL Rule](#update_switch_rule)
- [Remove Switch Chip ACL Rule](#remove_switch_rule)
- [Enable Switch Chip ACL Rule](#enable_switch_rule)
- [Disable Switch Chip ACL Rule](#disable_switch_rule)

## add_switch_rule

**Add Switch Chip ACL Rule** · Risk: **write**

Creates a hardware switch ACL/redirect rule (`/interface ethernet switch rule add`) on the built-in switch chip. Use this to match traffic in hardware at Layer 2/3 on specified source ports and redirect, rate-limit, mirror, or drop it without CPU involvement. This is NOT a software firewall rule — for software packet filtering use create_filter_rule, for address translation use create_nat_rule. Returns the created rule's detail including its `.id`.

Arguments:
switch: the switch chip the rule belongs to, e.g. 'switch1'.
ports: comma-separated source switch ports the rule matches on, e.g. 'ether1,ether2'.
new_dst_ports: redirect matched traffic to these ports (non-empty string; omit to leave unset).
redirect_to_cpu / copy_to_cpu / mirror: divert exclusively, duplicate, or span
matched traffic to CPU.
rate: rate limit in bits/second.
mac_protocol: e.g. 'ip', 'arp', 'vlan', or an EtherType number.

| Parameter           | Required | Definition                                                                            |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `switch`            | Yes      | Owning switch chip, e.g. 'switch1' `{"type":"string"}`                                |
| `ports`             | Yes      | Comma-separated source ports the rule matches `{"type":"string"}`                     |
| `src_address`       | No       | Source IP/mask `{"type":"string"}`                                                    |
| `dst_address`       | No       | Destination IP/mask `{"type":"string"}`                                               |
| `src_address6`      | No       | Source IPv6 address/mask `{"type":"string"}`                                          |
| `dst_address6`      | No       | Destination IPv6 address/mask `{"type":"string"}`                                     |
| `src_mac_address`   | No       | Source MAC/mask `{"type":"string"}`                                                   |
| `dst_mac_address`   | No       | Destination MAC/mask `{"type":"string"}`                                              |
| `src_port`          | No       | Layer-4 source port(s) `{"type":"string"}`                                            |
| `dst_port`          | No       | Layer-4 destination port(s) `{"type":"string"}`                                       |
| `protocol`          | No       | IP protocol, e.g. 'tcp' `{"type":"string"}`                                           |
| `mac_protocol`      | No       | MAC protocol, e.g. 'ip', 'arp', 'vlan' or a number `{"type":"string"}`                |
| `vlan_header`       | No       | Match on VLAN tag presence `{"type":"string","enum":["any","not-present","present"]}` |
| `vlan_id`           | No       | `{"type":"string"}`                                                                   |
| `vlan_priority`     | No       | `{"type":"string"}`                                                                   |
| `dscp`              | No       | `{"type":"string"}`                                                                   |
| `flow_label`        | No       | IPv6 flow label `{"type":"string"}`                                                   |
| `new_dst_ports`     | No       | Redirect target ports; empty string drops the traffic `{"type":"string"}`             |
| `new_vlan_id`       | No       | `{"type":"string"}`                                                                   |
| `new_vlan_priority` | No       | `{"type":"string"}`                                                                   |
| `redirect_to_cpu`   | No       | `{"type":"boolean"}`                                                                  |
| `copy_to_cpu`       | No       | `{"type":"boolean"}`                                                                  |
| `mirror`            | No       | `{"type":"boolean"}`                                                                  |
| `rate`              | No       | Rate limit in bits/second `{"type":"string"}`                                         |
| `comment`           | No       | `{"type":"string"}`                                                                   |
| `disabled`          | Yes      | `{"default":false,"type":"boolean"}`                                                  |

## list_switch_rules

**List Switch Chip ACL Rules** · Risk: **read**

Lists all hardware switch ACL/redirect rules (`/interface ethernet switch rule print`) on the switch chip. Use this to audit or discover existing rules before adding or updating. Optional filters narrow by switch chip name, port name substring, or disabled-only status. For software firewall rules use list_filter_rules; for NAT rules use list_nat_rules. Returns a formatted table of all matching rules including their `.id` values needed by get_switch_rule, update_switch_rule, remove_switch_rule, enable_switch_rule, and disable_switch_rule.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `switch_filter` | No       | `{"type":"string"}`                  |
| `ports_filter`  | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |

## get_switch_rule

**Get Switch Chip ACL Rule Detail** · Risk: **read**

Fetches full detail of a single hardware switch ACL/redirect rule (`/interface ethernet switch rule print detail where .id=…`). Use this to inspect all match criteria and action fields of one rule. `rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). For a tabular overview of all rules use list_switch_rules; for software firewall rule detail use get_filter_rule.

| Parameter | Required | Definition                                           |
| --------- | -------- | ---------------------------------------------------- |
| `rule_id` | Yes      | RouterOS '.id', e.g. '*1' or '0' `{"type":"string"}` |

## update_switch_rule

**Update Switch Chip ACL Rule** · Risk: **write-idempotent**

Modifies an existing hardware switch ACL/redirect rule (`/interface ethernet switch rule set`) by `.id`. Use this to change match criteria (ports, addresses, VLAN, protocol) or actions (redirect target ports, mirror, rate limit, disabled state). Pass an empty string ("") for any optional field to clear it. `rule_id` takes the `.id` from list_switch_rules. Returns the updated rule's full detail. For software firewall rule edits use update_filter_rule; to only toggle the enabled state use enable_switch_rule or disable_switch_rule.

| Parameter           | Required | Definition                                                 |
| ------------------- | -------- | ---------------------------------------------------------- |
| `rule_id`           | Yes      | `{"type":"string"}`                                        |
| `switch`            | No       | `{"type":"string"}`                                        |
| `ports`             | No       | `{"type":"string"}`                                        |
| `src_address`       | No       | `{"type":"string"}`                                        |
| `dst_address`       | No       | `{"type":"string"}`                                        |
| `src_address6`      | No       | `{"type":"string"}`                                        |
| `dst_address6`      | No       | `{"type":"string"}`                                        |
| `src_mac_address`   | No       | `{"type":"string"}`                                        |
| `dst_mac_address`   | No       | `{"type":"string"}`                                        |
| `src_port`          | No       | `{"type":"string"}`                                        |
| `dst_port`          | No       | `{"type":"string"}`                                        |
| `protocol`          | No       | `{"type":"string"}`                                        |
| `mac_protocol`      | No       | `{"type":"string"}`                                        |
| `vlan_header`       | No       | `{"type":"string","enum":["any","not-present","present"]}` |
| `vlan_id`           | No       | `{"type":"string"}`                                        |
| `vlan_priority`     | No       | `{"type":"string"}`                                        |
| `dscp`              | No       | `{"type":"string"}`                                        |
| `flow_label`        | No       | `{"type":"string"}`                                        |
| `new_dst_ports`     | No       | `{"type":"string"}`                                        |
| `new_vlan_id`       | No       | `{"type":"string"}`                                        |
| `new_vlan_priority` | No       | `{"type":"string"}`                                        |
| `redirect_to_cpu`   | No       | `{"type":"boolean"}`                                       |
| `copy_to_cpu`       | No       | `{"type":"boolean"}`                                       |
| `mirror`            | No       | `{"type":"boolean"}`                                       |
| `rate`              | No       | `{"type":"string"}`                                        |
| `comment`           | No       | `{"type":"string"}`                                        |
| `disabled`          | No       | `{"type":"boolean"}`                                       |

## remove_switch_rule

**Remove Switch Chip ACL Rule** · Risk: **destructive**

Permanently deletes a hardware switch ACL/redirect rule (`/interface ethernet switch rule remove`) by `.id`. Performs an existence check first and returns an error if the rule is not found. `rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). To keep the rule but stop it from matching use disable_switch_rule instead. For removing software firewall rules use remove_filter_rule.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## enable_switch_rule

**Enable Switch Chip ACL Rule** · Risk: **write-idempotent**

Re-enables a previously disabled hardware switch ACL/redirect rule (`/interface ethernet switch rule set … disabled=no`). Use this to activate a rule without recreating it. `rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). To deactivate a rule without deleting it use disable_switch_rule; to permanently delete use remove_switch_rule. Returns the updated rule's full detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_switch_rule

**Disable Switch Chip ACL Rule** · Risk: **write-idempotent**

Deactivates a hardware switch ACL/redirect rule without deleting it (`/interface ethernet switch rule set … disabled=yes`). Use this to temporarily suspend a rule's match/action while preserving its configuration. `rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). To reactivate the rule use enable_switch_rule; to permanently delete use remove_switch_rule. Returns the updated rule's full detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
