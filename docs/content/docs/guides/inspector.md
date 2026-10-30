---
title: "MCP Inspector"
description: "Practical setup, operations and limits for MCP Inspector."
---

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the
official visual + CLI tool for testing and debugging MCP servers. It's the
fastest way to poke at this server's tool catalog and prompt library without wiring up a
full AI client. Nothing to install — it runs via `bunx` (or `npx`).

## Quick start (UI)

```bash
# Dev server (loads .env automatically via Bun), opens the web UI:
bun run inspect

# Or against the bundled build in dist/:
bun run inspect:built

# Or use the committed config (lets you pick a server in the UI):
bun run inspect:config
```

This launches:

- the **Inspector UI** at <http://localhost:6274> (auto-opens, token pre-filled), and
- a local **proxy** on port `6277`.

In the UI: click **Connect**, then open **Tools → List Tools** to browse the
catalog, pick one (e.g. `list_interfaces`), fill its arguments, and **Run**.
**Prompts → List Prompts** shows the 9 guided workflows. Set the **Logging level**
to see the per-call `[device] Executing …` messages this server emits.

> The proxy mints a session **auth token** at startup and the browser opens with
> it pre-filled. To pin it: `MCP_PROXY_AUTH_TOKEN=$(openssl rand -hex 32) bun run inspect`.
> Override ports with `CLIENT_PORT` / `SERVER_PORT`. Avoid `DANGEROUSLY_OMIT_AUTH=true`.

## Passing connection details

The dev scripts run `bun run src/cli.ts serve`, and Bun auto-loads `.env`, so the
simplest path is to put your credentials in `.env` (copy `.env.example`). To set
them inline instead, use the Inspector's `-e` flag:

```bash
bunx @modelcontextprotocol/inspector \
  -e MIKROTIK_HOST=192.168.88.1 -e MIKROTIK_USERNAME=admin -e MIKROTIK_PASSWORD=•••• \
  bun run src/cli.ts serve
```

The committed [`mcp-inspector.config.json`](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/mcp-inspector.config.json) holds
named entries you can edit (`mikrotik`, `mikrotik-built`, `mikrotik-http`) and
select with `--server`.

## CLI mode (scriptable / CI)

`--cli` runs a single request and prints JSON — great for smoke tests:

```bash
# List every tool
bunx @modelcontextprotocol/inspector --cli bun run src/cli.ts serve --method tools/list

# List prompts
bunx @modelcontextprotocol/inspector --cli bun run src/cli.ts serve --method prompts/list

# Call a tool (connection-free — lists configured devices)
bunx @modelcontextprotocol/inspector --cli bun run src/cli.ts serve \
  --method tools/call --tool-name list_mikrotik_devices

# Call a tool that hits the device (needs reachable creds in env/.env)
bunx @modelcontextprotocol/inspector --cli bun run src/cli.ts serve \
  --method tools/call --tool-name list_interfaces --tool-arg type_filter=ether
```

`bun run inspect:cli` is a shortcut for the first one.

## Multiple devices

When [several devices](/docs/guides/multi-device) are configured, every tool exposes a
`device` argument. Target one from the CLI with `--tool-arg device=<name>`:

```bash
MIKROTIK_DEVICES='{"defaultDevice":"site-a","devices":{ … }}' \
bunx @modelcontextprotocol/inspector --cli bun run src/cli.ts serve \
  --method tools/call --tool-name get_system_identity --tool-arg device=site-b
```

In the UI the `device` field appears as a dropdown of your configured names.

## Inspecting the HTTP transport

Run the server over HTTP, then point the Inspector at it:

```bash
# Terminal 1 — serve over streamable-http
MIKROTIK_HOST=192.168.88.1 bun run src/cli.ts serve --transport streamable-http --mcp-port 8000

# Terminal 2 — connect the Inspector UI to it
bunx @modelcontextprotocol/inspector
# then in the UI choose Transport "Streamable HTTP" and URL http://127.0.0.1:8000/mcp
# (the mcp-inspector.config.json "mikrotik-http" entry is preconfigured for this)
```

Or open the UI straight at the right target:
`http://localhost:6274/?transport=streamable-http&serverUrl=http://127.0.0.1:8000/mcp`.

## Troubleshooting

| Symptom                                                                      | Fix                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| UI connects but tool calls error with "Failed to connect to MikroTik device" | Credentials/host are wrong or unreachable — verify with `mikrotik-mcp auth-check`. |
| No `device` dropdown though you set devices                                  | A `device` selector only appears when **more than one** device is configured.      |
| Port already in use                                                          | Set `CLIENT_PORT` / `SERVER_PORT`.                                                 |
| Want raw logs                                                                | Set `MIKROTIK_LOG_LEVEL=debug` (the config's `mikrotik` server already does).      |
