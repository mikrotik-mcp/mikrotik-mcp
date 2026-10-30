---
title: "Service Routing"
description: "Scoped dual-stack domain policies, router VRF service probes and explicitly authorized failover."
---

## Tools

- [List Service Routing Policies](#list_service_routing)
- [Inspect Router Routing Configuration](#service_routing_inventory)
- [Read Routing Address List Page](#service_routing_address_page)
- [Read Service Routing Traffic](#service_routing_traffic)
- [Create Service Routing Draft](#create_service_routing)
- [Probe Service Exits](#probe_service_routing)
- [Preview Service Routing Change](#preview_service_routing)
- [Apply Approved Service Routing Preview](#apply_service_routing)
- [Authorize Time-Limited Service Failover](#arm_service_routing)

## list_service_routing

**List Service Routing Policies** · Risk: **read**

Read persistent domain routing policies, path evidence, primary exit, history and authorization expiry for this router. No probes or router changes.

No tool-specific parameters.

## service_routing_inventory

**Inspect Router Routing Configuration** · Risk: **read**

Read live IPv4/IPv6 routes, ordered mangle and routing rules, address lists, tables, VRFs and filter rules independently of saved MCP policies. Includes dynamic/disabled entries, per-section failures and observation timestamps; bounded reads, 20-second cache. Missing data is not zero. Also lists enabled FIB exits and approved HTTPS aliases. Table presence is not path health; HTTPS exit probes require a matching VRF. No router changes.

No tool-specific parameters.

## service_routing_address_page

**Read Routing Address List Page** · Risk: **read**

Read the next bounded page of this router's IPv4 or IPv6 address-list members. Use nextOffset from service_routing_inventory or the preceding page. At most 200 rows per request; live lists may change between pages. Read-only, no router changes.

| Parameter | Required | Definition                                                     |
| --------- | -------- | -------------------------------------------------------------- |
| `family`  | Yes      | `{"type":"string","enum":["ipv4","ipv6"]}`                     |
| `offset`  | Yes      | `{"default":0,"type":"integer","minimum":0,"maximum":1000000}` |

## service_routing_traffic

**Read Service Routing Traffic** · Risk: **read**

Read the exact active MCP-owned routing mark's client-to-service byte and packet counters for one saved policy. Decimal strings preserve 64-bit totals. Four-second cache; missing, disabled or modified rules are unavailable, not zero. Excludes return/download traffic and does not prove delivery, DNS coverage or billing usage. No reset or router change.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## create_service_routing

**Create Service Routing Draft** · Risk: **write**

Save a single-family exact domain or *.example.com route for explicit client subnets. The wildcard excludes the apex and requires client DNS through this router, existing remote DNS, RouterOS 7.17+ and dnsLearningConfirmed. Wildcard FWD bypasses adlists for matching DNS queries. HTTPS target is optional for manual routing, required for health probes/failover; when domain is absent use the approved target's host (legacy). Shared CDN IPs can affect other services. No router change until preview and explicit apply. Never infer authorization from a draft.

| Parameter              | Required | Definition                                                                                                                                                                                   |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Yes      | `{"type":"string","minLength":1,"maxLength":80}`                                                                                                                                             |
| `target`               | No       | Optional approved HTTPS probe alias; legacy drafts without domain route this alias's exact host `{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-zA-Z0-9_.-]+$"}`               |
| `domain`               | No       | Exact domain or *.example.com (subdomains only, not the apex). Wildcards need client DNS through this router. `{"type":"string","maxLength":253}`                                            |
| `dnsLearningConfirmed` | No       | For wildcard only: confirms clients use this router DNS, shared-IP scope and FWD adlist bypass are understood. Does not enable or intercept DNS. `{"type":"boolean"}`                        |
| `precedence`           | No       | Explicitly allow this scoped policy before existing routing rules. Preview still binds their full configuration; FastTrack is never bypassed. `{"type":"string","enum":["before-existing"]}` |
| `family`               | Yes      | `{"type":"string","enum":["ipv4","ipv6"]}`                                                                                                                                                   |
| `sources`              | Yes      | `{"minItems":1,"maxItems":8,"type":"array","items":{"type":"string"}}`                                                                                                                       |
| `tables`               | Yes      | `{"minItems":1,"maxItems":3,"type":"array","items":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-zA-Z0-9_.-]+$"}}`                                                            |
| `primary`              | Yes      | `{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-zA-Z0-9_.-]+$"}`                                                                                                               |
| `maxLatencyMs`         | Yes      | `{"default":5000,"type":"integer","minimum":100,"maximum":15000}`                                                                                                                            |
| `failuresBeforeSwitch` | Yes      | `{"default":3,"type":"integer","minimum":2,"maximum":10}`                                                                                                                                    |
| `cooldownSeconds`      | Yes      | `{"default":300,"type":"integer","minimum":120,"maximum":3600}`                                                                                                                              |

## probe_service_routing

**Probe Service Exits** · Risk: **read**

Run bounded, IP-approved HTTPS HEAD fetches from the router through matching VRFs, certificate validation on, redirects off. No files/bodies stored. Table-only exits remain UNKNOWN. SSH overhead is included; not end-client reachability or throughput proof.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## preview_service_routing

**Preview Service Routing Change** · Risk: **read**

Read router state and save a two-minute state-bound preview for applying/switching or removing owned rules. Reject FastTrack, overlapping wildcard DNS and foreign routing conflicts unless before-existing precedence was explicitly selected. Wildcard plans add an owned DNS FWD learner, not DNS interception. Does not create exits, NAT or change the router until apply.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `table`   | Yes      | `{"type":"string","minLength":1,"maxLength":64}`                                                                                                                                                                         |
| `remove`  | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |

## apply_service_routing

**Apply Approved Service Routing Preview** · Risk: **write**

After explicit user confirmation, apply the exact fresh preview with a backup, exclusive Safe Mode and read-back. Router DNS maintains the owned destination list. Does not touch output/input chains. An ambiguous write is never retried; inspect router state. An apply pauses automatic failover.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `planId`  | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |

## arm_service_routing

**Authorize Time-Limited Service Failover** · Risk: **write**

Explicitly authorize automatic switching between saved exits for 1-60 minutes, or pause with 0. Requires fresh passing VRF evidence for every exit, consecutive definite failures and cooldown; UNKNOWN never triggers a switch. Expiry stops automation but retains the current route. No new exits or global policy rewrites.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `minutes` | Yes      | `{"type":"integer","minimum":0,"maximum":60}`                                                                                                                                                                            |
| `confirm` | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                     |
