---
title: "IPv6 Firewall — Filter"
description: "IPv6 filter rules (`/ipv6 firewall filter`)."
---

## Tools

- [Create IPv6 Firewall Filter Rule](#create_ipv6_filter_rule)
- [List IPv6 Firewall Filter Rules](#list_ipv6_filter_rules)
- [Get IPv6 Firewall Filter Rule](#get_ipv6_filter_rule)
- [Update IPv6 Firewall Filter Rule](#update_ipv6_filter_rule)
- [Remove IPv6 Firewall Filter Rule](#remove_ipv6_filter_rule)
- [Move IPv6 Firewall Filter Rule](#move_ipv6_filter_rule)
- [Enable IPv6 Firewall Filter Rule](#enable_ipv6_filter_rule)
- [Disable IPv6 Firewall Filter Rule](#disable_ipv6_filter_rule)

## create_ipv6_filter_rule

**Create IPv6 Firewall Filter Rule** · Risk: **write**

Creates an IPv6 firewall FILTER rule (`/ipv6 firewall filter`) — the accept/drop/reject decision table for IPv6 traffic TO the router (chain=input), THROUGH it (forward), or FROM it (output). For IPv4 filter rules use create_filter_rule; for IPv6 NAT use create_ipv6_nat_rule; for IPv6 packet marking use create_ipv6_mangle_rule; for IPv6 pre-conntrack drops use create_ipv6_raw_rule. Returns the created rule's full detail including its `.id`. connection_state: comma-separated e.g. "established,related,new,invalid". hop_limit: RouterOS hop-limit expression e.g. "equal:1" or "less:64". limit: RouterOS rate/burst string e.g. "10,5:packet". tcp_flags: RouterOS flag expression e.g. "syn,!ack". place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".

| Parameter                   | Required | Definition                                                                                                                                                                    |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                     | Yes      | `{"type":"string","enum":["input","forward","output"]}`                                                                                                                       |
| `action`                    | Yes      | `{"type":"string","enum":["accept","drop","reject","jump","log","passthrough","return","tarpit","fasttrack-connection","add-src-to-address-list","add-dst-to-address-list"]}` |
| `src_address`               | No       | `{"type":"string"}`                                                                                                                                                           |
| `dst_address`               | No       | `{"type":"string"}`                                                                                                                                                           |
| `src_port`                  | No       | `{"type":"string"}`                                                                                                                                                           |
| `dst_port`                  | No       | `{"type":"string"}`                                                                                                                                                           |
| `protocol`                  | No       | `{"type":"string"}`                                                                                                                                                           |
| `in_interface`              | No       | `{"type":"string"}`                                                                                                                                                           |
| `out_interface`             | No       | `{"type":"string"}`                                                                                                                                                           |
| `in_interface_list`         | No       | `{"type":"string"}`                                                                                                                                                           |
| `out_interface_list`        | No       | `{"type":"string"}`                                                                                                                                                           |
| `connection_state`          | No       | Comma-separated e.g. "established,related,new,invalid" `{"type":"string"}`                                                                                                    |
| `src_address_list`          | No       | `{"type":"string"}`                                                                                                                                                           |
| `dst_address_list`          | No       | `{"type":"string"}`                                                                                                                                                           |
| `hop_limit`                 | No       | Hop-limit expression e.g. "equal:1" or "less:64" `{"type":"string"}`                                                                                                          |
| `limit`                     | No       | RouterOS rate/burst string e.g. "10,5:packet" `{"type":"string"}`                                                                                                             |
| `tcp_flags`                 | No       | RouterOS flag expression e.g. "syn,!ack" `{"type":"string"}`                                                                                                                  |
| `port`                      | No       | Match src or dst port (any protocol with ports) `{"type":"string"}`                                                                                                           |
| `icmp_options`              | No       | ICMPv6 type:code e.g. "128:0" `{"type":"string"}`                                                                                                                             |
| `connection_mark`           | No       | Match packets with this connection mark `{"type":"string"}`                                                                                                                   |
| `connection_type`           | No       | Match connection helper type e.g. "ftp", "sip" `{"type":"string"}`                                                                                                            |
| `connection_bytes`          | No       | Match total connection bytes range e.g. "1000000-" `{"type":"string"}`                                                                                                        |
| `connection_limit`          | No       | Limit connections per address e.g. "100,128" `{"type":"string"}`                                                                                                              |
| `connection_rate`           | No       | Match connection data rate e.g. "100k-" `{"type":"string"}`                                                                                                                   |
| `packet_mark`               | No       | Match packets with this packet mark `{"type":"string"}`                                                                                                                       |
| `routing_mark`              | No       | Match packets with this routing mark `{"type":"string"}`                                                                                                                      |
| `packet_size`               | No       | Match packet size range e.g. "1400-1500" `{"type":"string"}`                                                                                                                  |
| `dscp`                      | No       | Match DSCP (0-63) `{"type":"string"}`                                                                                                                                         |
| `ingress_priority`          | No       | Match ingress priority (0-63) `{"type":"string"}`                                                                                                                             |
| `priority`                  | No       | Match priority set by mangle (0-63) `{"type":"string"}`                                                                                                                       |
| `src_mac_address`           | No       | Match source MAC address `{"type":"string"}`                                                                                                                                  |
| `src_address_type`          | No       | Match src address type e.g. "unicast", "multicast" `{"type":"string"}`                                                                                                        |
| `dst_address_type`          | No       | Match dst address type e.g. "unicast", "multicast" `{"type":"string"}`                                                                                                        |
| `tcp_mss`                   | No       | Match TCP MSS value/range e.g. "1300-1536" `{"type":"string"}`                                                                                                                |
| `headers`                   | No       | Match IPv6 extension headers present in the packet `{"type":"string"}`                                                                                                        |
| `tls_host`                  | No       | Match TLS SNI host (glob pattern) `{"type":"string"}`                                                                                                                         |
| `content`                   | No       | Match packets containing this text `{"type":"string"}`                                                                                                                        |
| `nth`                       | No       | Match every Nth packet e.g. "2,0" `{"type":"string"}`                                                                                                                         |
| `random`                    | No       | Randomly match a percentage of packets (1-99) `{"type":"string"}`                                                                                                             |
| `time`                      | No       | Match by time/day e.g. "8h-16h,mon,tue" `{"type":"string"}`                                                                                                                   |
| `dst_limit`                 | No       | Per-destination rate limit e.g. "10,5,dst-address" `{"type":"string"}`                                                                                                        |
| `ipsec_policy`              | No       | Match IPsec policy e.g. "in,ipsec" or "out,none" `{"type":"string"}`                                                                                                          |
| `per_connection_classifier` | No       | Hash connections into buckets e.g. "both-addresses:2/0" `{"type":"string"}`                                                                                                   |
| `jump_target`               | No       | Target chain name when action=jump `{"type":"string"}`                                                                                                                        |
| `reject_with`               | No       | ICMPv6 reject response when action=reject e.g. "icmp-admin-prohibited" `{"type":"string"}`                                                                                    |
| `address_list`              | No       | Address-list name when action=add-src/dst-to-address-list `{"type":"string"}`                                                                                                 |
| `address_list_timeout`      | No       | Timeout for the added address-list entry e.g. "1d" or "none" `{"type":"string"}`                                                                                              |
| `comment`                   | No       | `{"type":"string"}`                                                                                                                                                           |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                          |
| `log`                       | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                          |
| `log_prefix`                | No       | `{"type":"string"}`                                                                                                                                                           |
| `place_before`              | No       | Rule number or ID (*N) to insert before e.g. "0" or "*3" `{"type":"string"}`                                                                                                  |

## list_ipv6_filter_rules

**List IPv6 Firewall Filter Rules** · Risk: **read**

Lists all IPv6 firewall FILTER rules (`/ipv6 firewall filter`) with optional filtering by chain, action, address, protocol, interface, or state flags. Returns the ordered rule list including `.id` values needed by get_ipv6_filter_rule, update_ipv6_filter_rule, move_ipv6_filter_rule, enable_ipv6_filter_rule, disable_ipv6_filter_rule, and remove_ipv6_filter_rule. For IPv4 filter rules use list_filter_rules; for IPv6 NAT use list_ipv6_nat_rules; for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 raw use list_ipv6_raw_rules.

| Parameter            | Required | Definition                           |
| -------------------- | -------- | ------------------------------------ |
| `chain_filter`       | No       | `{"type":"string"}`                  |
| `action_filter`      | No       | `{"type":"string"}`                  |
| `src_address_filter` | No       | `{"type":"string"}`                  |
| `dst_address_filter` | No       | `{"type":"string"}`                  |
| `protocol_filter`    | No       | `{"type":"string"}`                  |
| `interface_filter`   | No       | `{"type":"string"}`                  |
| `disabled_only`      | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`       | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`       | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_filter_rule

**Get IPv6 Firewall Filter Rule** · Risk: **read**

Fetches full detail of a single IPv6 firewall FILTER rule (`/ipv6 firewall filter print detail where .id=…`). Use when you need all fields of one specific rule rather than the full list. For the complete ordered list use list_ipv6_filter_rules; for the IPv4 equivalent use get_filter_rule. rule_id takes the `.id` from list_ipv6_filter_rules output e.g. "*1" or "0".

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_ipv6_filter_rule

**Update IPv6 Firewall Filter Rule** · Risk: **write-idempotent**

Modifies one or more fields of an existing IPv6 firewall FILTER rule (`/ipv6 firewall filter set`) then returns the updated rule detail. Only supplied fields are changed; omit a field to leave it untouched. Pass "" (empty string) to clear an optional field (e.g. src_address=""). To toggle enabled/disabled state only, prefer enable_ipv6_filter_rule or disable_ipv6_filter_rule. For the IPv4 equivalent use update_filter_rule. rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".

| Parameter                   | Required | Definition           |
| --------------------------- | -------- | -------------------- |
| `rule_id`                   | Yes      | `{"type":"string"}`  |
| `chain`                     | No       | `{"type":"string"}`  |
| `action`                    | No       | `{"type":"string"}`  |
| `src_address`               | No       | `{"type":"string"}`  |
| `dst_address`               | No       | `{"type":"string"}`  |
| `src_port`                  | No       | `{"type":"string"}`  |
| `dst_port`                  | No       | `{"type":"string"}`  |
| `protocol`                  | No       | `{"type":"string"}`  |
| `in_interface`              | No       | `{"type":"string"}`  |
| `out_interface`             | No       | `{"type":"string"}`  |
| `in_interface_list`         | No       | `{"type":"string"}`  |
| `out_interface_list`        | No       | `{"type":"string"}`  |
| `connection_state`          | No       | `{"type":"string"}`  |
| `src_address_list`          | No       | `{"type":"string"}`  |
| `dst_address_list`          | No       | `{"type":"string"}`  |
| `hop_limit`                 | No       | `{"type":"string"}`  |
| `limit`                     | No       | `{"type":"string"}`  |
| `tcp_flags`                 | No       | `{"type":"string"}`  |
| `port`                      | No       | `{"type":"string"}`  |
| `icmp_options`              | No       | `{"type":"string"}`  |
| `connection_mark`           | No       | `{"type":"string"}`  |
| `connection_type`           | No       | `{"type":"string"}`  |
| `connection_bytes`          | No       | `{"type":"string"}`  |
| `connection_limit`          | No       | `{"type":"string"}`  |
| `connection_rate`           | No       | `{"type":"string"}`  |
| `packet_mark`               | No       | `{"type":"string"}`  |
| `routing_mark`              | No       | `{"type":"string"}`  |
| `packet_size`               | No       | `{"type":"string"}`  |
| `dscp`                      | No       | `{"type":"string"}`  |
| `ingress_priority`          | No       | `{"type":"string"}`  |
| `priority`                  | No       | `{"type":"string"}`  |
| `src_mac_address`           | No       | `{"type":"string"}`  |
| `src_address_type`          | No       | `{"type":"string"}`  |
| `dst_address_type`          | No       | `{"type":"string"}`  |
| `tcp_mss`                   | No       | `{"type":"string"}`  |
| `headers`                   | No       | `{"type":"string"}`  |
| `tls_host`                  | No       | `{"type":"string"}`  |
| `content`                   | No       | `{"type":"string"}`  |
| `nth`                       | No       | `{"type":"string"}`  |
| `random`                    | No       | `{"type":"string"}`  |
| `time`                      | No       | `{"type":"string"}`  |
| `dst_limit`                 | No       | `{"type":"string"}`  |
| `ipsec_policy`              | No       | `{"type":"string"}`  |
| `per_connection_classifier` | No       | `{"type":"string"}`  |
| `jump_target`               | No       | `{"type":"string"}`  |
| `reject_with`               | No       | `{"type":"string"}`  |
| `address_list`              | No       | `{"type":"string"}`  |
| `address_list_timeout`      | No       | `{"type":"string"}`  |
| `comment`                   | No       | `{"type":"string"}`  |
| `disabled`                  | No       | `{"type":"boolean"}` |
| `log`                       | No       | `{"type":"boolean"}` |
| `log_prefix`                | No       | `{"type":"string"}`  |

## remove_ipv6_filter_rule

**Remove IPv6 Firewall Filter Rule** · Risk: **destructive**

Permanently deletes an IPv6 firewall FILTER rule (`/ipv6 firewall filter remove`) after verifying the rule exists via a count-only check. To temporarily suppress a rule without deleting it use disable_ipv6_filter_rule instead. For the IPv4 equivalent use remove_filter_rule. rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_ipv6_filter_rule

**Move IPv6 Firewall Filter Rule** · Risk: **write-idempotent**

Reorders an IPv6 firewall FILTER rule to a target position within its chain (`/ipv6 firewall filter move`). Evaluation order is top-to-bottom; use this to ensure a rule fires before or after others. For the IPv4 equivalent use move_filter_rule; for IPv6 NAT reordering use move_ipv6_nat_rule. rule_id takes the `.id` from list_ipv6_filter_rules; destination is the 0-based target position index.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_ipv6_filter_rule

**Enable IPv6 Firewall Filter Rule** · Risk: **write-idempotent**

Re-enables a previously disabled IPv6 firewall FILTER rule (`/ipv6 firewall filter set disabled=no`) without altering any other field. For the IPv4 equivalent use enable_filter_rule; to disable use disable_ipv6_filter_rule; to change other fields use update_ipv6_filter_rule. rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_ipv6_filter_rule

**Disable IPv6 Firewall Filter Rule** · Risk: **write-idempotent**

Temporarily disables an IPv6 firewall FILTER rule (`/ipv6 firewall filter set disabled=yes`) without deleting it — the rule remains in the list but is skipped during packet evaluation. For the IPv4 equivalent use disable_filter_rule; to re-enable use enable_ipv6_filter_rule; to permanently remove use remove_ipv6_filter_rule. rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
