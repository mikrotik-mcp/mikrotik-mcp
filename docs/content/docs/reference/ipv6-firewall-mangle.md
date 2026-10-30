---
title: "IPv6 Firewall — Mangle"
description: "IPv6 mangle rules: connection/packet/routing marks, DSCP, hop-limit (`/ipv6 firewall mangle`)."
---

## Tools

- [Create IPv6 Firewall Mangle Rule](#create_ipv6_mangle_rule)
- [List IPv6 Firewall Mangle Rules](#list_ipv6_mangle_rules)
- [Get IPv6 Firewall Mangle Rule Details](#get_ipv6_mangle_rule)
- [Update IPv6 Firewall Mangle Rule](#update_ipv6_mangle_rule)
- [Remove IPv6 Firewall Mangle Rule](#remove_ipv6_mangle_rule)
- [Move IPv6 Firewall Mangle Rule](#move_ipv6_mangle_rule)
- [Enable IPv6 Firewall Mangle Rule](#enable_ipv6_mangle_rule)
- [Disable IPv6 Firewall Mangle Rule](#disable_ipv6_mangle_rule)

## create_ipv6_mangle_rule

**Create IPv6 Firewall Mangle Rule** · Risk: **write**

Creates an IPv6 mangle rule (`/ipv6 firewall mangle add`) — the packet-marking and header-modification table for IPv6 traffic, used to mark connections/packets/routing or change DSCP/hop-limit/MSS. For accept/drop decisions use create_ipv6_filter_rule; for address translation use create_ipv6_nat_rule; for pre-connection-tracking drops use create_ipv6_raw_rule. chain: prerouting/input/forward/output/postrouting. action: mark-connection/mark-packet/mark-routing/change-dscp/change-hop-limit/change-mss/accept/etc. Set the matching new-_-mark field for mark-_ actions; keep passthrough=true so later rules can also match the same packet. place_before accepts a rule number or ID (*N) to control insertion position. Returns the created rule's detail including its `.id`.

| Parameter                   | Required | Definition                                                                                                                                                                                                |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                     | Yes      | `{"type":"string","enum":["prerouting","input","forward","output","postrouting"]}`                                                                                                                        |
| `action`                    | Yes      | `{"type":"string","enum":["accept","drop","mark-connection","mark-packet","mark-routing","change-dscp","change-hop-limit","change-mss","jump","log","passthrough","return","set-priority","sniff-tzsp"]}` |
| `src_address`               | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `dst_address`               | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `src_port`                  | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `dst_port`                  | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `protocol`                  | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `in_interface`              | No       | Negatable, e.g. "!ether1" `{"type":"string"}`                                                                                                                                                             |
| `out_interface`             | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `in_interface_list`         | No       | Interface list, negatable e.g. "!WAN" `{"type":"string"}`                                                                                                                                                 |
| `out_interface_list`        | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `src_address_list`          | No       | Match src in a named list; negate "!name" `{"type":"string"}`                                                                                                                                             |
| `dst_address_list`          | No       | Match dst in a named list; negate "!name" `{"type":"string"}`                                                                                                                                             |
| `src_address_type`          | No       | e.g. "unicast", "local", "!local" `{"type":"string"}`                                                                                                                                                     |
| `dst_address_type`          | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `src_mac_address`           | No       | Source MAC, negatable e.g. "!00:11:..." `{"type":"string"}`                                                                                                                                               |
| `port`                      | No       | Match if src OR dst port matches (with protocol) `{"type":"string"}`                                                                                                                                      |
| `connection_state`          | No       | e.g. "new", "established,related", "!invalid" `{"type":"string"}`                                                                                                                                         |
| `connection_type`           | No       | Helper, e.g. "sip", "ftp" `{"type":"string"}`                                                                                                                                                             |
| `connection_bytes`          | No       | e.g. "1000000-0" (>1 MB connections) `{"type":"string"}`                                                                                                                                                  |
| `connection_limit`          | No       | e.g. "100,128" `{"type":"string"}`                                                                                                                                                                        |
| `connection_rate`           | No       | e.g. "100k-1M" `{"type":"string"}`                                                                                                                                                                        |
| `per_connection_classifier` | No       | PCC for load balancing, e.g. "both-addresses:2/0" `{"type":"string"}`                                                                                                                                     |
| `tcp_flags`                 | No       | RouterOS flag expression e.g. "syn,!ack" `{"type":"string"}`                                                                                                                                              |
| `tcp_mss`                   | No       | Match TCP MSS, e.g. "1400-1500" or "!1460" `{"type":"string"}`                                                                                                                                            |
| `icmp_options`              | No       | Match ICMPv6 type:code, e.g. "128:0" `{"type":"string"}`                                                                                                                                                  |
| `packet_size`               | No       | e.g. "1500" or "0-500" `{"type":"string"}`                                                                                                                                                                |
| `dscp`                      | No       | Match incoming DSCP (0-63) `{"type":"string"}`                                                                                                                                                            |
| `priority`                  | No       | Match packet/queue priority (0-63) `{"type":"string"}`                                                                                                                                                    |
| `ingress_priority`          | No       | Match ingress (VLAN/MPLS) priority (0-63) `{"type":"string"}`                                                                                                                                             |
| `ipsec_policy`              | No       | e.g. "in,ipsec" or "out,none" `{"type":"string"}`                                                                                                                                                         |
| `nth`                       | No       | e.g. "2,1" — every 2nd packet `{"type":"string"}`                                                                                                                                                         |
| `random`                    | No       | Match a random N% of packets (1-99) `{"type":"string"}`                                                                                                                                                   |
| `time`                      | No       | e.g. "8h-16h,mon,tue,wed,thu,fri" `{"type":"string"}`                                                                                                                                                     |
| `hop_limit`                 | No       | Match hop-limit, e.g. "equal:64", "less-than:10" `{"type":"string"}`                                                                                                                                      |
| `content`                   | No       | Match packets containing this text `{"type":"string"}`                                                                                                                                                    |
| `headers`                   | No       | Match IPv6 extension headers, e.g. "hop:contains" `{"type":"string"}`                                                                                                                                     |
| `limit`                     | No       | Rate limit matcher, e.g. "50,5:packet" `{"type":"string"}`                                                                                                                                                |
| `dst_limit`                 | No       | Per-destination rate matcher, e.g. "50,5,dst-address/1m" `{"type":"string"}`                                                                                                                              |
| `connection_mark`           | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `packet_mark`               | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `routing_mark`              | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `new_connection_mark`       | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `new_packet_mark`           | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `new_routing_mark`          | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `new_dscp`                  | No       | 0-63, for change-dscp `{"type":"string"}`                                                                                                                                                                 |
| `new_hop_limit`             | No       | e.g. "decrement", "increment", or "set:64" `{"type":"string"}`                                                                                                                                            |
| `new_mss`                   | No       | e.g. "1440" or "clamp-to-pmtu", for change-mss `{"type":"string"}`                                                                                                                                        |
| `new_priority`              | No       | e.g. "4" or "from-dscp", for set-priority `{"type":"string"}`                                                                                                                                             |
| `jump_target`               | No       | Target chain name for action=jump `{"type":"string"}`                                                                                                                                                     |
| `sniff_target`              | No       | TZSP collector IP for action=sniff-tzsp `{"type":"string"}`                                                                                                                                               |
| `sniff_target_port`         | No       | TZSP collector UDP port for sniff-tzsp `{"type":"string"}`                                                                                                                                                |
| `passthrough`               | No       | `{"type":"boolean"}`                                                                                                                                                                                      |
| `comment`                   | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                      |
| `log`                       | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                      |
| `log_prefix`                | No       | `{"type":"string"}`                                                                                                                                                                                       |
| `place_before`              | No       | Rule number or ID (*N) to insert before `{"type":"string"}`                                                                                                                                               |

## list_ipv6_mangle_rules

**List IPv6 Firewall Mangle Rules** · Risk: **read**

Lists IPv6 mangle rules (`/ipv6 firewall mangle print`) — returns all rules in the mangle table with their IDs, chains, actions, and match criteria. For IPv6 filter use list_ipv6_filter_rules; for IPv6 NAT use list_ipv6_nat_rules; for IPv6 raw use list_ipv6_raw_rules. Optionally filter by chain, action, connection-mark, packet-mark, disabled, invalid, or dynamic status. Rule `.id` values from this output are required by get_ipv6_mangle_rule, update_ipv6_mangle_rule, remove_ipv6_mangle_rule, move_ipv6_mangle_rule, enable_ipv6_mangle_rule, and disable_ipv6_mangle_rule.

| Parameter                | Required | Definition                           |
| ------------------------ | -------- | ------------------------------------ |
| `chain_filter`           | No       | `{"type":"string"}`                  |
| `action_filter`          | No       | `{"type":"string"}`                  |
| `connection_mark_filter` | No       | `{"type":"string"}`                  |
| `packet_mark_filter`     | No       | `{"type":"string"}`                  |
| `disabled_only`          | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`           | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`           | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_mangle_rule

**Get IPv6 Firewall Mangle Rule Details** · Risk: **read**

Retrieves full detail for a single IPv6 mangle rule (`/ipv6 firewall mangle print detail where .id=`). Use when you need all fields of one specific rule rather than the full table listing. For the full list use list_ipv6_mangle_rules. rule_id takes the `.id` value (e.g. "*1" or "0") returned by list_ipv6_mangle_rules.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_ipv6_mangle_rule

**Update IPv6 Firewall Mangle Rule** · Risk: **write-idempotent**

Updates fields on an existing IPv6 mangle rule (`/ipv6 firewall mangle set`) — change chain, action, match criteria, mark values, DSCP, hop-limit, or flags without recreating the rule. To toggle enabled state only use enable_ipv6_mangle_rule or disable_ipv6_mangle_rule. rule_id takes the `.id` from list_ipv6_mangle_rules. Pass "" (empty string) for an optional field to clear it. Returns the updated rule's full detail.

| Parameter                   | Required | Definition                              |
| --------------------------- | -------- | --------------------------------------- |
| `rule_id`                   | Yes      | `{"type":"string"}`                     |
| `chain`                     | No       | `{"type":"string"}`                     |
| `action`                    | No       | `{"type":"string"}`                     |
| `src_address`               | No       | `{"type":"string"}`                     |
| `dst_address`               | No       | `{"type":"string"}`                     |
| `src_port`                  | No       | `{"type":"string"}`                     |
| `dst_port`                  | No       | `{"type":"string"}`                     |
| `protocol`                  | No       | `{"type":"string"}`                     |
| `in_interface`              | No       | `{"type":"string"}`                     |
| `out_interface`             | No       | `{"type":"string"}`                     |
| `in_interface_list`         | No       | `{"type":"string"}`                     |
| `out_interface_list`        | No       | `{"type":"string"}`                     |
| `src_address_list`          | No       | Negate with "!name" `{"type":"string"}` |
| `dst_address_list`          | No       | Negate with "!name" `{"type":"string"}` |
| `src_address_type`          | No       | `{"type":"string"}`                     |
| `dst_address_type`          | No       | `{"type":"string"}`                     |
| `src_mac_address`           | No       | `{"type":"string"}`                     |
| `port`                      | No       | `{"type":"string"}`                     |
| `connection_state`          | No       | `{"type":"string"}`                     |
| `connection_type`           | No       | `{"type":"string"}`                     |
| `connection_bytes`          | No       | `{"type":"string"}`                     |
| `connection_limit`          | No       | `{"type":"string"}`                     |
| `connection_rate`           | No       | `{"type":"string"}`                     |
| `per_connection_classifier` | No       | `{"type":"string"}`                     |
| `tcp_flags`                 | No       | `{"type":"string"}`                     |
| `tcp_mss`                   | No       | `{"type":"string"}`                     |
| `icmp_options`              | No       | `{"type":"string"}`                     |
| `packet_size`               | No       | `{"type":"string"}`                     |
| `dscp`                      | No       | `{"type":"string"}`                     |
| `priority`                  | No       | `{"type":"string"}`                     |
| `ingress_priority`          | No       | `{"type":"string"}`                     |
| `ipsec_policy`              | No       | `{"type":"string"}`                     |
| `nth`                       | No       | `{"type":"string"}`                     |
| `random`                    | No       | `{"type":"string"}`                     |
| `time`                      | No       | `{"type":"string"}`                     |
| `hop_limit`                 | No       | `{"type":"string"}`                     |
| `content`                   | No       | `{"type":"string"}`                     |
| `headers`                   | No       | `{"type":"string"}`                     |
| `limit`                     | No       | `{"type":"string"}`                     |
| `dst_limit`                 | No       | `{"type":"string"}`                     |
| `connection_mark`           | No       | `{"type":"string"}`                     |
| `packet_mark`               | No       | `{"type":"string"}`                     |
| `routing_mark`              | No       | `{"type":"string"}`                     |
| `new_connection_mark`       | No       | `{"type":"string"}`                     |
| `new_packet_mark`           | No       | `{"type":"string"}`                     |
| `new_routing_mark`          | No       | `{"type":"string"}`                     |
| `new_dscp`                  | No       | `{"type":"string"}`                     |
| `new_hop_limit`             | No       | `{"type":"string"}`                     |
| `new_mss`                   | No       | `{"type":"string"}`                     |
| `new_priority`              | No       | `{"type":"string"}`                     |
| `jump_target`               | No       | `{"type":"string"}`                     |
| `sniff_target`              | No       | `{"type":"string"}`                     |
| `sniff_target_port`         | No       | `{"type":"string"}`                     |
| `passthrough`               | No       | `{"type":"boolean"}`                    |
| `comment`                   | No       | `{"type":"string"}`                     |
| `disabled`                  | No       | `{"type":"boolean"}`                    |
| `log`                       | No       | `{"type":"boolean"}`                    |
| `log_prefix`                | No       | `{"type":"string"}`                     |

## remove_ipv6_mangle_rule

**Remove IPv6 Firewall Mangle Rule** · Risk: **destructive**

Permanently deletes an IPv6 mangle rule (`/ipv6 firewall mangle remove`) — verifies the rule exists first, then removes it. To only deactivate without deleting use disable_ipv6_mangle_rule. rule_id takes the `.id` from list_ipv6_mangle_rules. Returns confirmation on success or a not-found message if the ID is absent.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_ipv6_mangle_rule

**Move IPv6 Firewall Mangle Rule** · Risk: **write-idempotent**

Reorders an IPv6 mangle rule to a specific position (`/ipv6 firewall mangle move`) — mangle rules are evaluated top-down, so position controls which rules fire first. For IPv6 filter reordering use move_ipv6_filter_rule. rule_id takes the `.id` from list_ipv6_mangle_rules; destination is the 0-based target index. Verifies the rule exists before moving.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_ipv6_mangle_rule

**Enable IPv6 Firewall Mangle Rule** · Risk: **write-idempotent**

Enables a disabled IPv6 mangle rule (`/ipv6 firewall mangle set disabled=no`) so it participates in packet processing again. To deactivate use disable_ipv6_mangle_rule; to delete permanently use remove_ipv6_mangle_rule. rule_id takes the `.id` from list_ipv6_mangle_rules. Returns the updated rule's detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_ipv6_mangle_rule

**Disable IPv6 Firewall Mangle Rule** · Risk: **write-idempotent**

Disables an active IPv6 mangle rule (`/ipv6 firewall mangle set disabled=yes`) — the rule remains in the table but is skipped during packet processing. To re-enable use enable_ipv6_mangle_rule; to delete permanently use remove_ipv6_mangle_rule. rule_id takes the `.id` from list_ipv6_mangle_rules. Returns the updated rule's detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
