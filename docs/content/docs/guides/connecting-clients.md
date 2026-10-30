---
title: "Connecting clients"
description: "Connect Claude, ChatGPT, Codex, Cursor, Copilot and other MCP-compatible AI apps, with client-specific configuration and a shared Bun service."
---

One router connection. Your choice of AI app. MikroTik MCP works with clients that
support **stdio** or **Streamable HTTP**; the app decides how tools are enabled,
approved and presented.

This guide covers the major desktop apps, coding assistants and hosted clients,
plus a recipe for other MCP clients. Client features and settings change; the
instructions below were checked against official documentation on **October 30,
2026**. Support for MCP does not imply support for every MCP feature or interactive
[MCP App view](/docs/guides/mcp-app-workspaces).

## Find your app

Choose an app to jump straight to its setup. **Local** means the app starts the
MCP process. **Shared** means it connects to an already running service.

| App                                                                 | Recommended connection           | Where to configure it              |
| ------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| [Claude Desktop](#claude-desktop-stdio)                             | Local stdio                      | Settings → Developer → Edit Config |
| [Claude Code](#claude-code)                                         | Shared HTTP                      | `claude mcp add`                   |
| [Claude web, mobile and Cowork](#claude-remote-connectors)          | Remote connector                 | Customize → Connectors             |
| [Codex CLI, desktop and IDE](#codex-cli-desktop-and-ide)            | Shared HTTP                      | Codex MCP settings / `config.toml` |
| [ChatGPT](#chatgpt)                                                 | Remote HTTP or Secure MCP Tunnel | Add custom MCP server              |
| [Cursor](#cursor)                                                   | Shared HTTP                      | `.cursor/mcp.json`                 |
| [VS Code / GitHub Copilot](#vs-code-and-github-copilot)             | Shared HTTP                      | MCP: Add Server                    |
| [GitHub Copilot CLI](#github-copilot-cli)                           | Shared HTTP                      | `/mcp add`                         |
| [Gemini CLI](#gemini-cli)                                           | Shared HTTP                      | `.gemini/settings.json`            |
| [Qwen Code](#qwen-code)                                             | Shared HTTP                      | `qwen mcp add`                     |
| [Windsurf / Devin Desktop and CLI](#windsurf-and-devin-desktop)     | Shared HTTP                      | Customize → MCPs                   |
| [JetBrains AI Assistant / Junie](#jetbrains-ai-assistant-and-junie) | Shared HTTP or local stdio       | AI Assistant → MCP                 |
| [Cline](#cline)                                                     | Shared HTTP                      | MCP Servers → Remote Servers       |
| [Roo Code](#roo-code)                                               | Local stdio or shared HTTP       | MCP Servers panel                  |
| [Kilo Code](#kilo-code)                                             | Shared HTTP                      | Agent Behaviour → MCP Servers      |
| [Continue](#continue)                                               | Local stdio                      | `.continue/mcpServers/`            |
| [Zed](#zed)                                                         | Local stdio                      | AI → MCP Servers                   |
| [Kiro](#kiro)                                                       | Shared HTTP                      | Kiro: Open user MCP config         |
| [OpenCode](#opencode)                                               | Shared HTTP                      | `opencode.json`                    |
| [Goose](#goose)                                                     | Local stdio or shared HTTP       | Extensions / `goose configure`     |
| [LM Studio](#lm-studio)                                             | Shared HTTP                      | Program → Install → Edit mcp.json  |
| [Cherry Studio](#cherry-studio)                                     | Shared HTTP                      | MCP Servers                        |
| [Chatbox AI](#chatbox-ai)                                           | Shared HTTP                      | Settings → MCP; Work Mode          |
| [AnythingLLM Desktop](#anythingllm-desktop)                         | Local stdio                      | Agent Skills                       |
| [LibreChat](#librechat)                                             | Shared HTTP from its backend     | `librechat.yaml`                   |
| [Open WebUI](#open-webui)                                           | Shared HTTP from its backend     | Admin → Integrations               |
| [Devin Cloud](#devin-cloud)                                         | Remote HTTP                      | Customize → MCPs                   |
| [Other MCP clients](#other-mcp-clients)                             | stdio or Streamable HTTP         | Client-specific MCP settings       |

## Prepare once

Install [Bun and MikroTik MCP](/docs/guides/getting-started), then create a
[devices.json configuration](/docs/guides/multi-device) on the machine that will
run the server. Docker is **not** required.

```bash
bun add -g @usex/mikrotik-mcp
mikrotik-mcp auth-check --config /absolute/path/devices.json
```

Keep router credentials and SSH private keys on that machine. The AI app needs
only the launch command or MCP URL. Use absolute paths; replace the placeholders
in this guide with your own paths. Merge the `mikrotik` entry into existing
settings instead of replacing other servers.

### Key-file authentication

Configure the router's SSH key in `devices.json`, following
[SSH keys and authentication](/docs/guides/ssh-keys). The key
path is resolved on the **MCP host**, not on the remote AI app's machine. Do not
paste a private key into chat or a shared workspace configuration.

### Choose how the app connects

| Situation                               | Use                                                             | What runs where                                      |
| --------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| One desktop app, simplest setup         | stdio                                                           | The app starts and stops its own MCP process.        |
| Several apps on the same computer       | Shared Streamable HTTP                                          | One Bun service serves separate client sessions.     |
| Self-hosted chat app                    | Streamable HTTP                                                 | The chat backend must be able to reach the MCP host. |
| Cloud app such as ChatGPT or Claude web | Authenticated remote endpoint, or the client's supported tunnel | The connection originates outside your laptop.       |

### Shared service — recommended for several apps

Start one service and reuse it from every local HTTP-capable client:

```bash
mikrotik-mcp serve \
  --config /absolute/path/devices.json \
  --transport streamable-http \
  --mcp-host 127.0.0.1 \
  --mcp-port 8080 \
  --dashboard \
  --dashboard-host 127.0.0.1 \
  --dashboard-port 9090
```

- **MCP endpoint:** `http://127.0.0.1:8080/mcp`
- **Dashboard:** `http://127.0.0.1:9090`
- **Liveness:** `http://127.0.0.1:8080/health`

The dashboard address is **not** the MCP endpoint. Leave this process running,
or use [shared service deployment](/docs/guides/shared-service) to start it with
your operating system. Do not launch another server on the same ports from each
app. For a first connection limited to observation, add `--read-only` to the
server command; remove it only when you intend to allow writes.

### Local stdio template

Apps using the `mcpServers` format can use this local configuration. The app
launches the executable directly; the command field is not a shell command line.

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "/absolute/path/mikrotik-mcp",
      "args": ["serve", "--transport", "stdio", "--config", "/absolute/path/devices.json"]
    }
  }
}
```

A desktop app may not inherit your terminal's `PATH`, including Bun. If the
installed launcher cannot find Bun, set `command` to the absolute Bun executable
and put the installed package's `dist/cli.js` path first in `args`:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "/absolute/path/bun",
      "args": [
        "/absolute/path/@usex/mikrotik-mcp/dist/cli.js",
        "serve",
        "--transport",
        "stdio",
        "--config",
        "/absolute/path/devices.json"
      ]
    }
  }
}
```

On Windows, use the actual `bun.exe` and package paths, with JSON-escaped
backslashes such as `C:\\Users\\you\\...`. This is a Bun server: do not replace
Bun with Node.js. Never add a shell banner or other stdout output to the launcher;
stdout carries the MCP protocol.

### Running from source

With this repository's dependencies installed, the same Bun command can run
`src/cli.ts` instead of the installed bundle:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "/absolute/path/bun",
      "args": [
        "run",
        "/absolute/path/mikrotik-mcp/src/cli.ts",
        "serve",
        "--transport",
        "stdio",
        "--config",
        "/absolute/path/devices.json"
      ]
    }
  }
}
```

## Claude and OpenAI apps

### Claude Desktop (stdio)

Open **Settings → Developer → Edit Config**, then merge the
[local stdio template](#local-stdio-template) into `claude_desktop_config.json`.
Quit and reopen Claude Desktop, then enable the server's tools in a conversation.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

This file configures a local subprocess. For a shared remote URL, use
[Claude remote connectors](#claude-remote-connectors), not a `url` entry copied
into this local configuration. [Official local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

### Claude Code

Connect to the running local service:

```bash
claude mcp add --transport http --scope user mikrotik http://127.0.0.1:8080/mcp
claude mcp list
```

Or, **instead of** that HTTP entry, let Claude Code launch the server:

```bash
claude mcp add --transport stdio --scope user mikrotik -- /absolute/path/mikrotik-mcp serve --transport stdio --config /absolute/path/devices.json
```

Use `/mcp` inside Claude Code to inspect the connection. User-scoped entries are
stored in `~/.claude.json`; project-scoped entries use `.mcp.json`. Keep router
credentials out of shared project files. [Official Claude Code instructions](https://code.claude.com/docs/en/mcp).

### Claude remote connectors

For Claude web, mobile, or remote connectors in Desktop and Cowork, open
**Customize → Connectors → Add → Add custom connector**. Supply your authenticated
HTTPS MCP endpoint, complete its authentication, and enable it for the conversation.
Settings labels and availability depend on the account and workspace policy.

These connections originate from **Anthropic's infrastructure**, even when the
remote connector is selected in a desktop app. Your laptop's `127.0.0.1:8080`
will not work here. Follow [remote access requirements](#remote-access-requirements)
first. [Official remote-connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Codex CLI, desktop and IDE

Register the shared service with the CLI:

```bash
codex mcp add mikrotik --url http://127.0.0.1:8080/mcp
codex mcp list
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.mikrotik]
url = "http://127.0.0.1:8080/mcp"
```

For local stdio, replace that table's `url` with:

```toml
[mcp_servers.mikrotik]
command = "/absolute/path/mikrotik-mcp"
args = ["serve", "--transport", "stdio", "--config", "/absolute/path/devices.json"]
```

Codex's desktop and IDE integrations use Codex MCP configuration; the VS Code
Copilot `servers` format is separate. Reconnect the server in Codex's MCP settings
after edits. Trusted projects can also use `.codex/config.toml`.
[Official Codex MCP guide](https://developers.openai.com/codex/mcp).

### ChatGPT

Open **Plugins → + → Add custom MCP server** where available. Older interfaces
use **Settings → Apps → Create**; availability and permissions vary by workspace.
Choose a supported connection, enter the server endpoint, authenticate, and
review its discovered tools before using it in a chat.
[Official ChatGPT setup](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

There are two deployment options:

- **Remote HTTP:** use an authenticated HTTPS gateway in front of this server.
  A laptop's loopback URL is not reachable from ChatGPT.
- **Secure MCP Tunnel:** when available for your account, set up the official
  tunnel on the MCP host, choose **Tunnel** in the connection form, and select
  that tunnel. Follow the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
  for provisioning and authentication; a tunnel is not created by MikroTik MCP.

Read [remote access requirements](#remote-access-requirements) before exposing an
endpoint. Refresh the connector's discovered tools after a server upgrade if
ChatGPT still shows the old catalog.

## Coding assistants

### Cursor

Open Cursor's MCP settings, or edit `~/.cursor/mcp.json` for all projects and
`.cursor/mcp.json` for one project. For the shared service:

```json
{
  "mcpServers": {
    "mikrotik": { "url": "http://127.0.0.1:8080/mcp" }
  }
}
```

For a local process, use the [stdio template](#local-stdio-template) instead.
Enable the server in the MCP panel and use Agent with its tools selected.
[Official Cursor MCP guide](https://cursor.com/docs/mcp).

### VS Code and GitHub Copilot

Run **MCP: Add Server** from the Command Palette, choose **HTTP**, and enter
`http://127.0.0.1:8080/mcp`. Choose the desired user/workspace scope. The VS Code
workspace format in `.vscode/mcp.json` is:

```json
{
  "servers": {
    "mikrotik": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

For stdio, choose **Command** in the wizard and supply the executable and arguments
from the local template. Use **MCP: List Servers** to start/inspect it and select
its tools in Agent chat. Follow the wizard for newer global Copilot configuration
formats; do not rename `servers` to `mcpServers` in this VS Code workspace example.
[Official VS Code guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

### GitHub Copilot CLI

Start Copilot CLI and run `/mcp add`. In the form, name the server `mikrotik`,
choose HTTP, and enter `http://127.0.0.1:8080/mcp`. Use `/mcp` to review the
connection and available tools. For local stdio, choose the command option and
supply the local launch command instead. The CLI has its own server setup; do not
assume a VS Code workspace entry has registered it.
[Official Copilot CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

### Gemini CLI

Merge into `~/.gemini/settings.json`, or `.gemini/settings.json` for the project:

```json
{
  "mcpServers": {
    "mikrotik": { "httpUrl": "http://127.0.0.1:8080/mcp" }
  }
}
```

Use **`httpUrl`**, not `url`: Gemini reserves `url` for the older SSE transport.
For stdio, use `command` and `args` from the local template. Restart the session
and run `/mcp` to inspect discovery.
[Official Gemini CLI guide](https://geminicli.com/docs/tools/mcp-server/).

### Qwen Code

```bash
qwen mcp add --scope user --transport http mikrotik http://127.0.0.1:8080/mcp
qwen mcp list
```

Qwen also supports `mcpServers` in `~/.qwen/settings.json` or
`.qwen/settings.json`. The HTTP entry uses `httpUrl`, as in the Gemini example;
`url` denotes legacy SSE. Restart an existing session after configuration changes
and check `/mcp`. [Official Qwen Code guide](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/).

### Windsurf and Devin Desktop

Open the app's MCP management panel; current Devin Desktop uses
**Customize → MCPs**. Choose **This computer** for a local connection, add the
shared HTTP URL, and refresh the server. Use the configuration file opened by
that panel: older Windsurf installations and newer Devin releases use different
locations. [Official desktop customization guide](https://docs.devin.ai/desktop/devin-local/customizations).

For current Devin CLI:

```bash
devin mcp add --scope user mikrotik http://127.0.0.1:8080/mcp
devin mcp list
```

Current releases store `mcpServers` in `~/.config/devin/mcp_config.json`
(`%APPDATA%\devin\mcp_config.json` on Windows); project scope uses
`.devin/mcp_config.json`. A shared entry uses `url`; a local entry uses `command`
and `args`. Older CLI releases used a combined `config.json`.
[Official Devin CLI configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration).

### JetBrains AI Assistant and Junie

In WebStorm, IntelliJ IDEA, PyCharm and other supported IDEs, open
**Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**.
Select Streamable HTTP and the shared URL, or supply the local stdio configuration.
Check the connection and enable the tools in AI Chat.
[Official AI Assistant guide](https://www.jetbrains.com/help/ai-assistant/mcp.html).

Junie in AI Chat uses the IDE's AI Assistant integration. The older standalone
Junie plugin also supports `~/.junie/mcp/mcp.json` or `.junie/mcp/mcp.json`;
follow the configuration for your installed edition. Its older tool limits make
[a focused tool catalog](#keep-the-tool-catalog-manageable) useful.
[Junie IDE configuration](https://junie.jetbrains.com/docs/junie-ide-plugin.html).

The IDE's separate **Tools → MCP Server** setting exposes IDE tools to external
clients; it is not where you connect MikroTik MCP.

### Cline

Open **MCP Servers → Remote Servers**, select **Streamable HTTP**, enter the
shared URL and connect. When editing Cline's MCP configuration directly, make the
transport explicit:

```json
{
  "mcpServers": {
    "mikrotik": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

For local stdio, open **Configure → Configure MCP Servers** and use the local
template. Keep approval enabled for router-changing tools; adding a server does
not require an auto-approve list. [Official Cline guide](https://docs.cline.bot/mcp/mcp-overview).

### Roo Code

Open the **MCP Servers** panel and **Edit Global MCP** (`mcp_settings.json`), or
use `.roo/mcp.json` for project scope. Merge the local `mcpServers` stdio template,
then refresh the server. For the shared service, use the panel's Streamable HTTP
connection option and the `/mcp` URL. Review tool permissions before enabling
router writes. [Official Roo Code guide](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/).

### Kilo Code

Open **Settings → Agent Behaviour → MCP Servers**. Current Kilo configuration
uses a top-level `mcp` object in `~/.config/kilo/kilo.jsonc`, `kilo.jsonc` or
`.kilo/kilo.jsonc`:

```json
{
  "mcp": {
    "mikrotik": {
      "type": "remote",
      "url": "http://127.0.0.1:8080/mcp",
      "enabled": true
    }
  }
}
```

For local execution, use `type: "local"` with a **command array** containing the
executable and its arguments. Do not paste an older Roo-style `mcpServers` file
into this current format. [Official Kilo MCP guide](https://kilo.ai/docs/automate/mcp/using-in-kilo-code).

### Continue

Create `.continue/mcpServers/mikrotik.yaml` in your project:

```yaml
name: MikroTik
version: 1.0.0
schema: v1
mcpServers:
  - name: mikrotik
    command: /absolute/path/mikrotik-mcp
    args:
      - serve
      - --transport
      - stdio
      - --config
      - /absolute/path/devices.json
```

Switch Continue to **Agent mode** and enable the server's tools. Plain chat mode
is not the same as tool-enabled Agent mode.
[Official Continue MCP guide](https://docs.continue.dev/customize/deep-dives/mcp).

### Zed

Open **Settings → AI → MCP Servers → Add Local Server**, or merge this into Zed's
settings:

```json
{
  "context_servers": {
    "mikrotik": {
      "command": "/absolute/path/mikrotik-mcp",
      "args": ["serve", "--transport", "stdio", "--config", "/absolute/path/devices.json"]
    }
  }
}
```

Enable it in the Agent panel. Zed also offers **Add Remote Server** for HTTP
connections; use that with a compatible authenticated gateway if its connection
flow requests OAuth. This server's bare local HTTP endpoint does not provide an
OAuth login. [Official Zed MCP guide](https://zed.dev/docs/ai/mcp).

### Kiro

Run **Kiro: Open user MCP config (JSON)**, or edit
`~/.kiro/settings/mcp.json`. Workspace configuration lives in
`.kiro/settings/mcp.json`. Use the Cursor-style `mcpServers` entry with `url` for
the shared service, or the local stdio template. Reconnect the server from the
MCP panel and leave approval prompts enabled for mutations.
[Official Kiro configuration](https://kiro.dev/docs/mcp/configuration/).

### OpenCode

Merge into `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mikrotik": {
      "type": "remote",
      "url": "http://127.0.0.1:8080/mcp",
      "enabled": true
    }
  }
}
```

Local servers use `type: "local"` and a **command array**, with the executable
followed by its arguments. Enable the tools for the intended agent and inspect
the MCP connection status. [Official OpenCode MCP guide](https://docs.opencode.ai/docs/mcp-servers/).

### Goose

In Goose Desktop, select **Extensions → Add custom extension**, choose
**Standard IO**, and enter the local executable plus its arguments. Enable the
extension for the session.

For the CLI, run `goose configure` → **Add Extension**. Choose **Command-Line
Extension** for stdio, or **Remote Extension (Streamable HTTP)** and
`http://127.0.0.1:8080/mcp` for the shared service. Start with the server's
`--read-only` option when exploring an agent's automatic tool execution.
[Official Goose extension guide](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md).

## Desktop chat apps

### LM Studio

Open **Program → Install → Edit mcp.json**. Merge the Cursor-style `mcpServers`
URL entry for the shared service, or the local stdio template. Load a model that
supports tool calling and enable MikroTik MCP in the conversation. Merely loading
a model or starting LM Studio's model API does not activate MCP tools.
[Official LM Studio MCP guide](https://lmstudio.ai/docs/app/mcp).

### Cherry Studio

Open **MCP Servers → Add** and use **Import from JSON** with the `mcpServers`
URL entry or local stdio template. You can also use Quick Create with the
corresponding transport. Enable the server and assign it to the assistant/agent
that will use its tools. Select a tool-capable model.
[Official Cherry Studio guide](https://www.cherryai.com/docs/en/advanced-basic/extensions/mcp/).

### Chatbox AI

Open **Settings → MCP → Add custom**. Choose HTTP and enter the shared URL, or
use the desktop app's stdio command and arguments. Run **Test**, save the server,
and enable it in **Work Mode**. MCP tools are not enabled in ordinary Chat Mode.
A web or mobile deployment must be able to reach the configured host; its
`localhost` is not automatically your MCP computer.
[Official Chatbox configuration](https://api.chatboxai.app/en/guide/work-mode/configuration).

### AnythingLLM Desktop

Open **Agent Skills** to initialize the MCP configuration, then edit
`plugins/anythingllm_mcp_servers.json` under the app's storage directory. Merge
the local `mcpServers` stdio template, return to Agent Skills, refresh and enable
the server. Use an agent conversation with a tool-capable model.
[Official AnythingLLM Desktop guide](https://docs.anythingllm.com/mcp-compatibility/desktop).

## Self-hosted and cloud agents

### LibreChat

Add this to `librechat.yaml`, then restart LibreChat and select the server's
tools in the intended agent or chat:

```yaml
mcpServers:
  mikrotik:
    type: streamable-http
    url: http://127.0.0.1:8080/mcp
```

The URL is resolved by the **LibreChat backend**, not the browser. Loopback only
works when it shares the MCP host's network environment. For another machine,
use a reachable authenticated endpoint and restrict which LibreChat users may
use it. [Official LibreChat configuration](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers).

### Open WebUI

As an administrator, open **Settings → Admin → Integrations** and add an
**MCP Streamable HTTP** server. Enter the `/mcp` URL, configure the authentication
required by your gateway, and enable its tools in chat. Select the MCP connection
type, not an OpenAPI connection.

The WebUI backend must reach the server. Use loopback only when both services
share that network environment; a browser successfully opening the dashboard
does not prove backend connectivity. [Official Open WebUI guide](https://docs.openwebui.com/features/extensibility/mcp/).

### Devin Cloud

Open **Customize → MCPs → Add MCP → Add custom MCP**, choose **HTTP**, and supply
a reachable, authenticated HTTPS endpoint. Configure the gateway's authentication
and run **Test tools** before saving. The workspace needs permission to manage
MCP servers. Devin Cloud cannot reach your laptop's loopback address; its setup
is separate from the local Devin Desktop/CLI connection above.
[Official Devin Cloud guide](https://docs.devin.ai/work-with-devin/mcp).

## Remote access requirements

The bundled HTTP listener does **not** implement OAuth or bearer-token
validation. A dashboard access token protects the dashboard, not `/mcp`.
Host/origin allowlists protect against DNS rebinding; they are not user
authentication.

For a cloud client or untrusted network:

1. Keep the Bun listener on a private interface and put an **authenticated HTTPS
   MCP gateway** in front of it, or use the client's supported secure tunnel.
2. Match the client's authentication support: some require OAuth, while others
   can send a configured authorization header. The gateway must validate it.
3. Preserve MCP session headers and methods through the gateway. Apply explicit
   [host/origin allowlists](/docs/guides/transports#dns-rebinding-protection).
4. Expose only the required tools and devices. See
   [Access Scope settings](/docs/guides/access-scope-settings) and
   [Security](/docs/guides/security).

Adding `https://` to an example URL does not provision TLS or authentication. Do
not publish the raw port just to make a cloud connector's discovery succeed.
All clients sharing this server use its configured router credentials; MCP
session separation is not per-user router authorization.

## Other MCP clients

This list is not an exhaustive registry of every app or plugin. A new client can
connect without a MikroTik-specific integration if it implements one of these
contracts. Consult its MCP documentation for the exact field names.

### Generic stdio client

- **Executable:** the installed `mikrotik-mcp` launcher, or the absolute Bun binary.
- **Arguments:** `serve --transport stdio --config /absolute/path/devices.json`
  (put the CLI entry file before these arguments when invoking Bun directly).
- **Protocol:** JSON-RPC on stdin/stdout; diagnostic logs on stderr.
- **Lifecycle:** the client owns the child process. Each app launches its own
  process, so prefer HTTP when you want to share one service.

A tool-calling LLM API alone is not an MCP client: the application or agent
framework must implement MCP discovery and tool execution.

### HTTP client (streamable-http / sse)

- **Transport:** Streamable HTTP.
- **URL:** `http://127.0.0.1:8080/mcp` for a same-host client.
- **Session:** initialize, then preserve the returned `Mcp-Session-Id` header on
  subsequent requests. Each initialization creates a separate server session.
- **Authentication:** configured at your gateway for remote access.

The server accepts the configuration value `sse`, but it currently selects the
same Streamable HTTP implementation. It does **not** create the legacy
`/sse` and `/messages` endpoint pair. A legacy SSE-only app needs an update or a
compatible protocol adapter; changing the flag or guessing `/sse` will not work.
See [Transports](/docs/guides/transports).

## Keep the tool catalog manageable

Some clients or models impose tool-count or context limits. If discovery works
but the app rejects the catalog, enable only the modules you need in
`devices.json`:

```json
{
  "tools": {
    "enabledModules": ["system", "interfaces"]
  }
}
```

This is a fragment to merge into the existing configuration, not a complete
device file. Check the [tool reference](/docs/reference) for module slugs.
Restart the service after changing startup configuration and refresh the client's
tool discovery. Client-side approval prompts and the server's read-only setting
serve different purposes; keep both appropriate to the task.

## Verifying the connection

Verify each layer separately:

1. **Router access:** `mikrotik-mcp auth-check --config /absolute/path/devices.json`
   confirms the server can authenticate to configured devices.
2. **Service liveness:** for shared HTTP, `curl http://127.0.0.1:8080/health`
   should return `OK`. This alone does not verify MCP or router access.
3. **Tool discovery:** reconnect in the app, then check that MikroTik tools appear.
   `mikrotik-mcp tools` can independently inspect the installed catalog.
4. **A read-only call:** ask the assistant:

> List the available MikroTik devices, then read the system identity, RouterOS
> version and uptime of the device I select. Do not change any router settings.

Check the result and, when enabled, the dashboard's **Live Feed**. Only then move
to configuration tasks with explicit scope and approval. Available prompts,
resources and embedded app views vary by client even when basic tools work.

### Troubleshooting

| Symptom                                | Check                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The app cannot find the command        | Use absolute executable/config paths and ensure Bun is available to the GUI process. Use the direct Bun launcher example if needed. |
| Works in Terminal, fails in the app    | Check the app's environment, working directory and file permissions. Restart it after installation.                                 |
| HTTP 404                               | Use the MCP port and `/mcp`, not the dashboard URL or `/sse`.                                                                       |
| Connection refused                     | Start the shared service. Check whether the caller runs on your computer, in WSL/a VM, on a backend host or in the cloud.           |
| HTTP 401 or a missing OAuth endpoint   | Check the gateway's authentication and the client's requirements. The bare server has no OAuth endpoints.                           |
| HTTP 421 / origin rejection            | Configure the actual gateway hostname and allowed origins; do not disable protection as a general workaround.                       |
| Stale or missing session               | Reconnect the client after a server restart; ensure the gateway preserves `Mcp-Session-Id`.                                         |
| Connected, but zero tools              | Inspect server logs, catalog filters and the client's tool enablement. Reload discovery after upgrades.                             |
| Tool count or context error            | Enable a smaller catalog and use a tool-capable model/Agent mode.                                                                   |
| Tools appear, but calls fail           | Run `auth-check`; verify SSH keys, device reachability and access scope on the MCP host.                                            |
| Cloud connector cannot reach localhost | Use authenticated remote access or a supported secure tunnel.                                                                       |

For a guided installation, use [Install with your AI assistant](/docs/guides/installation-assistant).
