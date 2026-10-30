---
title: "Firewall — Mangle"
description: "Mangle rules: connection/packet/routing marks, DSCP, TTL, MSS (`/ip firewall mangle`)."
---

## Tools

- [Create IPv4 Firewall Mangle Rule](#create_mangle_rule)
- [List IPv4 Firewall Mangle Rules](#list_mangle_rules)
- [Get IPv4 Firewall Mangle Rule Details](#get_mangle_rule)
- [Update IPv4 Firewall Mangle Rule](#update_mangle_rule)
- [Remove IPv4 Firewall Mangle Rule](#remove_mangle_rule)
- [Move IPv4 Firewall Mangle Rule](#move_mangle_rule)
- [Enable IPv4 Firewall Mangle Rule](#enable_mangle_rule)
- [Disable IPv4 Firewall Mangle Rule](#disable_mangle_rule)

## create_mangle_rule

**Create IPv4 Firewall Mangle Rule** · Risk: **write**

Creates an IPv4 mangle rule (`/ip firewall mangle add`) — the packet-marking and header-modification table, used to mark connections/packets/routing (for policy routing, QoS and per-connection classification) or to change DSCP/TTL/MSS. For accept/drop decisions use create_filter_rule; for address translation use create_nat_rule; for IPv6 mangle use create_ipv6_mangle_rule. chain: prerouting/input/forward/output/postrouting. action: mark-connection/mark-packet/mark-routing/change-dscp/change-ttl/change-mss/add-src-to-address-list/add-dst-to-address-list/fasttrack-connection/route/set-priority/accept/etc. Set the matching new-_-mark field for mark-_ actions and keep passthrough=true so later rules can also match the same packet; for add-*-to-address-list set address_list (and optionally address_list_timeout). Full match surface: address-lists (src_address_list/dst_address_list — negate with a leading '!', e.g. dst_address_list='!IR' to route traffic NOT bound for a list), interface-lists, per_connection_classifier (PCC load-balancing), connection_nat_state, tcp_flags, dscp, layer7_protocol, time, and more. Typical policy-routing rule: chain=prerouting, src_address=<lan>, dst_address_list='!IR', action=mark-routing, new_routing_mark=<table>, then a routing rule/route uses that table. place_before accepts a rule number or ID (*N) to control insertion position. Returns the created rule's detail including its `.id`.

| Parameter                   | Required | Definition                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chain`                     | Yes      | `{"type":"string","enum":["prerouting","input","forward","output","postrouting"]}`                                                                                                                                                                                                                           |
| `action`                    | Yes      | `{"type":"string","enum":["accept","add-dst-to-address-list","add-src-to-address-list","change-dscp","change-mss","change-ttl","clear-df","drop","fasttrack-connection","jump","log","mark-connection","mark-packet","mark-routing","passthrough","return","route","set-priority","sniff-pc","sniff-tzsp"]}` |
| `src_address`               | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `dst_address`               | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `src_port`                  | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `dst_port`                  | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `port`                      | No       | Match if src OR dst port matches (with protocol) `{"type":"string"}`                                                                                                                                                                                                                                         |
| `protocol`                  | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `src_mac_address`           | No       | Source MAC, negatable e.g. "!00:11:..." `{"type":"string"}`                                                                                                                                                                                                                                                  |
| `in_interface`              | No       | Negatable, e.g. "!ether1" `{"type":"string"}`                                                                                                                                                                                                                                                                |
| `out_interface`             | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `in_interface_list`         | No       | Interface list, negatable e.g. "!WAN" `{"type":"string"}`                                                                                                                                                                                                                                                    |
| `out_interface_list`        | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `src_address_list`          | No       | Match src in a named list; negate "!name" `{"type":"string"}`                                                                                                                                                                                                                                                |
| `dst_address_list`          | No       | Match dst in a named list; negate "!name" (e.g. "!IR" routes foreign traffic) `{"type":"string"}`                                                                                                                                                                                                            |
| `src_address_type`          | No       | e.g. "local", "unicast", "!local" `{"type":"string"}`                                                                                                                                                                                                                                                        |
| `dst_address_type`          | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `connection_mark`           | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `packet_mark`               | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `routing_mark`              | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `connection_state`          | No       | e.g. "new", "established,related", "!invalid" `{"type":"string"}`                                                                                                                                                                                                                                            |
| `connection_nat_state`      | No       | "srcnat" / "dstnat" / "!dstnat" `{"type":"string"}`                                                                                                                                                                                                                                                          |
| `connection_type`           | No       | Helper, e.g. "sip", "ftp" `{"type":"string"}`                                                                                                                                                                                                                                                                |
| `connection_bytes`          | No       | e.g. "1000000-0" (>1 MB connections) `{"type":"string"}`                                                                                                                                                                                                                                                     |
| `connection_limit`          | No       | e.g. "100,32" `{"type":"string"}`                                                                                                                                                                                                                                                                            |
| `connection_rate`           | No       | e.g. "100k-1M" `{"type":"string"}`                                                                                                                                                                                                                                                                           |
| `per_connection_classifier` | No       | PCC for load balancing, e.g. "both-addresses:2/0" `{"type":"string"}`                                                                                                                                                                                                                                        |
| `tcp_flags`                 | No       | RouterOS flag expression e.g. "syn,!ack" `{"type":"string"}`                                                                                                                                                                                                                                                 |
| `dscp`                      | No       | Match incoming DSCP (0-63) `{"type":"string"}`                                                                                                                                                                                                                                                               |
| `priority`                  | No       | Match packet/queue priority (0-63) `{"type":"string"}`                                                                                                                                                                                                                                                       |
| `packet_size`               | No       | e.g. "1500" or "0-500" `{"type":"string"}`                                                                                                                                                                                                                                                                   |
| `ttl`                       | No       | Match TTL, e.g. "equal:64", "less-than:10" `{"type":"string"}`                                                                                                                                                                                                                                               |
| `tcp_mss`                   | No       | Match TCP MSS, e.g. "1400-1500" or "!1460" `{"type":"string"}`                                                                                                                                                                                                                                               |
| `fragment`                  | No       | Match second and further fragments `{"type":"boolean"}`                                                                                                                                                                                                                                                      |
| `icmp_options`              | No       | Match ICMP type:code, e.g. "8:0" `{"type":"string"}`                                                                                                                                                                                                                                                         |
| `ipv4_options`              | No       | e.g. "any", "loose-source-routing", "record-route" `{"type":"string"}`                                                                                                                                                                                                                                       |
| `limit`                     | No       | Rate limit matcher, e.g. "50,5:packet" `{"type":"string"}`                                                                                                                                                                                                                                                   |
| `dst_limit`                 | No       | Per-destination rate matcher, e.g. "50,5,dst-address/1m" `{"type":"string"}`                                                                                                                                                                                                                                 |
| `content`                   | No       | Match packets containing this text `{"type":"string"}`                                                                                                                                                                                                                                                       |
| `psd`                       | No       | Port scan detection, e.g. "21,3s,3,1" `{"type":"string"}`                                                                                                                                                                                                                                                    |
| `layer7_protocol`           | No       | Name of an /ip firewall layer7-protocol regex `{"type":"string"}`                                                                                                                                                                                                                                            |
| `ipsec_policy`              | No       | e.g. "in,ipsec" or "out,none" `{"type":"string"}`                                                                                                                                                                                                                                                            |
| `nth`                       | No       | e.g. "2,1" — every 2nd packet `{"type":"string"}`                                                                                                                                                                                                                                                            |
| `random`                    | No       | Match a random N% of packets (1-99) `{"type":"string"}`                                                                                                                                                                                                                                                      |
| `time`                      | No       | e.g. "8h-16h,mon,tue,wed,thu,fri" `{"type":"string"}`                                                                                                                                                                                                                                                        |
| `hotspot`                   | No       | e.g. "auth", "!auth", "from-client" `{"type":"string"}`                                                                                                                                                                                                                                                      |
| `p2p`                       | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `new_connection_mark`       | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `new_packet_mark`           | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `new_routing_mark`          | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `new_dscp`                  | No       | 0-63, for change-dscp `{"type":"string"}`                                                                                                                                                                                                                                                                    |
| `new_ttl`                   | No       | e.g. "decrement", "increment", or "set:64" `{"type":"string"}`                                                                                                                                                                                                                                               |
| `new_mss`                   | No       | e.g. "1440" or "clamp-to-pmtu", for change-mss `{"type":"string"}`                                                                                                                                                                                                                                           |
| `new_priority`              | No       | Priority for action=set-priority, e.g. "4", "from-dscp", "from-ingress" `{"type":"string"}`                                                                                                                                                                                                                  |
| `routing_table`             | No       | Routing table for action=route `{"type":"string"}`                                                                                                                                                                                                                                                           |
| `route_dst`                 | No       | Gateway IP for action=route `{"type":"string"}`                                                                                                                                                                                                                                                              |
| `jump_target`               | No       | Target chain name for action=jump `{"type":"string"}`                                                                                                                                                                                                                                                        |
| `sniff_target`              | No       | Collector IP for action=sniff-tzsp/sniff-pc `{"type":"string"}`                                                                                                                                                                                                                                              |
| `sniff_target_port`         | No       | Collector UDP port for action=sniff-tzsp `{"type":"string"}`                                                                                                                                                                                                                                                 |
| `address_list`              | No       | Target list name for add-src/dst-to-address-list `{"type":"string"}`                                                                                                                                                                                                                                         |
| `address_list_timeout`      | No       | Entry timeout for add-*-to-address-list e.g. "1h", "none" `{"type":"string"}`                                                                                                                                                                                                                                |
| `passthrough`               | No       | `{"type":"boolean"}`                                                                                                                                                                                                                                                                                         |
| `comment`                   | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                         |
| `log`                       | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                         |
| `log_prefix`                | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                          |
| `place_before`              | No       | Rule number or ID (*N) to insert before `{"type":"string"}`                                                                                                                                                                                                                                                  |

## list_mangle_rules

**List IPv4 Firewall Mangle Rules** · Risk: **read**

Lists IPv4 mangle rules (`/ip firewall mangle print`) — returns all rules in the mangle table with their IDs, chains, actions, and match criteria. For IPv4 filter use list_filter_rules; for IPv4 NAT use list_nat_rules; for IPv6 mangle use list_ipv6_mangle_rules. Optionally filter by chain, action, connection-mark, packet-mark, disabled, invalid, or dynamic status. Rule `.id` values from this output are required by get_mangle_rule, update_mangle_rule, remove_mangle_rule, move_mangle_rule, enable_mangle_rule, and disable_mangle_rule.

| Parameter                | Required | Definition                           |
| ------------------------ | -------- | ------------------------------------ |
| `chain_filter`           | No       | `{"type":"string"}`                  |
| `action_filter`          | No       | `{"type":"string"}`                  |
| `connection_mark_filter` | No       | `{"type":"string"}`                  |
| `packet_mark_filter`     | No       | `{"type":"string"}`                  |
| `disabled_only`          | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`           | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`           | Yes      | `{"default":false,"type":"boolean"}` |

## get_mangle_rule

**Get IPv4 Firewall Mangle Rule Details** · Risk: **read**

Retrieves full detail for a single IPv4 mangle rule (`/ip firewall mangle print detail where .id=`). Use when you need all fields of one specific rule rather than the full table listing. For the full list use list_mangle_rules; for IPv6 mangle use get_ipv6_mangle_rule. rule_id takes the `.id` value (e.g. "*1" or "0") returned by list_mangle_rules.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_mangle_rule

**Update IPv4 Firewall Mangle Rule** · Risk: **write-idempotent**

Updates fields on an existing IPv4 mangle rule (`/ip firewall mangle set`) — change chain, action, match criteria, mark values, DSCP, TTL, MSS, or flags without recreating the rule. To toggle enabled state only use enable_mangle_rule or disable_mangle_rule; for IPv6 mangle use update_ipv6_mangle_rule. rule_id takes the `.id` from list_mangle_rules. Pass "" (empty string) for an optional field to clear it. Returns the updated rule's full detail.

| Parameter                   | Required | Definition                                           |
| --------------------------- | -------- | ---------------------------------------------------- |
| `rule_id`                   | Yes      | `{"type":"string"}`                                  |
| `chain`                     | No       | `{"type":"string"}`                                  |
| `action`                    | No       | `{"type":"string"}`                                  |
| `src_address`               | No       | `{"type":"string"}`                                  |
| `dst_address`               | No       | `{"type":"string"}`                                  |
| `src_port`                  | No       | `{"type":"string"}`                                  |
| `dst_port`                  | No       | `{"type":"string"}`                                  |
| `port`                      | No       | `{"type":"string"}`                                  |
| `protocol`                  | No       | `{"type":"string"}`                                  |
| `src_mac_address`           | No       | `{"type":"string"}`                                  |
| `in_interface`              | No       | `{"type":"string"}`                                  |
| `out_interface`             | No       | `{"type":"string"}`                                  |
| `in_interface_list`         | No       | `{"type":"string"}`                                  |
| `out_interface_list`        | No       | `{"type":"string"}`                                  |
| `src_address_list`          | No       | Negate with "!name" (e.g. "!IR") `{"type":"string"}` |
| `dst_address_list`          | No       | Negate with "!name" (e.g. "!IR") `{"type":"string"}` |
| `src_address_type`          | No       | `{"type":"string"}`                                  |
| `dst_address_type`          | No       | `{"type":"string"}`                                  |
| `connection_mark`           | No       | `{"type":"string"}`                                  |
| `packet_mark`               | No       | `{"type":"string"}`                                  |
| `routing_mark`              | No       | `{"type":"string"}`                                  |
| `connection_state`          | No       | `{"type":"string"}`                                  |
| `connection_nat_state`      | No       | `{"type":"string"}`                                  |
| `connection_type`           | No       | `{"type":"string"}`                                  |
| `connection_bytes`          | No       | `{"type":"string"}`                                  |
| `connection_limit`          | No       | `{"type":"string"}`                                  |
| `connection_rate`           | No       | `{"type":"string"}`                                  |
| `per_connection_classifier` | No       | `{"type":"string"}`                                  |
| `tcp_flags`                 | No       | `{"type":"string"}`                                  |
| `dscp`                      | No       | `{"type":"string"}`                                  |
| `priority`                  | No       | `{"type":"string"}`                                  |
| `packet_size`               | No       | `{"type":"string"}`                                  |
| `ttl`                       | No       | `{"type":"string"}`                                  |
| `tcp_mss`                   | No       | `{"type":"string"}`                                  |
| `fragment`                  | No       | `{"type":"boolean"}`                                 |
| `icmp_options`              | No       | `{"type":"string"}`                                  |
| `ipv4_options`              | No       | `{"type":"string"}`                                  |
| `limit`                     | No       | `{"type":"string"}`                                  |
| `dst_limit`                 | No       | `{"type":"string"}`                                  |
| `content`                   | No       | `{"type":"string"}`                                  |
| `psd`                       | No       | `{"type":"string"}`                                  |
| `layer7_protocol`           | No       | `{"type":"string"}`                                  |
| `ipsec_policy`              | No       | `{"type":"string"}`                                  |
| `nth`                       | No       | `{"type":"string"}`                                  |
| `random`                    | No       | `{"type":"string"}`                                  |
| `time`                      | No       | `{"type":"string"}`                                  |
| `hotspot`                   | No       | `{"type":"string"}`                                  |
| `p2p`                       | No       | `{"type":"string"}`                                  |
| `new_connection_mark`       | No       | `{"type":"string"}`                                  |
| `new_packet_mark`           | No       | `{"type":"string"}`                                  |
| `new_routing_mark`          | No       | `{"type":"string"}`                                  |
| `new_dscp`                  | No       | `{"type":"string"}`                                  |
| `new_ttl`                   | No       | `{"type":"string"}`                                  |
| `new_mss`                   | No       | `{"type":"string"}`                                  |
| `new_priority`              | No       | `{"type":"string"}`                                  |
| `routing_table`             | No       | `{"type":"string"}`                                  |
| `route_dst`                 | No       | `{"type":"string"}`                                  |
| `jump_target`               | No       | `{"type":"string"}`                                  |
| `sniff_target`              | No       | `{"type":"string"}`                                  |
| `sniff_target_port`         | No       | `{"type":"string"}`                                  |
| `address_list`              | No       | `{"type":"string"}`                                  |
| `address_list_timeout`      | No       | `{"type":"string"}`                                  |
| `passthrough`               | No       | `{"type":"boolean"}`                                 |
| `comment`                   | No       | `{"type":"string"}`                                  |
| `disabled`                  | No       | `{"type":"boolean"}`                                 |
| `log`                       | No       | `{"type":"boolean"}`                                 |
| `log_prefix`                | No       | `{"type":"string"}`                                  |

## remove_mangle_rule

**Remove IPv4 Firewall Mangle Rule** · Risk: **destructive**

Permanently deletes an IPv4 mangle rule (`/ip firewall mangle remove`) — verifies the rule exists first, then removes it. To only deactivate without deleting use disable_mangle_rule; for IPv6 mangle use remove_ipv6_mangle_rule. rule_id takes the `.id` from list_mangle_rules. Returns confirmation on success or a not-found message if the ID is absent.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_mangle_rule

**Move IPv4 Firewall Mangle Rule** · Risk: **write-idempotent**

Reorders an IPv4 mangle rule to a specific position (`/ip firewall mangle move`) — mangle rules are evaluated top-down, so position controls which rules fire first. For IPv4 filter reordering use move_filter_rule; for IPv6 mangle use move_ipv6_mangle_rule. rule_id takes the `.id` from list_mangle_rules; destination is the 0-based target index. Verifies the rule exists before moving.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_mangle_rule

**Enable IPv4 Firewall Mangle Rule** · Risk: **write-idempotent**

Enables a disabled IPv4 mangle rule (`/ip firewall mangle set disabled=no`) so it participates in packet processing again. To deactivate use disable_mangle_rule; to delete permanently use remove_mangle_rule; for IPv6 mangle use enable_ipv6_mangle_rule. rule_id takes the `.id` from list_mangle_rules. Returns the updated rule's detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_mangle_rule

**Disable IPv4 Firewall Mangle Rule** · Risk: **write-idempotent**

Disables an active IPv4 mangle rule (`/ip firewall mangle set disabled=yes`) — the rule remains in the table but is skipped during packet processing. To re-enable use enable_mangle_rule; to delete permanently use remove_mangle_rule; for IPv6 mangle use disable_ipv6_mangle_rule. rule_id takes the `.id` from list_mangle_rules. Returns the updated rule's detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
