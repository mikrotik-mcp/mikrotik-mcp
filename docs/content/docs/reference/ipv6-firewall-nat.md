---
title: "IPv6 Firewall — NAT"
description: "IPv6 NAT rules: src-nat, dst-nat, masquerade, netmap (`/ipv6 firewall nat`)."
---

## Tools

- [Create IPv6 Firewall NAT Rule](#create_ipv6_nat_rule)
- [List IPv6 Firewall NAT Rules](#list_ipv6_nat_rules)
- [Get IPv6 Firewall NAT Rule](#get_ipv6_nat_rule)
- [Update IPv6 Firewall NAT Rule](#update_ipv6_nat_rule)
- [Remove IPv6 Firewall NAT Rule](#remove_ipv6_nat_rule)
- [Move IPv6 Firewall NAT Rule](#move_ipv6_nat_rule)
- [Enable IPv6 Firewall NAT Rule](#enable_ipv6_nat_rule)
- [Disable IPv6 Firewall NAT Rule](#disable_ipv6_nat_rule)

## create_ipv6_nat_rule

**Create IPv6 Firewall NAT Rule** · Risk: **write**

Creates an IPv6 NAT rule (`/ipv6 firewall nat add`) — the address/port translation table for IPv6 traffic, used to redirect or masquerade connections. chain: 'srcnat' (applied after routing, for outbound traffic) or 'dstnat' (applied before routing, for inbound traffic). action: masquerade/src-nat/dst-nat/netmap/redirect/accept/drop/return/jump/passthrough/log. to_address: rewrite target for src-nat/dst-nat/netmap. place_before: rule number or ID (*N) to insert before a specific position. For IPv4 NAT use create_nat_rule; for IPv6 packet filtering use create_ipv6_filter_rule; for IPv6 traffic marking use create_ipv6_mangle_rule; for IPv6 pre-connection-tracking drops use create_ipv6_raw_rule. Returns the created rule's full detail including its `.id`.

| Parameter                   | Required | Definition                                                                                                                                                                                |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                     | Yes      | `{"type":"string","enum":["srcnat","dstnat"]}`                                                                                                                                            |
| `action`                    | Yes      | `{"type":"string","enum":["accept","drop","masquerade","src-nat","dst-nat","netmap","redirect","return","jump","passthrough","log","add-src-to-address-list","add-dst-to-address-list"]}` |
| `src_address`               | No       | `{"type":"string"}`                                                                                                                                                                       |
| `dst_address`               | No       | `{"type":"string"}`                                                                                                                                                                       |
| `src_port`                  | No       | `{"type":"string"}`                                                                                                                                                                       |
| `dst_port`                  | No       | `{"type":"string"}`                                                                                                                                                                       |
| `protocol`                  | No       | `{"type":"string"}`                                                                                                                                                                       |
| `in_interface`              | No       | `{"type":"string"}`                                                                                                                                                                       |
| `out_interface`             | No       | `{"type":"string"}`                                                                                                                                                                       |
| `to_address`                | No       | `{"type":"string"}`                                                                                                                                                                       |
| `to_ports`                  | No       | `{"type":"string"}`                                                                                                                                                                       |
| `src_address_list`          | No       | `{"type":"string"}`                                                                                                                                                                       |
| `dst_address_list`          | No       | `{"type":"string"}`                                                                                                                                                                       |
| `in_interface_list`         | No       | Ingress interface list, e.g. "WAN" or "!LAN" `{"type":"string"}`                                                                                                                          |
| `out_interface_list`        | No       | Egress interface list `{"type":"string"}`                                                                                                                                                 |
| `src_address_type`          | No       | "unicast" / "local" / "multicast" / etc. `{"type":"string"}`                                                                                                                              |
| `dst_address_type`          | No       | "unicast" / "local" / "multicast" / etc. `{"type":"string"}`                                                                                                                              |
| `src_mac_address`           | No       | Source MAC, negate "!AA:BB:.." `{"type":"string"}`                                                                                                                                        |
| `port`                      | No       | Match src OR dst port (any protocol with ports) `{"type":"string"}`                                                                                                                       |
| `connection_mark`           | No       | Match a connection mark set in mangle `{"type":"string"}`                                                                                                                                 |
| `connection_state`          | No       | e.g. "new" / "established,related" / "!invalid" `{"type":"string"}`                                                                                                                       |
| `connection_type`           | No       | Helper-detected conn type, e.g. "ftp" / "sip" `{"type":"string"}`                                                                                                                         |
| `connection_bytes`          | No       | Total conn bytes range, e.g. "1000000-" `{"type":"string"}`                                                                                                                               |
| `connection_limit`          | No       | Per-address conn limit, e.g. "100,64" `{"type":"string"}`                                                                                                                                 |
| `connection_rate`           | No       | Conn rate range, e.g. "0-100k" `{"type":"string"}`                                                                                                                                        |
| `packet_mark`               | No       | Match a packet mark set in mangle `{"type":"string"}`                                                                                                                                     |
| `routing_mark`              | No       | Match a routing mark set in mangle `{"type":"string"}`                                                                                                                                    |
| `icmp_options`              | No       | ICMPv6 type:code, e.g. "128:0" `{"type":"string"}`                                                                                                                                        |
| `ipsec_policy`              | No       | e.g. "in,ipsec" / "out,none" `{"type":"string"}`                                                                                                                                          |
| `content`                   | No       | Match a literal string in the packet payload `{"type":"string"}`                                                                                                                          |
| `dscp`                      | No       | DSCP value 0-63 `{"type":"string"}`                                                                                                                                                       |
| `priority`                  | No       | Match packet priority (queue/VLAN) `{"type":"string"}`                                                                                                                                    |
| `tcp_flags`                 | No       | e.g. "syn,!ack" `{"type":"string"}`                                                                                                                                                       |
| `tcp_mss`                   | No       | TCP MSS range, e.g. "1440-1500" `{"type":"string"}`                                                                                                                                       |
| `packet_size`               | No       | Packet size range, e.g. "1500" or "0-500" `{"type":"string"}`                                                                                                                             |
| `hop_limit`                 | No       | IPv6 hop-limit matcher, e.g. "equal:64" `{"type":"string"}`                                                                                                                               |
| `headers`                   | No       | Match IPv6 extension headers `{"type":"string"}`                                                                                                                                          |
| `limit`                     | No       | Rate limit, e.g. "10,5:packet" `{"type":"string"}`                                                                                                                                        |
| `dst_limit`                 | No       | Per-dst rate limit, e.g. "10,5,dst-address/1m" `{"type":"string"}`                                                                                                                        |
| `nth`                       | No       | Every Nth packet, e.g. "2,0" `{"type":"string"}`                                                                                                                                          |
| `random`                    | No       | Match packet randomly with given probability % (1-99) `{"type":"string"}`                                                                                                                 |
| `per_connection_classifier` | No       | PCC classifier, e.g. "both-addresses:2/0" `{"type":"string"}`                                                                                                                             |
| `time`                      | No       | Time/day matcher, e.g. "8h-16h,mon,tue,wed,thu,fri" `{"type":"string"}`                                                                                                                   |
| `jump_target`               | No       | Target chain name when action=jump `{"type":"string"}`                                                                                                                                    |
| `address_list`              | No       | List name for add-src-to-address-list / add-dst-to-address-list `{"type":"string"}`                                                                                                       |
| `address_list_timeout`      | No       | Timeout for the address-list entry, e.g. "1h" or "none" `{"type":"string"}`                                                                                                               |
| `comment`                   | No       | `{"type":"string"}`                                                                                                                                                                       |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                      |
| `log`                       | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                      |
| `log_prefix`                | No       | `{"type":"string"}`                                                                                                                                                                       |
| `place_before`              | No       | Rule number or ID (*N) to insert before `{"type":"string"}`                                                                                                                               |

## list_ipv6_nat_rules

**List IPv6 Firewall NAT Rules** · Risk: **read**

Lists IPv6 NAT rules (`/ipv6 firewall nat print`) with optional filters — use to inspect all address/port translation rules in the srcnat or dstnat chain. Filters: chain_filter, action_filter, src_address_filter, dst_address_filter, disabled_only, invalid_only, dynamic_only. For a single rule's full detail use get_ipv6_nat_rule. For IPv4 NAT use list_nat_rules; for IPv6 filter rules use list_ipv6_filter_rules; for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 raw use list_ipv6_raw_rules. Returns matching rule list with `.id` values needed by get_ipv6_nat_rule, update_ipv6_nat_rule, remove_ipv6_nat_rule, move_ipv6_nat_rule, enable_ipv6_nat_rule, and disable_ipv6_nat_rule.

| Parameter            | Required | Definition                           |
| -------------------- | -------- | ------------------------------------ |
| `chain_filter`       | No       | `{"type":"string"}`                  |
| `action_filter`      | No       | `{"type":"string"}`                  |
| `src_address_filter` | No       | `{"type":"string"}`                  |
| `dst_address_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`      | Yes      | `{"default":false,"type":"boolean"}` |
| `invalid_only`       | Yes      | `{"default":false,"type":"boolean"}` |
| `dynamic_only`       | Yes      | `{"default":false,"type":"boolean"}` |

## get_ipv6_nat_rule

**Get IPv6 Firewall NAT Rule** · Risk: **read**

Fetches full detail of a single IPv6 NAT rule (`/ipv6 firewall nat print detail where .id=...`) — use when you need all fields of one rule rather than scanning the full list. rule_id takes the `.id` value from list_ipv6_nat_rules (e.g. "*1" or "0"). For IPv4 use get_nat_rule; for the IPv6 filter table use get_ipv6_filter_rule. Returns all fields for the matched rule, or a not-found message if the ID does not exist.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_ipv6_nat_rule

**Update IPv6 Firewall NAT Rule** · Risk: **write-idempotent**

Modifies fields of an existing IPv6 NAT rule (`/ipv6 firewall nat set`) — use to change action, addresses, ports, chain, or flags without removing and recreating the rule. rule_id takes the `.id` from list_ipv6_nat_rules. Pass "" for any optional field to clear it (e.g. to_address=""). For IPv4 use update_nat_rule; for the IPv6 filter table use update_ipv6_filter_rule. To only toggle active state use enable_ipv6_nat_rule or disable_ipv6_nat_rule. Returns the updated rule's full detail.

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
| `to_address`                | No       | `{"type":"string"}`  |
| `to_ports`                  | No       | `{"type":"string"}`  |
| `src_address_list`          | No       | `{"type":"string"}`  |
| `dst_address_list`          | No       | `{"type":"string"}`  |
| `in_interface_list`         | No       | `{"type":"string"}`  |
| `out_interface_list`        | No       | `{"type":"string"}`  |
| `src_address_type`          | No       | `{"type":"string"}`  |
| `dst_address_type`          | No       | `{"type":"string"}`  |
| `src_mac_address`           | No       | `{"type":"string"}`  |
| `port`                      | No       | `{"type":"string"}`  |
| `connection_mark`           | No       | `{"type":"string"}`  |
| `connection_state`          | No       | `{"type":"string"}`  |
| `connection_type`           | No       | `{"type":"string"}`  |
| `connection_bytes`          | No       | `{"type":"string"}`  |
| `connection_limit`          | No       | `{"type":"string"}`  |
| `connection_rate`           | No       | `{"type":"string"}`  |
| `packet_mark`               | No       | `{"type":"string"}`  |
| `routing_mark`              | No       | `{"type":"string"}`  |
| `icmp_options`              | No       | `{"type":"string"}`  |
| `ipsec_policy`              | No       | `{"type":"string"}`  |
| `content`                   | No       | `{"type":"string"}`  |
| `dscp`                      | No       | `{"type":"string"}`  |
| `priority`                  | No       | `{"type":"string"}`  |
| `tcp_flags`                 | No       | `{"type":"string"}`  |
| `tcp_mss`                   | No       | `{"type":"string"}`  |
| `packet_size`               | No       | `{"type":"string"}`  |
| `hop_limit`                 | No       | `{"type":"string"}`  |
| `headers`                   | No       | `{"type":"string"}`  |
| `limit`                     | No       | `{"type":"string"}`  |
| `dst_limit`                 | No       | `{"type":"string"}`  |
| `nth`                       | No       | `{"type":"string"}`  |
| `random`                    | No       | `{"type":"string"}`  |
| `per_connection_classifier` | No       | `{"type":"string"}`  |
| `time`                      | No       | `{"type":"string"}`  |
| `jump_target`               | No       | `{"type":"string"}`  |
| `address_list`              | No       | `{"type":"string"}`  |
| `address_list_timeout`      | No       | `{"type":"string"}`  |
| `comment`                   | No       | `{"type":"string"}`  |
| `disabled`                  | No       | `{"type":"boolean"}` |
| `log`                       | No       | `{"type":"boolean"}` |
| `log_prefix`                | No       | `{"type":"string"}`  |

## remove_ipv6_nat_rule

**Remove IPv6 Firewall NAT Rule** · Risk: **destructive**

Permanently deletes an IPv6 NAT rule (`/ipv6 firewall nat remove`) — use to remove a translation entry entirely. First verifies the rule exists via a count-only check; returns a not-found message if absent. rule_id takes the `.id` from list_ipv6_nat_rules. For IPv4 use remove_nat_rule; for the IPv6 filter table use remove_ipv6_filter_rule. To temporarily deactivate instead of delete, use disable_ipv6_nat_rule.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_ipv6_nat_rule

**Move IPv6 Firewall NAT Rule** · Risk: **write-idempotent**

Repositions an IPv6 NAT rule to a different ordinal slot (`/ipv6 firewall nat move ... destination=N`) — NAT rules are evaluated top-to-bottom so position controls which rule matches first. destination is a 0-based integer index. rule_id takes the `.id` from list_ipv6_nat_rules. For IPv4 use move_nat_rule; for the IPv6 filter table use move_ipv6_filter_rule. Confirms success or returns the error message from the device.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_ipv6_nat_rule

**Enable IPv6 Firewall NAT Rule** · Risk: **write-idempotent**

Re-activates a disabled IPv6 NAT rule (`/ipv6 firewall nat set ... disabled=no`) — use to restore a rule that was previously disabled without recreating it. rule_id takes the `.id` from list_ipv6_nat_rules. To deactivate use disable_ipv6_nat_rule; to permanently delete use remove_ipv6_nat_rule. For IPv4 NAT use enable_nat_rule. Returns the updated rule's full detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_ipv6_nat_rule

**Disable IPv6 Firewall NAT Rule** · Risk: **write-idempotent**

Temporarily deactivates an IPv6 NAT rule (`/ipv6 firewall nat set ... disabled=yes`) without removing it — use to suspend a translation rule while preserving its configuration. rule_id takes the `.id` from list_ipv6_nat_rules. To re-activate use enable_ipv6_nat_rule; to permanently delete use remove_ipv6_nat_rule. For IPv4 NAT use disable_nat_rule. Returns the updated rule's full detail.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
