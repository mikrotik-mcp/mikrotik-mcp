---
title: "Firewall — NAT"
description: "NAT rules: src/dst-nat, masquerade, redirect (`/ip firewall nat`)."
---

## Tools

- [Create IPv4 Firewall NAT Rule](#create_nat_rule)
- [List IPv4 Firewall NAT Rules](#list_nat_rules)
- [Get IPv4 Firewall NAT Rule Details](#get_nat_rule)
- [Update IPv4 Firewall NAT Rule](#update_nat_rule)
- [Remove IPv4 Firewall NAT Rule](#remove_nat_rule)
- [Move IPv4 Firewall NAT Rule](#move_nat_rule)
- [Enable IPv4 Firewall NAT Rule](#enable_nat_rule)
- [Disable IPv4 Firewall NAT Rule](#disable_nat_rule)

## create_nat_rule

**Create IPv4 Firewall NAT Rule** · Risk: **write**

Creates an IPv4 NAT rule (`/ip firewall nat add`) — the address-translation table for outbound masquerade or source NAT (chain=srcnat: actions masquerade, src-nat, netmap, same) and for port-forwarding or destination NAT (chain=dstnat: actions dst-nat, redirect, netmap, same). For accept/drop/reject packet filtering use create_filter_rule; for IPv6 NAT use create_ipv6_nat_rule. Returns the created rule's detail including its `.id`. to_addresses: single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10". to_ports: single port or range e.g. "8080" or "8080-8090". place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".

| Parameter                   | Required | Definition                                                                                 |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `chain`                     | Yes      | `{"type":"string","enum":["srcnat","dstnat"]}`                                             |
| `action`                    | Yes      | `{"type":"string"}`                                                                        |
| `src_address`               | No       | `{"type":"string"}`                                                                        |
| `dst_address`               | No       | `{"type":"string"}`                                                                        |
| `src_port`                  | No       | `{"type":"string"}`                                                                        |
| `dst_port`                  | No       | `{"type":"string"}`                                                                        |
| `protocol`                  | No       | `{"type":"string"}`                                                                        |
| `in_interface`              | No       | Negatable, e.g. "!ether1" `{"type":"string"}`                                              |
| `out_interface`             | No       | `{"type":"string"}`                                                                        |
| `in_interface_list`         | No       | Interface list, e.g. "WAN" or "!LAN" `{"type":"string"}`                                   |
| `out_interface_list`        | No       | `{"type":"string"}`                                                                        |
| `src_address_list`          | No       | Match src in a named list; negate "!name" `{"type":"string"}`                              |
| `dst_address_list`          | No       | Match dst in a named list; negate "!name" `{"type":"string"}`                              |
| `connection_mark`           | No       | `{"type":"string"}`                                                                        |
| `connection_nat_state`      | No       | "srcnat" / "dstnat" / "!dstnat" `{"type":"string"}`                                        |
| `connection_state`          | No       | Match conn state, e.g. "new" / "established,related" / "!invalid" `{"type":"string"}`      |
| `connection_type`           | No       | Match helper-detected conn type, e.g. "ftp" / "sip" `{"type":"string"}`                    |
| `connection_bytes`          | No       | Total conn bytes range, e.g. "1000000-" `{"type":"string"}`                                |
| `connection_limit`          | No       | Per-address conn limit, e.g. "100,32" `{"type":"string"}`                                  |
| `connection_rate`           | No       | Conn rate range, e.g. "0-100k" `{"type":"string"}`                                         |
| `port`                      | No       | Match src OR dst port (any protocol with ports) `{"type":"string"}`                        |
| `src_mac_address`           | No       | Source MAC, negate "!AA:BB:.." `{"type":"string"}`                                         |
| `packet_mark`               | No       | Match a packet mark set in mangle `{"type":"string"}`                                      |
| `routing_mark`              | No       | Match a routing mark set in mangle `{"type":"string"}`                                     |
| `src_address_type`          | No       | "unicast" / "local" / "broadcast" / etc. `{"type":"string"}`                               |
| `dst_address_type`          | No       | "unicast" / "local" / "broadcast" / etc. `{"type":"string"}`                               |
| `in_bridge_port`            | No       | Ingress bridge port (bridge-filtered) `{"type":"string"}`                                  |
| `out_bridge_port`           | No       | Egress bridge port (bridge-filtered) `{"type":"string"}`                                   |
| `in_bridge_port_list`       | No       | Ingress bridge port list `{"type":"string"}`                                               |
| `out_bridge_port_list`      | No       | Egress bridge port list `{"type":"string"}`                                                |
| `icmp_options`              | No       | ICMP type:code, e.g. "8:0" `{"type":"string"}`                                             |
| `ipsec_policy`              | No       | e.g. "in,ipsec" / "out,none" `{"type":"string"}`                                           |
| `layer7_protocol`           | No       | Name of an /ip firewall layer7-protocol `{"type":"string"}`                                |
| `content`                   | No       | Match a literal string in the packet payload `{"type":"string"}`                           |
| `dscp`                      | No       | DSCP value 0-63 `{"type":"string"}`                                                        |
| `priority`                  | No       | Match packet priority (queue/VLAN) `{"type":"string"}`                                     |
| `tcp_flags`                 | No       | e.g. "syn,!ack" `{"type":"string"}`                                                        |
| `tcp_mss`                   | No       | TCP MSS range, e.g. "1440-1500" `{"type":"string"}`                                        |
| `packet_size`               | No       | Packet size range, e.g. "1500" or "0-500" `{"type":"string"}`                              |
| `limit`                     | No       | Rate limit, e.g. "10,5:packet" `{"type":"string"}`                                         |
| `nth`                       | No       | Every Nth packet, e.g. "2,0" `{"type":"string"}`                                           |
| `psd`                       | No       | Port-scan detection params `{"type":"string"}`                                             |
| `random`                    | No       | Match packet randomly with given probability % (1-99) `{"type":"string"}`                  |
| `per_connection_classifier` | No       | PCC classifier, e.g. "both-addresses:2/0" `{"type":"string"}`                              |
| `time`                      | No       | Time/day matcher, e.g. "8h-16h,mon,tue,wed,thu,fri" `{"type":"string"}`                    |
| `ttl`                       | No       | IP TTL matcher, e.g. "equal:64" `{"type":"string"}`                                        |
| `hotspot`                   | No       | Hotspot state, e.g. "auth" / "!auth" `{"type":"string"}`                                   |
| `jump_target`               | No       | Target chain name when action=jump `{"type":"string"}`                                     |
| `address_list`              | No       | List name for action=add-src-to-address-list / add-dst-to-address-list `{"type":"string"}` |
| `address_list_timeout`      | No       | Timeout for the address-list entry, e.g. "1h" or "none" `{"type":"string"}`                |
| `fragment`                  | No       | Match non-first IP fragments `{"type":"boolean"}`                                          |
| `to_addresses`              | No       | Single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10" `{"type":"string"}`             |
| `to_ports`                  | No       | Single port or range e.g. "8080" or "8080-8090" `{"type":"string"}`                        |
| `comment`                   | No       | `{"type":"string"}`                                                                        |
| `disabled`                  | Yes      | `{"default":false,"type":"boolean"}`                                                       |
| `log`                       | Yes      | `{"default":false,"type":"boolean"}`                                                       |
| `log_prefix`                | No       | `{"type":"string"}`                                                                        |
| `place_before`              | No       | Rule number or ID (*N) to insert before e.g. "0" or "*3" `{"type":"string"}`               |

## list_nat_rules

**List IPv4 Firewall NAT Rules** · Risk: **read**

Lists IPv4 NAT rules (`/ip firewall nat print`) — returns all srcnat and dstnat rules, optionally filtered by chain, action, address, protocol, or interface. Use the returned `.id` values with get_nat_rule, update_nat_rule, move_nat_rule, enable_nat_rule, disable_nat_rule, and remove_nat_rule. For IPv6 NAT rules use list_ipv6_nat_rules; for IPv4 filter rules use list_filter_rules.

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

## get_nat_rule

**Get IPv4 Firewall NAT Rule Details** · Risk: **read**

Fetches full detail for a single IPv4 NAT rule (`/ip firewall nat print detail where .id=<rule_id>`). Returns chain, action, address matchers, port matchers, to-addresses, to-ports, and rule flags for that rule. rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0". To list all rules use list_nat_rules; for IPv6 NAT use get_ipv6_nat_rule.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `rule_id` | Yes      | Rule ID from list output e.g. "*1" or "0" `{"type":"string"}` |

## update_nat_rule

**Update IPv4 Firewall NAT Rule** · Risk: **write-idempotent**

Modifies fields of an existing IPv4 NAT rule (`/ip firewall nat set`) without recreating it. rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule's full detail. For IPv6 NAT use update_ipv6_nat_rule; to toggle enabled state only use enable_nat_rule or disable_nat_rule. to_addresses: single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10". to_ports: single port or range e.g. "8080" or "8080-8090". Pass "" to clear an optional field.

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
| `connection_mark`           | No       | `{"type":"string"}`                     |
| `connection_nat_state`      | No       | `{"type":"string"}`                     |
| `connection_state`          | No       | `{"type":"string"}`                     |
| `connection_type`           | No       | `{"type":"string"}`                     |
| `connection_bytes`          | No       | `{"type":"string"}`                     |
| `connection_limit`          | No       | `{"type":"string"}`                     |
| `connection_rate`           | No       | `{"type":"string"}`                     |
| `port`                      | No       | `{"type":"string"}`                     |
| `src_mac_address`           | No       | `{"type":"string"}`                     |
| `packet_mark`               | No       | `{"type":"string"}`                     |
| `routing_mark`              | No       | `{"type":"string"}`                     |
| `src_address_type`          | No       | `{"type":"string"}`                     |
| `dst_address_type`          | No       | `{"type":"string"}`                     |
| `in_bridge_port`            | No       | `{"type":"string"}`                     |
| `out_bridge_port`           | No       | `{"type":"string"}`                     |
| `in_bridge_port_list`       | No       | `{"type":"string"}`                     |
| `out_bridge_port_list`      | No       | `{"type":"string"}`                     |
| `icmp_options`              | No       | `{"type":"string"}`                     |
| `ipsec_policy`              | No       | `{"type":"string"}`                     |
| `layer7_protocol`           | No       | `{"type":"string"}`                     |
| `content`                   | No       | `{"type":"string"}`                     |
| `dscp`                      | No       | `{"type":"string"}`                     |
| `priority`                  | No       | `{"type":"string"}`                     |
| `tcp_flags`                 | No       | `{"type":"string"}`                     |
| `tcp_mss`                   | No       | `{"type":"string"}`                     |
| `packet_size`               | No       | `{"type":"string"}`                     |
| `limit`                     | No       | `{"type":"string"}`                     |
| `nth`                       | No       | `{"type":"string"}`                     |
| `psd`                       | No       | `{"type":"string"}`                     |
| `random`                    | No       | `{"type":"string"}`                     |
| `per_connection_classifier` | No       | `{"type":"string"}`                     |
| `time`                      | No       | `{"type":"string"}`                     |
| `ttl`                       | No       | `{"type":"string"}`                     |
| `hotspot`                   | No       | `{"type":"string"}`                     |
| `jump_target`               | No       | `{"type":"string"}`                     |
| `address_list`              | No       | `{"type":"string"}`                     |
| `address_list_timeout`      | No       | `{"type":"string"}`                     |
| `fragment`                  | No       | `{"type":"boolean"}`                    |
| `to_addresses`              | No       | `{"type":"string"}`                     |
| `to_ports`                  | No       | `{"type":"string"}`                     |
| `comment`                   | No       | `{"type":"string"}`                     |
| `disabled`                  | No       | `{"type":"boolean"}`                    |
| `log`                       | No       | `{"type":"boolean"}`                    |
| `log_prefix`                | No       | `{"type":"string"}`                     |

## remove_nat_rule

**Remove IPv4 Firewall NAT Rule** · Risk: **destructive**

Permanently deletes an IPv4 NAT rule (`/ip firewall nat remove`). Verifies existence with a count-only check before deleting; returns an error if the rule is not found. rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0". To disable without deleting use disable_nat_rule; for IPv6 NAT use remove_ipv6_nat_rule.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_nat_rule

**Move IPv4 Firewall NAT Rule** · Risk: **write-idempotent**

Reorders an IPv4 NAT rule within the NAT chain (`/ip firewall nat move`). NAT rules are evaluated top to bottom and the first match wins, so position matters. rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; destination is the 0-based target position index. For filter rule reordering use move_filter_rule; for IPv6 NAT reordering use move_ipv6_nat_rule.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_nat_rule

**Enable IPv4 Firewall NAT Rule** · Risk: **write-idempotent**

Re-enables a disabled IPv4 NAT rule (`/ip firewall nat set disabled=no`). rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule detail. To disable use disable_nat_rule; to edit other fields use update_nat_rule; for IPv6 NAT use enable_ipv6_nat_rule.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_nat_rule

**Disable IPv4 Firewall NAT Rule** · Risk: **write-idempotent**

Disables an active IPv4 NAT rule without removing it (`/ip firewall nat set disabled=yes`). rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule detail after disabling. To re-enable use enable_nat_rule; to permanently delete use remove_nat_rule; for IPv6 NAT use disable_ipv6_nat_rule.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |
