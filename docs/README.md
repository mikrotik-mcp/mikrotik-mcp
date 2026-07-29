# Documentation

`@usex/mikrotik-mcp` is a Bun-native [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes **780+ tools across 90+ modules** for managing MikroTik
RouterOS devices over SSH (or Layer-2 MAC-Telnet) — firewall, NAT, routing, DHCP,
DNS, wireless, QoS, and a complete **VPN suite** (WireGuard, IPsec, L2TP, PPTP,
SSTP, OpenVPN, and GRE/IPIP/EoIP/VXLAN tunnels). It can manage **multiple named
devices** at once, so the AI can configure both ends of a tunnel from one
conversation — and it ships higher-level workflows on top: a terraform-style
change planner, config snapshots, a firewall auditor, live packet capture, MNDP
discovery, and a real-time dashboard.

## Contents

| Doc                                                 | What's inside                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)             | Install, verify connectivity with `auth-check`, first run.                                                                                                                                    |
| [Configuration](./configuration.md)                 | Every env var and CLI flag, defaults, key vs. password auth, log levels.                                                                                                                      |
| **[Multiple devices](./multi-device.md)**           | Manage several routers; how the AI targets one per call; per-device Safe Mode.                                                                                                                |
| [Transports](./transports.md)                       | `stdio` vs `streamable-http` vs `sse`, the `/mcp` and `/health` endpoints, DNS-rebinding protection.                                                                                          |
| **[Observability dashboard](./observability.md)**   | Optional real-time, localhost dashboard: live feed of every tool call, analytics, SQLite persistence.                                                                                         |
| [Connecting clients](./connecting-clients.md)       | Claude Desktop config, generic stdio clients, HTTP clients.                                                                                                                                   |
| [Safe Mode](./safe-mode.md)                         | Transactional config changes that auto-revert on disconnect.                                                                                                                                  |
| **[Cross-Device Transactions](./transactions.md)**  | Two-phase commit across several routers: prepare, verify uncommitted, commit in order — COMMITTED / ABORTED / PARTIAL.                                                                        |
| **[Traffic Flow](./traffic-flow.md)**               | NetFlow/IPFIX export + host-side collector: top talkers, conversations, application mix, anomalies. Metadata only, no payload.                                                                |
| **[Staged Fleet Rollout](./fleet-rollout.md)**      | One change across N routers as canary → wave → fleet, with health gates, a soak and automatic revert on the first failure.                                                                    |
| **[Change Plan & Dry-Run](./change-plan.md)**       | Terraform-style preview of intended commands + safe apply with the exact diff.                                                                                                                |
| **[Config Snapshots](./config-snapshots.md)**       | Point-in-time `/export` snapshots + time-travel diff (incl. vs. live).                                                                                                                        |
| **[Firewall Audit](./firewall-audit.md)**           | Shadowed/broad/missing-drop/duplicate/dead rules, risk-scored, with one-click fixes.                                                                                                          |
| **[Security Hardening](./security-hardening.md)**   | Per-category audit+remediate pairs (default-deny, address-list enforcement, kernel IP, IPv6, SSH, services, DNS, …) + orchestrator; fix by finding_id, dry-run default, snapshot + Safe-Mode. |
| **[Port-Scan Detection](./port-scan-detection.md)** | Detect (never block) six port-scan signatures by tagging the source, inside a trust-excluding `detect-portscan` jump-gate; explicit selection, trust-list pre-flight, snapshot + Safe-Mode.   |
| **[Packet Capture Studio](./packet-capture.md)**    | Live TZSP capture decoded in the dashboard; per-flow mirrors; pcap export.                                                                                                                    |
| **[Discovery](./discovery.md)**                     | `bun run discover`, MNDP neighbours, and the live topology map.                                                                                                                               |
| **[Config Studio](./config-studio.md)**             | Edit the config JSON in the dashboard with autocomplete + safe-apply.                                                                                                                         |
| **[VPN guide](./vpn-guide.md)**                     | Every MikroTik VPN/tunnel type, when to use it, and the tools + prompts that build it.                                                                                                        |
| [Architecture](./architecture.md)                   | How the layers fit together: CLI → config → registry → tools → connector → SSH.                                                                                                               |
| [Prompts](./prompts.md)                             | The 9 built-in MCP prompts and how clients invoke them.                                                                                                                                       |
| [Security](./security.md)                           | Credential handling, DNS-rebinding, risk annotations, client-side gating.                                                                                                                     |
| [Development](./development.md)                     | Tests, type-checking, building, generating schemas and docs, project layout.                                                                                                                  |
| **[MCP Inspector](./inspector.md)**                 | Test the server's tools and prompts in the official UI / CLI.                                                                                                                                 |
| [Docker](./docker.md)                               | A minimal Bun-based image and how to pass `MIKROTIK_*` env vars.                                                                                                                              |
| **[Tool reference](./tools-reference.md)**          | The full, generated catalog of every tool with parameters and risk levels.                                                                                                                    |

## Quick links

- Tool catalog (machine-readable): [`schemas/tool-catalog.json`](../schemas/tool-catalog.json)
- Per-tool input schemas: [`schemas/tools/<name>.json`](../schemas/tools/)
- Config schema: [`schemas/config.schema.json`](../schemas/config.schema.json)
