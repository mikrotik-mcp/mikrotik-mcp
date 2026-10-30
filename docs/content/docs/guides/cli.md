---
title: Command-line interface
description: Start a server, inspect the catalog and verify connectivity.
---

Use `mikrotik-mcp --help` for your installed release. Run from source with `bun src/cli.ts`, or from a build with `bun dist/cli.js`. Both use Bun.

- `serve`: starts MCP and the configured background services. The default transport is stdio.
- `devices`: prints configured connection targets; it does not test reachability.
- `tools`: lists the tool catalog without changing a router.
- `auth-check`: makes read-only connection probes to configured devices.
- `version` / `--version`, `help` / `--help`: print local information and exit.

## Common options

The installed help for the documented release is shown below. [Configuration](/docs/guides/configuration) covers additional settings; the [complete JSON schema](/docs/guides/config-schema) includes every block and its constraints. Not every JSON field has a CLI flag.

```text
mikrotik-mcp v6.10.0 — MikroTik RouterOS MCP server

USAGE
  mikrotik-mcp [command] [options]

COMMANDS
  serve         Start the MCP server (default)
  auth-check    Connect over SSH to every configured device and probe it
  devices       List the configured devices (name · host · auth)
  tools         Print the full tool catalog (name · risk · title)
  version       Print the version

CONNECTION OPTIONS  (env var in parentheses) — defines the "default" device
  --host           RouterOS host             (MIKROTIK_HOST, default 127.0.0.1)
  --username       SSH username              (MIKROTIK_USERNAME, default admin)
  --port           SSH port                  (MIKROTIK_PORT, default 22)

AUTHENTICATION — use a password OR an SSH key (key takes precedence)
  --password       SSH password              (MIKROTIK_PASSWORD)
  --key-filename   Path to a private key     (MIKROTIK_KEY_FILENAME)
  --private-key    Inline private key (PEM)  (MIKROTIK_PRIVATE_KEY)
  --key-passphrase Passphrase for an encrypted key (MIKROTIK_KEY_PASSPHRASE)

MULTIPLE DEVICES — give each router a name to target per tool call
  --config <path>  JSON file of named devices (MIKROTIK_CONFIG_FILE)
                   { "defaultDevice": "site-a",
                     "devices": { "site-a": { "host": "...", ... },
                                  "site-b": { "host": "...", ... } } }
  MIKROTIK_DEVICES Inline JSON alternative to --config

TRANSPORT OPTIONS
  --transport          stdio | sse | streamable-http   (MIKROTIK_MCP__TRANSPORT)
  --mcp-host           HTTP bind host                   (MIKROTIK_MCP__HOST)
  --mcp-port           HTTP bind port                   (MIKROTIK_MCP__PORT)
  --mcp-allowed-hosts  Host header allow-list (DNS-rebinding protection)

SSH CONNECTION POOLING  (persistent connections, on by default)
  --ssh-keep-alive          Enable/disable pooling   (MIKROTIK_SSH__KEEP_ALIVE, default true)
  --ssh-keepalive-interval  Keepalive packet interval (ms) (MIKROTIK_SSH__KEEPALIVE_INTERVAL)
  --ssh-idle-timeout        Close idle connections after (ms) (MIKROTIK_SSH__IDLE_TIMEOUT)

OBSERVABILITY DASHBOARD  (optional; real-time feed + analytics of every tool call)
  --dashboard               Enable the dashboard     (MIKROTIK_DASHBOARD__ENABLED)
  --dashboard-host          Bind host (default 0.0.0.0=LAN) (MIKROTIK_DASHBOARD__HOST)
  --dashboard-port          Bind port (default 9090)       (MIKROTIK_DASHBOARD__PORT)
  --dashboard-db            SQLite path (bun:sqlite; ":memory:" for ephemeral)
                                                           (MIKROTIK_DASHBOARD__DB_PATH)
  --dashboard-max-events    Retention cap (default 100000) (MIKROTIK_DASHBOARD__MAX_EVENTS)
  --dashboard-capture-body  Record redacted in/out bodies  (MIKROTIK_DASHBOARD__CAPTURE_BODY)
  --dashboard-token         Bearer token to protect the dashboard
                                                           (MIKROTIK_DASHBOARD__TOKEN)
```

## Shared service

Keep one Bun process running and connect clients to its HTTP endpoint. Use absolute paths for Bun, the entry point, the configuration and key files. See [Shared service deployment](/docs/guides/shared-service).

Keep credentials in a protected config file or secret-managed environment, rather than shell history. `--dashboard-host 127.0.0.1` restricts the dashboard to this computer; the default bind address also accepts LAN traffic.
