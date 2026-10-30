---
title: "Port Forward"
description: "Smart port-forward wizard: dst-nat + forward accept + hairpin NAT in one call, with preview-before-apply."
---

## Tools

- [Forward a Port (Smart Wizard)](#forward_port)

## forward_port

**Forward a Port (Smart Wizard)** · Risk: **dangerous**

Exposes an internal service correctly and completely in one call: the DST-NAT rule that forwards `external_port` to `internal_host:internal_port`, the matching forward-chain accept (so it passes a default-drop firewall), and — when `lan_subnet` is given — the hairpin/loopback srcnat so the service also works when reached from inside the LAN via the public IP. DEFAULTS TO A DRY RUN (`apply=false`) showing every rule; set `apply=true` to create them. All rules are tagged 'port-forward:'. Returns the plan or a build report.

| Parameter       | Required | Definition                                                                    |
| --------------- | -------- | ----------------------------------------------------------------------------- |
| `protocol`      | Yes      | `{"default":"tcp","type":"string","enum":["tcp","udp"]}`                      |
| `external_port` | Yes      | `{"type":"integer","minimum":1,"maximum":65535}`                              |
| `internal_host` | Yes      | LAN IP of the service, e.g. '192.168.1.10' `{"type":"string"}`                |
| `internal_port` | No       | Defaults to external_port `{"type":"integer","minimum":1,"maximum":65535}`    |
| `wan_interface` | No       | Restrict the forward to this WAN interface `{"type":"string"}`                |
| `lan_subnet`    | No       | LAN subnet for hairpin NAT, e.g. '192.168.1.0/24' `{"type":"string"}`         |
| `comment`       | No       | `{"type":"string"}`                                                           |
| `apply`         | Yes      | false = preview (default); true = create `{"default":false,"type":"boolean"}` |
