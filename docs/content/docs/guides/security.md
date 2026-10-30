---
title: "Security"
description: "Practical setup, operations and limits for Security."
---

This server holds the keys to your router. Treat it with the same care as the
SSH credentials it carries. This page covers the controls it provides and the
practices it expects of the deployment around it.

## SSH credential handling

The server connects to RouterOS over the **SSH protocol** via `ssh2`. RouterOS commands travel over SSH `exec`/`shell` channels, with optional REST or MAC-Telnet transports. MAC-Telnet dependencies can use local interface-discovery commands. This does not make arbitrary raw RouterOS commands safe.

Credentials are resolved as described in [Configuration](/docs/guides/configuration):

- **Inline private key** (`MIKROTIK_PRIVATE_KEY`) — PEM string; highest priority.
- **Key file** (`MIKROTIK_KEY_FILENAME`) — read from disk at connect time.
- **Password** (`MIKROTIK_PASSWORD`) — used when present, alone or with a key.

**Prefer key-based authentication.** Use a dedicated RouterOS user with only the
privileges the deployment needs, rather than `admin`.

### Plaintext passwords in containers

When the process detects it's running inside a container (`/.dockerenv` exists or
`container=docker`) **and** a plaintext password is set, it logs a security
warning:

> Environment variables are visible via `docker inspect`. Prefer Docker secrets
> or a key file.

In containerized deployments, mount an SSH key (or use Docker/Compose secrets)
instead of putting a password in the environment. See [Docker](/docs/guides/docker).

## Command quoting (injection-safe)

RouterOS-bound commands are assembled with the `Cmd` builder, whose
`quoteValue()` is the injection boundary: any value that isn't a bare-safe token
is quoted, with embedded quotes and backslashes escaped. This prevents a
user-supplied value like `My LAN; /system reset` from splitting into extra
RouterOS commands. See [Architecture](/docs/guides/architecture#the-cmd-builder-injection-safe-quoting).

## DNS-rebinding protection (HTTP transports)

When served over HTTP, the server can reject requests whose `Host`/`Origin`
headers aren't on an allow-list, which defeats DNS-rebinding attacks from a
browser. The protection is reconciled automatically with the bind host:

- **Localhost bind, no allow-list** → protection on with a secure localhost
  allow-list.
- **Explicit allow-list** → honored exactly.
- **Public bind (e.g. `0.0.0.0`), no allow-list** → protection off (with a
  warning) so a reverse proxy isn't met with HTTP 421.
- **`allowed-hosts=*`** → protection explicitly disabled (with a warning).

If you expose HTTP beyond localhost, set `--mcp-allowed-hosts` /
`--mcp-allowed-origins` to your real domain so protection stays on. Full table in
[Transports](/docs/guides/transports#dns-rebinding-protection). The stdio transport has
no network listener and is unaffected.

## Risk annotations and client-side gating

Every tool carries an MCP **risk annotation** so clients can decide what to allow
automatically and what to gate behind confirmation:

| Risk             | Annotation                                 | Examples                                |
| ---------------- | ------------------------------------------ | --------------------------------------- |
| read             | `readOnlyHint`                             | `list_*`, `get_*`, `ping`, `traceroute` |
| write            | `destructiveHint: false`                   | `create_*`, `add_*`                     |
| write-idempotent | `destructiveHint: false`, `idempotentHint` | `set_*`, `enable_*`, `disable_*`        |
| destructive      | `destructiveHint`                          | `remove_*`, `delete_*`                  |
| dangerous        | `destructiveHint`, not idempotent          | restore, import, factory setup          |

**Destructive and dangerous tools should be gated by the client** — require human
confirmation before they run. The annotations exist precisely so a client can
enforce this. Server-side read-only mode, access scopes, tool curation and capability checks also constrain execution. An annotation is not authorization; RouterOS permissions remain a separate boundary.

The full risk-by-tool breakdown is in the
[tool reference](/docs/reference), and the same data in machine-readable
form is in [`schemas/tool-catalog.json`](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/schemas/tool-catalog.json).

## Reducing blast radius

- Run as a **least-privilege RouterOS user**, not `admin`.
- Wrap risky firewall/management changes in [Safe Mode](/docs/guides/safe-mode) so a
  mistake auto-reverts instead of locking you out.
- Bind HTTP to **localhost** unless you genuinely need remote access; when you
  do, put it behind a TLS-terminating reverse proxy with an explicit allow-list.
- Keep credentials out of shell history and image layers; prefer keys and
  secrets over inline passwords.
- **Don't expose a router's SSH port to the internet to manage it remotely** —
  put it behind a bastion and reach it with `jumpVia` (SSH ProxyJump). Only the
  bastion is reachable; the target rides a forwarded channel, so no extra port is
  opened. See [Multiple devices → SSH jump hosts](/docs/guides/multi-device#ssh-jump-hosts-bastion--proxyjump).
  Enable forwarding narrowly on the bastion (`/ip ssh set forwarding-enabled=local`).
