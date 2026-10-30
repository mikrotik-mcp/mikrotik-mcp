---
title: Shared service deployment
description: Keep one Bun server running for Claude, Codex and other MCP clients.
---

A shared process keeps connection pools, caches, scheduled jobs and local history in one place. Docker is optional. MCP has no built-in OS service installer: use launchd on macOS, systemd on Linux, or a managed startup task on Windows.

## Start and verify

Install with [Getting started](/docs/guides/getting-started), create a protected [devices.json](/docs/guides/configuration), and verify `auth-check` first. Then run:

```sh
mikrotik-mcp serve --config /absolute/path/devices.json \
  --transport streamable-http --mcp-host 127.0.0.1 --mcp-port 8080 \
  --dashboard --dashboard-host 127.0.0.1 --dashboard-port 9090
```

The dashboard is at `http://127.0.0.1:9090`; MCP clients use `http://127.0.0.1:8080/mcp`. These are different services. Test the foreground process before registering it for automatic startup.

## Register with the operating system

| Host    | Service definition                            | Essential settings                                                                                                                                   |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | A LaunchAgent in `~/Library/LaunchAgents/`    | Absolute `ProgramArguments`, `RunAtLoad`, `KeepAlive`, writable log paths. It starts at user login.                                                  |
| Linux   | A user systemd unit                           | Absolute `ExecStart`, `WorkingDirectory`, `Restart=on-failure`; enable the unit. Boot without login requires explicit lingering or a system service. |
| Windows | Task Scheduler or an existing service manager | Run under the account that owns the config and SSH keys, use absolute Bun/entry-point paths, set startup trigger and restart behavior.               |

For the executable, use the installed Bun binary followed by the installed `dist/cli.js`, `serve`, and the options above. Do not assume a GUI-launched service inherits your interactive shell's PATH. Use the same home/data directories on every restart so SQLite history, memory and snapshots remain available.

Keep secrets out of the service command. Restrict the config and key files to the service user. Send logs to a bounded/rotated file or the OS journal. Stop and unregister the service before removing its files.

## Connect your clients

Use the remote HTTP configuration described in [Connecting clients](/docs/guides/connecting-clients). A client should connect to the shared endpoint instead of launching another local stdio instance. Verify a read-only tool call from each client, then restart the service and verify again.

Loopback is suitable for clients on the same machine. Remote clients need an intentional authenticated, TLS-protected deployment; do not expose the raw management service publicly. See [Security](/docs/guides/security).
