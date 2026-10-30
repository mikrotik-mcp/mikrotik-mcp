---
title: "Firewall — Filter"
description: "Filter rules and a guided basic setup (`/ip firewall filter`)."
---

## Tools

- [Create Firewall Filter Rule](#create_filter_rule)
- [List Firewall Filter Rules](#list_filter_rules)
- [Get Firewall Filter Rule](#get_filter_rule)
- [Update Firewall Filter Rule](#update_filter_rule)
- [Remove Firewall Filter Rule](#remove_filter_rule)
- [Move Firewall Filter Rule](#move_filter_rule)
- [Enable Firewall Filter Rule](#enable_filter_rule)
- [Disable Firewall Filter Rule](#disable_filter_rule)
- [Create Basic Firewall Setup](#create_basic_firewall_setup)

## create_filter_rule

**Create Firewall Filter Rule** · Risk: **write**

Creates an IPv4 firewall FILTER rule (`/ip firewall filter`) — the accept/drop/reject decision table for traffic TO the router (chain=input), THROUGH it (forward) or FROM it (output). Use this to allow or block traffic. For address translation use the NAT tools, for packet marking use mangle, for pre-connection-tracking drops use raw, and for IPv6 use create_ipv6_filter_rule. `chain` also accepts a CUSTOM sub-chain name (e.g. detect-portscan) reached by an action=jump rule, and `action` supports add-src-to-address-list / add-dst-to-address-list (with `address_list` + `address_list_timeout`) for tagging/detection rules. Rule order matters (first match wins) — use place_before or move_filter_rule to position it. Returns the created rule's detail including its `.id`. connection_state: comma-separated e.g. "established,related,new,invalid". limit: RouterOS rate/burst string e.g. "10,5:packet" or "10/1s:packet". tcp_flags: RouterOS flag expression e.g. "syn,!ack". place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".

| Parameter              | Required | Definition                                                                                                                                                                                                                                                                              |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                | Yes      | The built-in `input`, `forward`, or `output` chain — OR a custom sub-chain name (e.g. `detect-portscan`). A custom chain runs only when a rule with action=jump and jump-target=<that chain> sends traffic into it; use this to build tagging/detection sub-chains. `{"type":"string"}` |
| `action`               | Yes      | `{"type":"string","enum":["accept","drop","reject","jump","log","passthrough","return","tarpit","fasttrack-connection","add-src-to-address-list","add-dst-to-address-list"]}`                                                                                                           |
| `src_address`          | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `dst_address`          | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `src_port`             | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `dst_port`             | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `protocol`             | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `in_interface`         | No       | Match by inbound interface NAME (e.g. ether1, pppoe-out1) — NOT a chain and NOT an interface list. For an interface list use in_interface_list. `{"type":"string"}`                                                                                                                     |
| `out_interface`        | No       | Match by outbound interface NAME (e.g. ether1, pppoe-out1) — NOT a chain and NOT an interface list. For an interface list use out_interface_list. `{"type":"string"}`                                                                                                                   |
| `connection_state`     | No       | Comma-separated e.g. "established,related,new,invalid" `{"type":"string"}`                                                                                                                                                                                                              |
| `connection_nat_state` | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `src_address_list`     | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `dst_address_list`     | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `limit`                | No       | RouterOS rate/burst string e.g. "10,5:packet" `{"type":"string"}`                                                                                                                                                                                                                       |
| `tcp_flags`            | No       | RouterOS flag expression e.g. "syn,!ack" `{"type":"string"}`                                                                                                                                                                                                                            |
| `src_mac_address`      | No       | Source MAC, supports ! and mask e.g. "00:11:..." `{"type":"string"}`                                                                                                                                                                                                                    |
| `in_interface_list`    | No       | Match by inbound interface list name `{"type":"string"}`                                                                                                                                                                                                                                |
| `out_interface_list`   | No       | Match by outbound interface list name `{"type":"string"}`                                                                                                                                                                                                                               |
| `port`                 | No       | Match src OR dst port(s) (protocol-agnostic) `{"type":"string"}`                                                                                                                                                                                                                        |
| `connection_mark`      | No       | Match packets with this connection mark `{"type":"string"}`                                                                                                                                                                                                                             |
| `packet_mark`          | No       | Match packets with this packet mark `{"type":"string"}`                                                                                                                                                                                                                                 |
| `routing_mark`         | No       | Match packets with this routing mark `{"type":"string"}`                                                                                                                                                                                                                                |
| `connection_type`      | No       | Conntrack helper type e.g. "ftp,sip" `{"type":"string"}`                                                                                                                                                                                                                                |
| `connection_bytes`     | No       | Total conn bytes range e.g. "1000000-0" `{"type":"string"}`                                                                                                                                                                                                                             |
| `connection_limit`     | No       | Per-address conn limit e.g. "100,32" `{"type":"string"}`                                                                                                                                                                                                                                |
| `connection_rate`      | No       | Connection rate range e.g. "0-100k" `{"type":"string"}`                                                                                                                                                                                                                                 |
| `content`              | No       | Match a literal string in the packet payload `{"type":"string"}`                                                                                                                                                                                                                        |
| `dscp`                 | No       | Match DSCP/TOS value 0-63 `{"type":"string"}`                                                                                                                                                                                                                                           |
| `layer7_protocol`      | No       | Match a /ip firewall layer7-protocol name `{"type":"string"}`                                                                                                                                                                                                                           |
| `packet_size`          | No       | Packet size or range in bytes e.g. "0-1500" `{"type":"string"}`                                                                                                                                                                                                                         |
| `ipsec_policy`         | No       | IPsec policy match e.g. "in,ipsec" or "out,none" `{"type":"string"}`                                                                                                                                                                                                                    |
| `ttl`                  | No       | TTL match e.g. "equal:64" or "less-than:5" `{"type":"string"}`                                                                                                                                                                                                                          |
| `nth`                  | No       | Match every Nth packet e.g. "2,1" `{"type":"string"}`                                                                                                                                                                                                                                   |
| `time`                 | No       | Time/day match e.g. "8h-16h,mon,tue,wed" `{"type":"string"}`                                                                                                                                                                                                                            |
| `random`               | No       | Match a packet randomly with given probability (1-99) `{"type":"string"}`                                                                                                                                                                                                               |
| `tcp_mss`              | No       | TCP MSS match e.g. "1300-1536" or "!1460" `{"type":"string"}`                                                                                                                                                                                                                           |
| `fragment`             | No       | Match non-first IP fragments `{"type":"boolean"}`                                                                                                                                                                                                                                       |
| `src_address_type`     | No       | Source address type e.g. "unicast","local" `{"type":"string"}`                                                                                                                                                                                                                          |
| `dst_address_type`     | No       | Dest address type e.g. "broadcast","multicast" `{"type":"string"}`                                                                                                                                                                                                                      |
| `hotspot`              | No       | Hotspot match e.g. "auth","from-client","local-dst" `{"type":"string"}`                                                                                                                                                                                                                 |
| `icmp_options`         | No       | ICMP type:code match e.g. "8:0" `{"type":"string"}`                                                                                                                                                                                                                                     |
| `priority`             | No       | Match packets by priority (0-63) set internally `{"type":"string"}`                                                                                                                                                                                                                     |
| `jump_target`          | No       | Target chain name when action=jump `{"type":"string"}`                                                                                                                                                                                                                                  |
| `reject_with`          | No       | ICMP/TCP reject response when action=reject `{"type":"string"}`                                                                                                                                                                                                                         |
| `address_list`         | No       | List name for add-src-to-address-list / add-dst-to-address-list actions `{"type":"string"}`                                                                                                                                                                                             |
| `address_list_timeout` | No       | Timeout for the address-list entry e.g. "1d" or "none" `{"type":"string"}`                                                                                                                                                                                                              |
| `comment`              | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `disabled`             | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                    |
| `log`                  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                    |
| `log_prefix`           | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                     |
| `place_before`         | No       | Insert before this position. Either a bare ordinal/row number (e.g. "0", "13") OR a CURRENT internal .id ("*N") from list_filter_rules. Note: a "*N" .id is hexadecimal and reassigned over time — it is NOT the row number, so "*13" ≠ the 13th rule. `{"type":"string"}`              |

## list_filter_rules

**List Firewall Filter Rules** · Risk: **read**

Lists IPv4 firewall FILTER rules (`/ip firewall filter`) in chain/match order — each with its `.id`, chain, action, matchers, comment and packet/byte counters. This is the accept/drop decision table, NOT NAT (address translation), mangle (marking) or raw (pre-conntrack); for IPv6 use list_ipv6_filter_rules. Optional filters narrow by chain, action, src/dst address, protocol or interface, or to only disabled/invalid/dynamic rules.

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

## get_filter_rule

**Get Firewall Filter Rule** · Risk: **read**

Gets the full detail of one IPv4 firewall FILTER rule (`/ip firewall filter`) by id — every matcher, action, counter and flag. For IPv6 use get_ipv6_filter_rule. rule_id: preferably the `.id` from list_filter_rules e.g. "*1F". A bare number like "3" is read as the positional ROW INDEX and resolved to whatever `.id` currently sits there — it is never treated as `.id=*3`, since a `*N` id is hex and reassigned over time. Row positions shift whenever a rule is added, removed or moved, so prefer the `.id`.

| Parameter | Required | Definition                                                                |
| --------- | -------- | ------------------------------------------------------------------------- |
| `rule_id` | Yes      | Rule .id e.g. "*1F", or bare position number e.g. "3" `{"type":"string"}` |

## update_filter_rule

**Update Firewall Filter Rule** · Risk: **write-idempotent**

Updates an existing IPv4 firewall FILTER rule (`/ip firewall filter`) in place and returns its new detail. To reorder it use move_filter_rule; to toggle it on/off use enable_filter_rule / disable_filter_rule; for IPv6 use update_ipv6_filter_rule. rule_id: the `.id` from list_filter_rules e.g. "*1" or "0". connection_state: comma-separated e.g. "established,related". limit: RouterOS rate string e.g. "10,5:packet". tcp_flags: RouterOS flag expression e.g. "syn,!ack". Pass "" to clear an optional field (e.g. src_address="").

| Parameter              | Required | Definition                                                                                                  |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `rule_id`              | Yes      | `{"type":"string"}`                                                                                         |
| `chain`                | No       | `{"type":"string"}`                                                                                         |
| `action`               | No       | `{"type":"string"}`                                                                                         |
| `src_address`          | No       | `{"type":"string"}`                                                                                         |
| `dst_address`          | No       | `{"type":"string"}`                                                                                         |
| `src_port`             | No       | `{"type":"string"}`                                                                                         |
| `dst_port`             | No       | `{"type":"string"}`                                                                                         |
| `protocol`             | No       | `{"type":"string"}`                                                                                         |
| `in_interface`         | No       | Inbound interface NAME (e.g. ether1) — not a chain; use in_interface_list for a list. `{"type":"string"}`   |
| `out_interface`        | No       | Outbound interface NAME (e.g. ether1) — not a chain; use out_interface_list for a list. `{"type":"string"}` |
| `connection_state`     | No       | `{"type":"string"}`                                                                                         |
| `connection_nat_state` | No       | `{"type":"string"}`                                                                                         |
| `src_address_list`     | No       | `{"type":"string"}`                                                                                         |
| `dst_address_list`     | No       | `{"type":"string"}`                                                                                         |
| `limit`                | No       | `{"type":"string"}`                                                                                         |
| `tcp_flags`            | No       | `{"type":"string"}`                                                                                         |
| `src_mac_address`      | No       | `{"type":"string"}`                                                                                         |
| `in_interface_list`    | No       | `{"type":"string"}`                                                                                         |
| `out_interface_list`   | No       | `{"type":"string"}`                                                                                         |
| `port`                 | No       | `{"type":"string"}`                                                                                         |
| `connection_mark`      | No       | `{"type":"string"}`                                                                                         |
| `packet_mark`          | No       | `{"type":"string"}`                                                                                         |
| `routing_mark`         | No       | `{"type":"string"}`                                                                                         |
| `connection_type`      | No       | `{"type":"string"}`                                                                                         |
| `connection_bytes`     | No       | `{"type":"string"}`                                                                                         |
| `connection_limit`     | No       | `{"type":"string"}`                                                                                         |
| `connection_rate`      | No       | `{"type":"string"}`                                                                                         |
| `content`              | No       | `{"type":"string"}`                                                                                         |
| `dscp`                 | No       | `{"type":"string"}`                                                                                         |
| `layer7_protocol`      | No       | `{"type":"string"}`                                                                                         |
| `packet_size`          | No       | `{"type":"string"}`                                                                                         |
| `ipsec_policy`         | No       | `{"type":"string"}`                                                                                         |
| `ttl`                  | No       | `{"type":"string"}`                                                                                         |
| `nth`                  | No       | `{"type":"string"}`                                                                                         |
| `time`                 | No       | `{"type":"string"}`                                                                                         |
| `random`               | No       | `{"type":"string"}`                                                                                         |
| `tcp_mss`              | No       | `{"type":"string"}`                                                                                         |
| `fragment`             | No       | `{"type":"boolean"}`                                                                                        |
| `src_address_type`     | No       | `{"type":"string"}`                                                                                         |
| `dst_address_type`     | No       | `{"type":"string"}`                                                                                         |
| `hotspot`              | No       | `{"type":"string"}`                                                                                         |
| `icmp_options`         | No       | `{"type":"string"}`                                                                                         |
| `priority`             | No       | `{"type":"string"}`                                                                                         |
| `jump_target`          | No       | `{"type":"string"}`                                                                                         |
| `reject_with`          | No       | `{"type":"string"}`                                                                                         |
| `address_list`         | No       | `{"type":"string"}`                                                                                         |
| `address_list_timeout` | No       | `{"type":"string"}`                                                                                         |
| `comment`              | No       | `{"type":"string"}`                                                                                         |
| `disabled`             | No       | `{"type":"boolean"}`                                                                                        |
| `log`                  | No       | `{"type":"boolean"}`                                                                                        |
| `log_prefix`           | No       | `{"type":"string"}`                                                                                         |

## remove_filter_rule

**Remove Firewall Filter Rule** · Risk: **destructive**

Permanently deletes one IPv4 firewall FILTER rule (`/ip firewall filter`) by id (verifies it exists first). To keep a rule but stop it matching, use disable_filter_rule instead; for IPv6 use remove_ipv6_filter_rule. rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_filter_rule

**Move Firewall Filter Rule** · Risk: **write-idempotent**

Reorders one IPv4 firewall FILTER rule (`/ip firewall filter`) within its chain. Order is significant — the first matching rule decides the packet's fate, so position an accept before a broad drop. For IPv6 use move_ipv6_filter_rule. rule_id: the `.id` from list_filter_rules e.g. "*1" or "0". destination: 0-based target position index.

| Parameter     | Required | Definition                                                                                                |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                                                                       |
| `destination` | Yes      | 0-based target position index `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## enable_filter_rule

**Enable Firewall Filter Rule** · Risk: **write-idempotent**

Enables (un-disables) one IPv4 firewall FILTER rule (`/ip firewall filter`) by id so it takes effect again. Idempotent. For IPv6 use enable_ipv6_filter_rule. rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## disable_filter_rule

**Disable Firewall Filter Rule** · Risk: **write-idempotent**

Disables one IPv4 firewall FILTER rule (`/ip firewall filter`) by id WITHOUT deleting it, so it stops matching traffic but stays in the config. Idempotent and reversible with enable_filter_rule. For IPv6 use disable_ipv6_filter_rule. rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## create_basic_firewall_setup

**Create Basic Firewall Setup** · Risk: **dangerous**

Appends a starter set of IPv4 input-chain FILTER rules (`/ip firewall filter`): accept established/related, drop invalid, accept ICMP, and a management allow — a safe baseline for a fresh router. DANGEROUS: adds several live rules at once and is NOT idempotent (running twice duplicates them). Ensure a management-allow rule precedes any drop, or you can lock yourself out — prefer plan_changes/apply_plan (Safe Mode) to stage it safely.

No tool-specific parameters.
