# Configuration

Every setting can be supplied as an **environment variable** or a **CLI flag**.

## Resolution order

Settings are resolved with the following precedence (later wins):

```
built-in defaults  →  environment variables  →  command-line flags
```

So a `--host` flag overrides `MIKROTIK_HOST`, which overrides the `127.0.0.1`
default.

## Connection settings

These control the SSH connection to the RouterOS device. On their own they define
a single device named `default`.

| Setting                  | CLI flag           | Environment variable      | Default     |
| ------------------------ | ------------------ | ------------------------- | ----------- |
| Host / IP                | `--host`           | `MIKROTIK_HOST`           | `127.0.0.1` |
| SSH username             | `--username`       | `MIKROTIK_USERNAME`       | `admin`     |
| SSH password             | `--password`       | `MIKROTIK_PASSWORD`       | _(empty)_   |
| SSH port                 | `--port`           | `MIKROTIK_PORT`           | `22`        |
| Private key file path    | `--key-filename`   | `MIKROTIK_KEY_FILENAME`   | _(unset)_   |
| Inline private key (PEM) | `--private-key`    | `MIKROTIK_PRIVATE_KEY`    | _(unset)_   |
| Private key passphrase   | `--key-passphrase` | `MIKROTIK_KEY_PASSPHRASE` | _(unset)_   |
| SSH connect timeout (ms) | `--timeout-ms`     | `MIKROTIK_TIMEOUT_MS`     | `10000`     |

### SSH jump host (bastion / ProxyJump)

Reach a router with no exposed SSH port by tunnelling through another over SSH —
only the bastion is reachable, no new port is opened on the target. For a single
device, point it at an inline bastion:

| Setting             | CLI flag                | Environment variable           | Default   |
| ------------------- | ----------------------- | ------------------------------ | --------- |
| Jump host / IP      | `--jump-host`           | `MIKROTIK_JUMP_HOST`           | _(unset)_ |
| Jump SSH port       | `--jump-port`           | `MIKROTIK_JUMP_PORT`           | `22`      |
| Jump username       | `--jump-username`       | `MIKROTIK_JUMP_USERNAME`       | `admin`   |
| Jump password       | `--jump-password`       | `MIKROTIK_JUMP_PASSWORD`       | _(unset)_ |
| Jump key file path  | `--jump-key-filename`   | `MIKROTIK_JUMP_KEY_FILENAME`   | _(unset)_ |
| Jump key passphrase | `--jump-key-passphrase` | `MIKROTIK_JUMP_KEY_PASSPHRASE` | _(unset)_ |

In a **multi-device** config, prefer a device's `jumpVia: "<device-name>"` to
reuse an existing entry as the bastion (chains and the RouterOS
`forwarding-enabled` prerequisite are covered in
**[Multiple devices → SSH jump hosts](./multi-device.md#ssh-jump-hosts-bastion--proxyjump)**).

## Multiple devices

To manage more than one router from a single server (e.g. to build a tunnel
between two), define a **named devices map**. The AI then targets a device per
call via an injected `device` argument.

| Setting                   | CLI flag    | Environment variable   |
| ------------------------- | ----------- | ---------------------- |
| Named-devices JSON file   | `--config`  | `MIKROTIK_CONFIG_FILE` |
| Named-devices inline JSON | `--devices` | `MIKROTIK_DEVICES`     |

Full guide, file format, and the per-device Safe Mode behaviour:
**[Multiple devices](./multi-device.md)**.

## Transport settings

These control how MCP clients reach the server. See [Transports](./transports.md)
for the full behavior.

| Setting                    | CLI flag                | Environment variable                              | Default               |
| -------------------------- | ----------------------- | ------------------------------------------------- | --------------------- |
| Transport                  | `--transport`           | `MIKROTIK_MCP__TRANSPORT` (alias `MCP_TRANSPORT`) | `stdio`               |
| HTTP bind host             | `--mcp-host`            | `MIKROTIK_MCP__HOST`                              | `0.0.0.0`             |
| HTTP bind port             | `--mcp-port`            | `MIKROTIK_MCP__PORT`                              | `8000`                |
| Allowed `Host` headers     | `--mcp-allowed-hosts`   | `MIKROTIK_MCP__ALLOWED_HOSTS`                     | _(empty)_             |
| Allowed `Origin` headers   | `--mcp-allowed-origins` | `MIKROTIK_MCP__ALLOWED_ORIGINS`                   | _(empty)_             |
| CORS allow-list for `/mcp` | `--mcp-cors-origins`    | `MIKROTIK_MCP__CORS_ORIGINS`                      | _(MCP-host defaults)_ |
| Read-only mode             | `--read-only`           | `MIKROTIK_READ_ONLY`                              | `false`               |
| App Views                  | `--app-views`           | `MIKROTIK_MCP__APP_VIEWS`                         | `false`               |
| Capability gating          | `--capability-gating`   | `MIKROTIK_MCP__CAPABILITY_GATING`                 | `annotate`            |

Transport values are `stdio`, `streamable-http`, or `sse`. The HTTP bind host,
port, and allow-lists only apply to the HTTP transports; they're ignored for
`stdio`.

Capability gating is `off`, `annotate` (default) or `filter` — how to treat tools
the target device cannot run. `filter` is honoured only in single-device mode.
See **[docs/capabilities.md](capabilities.md)**.

`--mcp-cors-origins` controls CORS on the `/mcp` endpoint, needed by the
**ChatGPT Apps** connector. Empty allows the built-in MCP-host origins
(ChatGPT, Claude); pass a comma-separated list to add your own, or `*` for any.

**Read-only mode** registers only `readOnlyHint` tools — inspection only, every
write/destructive tool is withheld. Turn it on whenever the server is exposed
publicly (e.g. a ChatGPT Apps connector) before authentication is in place. See
[Deploying to ChatGPT Apps](./docker.md#deploying-to-chatgpt-apps).

**App Views** controls whether read tools (`list_*`/`get_*`/`show_*`/`print_*`)
emit MCP App view metadata (`_meta.ui`). When enabled, these tools render
interactive table/detail widgets in supporting MCP hosts — but they also add
`(renders an MCP App view)` to every tool description, which can bloat the LLM
context. Disabled by default for a lean tool surface. Enable via the config file
(`mcp.appViews: true`), environment, CLI flag, or the dashboard's Modules view.

The `__` (double underscore) in the env var names is the nested-key delimiter.

## Tool surface (curation)

The server exposes several hundred tools across ~110 modules. MCP clients
discover tools by relevance search and only feed a **capped candidate set** to
the model, so on a surface this large a query can crowd out simple read tools
(e.g. `list_wireguard_*` losing to `build_wireguard_mesh`). If the model claims a
tool "doesn't exist" or can't be found, that's almost always retrieval bloat, not
a missing tool. Narrowing the surface to the scopes a deployment actually uses
makes every matching tool surface reliably.

Filter by module **slug** or **group** (see the module list in
[Tools reference](./tools-reference.md)):

| Setting         | CLI flag                   | Environment variable               | Default  |
| --------------- | -------------------------- | ---------------------------------- | -------- |
| Enable modules  | `--tools-enabled-modules`  | `MIKROTIK_TOOLS__ENABLED_MODULES`  | _(all)_  |
| Disable modules | `--tools-disabled-modules` | `MIKROTIK_TOOLS__DISABLED_MODULES` | _(none)_ |
| Enable groups   | `--tools-enabled-groups`   | `MIKROTIK_TOOLS__ENABLED_GROUPS`   | _(all)_  |
| Disable groups  | `--tools-disabled-groups`  | `MIKROTIK_TOOLS__DISABLED_GROUPS`  | _(none)_ |

Env/flag values are comma-separated lists; a JSON config file's `tools` block
(arrays) overrides them. Matching is case-insensitive. **Semantics:** when any
allow-list (`enabledModules`/`enabledGroups`) is non-empty, only matching modules
register and everything else drops. The deny-lists are then subtracted and **win**
over the allow-lists. Empty everywhere = the full surface (the default — zero
behaviour change).

Groups are: `Interfaces`, `Switch`, `Addressing & Routing`, `Dynamic Routing`,
`IPv6`, `Security`, `QoS`, `VPN & Tunneling`, `AAA`, `Tools`, `System & Ops`,
`MCP Apps`.

```bash
# Only expose addressing/routing + VPN scopes (smallest surface)
mikrotik-mcp serve --tools-enabled-groups "Addressing & Routing,VPN & Tunneling"

# Full surface minus the noisy diagnostic tools
MIKROTIK_TOOLS__DISABLED_GROUPS="Tools" mikrotik-mcp serve
```

Or in a JSON config file:

```json
{
  "tools": {
    "enabledGroups": ["VPN & Tunneling", "Security"],
    "disabledModules": ["wireguard-mesh"]
  }
}
```

> Read-only mode and tool curation compose: curation picks the modules, then
> read-only drops every write/destructive tool from what remains.

## Logging

| Setting       | Environment variable | Default | Values                           |
| ------------- | -------------------- | ------- | -------------------------------- |
| Log verbosity | `MIKROTIK_LOG_LEVEL` | `info`  | `debug`, `info`, `warn`, `error` |

All log output is written to **stderr** (never stdout, which carries the
JSON-RPC protocol stream on the stdio transport). Each line is prefixed with
`[mikrotik-mcp]` and the level; color is added automatically when stderr is a
TTY. Set `MIKROTIK_LOG_LEVEL=debug` to see every command the server issues.

## Authentication: key file vs. password

The SSH client accepts a private key, a password, or both. Resolution:

1. **Inline private key** (`MIKROTIK_PRIVATE_KEY` / `--private-key`) — a PEM
   string. Takes precedence over a key file.
2. **Key file** (`MIKROTIK_KEY_FILENAME` / `--key-filename`) — a path read from
   disk at connect time. If the file can't be read, the connection fails with a
   logged error.
3. **Key passphrase** (`MIKROTIK_KEY_PASSPHRASE` / `--key-passphrase`) — supply
   this when the private key (file or inline) is **encrypted**. It is ignored
   when no key is configured.
4. **Password** (`MIKROTIK_PASSWORD` / `--password`) — added to the SSH config
   when present. The key is tried first; a password can be supplied as a fallback.

`auth-check` prints which mode it used (`Auth mode: SSH key` or `password`) so
you can confirm at a glance.

**Recommendation:** prefer key-based auth, especially in containers, where a
plaintext password in the environment is visible via `docker inspect`. The
server emits a security warning when it detects a plaintext password while
running inside a container. See [Security](./security.md).

## S3 backup storage (optional)

The S3 backup tools ship device backups and config exports to any
S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, …)
using Bun's native S3 client. The feature is **opt-in**: with no S3 settings
the tools simply report that storage is disabled and do nothing.

Credentials follow Bun's native lookup order — `S3_*` first, then `AWS_*` as a
fallback — and can be overridden by flags or a JSON config `s3` block.

| Setting               | CLI flag                  | Environment variable                             | Default    |
| --------------------- | ------------------------- | ------------------------------------------------ | ---------- |
| Access key ID         | `--s3-access-key-id`      | `S3_ACCESS_KEY_ID` / `AWS_ACCESS_KEY_ID`         | _(unset)_  |
| Secret access key     | `--s3-secret-access-key`  | `S3_SECRET_ACCESS_KEY` / `AWS_SECRET_ACCESS_KEY` | _(unset)_  |
| Session token         | `--s3-session-token`      | `S3_SESSION_TOKEN` / `AWS_SESSION_TOKEN`         | _(unset)_  |
| Region                | `--s3-region`             | `S3_REGION` / `AWS_REGION`                       | _(unset)_  |
| Endpoint (R2/MinIO/…) | `--s3-endpoint`           | `S3_ENDPOINT` / `AWS_ENDPOINT`                   | _(AWS S3)_ |
| Bucket                | `--s3-bucket`             | `S3_BUCKET` / `AWS_BUCKET`                       | _(unset)_  |
| Key prefix            | `--s3-prefix`             | `MIKROTIK_S3_PREFIX`                             | _(empty)_  |
| Presigned-URL TTL (s) | `--s3-presign-expires-in` | `MIKROTIK_S3_PRESIGN_EXPIRES_IN`                 | `3600`     |

S3 is considered configured once a **bucket**, **endpoint**, or **access key**
is present.

### Per-device layout

Backups are organised per device so each router's files live under their own
"folder": object keys default to `<prefix>/<device>/<filename>` (e.g.
`mikrotik/site-a/daily.backup`). `list_s3_backups` defaults to the current
device's prefix; pass an explicit `prefix` (including `""` for the whole
bucket) to look elsewhere.

### How transfers work

Uploads and downloads are performed by the **device itself** via `/tool fetch`
against a short-lived presigned URL generated by the Bun S3 client, so large or
binary backups stream straight between the router and S3 without passing
through the MCP server. Object listing, `stat` and deletion are done
server-side with the native Bun S3 client.

### JSON config block

When using a config file (`--config` / `MIKROTIK_CONFIG_FILE`), add an `s3`
block alongside `devices`:

```json
{
  "defaultDevice": "site-a",
  "devices": { "site-a": { "host": "203.0.113.10", "keyFilename": "/keys/a" } },
  "s3": {
    "bucket": "my-mikrotik-backups",
    "region": "us-east-1",
    "prefix": "mikrotik/",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com"
  }
}
```

## Example

A fully explicit invocation over the streamable-HTTP transport, bound to
localhost with key auth:

```bash
mikrotik-mcp serve \
  --host 192.168.88.1 \
  --username automation \
  --key-filename ~/.ssh/mikrotik_ed25519 \
  --transport streamable-http \
  --mcp-host 127.0.0.1 \
  --mcp-port 8000
```

The same thing via environment variables:

```bash
export MIKROTIK_HOST=192.168.88.1
export MIKROTIK_USERNAME=automation
export MIKROTIK_KEY_FILENAME=~/.ssh/mikrotik_ed25519
export MIKROTIK_MCP__TRANSPORT=streamable-http
export MIKROTIK_MCP__HOST=127.0.0.1
export MIKROTIK_MCP__PORT=8000
mikrotik-mcp serve
```
