# Docker

The server is a single Bun process, so a container image is small and simple. It
reaches the RouterOS device over the network via SSH, so the container only needs
outbound access to the device.

A ready-to-use **`docker-compose.yml`** ships in the repo root:

```bash
test -e devices.json || cp docker/devices.example.json devices.json
# Edit devices.json: devices, credentials/key paths, dashboard.enabled, etc.
docker compose pull mikrotik-mcp
docker compose up -d mikrotik-mcp  # → http://localhost:8000/mcp
```

It requires an existing writable `devices.json`, runs HTTP by default and includes an optional `chatgpt` profile
(a Cloudflare tunnel) — see [Deploying to ChatGPT Apps](#deploying-to-chatgpt-apps).
The sections below explain the pieces it wires up.

## Host compatibility

This is a **multi-architecture Linux image**, not an ARM-only image. Docker selects
the variant matching its Linux engine. The Alpine filesystem inside the image
does not require Alpine on the host: Ubuntu, Debian and other Linux distributions
run the same image.

| Host                                                            | Container engine                               | Image variant                 |
| --------------------------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| Ubuntu / Debian / Fedora and other supported x86-64 Linux hosts | Docker Engine + Compose v2                     | `linux/amd64`                 |
| ARM64 Linux, including 64-bit Raspberry Pi OS                   | Docker Engine + Compose v2                     | `linux/arm64`                 |
| Windows x86-64                                                  | Docker Desktop, WSL2 backend, Linux containers | `linux/amd64`                 |
| macOS on Intel / Apple Silicon                                  | Docker Desktop                                 | `linux/amd64` / `linux/arm64` |

Windows-on-ARM requires a compatible Docker Desktop ARM release and Linux backend;
its host support follows Docker's support policy. Native Windows containers,
32-bit x86 and 32-bit ARM are not image targets. Windows Server needs a supported
Linux VM/engine; installing this image does not turn it into a Windows container.
See [Docker's multi-platform model](https://docs.docker.com/build/building/multi-platform/)
and [Windows installation requirements](https://docs.docker.com/desktop/setup/install/windows-install/).

Check the **engine**, not the host terminal's OS:

```sh
docker info --format '{{.OSType}}/{{.Architecture}}'
docker buildx imagetools inspect alimaster/mikrotik-mcp:6.2.0
```

The engine should report `linux/x86_64` or `linux/aarch64` (some versions use
`amd64` / `arm64`). Do not force `platform: linux/arm64` on an Intel/AMD machine,
or globally override `DOCKER_DEFAULT_PLATFORM`. Compose intentionally has no
`platform` setting. It also avoids host-network mode for Desktop compatibility.

### Windows PowerShell quick start

Install/start Docker Desktop with its WSL2 backend and **Linux containers**, then
run these commands from this repository's directory in PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .\devices.json)) {
  Copy-Item .\docker\devices.example.json .\devices.json
}
notepad .\devices.json
# Configure your devices and set dashboard.enabled to true before starting.
docker compose pull mikrotik-mcp
docker compose up -d mikrotik-mcp
docker compose ps mikrotik-mcp
```

Dashboard: **http://localhost:9090**; MCP: **http://localhost:8000/mcp**.
The existing JSON is never overwritten by the copy step. Keep it UTF-8 and mount
SSH keys separately; a Windows key path in JSON is not a container path. For a
different configuration file, set `$env:MIKROTIK_CONFIG_PATH = 'C:/path/devices.json'`
before `docker compose up`; quote paths containing spaces. Named volumes keep
SQLite databases on the Linux filesystem and survive container recreation.

### Linux and macOS

Use the shell quick start at the top of this page. On Linux, ensure container UID
1000 can read/write the mounted JSON while preserving restrictive permissions;
see [Persistent devices.json](#persistent-devicesjson). On Docker Desktop, ensure
the source file's directory is shared with Docker. No host installation of Bun
or Node.js is required when using the published image.

## Published image

Docker Hub: **[alimaster/mikrotik-mcp](https://hub.docker.com/r/alimaster/mikrotik-mcp)**.
The versioned `6.2.0` image provides `linux/amd64` and `linux/arm64`; Docker
selects the matching architecture automatically. Compose uses `6.2.0` by default,
with no implicit local build. Prefer a release tag for deliberate upgrades;
`latest` moves only after explicit promotion and may point to an older release.

```bash
docker pull alimaster/mikrotik-mcp:6.2.0
# Optional: opt into the moving tag. Use the same override for pull and up.
MIKROTIK_IMAGE_TAG=latest docker compose pull mikrotik-mcp
MIKROTIK_IMAGE_TAG=latest docker compose up -d mikrotik-mcp
```

Pulling an image does not restart an existing container. `up -d` recreates the
service when its image/config changes while retaining the configured JSON and
state mounts. Confirm pending configuration edits before recreation; never use
`down -v` for an upgrade. Keep one writer per `devices.json`.

For local development, build a separate tag and select it explicitly:

```bash
docker build --pull -t alimaster/mikrotik-mcp:local .
MIKROTIK_IMAGE_TAG=local docker compose up -d --pull never mikrotik-mcp
```

Maintainers: use the **[Docker Hub publishing workflow](docker-publishing.md)**.
Push the versioned tag first, verify its remote manifest and pulled runtime, then
promote that exact digest to `latest`. Publishing is separate from a Git release
and does not restart an existing service.

## Minimal production image

The repository Dockerfile pins **Bun 1.4.2 Alpine**, the latest stable release
checked on October 3, 2026. All stages use the same Bun version; there is no Node
runtime, Git, compiler toolchain, or package installation in the final image.
To deliberately test a newer version, use `--build-arg BUN_VERSION=x.y.z`.
The builder runs on `BUILDPLATFORM` and produces architecture-independent
JavaScript and HTML; the final Bun image uses the requested target platform.
This avoids QEMU/JSC failures during cross-platform builds. No `.node` binaries
are copied from the builder. Even the private state directory and default JSON
are prepared on `BUILDPLATFORM`: the final stage contains no `RUN`, so assembling
the other architecture never executes its binaries. The state directory is
owned by `bun` with mode `0700`; the seed JSON is `0600`.
To publish both supported architectures, use
`docker buildx build --platform linux/amd64,linux/arm64` with your desired output.
Run the resulting image on matching hardware: Bun 1.4.2's x64 JavaScriptCore was
observed aborting with `MemoryExhaustion` under QEMU on an ARM Docker Desktop host.
Successful cross-building is not a native amd64 runtime validation; do not
disable production JIT or skip verification to hide an emulation failure.

For a local build on any supported host, `docker build -t mikrotik-mcp:local .`
uses the engine's native architecture. For a two-architecture build without
publishing, use a multi-platform-capable Buildx builder and an OCI output:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=mikrotik-mcp.oci.tar .
```

The `Docker portability` GitHub workflow builds and smoke-tests separately on
native Ubuntu x86-64 and ARM64 runners (no QEMU). It checks the packaged Bun and
MCP versions, non-root UID, healthcheck, dashboard HTML, MCP initialization and
tool pagination, and a writable disposable JSON mount. The MCP port is changed
in that fixture to verify that the healthcheck follows JSON settings. Containers
have `--network none`, no real device credentials, and no published ports. This
does not claim a Windows Desktop end-to-end test or verify live router access;
CI results must pass before claiming native validation of a release.

The multi-stage build installs the frozen lockfile with the repository's Bun
settings, then uses Bun's bundler to minify the CLI and bundle ordinary runtime
dependencies. SDK and Zod remain together; the Docker-only bundler also handles
centrs' raw TypeScript directly. Published npm/MCPB builds remain unchanged.
`ssh2`, `figlet` and their required dependencies remain file-backed. Only the
banner's Small font ships; optional native SSH accelerators are omitted, using
the same pure-JavaScript fallback as an install with lifecycle scripts disabled.

The final image includes the dashboard and all MCP App views, prompts, schemas,
built-in policies, offline flags and third-party notices. It excludes the source
tree, library-only bundles, declarations, source maps, tests and build tools.
`.dockerignore` is an allow-list so local `.env` files, router configs, keys,
databases and host dependencies do not enter the build context.

The server runs as **UID/GID 1000 (`bun`)**. Persist its default databases,
knowledge memory and backups at `/home/bun/.mikrotik-mcp`; Compose mounts a named
volume there. Existing bind mounts and private keys must be accessible to that
UID. Do not make a private key world-readable to solve a permissions mismatch.
Runtime auto-install and automatic `.env` loading are disabled; pass configuration
with environment variables, a mounted config, or Docker secrets instead.

Pull and run:

```bash
docker pull alimaster/mikrotik-mcp:6.2.0

docker run --rm -it \
  -e MIKROTIK_HOST=192.168.88.1 \
  -e MIKROTIK_USERNAME=automation \
  alimaster/mikrotik-mcp:6.2.0 auth-check
```

## Passing configuration

The image reads `MIKROTIK_CONFIG_FILE=/home/bun/.mikrotik-mcp/devices.json` by
default. The image seeds that file with HTTP port 8000 and dashboard port 9090
(dashboard disabled). A new named volume inherits the seed; an existing volume
or host directory must already contain `devices.json`. Environment-only device
credentials still work with the empty starter `devices` map. Once devices are
saved in JSON, configure them there instead of mixing sources.

Explicit [environment settings](./configuration.md) and CLI flags override JSON.
Unlike earlier images, Docker no longer bakes transport/bind/port **environment**
defaults that would override edits saved to the file. Use `-e` deliberately:

```bash
docker run --rm \
  -e MIKROTIK_HOST=192.168.88.1 \
  -e MIKROTIK_USERNAME=automation \
  -e MIKROTIK_KEY_FILENAME=/run/secrets/mikrotik_key \
  -e MIKROTIK_MCP__TRANSPORT=streamable-http \
  -e MIKROTIK_MCP__PORT=8000 \
  -e MIKROTIK_MCP__ALLOWED_HOSTS=mcp.example.com \
  -v /path/to/key:/run/secrets/mikrotik_key:ro \
  -p 8000:8000 \
  alimaster/mikrotik-mcp:6.2.0 serve
```

For the HTTP transports, publish the port (`-p 8000:8000`) and remember that
binding to `0.0.0.0` without an allow-list disables DNS-rebinding protection —
set `MIKROTIK_MCP__ALLOWED_HOSTS` to your domain. See
[Transports](./transports.md#dns-rebinding-protection).

The image's healthcheck runs a bounded Bun `fetch` against `/health`, following
explicit `MIKROTIK_MCP__PORT`, then `mcp.port` in the JSON (fallback 8000). It checks server liveness, **not router
reachability**. No extra HTTP client is installed. If you override the HTTP port
using a CLI flag, also set this environment variable to the same port. Config-file
port edits require restarting the listener and adjusting published ports.
For stdio-only containers, use `--no-healthcheck`.

The dashboard stays opt-in and defaults to **9090** when enabled:

```bash
docker run --rm \
  -p 127.0.0.1:8000:8000 -p 127.0.0.1:9090:9090 \
  -e MIKROTIK_HOST=192.168.88.1 \
  -e MIKROTIK_USERNAME=automation \
  -e MIKROTIK_KEY_FILENAME=/run/secrets/mikrotik_key \
  -e MIKROTIK_DASHBOARD__ENABLED=true \
  -v /path/to/key:/run/secrets/mikrotik_key:ro \
  -v mikrotik-state:/home/bun/.mikrotik-mcp \
  alimaster/mikrotik-mcp:6.2.0
```

`EXPOSE` documents ports; it does not publish them. Compose publishes MCP and
dashboard ports on host loopback; enable the dashboard in JSON. Keep management endpoints
private or put an authenticated HTTPS proxy in front of them. MAC-Telnet still
requires real Layer-2 reachability; Docker Desktop's VM/NAT does not provide that
to the physical LAN merely because its dependencies are bundled.

To inspect the result, use `docker image inspect alimaster/mikrotik-mcp:6.2.0 --format '{{.Size}}'`
and `docker history alimaster/mikrotik-mcp:6.2.0`. Report the platform and whether a size is
compressed registry storage or unpacked layer size when comparing images.

## Persistent devices.json

`devices.json` is the **whole server configuration**, including device inventory,
MCP transport, dashboard, SSH pool, memory settings, access rules, modules,
scheduled audits, flow collection, alerts, policies, attack detection, S3 and
service-probe settings. Config/Devices saves serialize the full validated config;
MCP settings tools use the same file and safe-apply coordinator. No separate
container-only settings file is created. Confirm a pending save with **Keep
changes** / `confirm_mcp_settings` before a planned restart. Changes to listeners
and transport require restarting the server; Docker port publishing must match.

### Single-file mount

Use the complete JSON example and `docker run` command in the
[README](../README.md#docker-one-writable-devicesjson-for-all-mcp-settings).
Mount the host file read-write at `/home/bun/.mikrotik-mcp/devices.json` and keep
`mikrotik-state` mounted at its parent. The file must already exist; `--mount`
fails for a missing source, and Compose uses `create_host_path: false` to avoid
silently creating a directory where JSON was expected. See
[Docker bind-mount documentation](https://docs.docker.com/engine/storage/bind-mounts/).

Compose accepts `MIKROTIK_CONFIG_PATH=/absolute/path/devices.json`; otherwise it
uses `./devices.json`. `MCP_PORT` and `DASHBOARD_PORT` only control port mappings,
so keep them equal to the corresponding JSON ports (defaults 8000 and 9090).
Leave application env overrides out of `.env` when the file is authoritative.
An existing JSON must explicitly bind listeners to `0.0.0.0` inside the container
for published ports to work; host mappings can remain loopback-only.

Writes preserve the mounted inode: normal files still use a private temporary
file and atomic rename; **only `EBUSY` on rename** triggers the single-file mount
fallback. It flushes a private `.bak-mounted-*` copy first, writes and flushes
the new contents, and attempts to restore the original bytes on an I/O failure.
It never bypasses `EROFS`/permission errors. This is not atomic across process or
power failure; retain the backup for manual recovery. Backups/history live in
the persistent parent state volume. Run only one writer for a given JSON; do not
share a live local service's file with a second container. Host editors that
replace files via rename require recreating the container to remount the new inode.

### Directory mount (recommended for atomic updates)

Place `devices.json` in a dedicated writable state directory, then mount that
directory instead of the named volume and individual JSON mount:

```bash
docker run -d --name mikrotik-mcp --restart unless-stopped \
  -p 127.0.0.1:8000:8000 -p 127.0.0.1:9090:9090 \
  --mount type=bind,src=/absolute/path/mikrotik-state,dst=/home/bun/.mikrotik-mcp \
  --mount type=bind,src=/absolute/path/mikrotik_ed25519,dst=/run/secrets/mikrotik_key,readonly \
  alimaster/mikrotik-mcp:6.2.0
```

Both the directory (for temp files/backups) and JSON must be writable by UID/GID 1000. On Linux give that UID access through ownership or a suitable ACL; keep the
directory private and JSON/key permissions restrictive (JSON `0600`). Do not
solve a mismatch with `chmod 777` or world-readable secrets. A read-only JSON can
be loaded but cannot persist edits; inspect save errors / `persisted:false`.

Settings remain in JSON, while Memory entries, SQLite events/usage reports,
backup files and config history remain in the parent state directory. Mount any
custom data paths too. Recreating the container preserves these mounts; removing
the named volume with `docker compose down -v` deletes its data. Never bake real
devices/credentials into the image or commit them to Git.

## Security: don't put passwords in env

Environment variables are visible via `docker inspect`. When the server detects
it's running in a container (`/.dockerenv` or `container=docker`) with a plaintext
`MIKROTIK_PASSWORD`, it logs a security warning.

**Prefer a mounted SSH key or Docker/Compose secrets** over an inline password:

```yaml
# docker-compose.yml (excerpt)
services:
  mikrotik-mcp:
    image: alimaster/mikrotik-mcp:6.2.0
    command: ["serve"]
    environment:
      MIKROTIK_HOST: 192.168.88.1
      MIKROTIK_USERNAME: automation
      MIKROTIK_KEY_FILENAME: /run/secrets/mikrotik_key
    secrets:
      - mikrotik_key
    ports:
      - "8000:8000"

secrets:
  mikrotik_key:
    file: ./secrets/mikrotik_ed25519
```

See [Security](./security.md) for the full threat model.

## Deploying to ChatGPT Apps

The server exposes its tools — and the interactive [MCP App views](./configuration.md)
(e.g. the device dashboard) — over the streamable-HTTP transport, which is what a
**ChatGPT Apps connector** talks to. ChatGPT requires three things the connector
checks for: a **public HTTPS `/mcp`**, **CORS** on that endpoint, and (for the
inline view) the App metadata the server already emits. CORS is built in; you
provide the public HTTPS.

> ⚠️ **This server SSHes into your router(s).** A public `/mcp` that anyone can
> reach can reconfigure your network. Until you put **authentication** in front
> of it, run it **read-only** (`--read-only` / `MIKROTIK_READ_ONLY=true`) so the
> connector can only _inspect_ — every write/destructive tool is withheld from
> the surface entirely. Keep writes for a trusted, authenticated path.

### 1. Run the server (read-only, CORS-ready)

```bash
docker run --rm \
  -e MIKROTIK_HOST=192.168.88.1 \
  -e MIKROTIK_USERNAME=automation \
  -e MIKROTIK_KEY_FILENAME=/run/secrets/mikrotik_key \
  -e MIKROTIK_MCP__TRANSPORT=streamable-http \
  -e MIKROTIK_MCP__HOST=0.0.0.0 -e MIKROTIK_MCP__PORT=8000 \
  -e MIKROTIK_MCP__ALLOWED_HOSTS=your-tunnel.example.com \
  -e MIKROTIK_READ_ONLY=true \
  -v /path/to/key:/run/secrets/mikrotik_key:ro \
  -p 8000:8000 \
  alimaster/mikrotik-mcp:6.2.0 serve
```

CORS defaults to the ChatGPT and Claude origins; set
`MIKROTIK_MCP__CORS_ORIGINS` to add others (or `*` to allow any). The startup
log shows `… app views (streamable-http) [READ-ONLY]`.

### 2. Put HTTPS in front (Cloudflare Tunnel)

ChatGPT needs an `https://` URL. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
is the simplest zero-config option (no inbound ports, free TLS):

```bash
# Quick tunnel (ephemeral hostname) — great for first-time testing:
cloudflared tunnel --url http://localhost:8000
#  → https://random-words.trycloudflare.com   ⇒  endpoint: …/mcp

# Or a named tunnel bound to your own domain (stable, for keeps):
cloudflared tunnel create mikrotik-mcp
cloudflared tunnel route dns mikrotik-mcp mcp.example.com
cloudflared tunnel run --url http://localhost:8000 mikrotik-mcp
```

Set `MIKROTIK_MCP__ALLOWED_HOSTS` to the tunnel hostname so DNS-rebinding
protection stays on. `ngrok http 8000` works the same way for a quick test.

Run both together with Compose:

```yaml
# docker-compose.yml (excerpt)
services:
  mikrotik-mcp:
    image: alimaster/mikrotik-mcp:6.2.0
    command: ["serve"]
    environment:
      MIKROTIK_HOST: 192.168.88.1
      MIKROTIK_USERNAME: automation
      MIKROTIK_KEY_FILENAME: /run/secrets/mikrotik_key
      MIKROTIK_MCP__TRANSPORT: streamable-http
      MIKROTIK_MCP__ALLOWED_HOSTS: mcp.example.com
      MIKROTIK_READ_ONLY: "true"
    secrets: [mikrotik_key]
  tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CF_TUNNEL_TOKEN}
    depends_on: [mikrotik-mcp]
```

### 3. Connect in ChatGPT

1. ChatGPT → **Settings** → enable **Developer mode**.
2. **Settings → Connectors → Create** → set the URL to
   `https://mcp.example.com/mcp`.
3. New chat → _"show my MikroTik dashboard"_. ChatGPT calls
   `show_system_dashboard` and renders the dashboard view inline. **Refresh the
   connector** after any server change. For a public listing, follow OpenAI's
   app submission/review flow.

### Notes

- **Verify the endpoint** before connecting:
  `curl -i -X OPTIONS https://mcp.example.com/mcp -H 'Origin: https://chatgpt.com'`
  should return `204` with `access-control-allow-origin: https://chatgpt.com`.
- **Claude** needs none of this — Claude Desktop connects over local stdio (or
  the same HTTP endpoint) without public hosting.
- The container must keep **outbound SSH** reach to the MikroTik device(s).
