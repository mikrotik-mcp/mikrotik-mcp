---
title: "Simulator"
description: "Offline packet simulator: trace a hypothetical packet through NAT, routing and firewall against a config snapshot — no device touched. Reports UNKNOWN rather than guessing when the path crosses something it does not model."
---

## Tools

- [Verify a Filter Policy over Address and Port Sets](#verify_filter_policy)
- [Simulate a Packet](#simulate_packet)
- [Simulate a Config Change](#simulate_change)
- [Explain Firewall Rule Reachability](#explain_rule_reachability)
- [Run a Packet Suite](#simulate_suite)

## verify_filter_policy

**Verify a Filter Policy over Address and Port Sets** · Risk: **read**

Exhaustively checks IPv4 source/destination ranges and port ranges using equivalence partitions, not sampling. Returns proved, violated with a counterexample and rule trace, or unknown. Supplied static export only; packet fields are at filter-chain entry, AFTER any destination NAT. This is NOT routing/NAT/IPv6/conntrack verification and cannot prove no WAN leak. Unsupported constructs, dynamic lists or >4096 cells fail closed to unknown. No router I/O.

| Parameter           | Required | Definition                                                                           |
| ------------------- | -------- | ------------------------------------------------------------------------------------ |
| `config_text`       | Yes      | `{"type":"string","minLength":1,"maxLength":200000}`                                 |
| `source`            | Yes      | `{"type":"string","maxLength":64}`                                                   |
| `destination`       | Yes      | `{"type":"string","maxLength":64}`                                                   |
| `source_ports`      | Yes      | `{"default":"0-65535","type":"string","maxLength":64}`                               |
| `destination_ports` | Yes      | `{"default":"0-65535","type":"string","maxLength":64}`                               |
| `protocol`          | Yes      | `{"default":"tcp","type":"string","enum":["tcp","udp"]}`                             |
| `chain`             | Yes      | `{"default":"forward","type":"string","enum":["input","forward","output"]}`          |
| `in_interface`      | Yes      | `{"default":"bridge","type":"string","maxLength":128}`                               |
| `out_interface`     | Yes      | `{"default":"ether1","type":"string","maxLength":128}`                               |
| `connection_state`  | Yes      | `{"default":"new","type":"string","enum":["new","established","related","invalid"]}` |
| `expect`            | Yes      | `{"default":"drop","type":"string","enum":["accept","drop","reject"]}`               |

## simulate_packet

**Simulate a Packet** · Risk: **read**

Traces a hypothetical packet through the router's NAT, routing and firewall — WITHOUT sending anything or changing anything. Answers 'would this get through, and which rule decides?' before Safe Mode is ever opened. Returns a step-by-step traversal naming each rule's chain, index and source line, so the reasoning can be checked rather than trusted. Reads a stored snapshot (`snapshot_id`), supplied text (`config_text`), or captures the live config with a read-only `/export terse`. Models IPv4 filter/NAT/routing only: no raw table, no queues, no layer7, no IPv6, and no live connection tracking (`connection_state` is declared by you, not inferred). Anything on the path that is out of scope downgrades the verdict to UNKNOWN rather than guessing.

| Parameter          | Required | Definition                                                                                                                                                |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src_address`      | Yes      | Source IPv4 address, e.g. "192.168.88.50" `{"type":"string"}`                                                                                             |
| `dst_address`      | Yes      | Destination IPv4 address, e.g. "8.8.8.8" `{"type":"string"}`                                                                                              |
| `protocol`         | Yes      | "tcp", "udp", "icmp" or a protocol number `{"default":"tcp","type":"string"}`                                                                             |
| `src_port`         | No       | `{"type":"integer","minimum":0,"maximum":65535}`                                                                                                          |
| `dst_port`         | No       | `{"type":"integer","minimum":0,"maximum":65535}`                                                                                                          |
| `in_interface`     | Yes      | Interface the packet arrives on, e.g. `bridge` `{"type":"string"}`                                                                                        |
| `connection_state` | Yes      | DECLARED, not inferred — this model has no connection-tracking table `{"default":"new","type":"string","enum":["new","established","related","invalid"]}` |
| `connection_mark`  | No       | `{"type":"string"}`                                                                                                                                       |
| `snapshot_id`      | No       | Evaluate against a stored snapshot `{"type":"string"}`                                                                                                    |
| `config_text`      | No       | Evaluate against raw `/export` text `{"type":"string"}`                                                                                                   |

## simulate_change

**Simulate a Config Change** · Risk: **read**

Applies proposed configuration lines to a COPY of the config in memory, re-traces the same packet, and reports whether the verdict changed and at which step the paths diverged. This is the tool for 'would this rule break the VPN?' — pair it with plan_changes so a change is evaluated before it is applied. Nothing is sent to any device: the change exists only inside this simulation. Models IPv4 filter/NAT/routing only: no raw table, no queues, no layer7, no IPv6, and no live connection tracking (`connection_state` is declared by you, not inferred). Anything on the path that is out of scope downgrades the verdict to UNKNOWN rather than guessing.

| Parameter          | Required | Definition                                                                                                                                                |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src_address`      | Yes      | Source IPv4 address, e.g. "192.168.88.50" `{"type":"string"}`                                                                                             |
| `dst_address`      | Yes      | Destination IPv4 address, e.g. "8.8.8.8" `{"type":"string"}`                                                                                              |
| `protocol`         | Yes      | "tcp", "udp", "icmp" or a protocol number `{"default":"tcp","type":"string"}`                                                                             |
| `src_port`         | No       | `{"type":"integer","minimum":0,"maximum":65535}`                                                                                                          |
| `dst_port`         | No       | `{"type":"integer","minimum":0,"maximum":65535}`                                                                                                          |
| `in_interface`     | Yes      | Interface the packet arrives on, e.g. `bridge` `{"type":"string"}`                                                                                        |
| `connection_state` | Yes      | DECLARED, not inferred — this model has no connection-tracking table `{"default":"new","type":"string","enum":["new","established","related","invalid"]}` |
| `connection_mark`  | No       | `{"type":"string"}`                                                                                                                                       |
| `changes`          | Yes      | Proposed export lines, e.g. `/ip firewall filter` then `add action=drop ...` `{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"string"}]}`   |
| `snapshot_id`      | No       | `{"type":"string"}`                                                                                                                                       |
| `config_text`      | No       | `{"type":"string"}`                                                                                                                                       |

## explain_rule_reachability

**Explain Firewall Rule Reachability** · Risk: **read**

Static analysis, no packet needed: which firewall rules can NEVER match because an earlier terminal rule in the same chain already matches everything they would? Deliberately conservative — only an exact-superset relation counts, because a false 'this rule is dead' gets a working rule deleted, which is worse than missing one. Complements firewall_audit's shadow detection with the simulator's own matcher model.

| Parameter     | Required | Definition                                              |
| ------------- | -------- | ------------------------------------------------------- |
| `snapshot_id` | No       | `{"type":"string"}`                                     |
| `config_text` | No       | `{"type":"string"}`                                     |
| `chain`       | No       | Restrict to one chain, e.g. `input` `{"type":"string"}` |

## simulate_suite

**Run a Packet Suite** · Risk: **read**

Runs a set of packets with their EXPECTED verdicts — a regression test for the firewall. Declare the flows that must work ('LAN can reach the internet', 'WAN cannot reach SSH') and any change that breaks one is caught here rather than in production. Each packet reports pass/fail with the deciding rule; an UNKNOWN verdict counts as a failure, because a flow whose fate the model cannot determine is not a flow you have verified. Models IPv4 filter/NAT/routing only: no raw table, no queues, no layer7, no IPv6, and no live connection tracking (`connection_state` is declared by you, not inferred). Anything on the path that is out of scope downgrades the verdict to UNKNOWN rather than guessing.

| Parameter     | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packets`     | Yes      | `{"minItems":1,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"What this flow is, e.g. \"LAN → internet\""},"src_address":{"type":"string"},"dst_address":{"type":"string"},"protocol":{"default":"tcp","type":"string"},"src_port":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"dst_port":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"in_interface":{"type":"string"},"connection_state":{"default":"new","type":"string","enum":["new","established","related","invalid"]},"expect":{"type":"string","enum":["accept","drop","reject"],"description":"The verdict this flow must get"}},"required":["name","src_address","dst_address","protocol","in_interface","connection_state","expect"],"additionalProperties":false}}` |
| `snapshot_id` | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `config_text` | No       | `{"type":"string"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
