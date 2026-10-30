---
title: "Multi-WAN"
description: "Resilient multi-WAN from intent: active-passive failover and ECMP load balancing with health-checked default routes and a preview-before-apply step."
---

## Tools

- [Set Up Multi-WAN Failover](#setup_wan_failover)
- [Set Up Multi-WAN Load Balancing (ECMP)](#setup_wan_loadbalance)

## setup_wan_failover

**Set Up Multi-WAN Failover** · Risk: **dangerous**

Builds ACTIVE-PASSIVE multi-WAN failover by adding health-checked default routes with ascending distances (primary=1, each backup +1). RouterOS uses the lowest-distance reachable route; `check-gateway` withdraws a route when its gateway stops answering, so traffic fails over to the next WAN — and fails back automatically when the primary recovers. DEFAULTS TO A DRY RUN (`apply=false`) so you can review before changing default routing (which can cut your own access); set `apply=true` to execute. Does NOT remove existing 0.0.0.0/0 routes — clear conflicting ones first with the route tools. For load balancing instead of failover use setup_wan_loadbalance. Returns the plan or the resulting default routes.

| Parameter         | Required | Definition                                                                                                   |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `primary_gateway` | Yes      | Primary WAN gateway IP (or interface name) `{"type":"string"}`                                               |
| `backup_gateways` | Yes      | One or more backup WAN gateways, in failover order `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `check`           | Yes      | Gateway health-check method `{"default":"ping","type":"string","enum":["ping","arp"]}`                       |
| `comment_prefix`  | Yes      | `{"default":"wan-failover","type":"string"}`                                                                 |
| `apply`           | Yes      | false = preview only (default); true = execute `{"default":false,"type":"boolean"}`                          |

## setup_wan_loadbalance

**Set Up Multi-WAN Load Balancing (ECMP)** · Risk: **dangerous**

Builds ECMP (equal-cost multi-path) load balancing across multiple WANs by adding ONE default route whose `gateway` lists every WAN — RouterOS then spreads connections across the links (per-connection, so a single flow stays on one WAN). `check-gateway` drops a dead link from the set. DEFAULTS TO A DRY RUN (`apply=false`); set `apply=true` to execute. Does NOT remove existing 0.0.0.0/0 routes — clear conflicting ones first. ECMP is simple but balances by connection-hash, not by bandwidth; for sticky per-source balancing (PCC) use the firewall mangle + routing-table tools. For failover instead of balancing use setup_wan_failover. Returns the plan or the resulting default route.

| Parameter  | Required | Definition                                                                                           |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `gateways` | Yes      | Two or more WAN gateways to balance across `{"minItems":2,"type":"array","items":{"type":"string"}}` |
| `check`    | Yes      | Gateway health-check method `{"default":"ping","type":"string","enum":["ping","arp"]}`               |
| `comment`  | Yes      | `{"default":"wan-ecmp","type":"string"}`                                                             |
| `apply`    | Yes      | false = preview only (default); true = execute `{"default":false,"type":"boolean"}`                  |
