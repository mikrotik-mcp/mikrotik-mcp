---
title: "IPv6 Firewall — Raw"
description: "IPv6 raw rules: pre-conntrack accept/drop/notrack (`/ipv6 firewall raw`)."
---

## Tools

- [Create IPv6 Firewall Raw Rule](#create_ipv6_raw_rule)
- [List IPv6 Firewall Raw Rules](#list_ipv6_raw_rules)
- [Get IPv6 Firewall Raw Rule](#get_ipv6_raw_rule)
- [Update IPv6 Firewall Raw Rule](#update_ipv6_raw_rule)
- [Remove IPv6 Firewall Raw Rule](#remove_ipv6_raw_rule)
- [Move IPv6 Firewall Raw Rule](#move_ipv6_raw_rule)
- [Enable IPv6 Firewall Raw Rule](#enable_ipv6_raw_rule)
- [Disable IPv6 Firewall Raw Rule](#disable_ipv6_raw_rule)

## create_ipv6_raw_rule

**Create IPv6 Firewall Raw Rule** · Risk: **write**

Creates an IPv6 raw rule (`/ipv6 firewall raw`) — the pre-connection-tracking table for IPv6 traffic. Use to cheaply drop packets before the state machine runs (action=drop) or to exempt traffic from connection tracking (action=notrack). chain: 'prerouting' (all arriving IPv6 traffic) or 'output' (locally generated IPv6 traffic). For IPv6 accept/drop based on state use create_ipv6_filter_rule; for IPv6 packet marking use create_ipv6_mangle_rule; for IPv6 address translation use create_ipv6_nat_rule. place_before accepts a rule number or ID (*N) to control insertion point. Returns the created rule's details including its .id.

| Parameter            | Required | Definition                                                                                 |
| -------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `chain`              | Yes      | `{"type":"string","enum":["prerouting","output"]}`                                         |
| `action`             | Yes      | `{"type":"string","enum":["accept","drop","notrack","jump","log","passthrough","return"]}` |
| `src_address`        | No       | `{"type":"string"}`                                                                        |
| `dst_address`        | No       | `{"type":"string"}`                                                                        |
| `src_port`           | No       | `{"type":"string"}`                                                                        |
| `dst_port`           | No       | `{"type":"string"}`                                                                        |
| `port`               | No       | Match src or dst port (any direction) `{"type":"string"}`                                  |
| `protocol`           | No       | `{"type":"string"}`                                                                        |
| `in_interface`       | No       | `{"type":"string"}`                                                                        |
| `out_interface`      | No       | `{"type":"string"}`                                                                        |
| `in_interface_list`  | No       | Match inbound interface list name `{"type":"string"}`                                      |
| `out_interface_list` | No       | Match outbound interface list name `{"type":"string"}`                                     |
| `src_address_list`   | No       | `{"type":"string"}`                                                                        |
| `dst_address_list`   | No       | `{"type":"string"}`                                                                        |
| `src_address_type`   | No       | Source address type e.g. "unicast", "local", "multicast" `{"type":"string"}`               |
| `dst_address_type`   | No       | Destination address type e.g. "unicast", "local", "multicast" `{"type":"string"}`          |
| `src_mac_address`    | No       | Match source MAC address `{"type":"string"}`                                               |
| `hop_limit`          | No       | Hop-limit expression e.g. "equal:1" or "less:64" `{"type":"string"}`                       |
| `tcp_flags`          | No       | TCP flag expression e.g. "syn,!ack" `{"type":"string"}`                                    |
| `tcp_mss`            | No       | TCP MSS value or range e.g. "1400-1500" `{"type":"string"}`                                |
| `packet_size`        | No       | Packet size or range in bytes e.g. "0-500" `{"type":"string"}`                             |
| `dscp`               | No       | DSCP value 0-63 `{"type":"string"}`                                                        |
| `ipsec_policy`       | No       | IPsec policy match e.g. "in,ipsec" or "out,none" `{"type":"string"}`                       |
| `limit`              | No       | Rate/burst string e.g. "10,5:packet" `{"type":"string"}`                                   |
| `comment`            | No       | `{"type":"string"}`                                                                        |
| `disabled`           | Yes      | `{"default":false,"type":"boolean"}`                                                       |
| `log`                | Yes      | `{"default":false,"type":"boolean"}`                                                       |
| `log_prefix`         | No       | `{"type":"string"}`                                                                        |
| `place_before`       | No       | Rule number or ID (*N) to insert before `{"type":"string"}`                                |

## list_ipv6_raw_rules

**List IPv6 Firewall Raw Rules** · Risk: **read**

Lists IPv6 raw rules (`/ipv6 firewall raw`) — the pre-connection-tracking table for IPv6 traffic. Use to audit which rules bypass or cheaply drop traffic before connection tracking runs. For IPv6 filter use list_ipv6_filter_rules; for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 NAT use list_ipv6_nat_rules. Supports optional filters: chain_filter, action_filter, src/dst address substring match, and disabled_only/invalid_only/dynamic_only flags. Returns all matching rules; .id values are used by get_ipv6_raw_rule, update_ipv6_raw_rule, remove_ipv6_raw_rule, and move_ipv6_raw_rule.

| Parameter            | Required | Definition                           |
| -------------------- | -------- | ------------------------------------ |
| `chain_filter`       | No       | `{"type":"string"}`                  |
| `action_filter`      | No       | `{"type":"string"}`                  |
| `src_address_filter` | No       | `{"type":"string"}`                  |
| `dst_address_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`      | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`       | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`       | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_raw_rule

**Get IPv6 Firewall Raw Rule** · Risk: **read**

Fetches full detail of a single IPv6 raw rule (`/ipv6 firewall raw print detail`) by its .id. Use to inspect the exact match criteria, action, and flags of one specific rule. For the full list use list_ipv6_raw_rules. rule_id takes the .id value (e.g. '*1' or '0') from list_ipv6_raw_rules output. Returns the complete detail block for that rule, or a not-found message if the ID is absent.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_ipv6_raw_rule

**Update IPv6 Firewall Raw Rule** · Risk: **write-idempotent**

Modifies fields of an existing IPv6 raw rule (`/ipv6 firewall raw set`) without deleting and recreating it. Use to change chain, action, match criteria (src/dst address, port, protocol, interface, address list), comment, log settings, or enabled state. To reorder a rule use move_ipv6_raw_rule; to toggle only the enabled state use enable_ipv6_raw_rule or disable_ipv6_raw_rule. rule_id takes the .id from list_ipv6_raw_rules. Pass "" for any optional string field to clear it. Returns the updated rule's full details.

| Parameter            | Required | Definition           |
| -------------------- | -------- | -------------------- |
| `rule_id`            | Yes      | `{"type":"string"}`  |
| `chain`              | No       | `{"type":"string"}`  |
| `action`             | No       | `{"type":"string"}`  |
| `src_address`        | No       | `{"type":"string"}`  |
| `dst_address`        | No       | `{"type":"string"}`  |
| `src_port`           | No       | `{"type":"string"}`  |
| `dst_port`           | No       | `{"type":"string"}`  |
| `port`               | No       | `{"type":"string"}`  |
| `protocol`           | No       | `{"type":"string"}`  |
| `in_interface`       | No       | `{"type":"string"}`  |
| `out_interface`      | No       | `{"type":"string"}`  |
| `in_interface_list`  | No       | `{"type":"string"}`  |
| `out_interface_list` | No       | `{"type":"string"}`  |
| `src_address_list`   | No       | `{"type":"string"}`  |
| `dst_address_list`   | No       | `{"type":"string"}`  |
| `src_address_type`   | No       | `{"type":"string"}`  |
| `dst_address_type`   | No       | `{"type":"string"}`  |
| `src_mac_address`    | No       | `{"type":"string"}`  |
| `hop_limit`          | No       | `{"type":"string"}`  |
| `tcp_flags`          | No       | `{"type":"string"}`  |
| `tcp_mss`            | No       | `{"type":"string"}`  |
| `packet_size`        | No       | `{"type":"string"}`  |
| `dscp`               | No       | `{"type":"string"}`  |
| `ipsec_policy`       | No       | `{"type":"string"}`  |
| `limit`              | No       | `{"type":"string"}`  |
| `comment`            | No       | `{"type":"string"}`  |
| `disabled`           | No       | `{"type":"boolean"}` |
| `log`                | No       | `{"type":"boolean"}` |
| `log_prefix`         | No       | `{"type":"string"}`  |

## remove_ipv6_raw_rule

**Remove IPv6 Firewall Raw Rule** · Risk: **destructive**

Permanently deletes an IPv6 raw rule (`/ipv6 firewall raw remove`). Use to discard a pre-connection-tracking rule that is no longer needed. To temporarily suspend without deleting use disable_ipv6_raw_rule. rule_id takes the .id from list_ipv6_raw_rules; the tool verifies existence (count-only check) before attempting removal. Returns a success or not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_ipv6_raw_rule

**Move IPv6 Firewall Raw Rule** · Risk: **write-idempotent**

Reorders an IPv6 raw rule to a specific position (`/ipv6 firewall raw move`). Use to change evaluation order — rules are matched top-to-bottom within a chain, so position matters. To reorder IPv6 filter rules use move_ipv6_filter_rule. rule_id takes the .id from list_ipv6_raw_rules; destination is the 0-based integer target position. Returns a confirmation message with the new position.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_ipv6_raw_rule

**Enable IPv6 Firewall Raw Rule** · Risk: **write-idempotent**

Enables a disabled IPv6 raw rule (`/ipv6 firewall raw set disabled=no`). Use to activate a rule that was previously suspended without recreating it. To disable use disable_ipv6_raw_rule; for full field edits use update_ipv6_raw_rule. rule_id takes the .id from list_ipv6_raw_rules. Returns the updated rule's full details.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_ipv6_raw_rule

**Disable IPv6 Firewall Raw Rule** · Risk: **write-idempotent**

Disables an active IPv6 raw rule (`/ipv6 firewall raw set disabled=yes`). Use to temporarily suspend a rule without deleting it — disabled rules are skipped during chain evaluation. To re-enable use enable_ipv6_raw_rule; for full field edits use update_ipv6_raw_rule. rule_id takes the .id from list_ipv6_raw_rules. Returns the updated rule's full details.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
