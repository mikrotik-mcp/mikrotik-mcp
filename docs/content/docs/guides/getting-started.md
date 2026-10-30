---
title: "Getting started"
description: "Practical setup, operations and limits for Getting started."
---

This server bridges an MCP client (Claude Desktop, an agent, your own code) and
a MikroTik RouterOS device. It connects to the device over **SSH** and exposes
its configuration surface as MCP tools.

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.4.4** — the only runtime requirement.
- A reachable **RouterOS device** with SSH enabled (`/ip service` → `ssh`).
- SSH credentials: either a **password** or an **SSH private key** for a user
  with the privileges you intend to manage.

## Install

### Global install (recommended)

```bash
bun add -g @usex/mikrotik-mcp
```

This puts a `mikrotik-mcp` binary on your `PATH`.

```bash
mikrotik-mcp --version      # prints the version, e.g. 1.0.0
mikrotik-mcp --help         # usage and all flags
```

### From source

```bash
git clone https://github.com/mikrotik-mcp/mikrotik-mcp.git
cd mikrotik-mcp
bun install
bun run start               # runs src/cli.ts serve (stdio transport)
```

## Verify connectivity

Before wiring up a client, confirm the server can actually reach your device.
`auth-check` opens an SSH connection, runs two read-only probe commands
(`/system identity print` and `/system resource print`), prints the result, and
exits.

```bash
MIKROTIK_HOST=192.168.88.1 \
MIKROTIK_USERNAME=admin \
MIKROTIK_PASSWORD='your-password' \
mikrotik-mcp auth-check
```

Equivalent using flags (flags override env vars):

```bash
mikrotik-mcp auth-check \
  --host 192.168.88.1 \
  --username admin \
  --password 'your-password'
```

A successful run prints `Connection OK.` followed by the device identity and
resource output. On failure it prints `Connection FAILED.` and exits with a
non-zero status — check host, credentials, SSH port, and reachability.

See [Configuration](/docs/guides/configuration) for every connection option, including
key-file authentication.

### Create an SSH key from the dashboard

In **Devices → Add device / Edit settings → Authentication → SSH key**, choose
**Create key**, enter a unique name, then **Generate & select key**. The MCP host
creates an RSA-3072 pair in its user's `.ssh` directory and selects its private
file path in the unsaved device draft. Existing files are never overwritten.

Copy the displayed **public key** into `<name>.pub`, upload that file through
WinBox → Files, and import it under System → Users → SSH Keys for the intended
login user. Only the public key is returned to the browser; never upload the
private file. Importing a key can disable password SSH login for that user, so
keep an existing management session open until **Test connection** succeeds.
Creating/selecting a key does not install it on the router or save device settings.

Keys are unencrypted for unattended service use, with owner-only file permissions
on macOS/Linux. They remain on disk if the device draft is cancelled. In Docker,
persist the MCP user's `.ssh` directory separately from disposable container layers.
Native Windows creation is refused until restricted ACLs can be enforced; generate
the key with Windows OpenSSH and refresh the existing key picker instead.

## First run

Start the server. By default it speaks the **stdio** transport, which is what
Claude Desktop and most local MCP clients expect:

```bash
mikrotik-mcp serve          # or just: mikrotik-mcp
```

All diagnostic logging goes to **stderr**; stdout is reserved for the JSON-RPC
protocol stream. On startup you'll see (on stderr) a line like:

```
[mikrotik-mcp] INFO MCP server ready on stdio — the enabled tool and prompt counts
```

## Explore the catalog

List every registered tool with its risk level without connecting to a device:

```bash
mikrotik-mcp tools
```

This prints `RISK  name  title` rows and a final `the current tool and module counts`
summary. For the full reference with parameters, see the
[tool reference](/docs/reference).

## Next steps

- [Connect a client](/docs/guides/connecting-clients) (Claude Desktop, HTTP, custom).
- [Choose a transport](/docs/guides/transports) for local vs. networked deployments.
- [Use Safe Mode](/docs/guides/safe-mode) to make risky changes reversible.
