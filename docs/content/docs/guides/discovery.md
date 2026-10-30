---
title: "Discovery \u2014 Neighbors, Topology & `bun run discover`"
description: "Practical setup, operations and limits for Discovery \u2014 Neighbors, Topology & `bun run discover`."
---

Find MikroTik devices on the local network (by MAC, before they even have an IP),
visualise how they interconnect, and onboard new ones — all from MNDP (MikroTik
Neighbor Discovery Protocol) and `/ip neighbor`.

## `bun run discover` — list devices on the LAN

A standalone script that listens for MNDP announcements (UDP 5678) and prints
each device's **MAC**, identity, IPv4, interface, board and RouterOS version:

```bash
bun run discover                 # ~6s listen, aligned table
bun run discover --timeout 12    # longer window
bun run discover --json | jq -r '.[].mac'   # just the MACs, scriptable
```

It sprays the MNDP request to the limited broadcast **and every interface's
directed broadcast** (like WinBox), so it finds a device even when it's on a
non-default-route NIC. The MAC it prints is what you put in a device config to
reach the router over [MAC-Telnet](/docs/guides/transports) (Layer-2, no IP).

The script reports how many external datagrams it received, which makes failures
actionable: `received 0` usually means another tool (WinBox) is holding UDP 5678,
or a host firewall is dropping inbound UDP.

## Neighbors / MNDP tools

The **Neighbors / MNDP** module (System & Ops) reads the device's own discovery
cache:

| Tool                              | Risk             | What it does                                                             |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `list_neighbors`                  | READ             | Directly-attached devices discovered via MNDP/CDP/LLDP (`/ip neighbor`). |
| `get_neighbor_discovery_settings` | READ             | Which interface-list/protocols participate.                              |
| `set_neighbor_discovery_settings` | WRITE_IDEMPOTENT | Tune discovery (controls what appears on the map).                       |

## The topology map (dashboard)

With the [observability dashboard](/docs/guides/observability) running, the **Network
topology** panel draws a live Layer-2 map built from each device's neighbour
cache:

- configured devices on an inner ring with **inline CPU/memory health**,
- discovered neighbours fanned around them — solid links between devices you
  manage, dashed links to **onboardable** neighbours (matched to nothing
  configured),
- click an onboardable neighbour for a ready-to-paste device-config stub, or
  **"Add to config →"** to open it pre-filled in [Config Studio](/docs/guides/config-studio).

A neighbour that matches a configured device (by MAC / IP / identity) folds into
that device node, yielding device↔device links — so the map shows your real
fabric, and expands itself as you discover more.

Served at `GET /api/topology`. The neighbour data is read over the SSH connection
the health probe already holds, so it adds no extra connections.
