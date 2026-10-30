---
title: Raycast companion
description: Inspect routers and dashboard workflows from Raycast on macOS.
---

The extension in `raycast/` connects to the existing dashboard HTTP API; it does not open its own router connection. Start the dashboard first, then configure **Dashboard URL** (default `http://127.0.0.1:9090`) and its token when authentication is enabled.

## Available commands

- **Prompt Library** — Compose a guided MikroTik request, hand it to your MCP assistant or ask Raycast AI for a plan
- **Fleet Menu Bar** — Live MikroTik fleet cockpit in the menu bar — health, activity, alerts
- **Overview** — Tool-call volume, latency, error rate and risk at a glance
- **Devices** — Router connectivity, system health (CPU/MEM/DISK) and SSH pool
- **Clients** — LAN devices on a router — live traffic, block/allow, pin IP, rate limits
- **Packet Capture** — Live decoded TZSP packet capture — protocols, talkers, pcap export
- **Flows** — NetFlow/IPFIX top talkers, conversations and applications
- **RADIUS & UM** — RADIUS client and User Manager — users, profiles, limitations, NAS, sessions
- **CAPsMAN** — Wi-Fi fabric — radios, co-channel conflicts, weak-signal clients and roaming/HA audit
- **Topology** — Configured devices and discovered Layer-2 neighbours (MNDP/CDP/LLDP)
- **Snapshots** — Browse stored config snapshots and time-travel diff any two
- **Drift Guard** — Golden config baselines and live drift detection per device
- **Explain** — Plain-language architecture document for a router, from its configuration
- **Policies** — Policy-as-code findings and compliance score per device
- **Transactions** — Cross-device two-phase commit — swimlane, assertions, abort
- **Change Plan** — Dry-run intended RouterOS commands — risk-scored, safely ordered
- **S3 Backups** — List, download and delete S3 backup objects
- **Backups** — Local config vault — create, download, rename, restore, delete
- **Modules** — Enable/disable tool modules — curate the exposed MCP surface
- **Config** — Effective configuration, safe editor, version history and field guide
- **Reload Server** — Reload the MCP server config live, or restart the process
- **Releases** — Browse versions with release notes; upgrade, downgrade or reinstall the server
- **Catalog** — Browse every tool, module and prompt with search and kind/group filters
- **Memory** — Knowledge graph — entities, relations, observations and activity
- **Live Feed** — Every MCP tool call in real time (WebSocket, SSE fallback)
- **Monitor Devices** — Background health check that notifies when a router goes offline or comes back online

## Install and use

Follow the [extension development instructions](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/raycast/README.md) to load the local extension. This is a separate Raycast package with its own dependency constraints; the MCP server itself continues to run on Bun.

List and detail commands read existing dashboard data. Mutation actions still require the relevant confirmation and server permissions. Background monitoring uses background-safe notifications. If a command is missing or data fails to load, check the dashboard URL/token and server version first. The companion covers the commands above, not every dashboard page.
