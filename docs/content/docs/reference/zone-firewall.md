---
title: "Zone Firewall"
description: "Zone-based firewall: name zones (sets of interfaces) and the traffic allowed between them; the tools compile interface lists and filter rules, apply them in Safe Mode, and remove the whole design again."
---

## Tools

- [Design a Zone-Based Firewall](#design_zone_firewall)
- [Remove the Zone-Based Firewall](#remove_zone_firewall)

## design_zone_firewall

**Design a Zone-Based Firewall** · Risk: **write**

Builds a zone-based firewall from a description instead of single rules. You name zones (each a set of interfaces, for example lan, guest, wan) and policies (what may go from one zone to another, optionally limited to a protocol and ports). The tool creates one interface list for each zone and filter rules for each policy, accepts replies to allowed connections, and drops everything else that enters from a zone. The special zone 'router' is the router itself: `from: lan, to: router` allows access TO the router (an input rule). DEFAULTS TO A DRY RUN (`apply=false`) that returns every command. With `apply=true` it takes a config snapshot and writes in Safe Mode, so a rule that cuts your own connection is rolled back. It refuses a design it cannot make safely: an interface in two zones, an unknown zone or interface, ports without a protocol, or `protect_router=true` with no accept policy to the router (that would lock everyone out). Rules are added at the END of each chain, so existing rules that match first still decide. Use `remove_zone_firewall` to take the whole design out. IPv4 only.

| Parameter        | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zones`          | Yes      | `{"minItems":1,"maxItems":16,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"Zone name: lowercase letters, digits, '-'"},"interfaces":{"type":"array","items":{"type":"string","minLength":1},"description":"Interfaces in this zone"}},"required":["name","interfaces"],"additionalProperties":false}}`                                                                                                                                                                                                                                                               |
| `policies`       | Yes      | `{"default":[],"maxItems":64,"type":"array","items":{"type":"object","properties":{"from":{"type":"string","description":"Source zone, or 'router'"},"to":{"type":"string","description":"Destination zone, or 'router'"},"action":{"default":"accept","type":"string","enum":["accept","drop","reject"]},"protocol":{"type":"string","enum":["tcp","udp","icmp"]},"ports":{"description":"Destination ports, e.g. '443' or '80,443'","type":"string"},"note":{"description":"A short note for the rule comment","type":"string","maxLength":60}},"required":["from","to","action"],"additionalProperties":false}}` |
| `protect_router` | Yes      | Also drop traffic to the router itself that no policy allows `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apply`          | Yes      | false = show the commands; true = apply `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## remove_zone_firewall

**Remove the Zone-Based Firewall** · Risk: **destructive**

Removes everything `design_zone_firewall` created on a router: its filter rules, zone interface-list members and zone interface lists (all carry a 'zone-fw:' comment). Rules you added yourself are not touched. After this, traffic between the former zones is decided by the rules that remain, which may be none: check before you remove a firewall on a router that faces the internet. DEFAULTS TO A DRY RUN (`apply=false`) that counts what would go.

| Parameter | Required | Definition                                                             |
| --------- | -------- | ---------------------------------------------------------------------- |
| `apply`   | Yes      | false = count only; true = remove `{"default":false,"type":"boolean"}` |
