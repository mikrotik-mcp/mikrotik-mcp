<div align="center">
  <img src="assets/logo.svg" alt="MikroTik MCP" width="440" />
  <p><strong>Your network. One conversation.</strong><br />
  RouterOS management, diagnostics and evidence for your AI assistant.</p>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-7C3AED.svg" /></a>
  <img alt="Bun runtime" src="https://img.shields.io/badge/runtime-Bun-06B6D4.svg" />
  <a href="docs/README.md"><img alt="Documentation" src="https://img.shields.io/badge/docs-field%20guide-1F2937.svg" /></a>
</div>

**MikroTik MCP** connects Claude, Codex and other MCP clients to one or more MikroTik routers. Inspect the network, investigate a connection, preview changes and verify the result. The server runs on **Bun** and uses SSH by default; no agent is required on the router.

**[Documentation website →](docs/README.md)** · [Getting started](docs/content/docs/guides/getting-started.md) · [AI installation prompt](docs/content/docs/guides/installation-assistant.md) · [Tool reference](docs/content/docs/reference/index.md)

## Get connected

Install [Bun](https://bun.sh) (the project pins its tested version in `package.json`), then:

```sh
bun add -g @usex/mikrotik-mcp
mikrotik-mcp --help
```

Add this server to a local MCP client, replacing the example host, username and key path:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "mikrotik-mcp",
      "args": ["serve"],
      "env": {
        "MIKROTIK_HOST": "192.168.88.1",
        "MIKROTIK_USERNAME": "automation",
        "MIKROTIK_KEY_FILENAME": "/absolute/path/to/private-key"
      }
    }
  }
}
```

Import the matching **public** key into the intended RouterOS user, then verify connectivity with `auth-check` before making changes. The [setup guide](docs/content/docs/guides/getting-started.md) covers passwords, key creation and troubleshooting. Prefer one shared process? Follow [service deployment](docs/content/docs/guides/shared-service.md) and [client configuration](docs/content/docs/guides/connecting-clients.md). Docker is optional.

## Explore the dashboard

```sh
mikrotik-mcp serve --config /absolute/path/devices.json \
  --dashboard --dashboard-host 127.0.0.1 --dashboard-port 9090
```

Open `http://127.0.0.1:9090`. The dashboard brings together:

- **Network operations:** device setup, address failover, routing, Wi-Fi, VPN sessions and user accounting.
- **Investigation:** client paths, packet and flow evidence, service checks, site activity and incident timelines.
- **Controlled changes:** plans, Safe Mode, access scope, transactions, rollouts, snapshots and recovery workflows.
- **MCP workspace:** tool-call tracing, configuration, memory, prompts and module controls.

See [every dashboard page](docs/content/docs/dashboard/index.md), with full-page previews and instructions for its controls and limitations.

<!-- Keep the GitHub video attachment URL alone so GitHub renders a player. -->

https://github.com/user-attachments/assets/f6dba72e-60f8-47ef-9045-2e871d92c8f0

[Watch the dashboard film](https://mikrotik-mcp.usestrict.dev/motion/index.html) · [Download MP4](assets/motion/dashboard-film.mp4) · 60 seconds · 1080p · Synthetic demonstration data

## Documentation

The new website lives in `docs/`. Run `cd docs && bun install --frozen-lockfile && bun run dev`, then open `http://localhost:4000`. It includes operational guides, all dashboard pages, the generated tool/configuration/prompt references and a clearly marked historical archive. [Build and deployment instructions](docs/README.md).

| Start here                                                   | Continue with                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [Configuration](docs/content/docs/guides/configuration.md)   | [Multiple routers and failover](docs/content/docs/guides/endpoint-failover.md) |
| [Docker and persistence](docs/content/docs/guides/docker.md) | [Publishing images](docs/content/docs/guides/docker-publishing.md)             |
| [Security and access](docs/content/docs/guides/security.md)  | [Safe Mode](docs/content/docs/guides/safe-mode.md)                             |
| [Development](docs/content/docs/guides/development.md)       | [Architecture](docs/content/docs/guides/architecture.md)                       |

Only manage routers you are authorized to control. Use scoped credentials, review write operations and keep recoverable backups. Safe Mode and multi-device rollback have practical limits; they do not replace verification.

## License

[MIT](LICENSE). Made by [Ali Torki](https://github.com/ali-master) and contributors.
