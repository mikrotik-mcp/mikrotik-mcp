---
title: "WireGuard Mesh"
description: "Stand up a full-mesh or hub-spoke WireGuard VPN across several devices in one call — auto key distribution, mesh addressing and peer wiring, with a preview-before-build step."
---

## Tools

- [Build WireGuard Mesh / Hub-Spoke VPN](#build_wireguard_mesh)

## build_wireguard_mesh

**Build WireGuard Mesh / Hub-Spoke VPN** · Risk: **dangerous**

Stands up a WireGuard VPN across several configured devices in ONE call: ensures a WireGuard interface on each, reads each device's public key, assigns every device a mesh address from `address_prefix`, then wires the peers between routers — `topology=full-mesh` connects every pair, `hub-spoke` connects the `hub` to each spoke — distributing public keys automatically. Endpoints default to each device's configured host (override per device via `endpoints`); add each site's LAN subnet via `allowed_lans` to route it through the tunnel. DEFAULTS TO A DRY RUN (`apply=false`) that shows the full plan; set `apply=true` to build it. Operates across MULTIPLE devices, so it is not affected by the single `device` selector. SSH devices only (needs to read public keys). Returns the plan, or a per-device build report.

| Parameter              | Required | Definition                                                                                                                                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`              | Yes      | Configured device names to include in the mesh (2+) `{"minItems":2,"type":"array","items":{"type":"string"}}`                                                                       |
| `address_prefix`       | Yes      | Mesh subnet; each device gets <prefix>.<index+1> on its WireGuard interface `{"default":"10.20.0.0/24","type":"string"}`                                                            |
| `interface`            | Yes      | WireGuard interface name to create/use (no spaces) `{"default":"wg-mesh","type":"string","pattern":"^\\S+$"}`                                                                       |
| `listen_port`          | Yes      | `{"default":13231,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                         |
| `topology`             | Yes      | `{"default":"full-mesh","type":"string","enum":["full-mesh","hub-spoke"]}`                                                                                                          |
| `hub`                  | No       | Hub device name (required when topology=hub-spoke) `{"type":"string"}`                                                                                                              |
| `endpoints`            | No       | Per-device public endpoint host override, e.g. {"site-a":"a.example.com"} `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}`            |
| `allowed_lans`         | No       | Per-device LAN subnet to route through the tunnel, e.g. {"site-a":"192.168.10.0/24"} `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}` |
| `persistent_keepalive` | Yes      | `{"default":"25s","type":"string"}`                                                                                                                                                 |
| `apply`                | Yes      | false = preview the plan (default); true = build `{"default":false,"type":"boolean"}`                                                                                               |
