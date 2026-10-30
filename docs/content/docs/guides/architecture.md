---
title: "Architecture"
description: "Practical setup, operations and limits for Architecture."
---

The server is a thin, well-layered bridge between the MCP protocol and the
RouterOS CLI over SSH. Each layer has one job and pushes everything else down.

## Layers

```
 mikrotik-mcp (CLI)                 src/cli.ts
       │  parses argv, picks a command (serve / auth-check / tools / version)
       ▼
 config + runtime                   src/config.ts, src/core/runtime.ts
       │  resolves defaults → env → flags into a validated MikrotikConfig,
       │  stores it as process-wide runtime state
       ▼
 server (registry)                  src/server.ts, src/core/registry.ts
       │  builds an McpServer, registers all tools + prompts,
       │  attaches instructions and capabilities
       ▼
 tools                              src/tools/*.ts  (registered modules and tools)
       │  each tool builds a RouterOS command and calls the connector
       ▼
 connector                          src/core/connector.ts
       │  the single choke point: routes through Safe Mode if active,
       │  otherwise opens a one-shot SSH channel
       ▼
 SSH client / Safe Mode             src/ssh/client.ts, src/ssh/safe-mode.ts
          talks to the device over the SSH protocol (ssh2)
```

`src/core/transport.ts` picks the device transport (SSH vs. Layer-2 MAC-Telnet)
and, for an SSH device with a `jumpVia`/`jumpHost`, resolves the bastion chain so
`MikroTikSSHClient` dials the target through one or more jump hosts (ssh2
`forwardOut` + `sock`) — commands, Safe Mode and SFTP all ride the same hop. See
[Multiple devices → SSH jump hosts](/docs/guides/multi-device#ssh-jump-hosts-bastion--proxyjump).

A transport (`src/transport/stdio.ts` or `src/transport/http.ts`) wraps the
assembled server and connects it to the outside world. See
[Transports](/docs/guides/transports).

## CLI (`src/cli.ts`)

The entry point. It finds the first non-`--` token as the command (defaulting to
`serve`) and dispatches:

- `serve` — load config, store it in runtime, start the selected transport.
- `auth-check` — connect over SSH, run two probe commands, print, exit.
- `tools` — print the catalog without touching the network.
- `version` / `--version`, `help` / `--help` / `-h`.

On `serve` it also emits a security warning if it detects a plaintext password
while running inside a container.

## Config & runtime (`src/config.ts`, `src/core/runtime.ts`)

`loadConfig()` merges, in increasing precedence, **defaults → environment →
CLI flags**, then validates the result against a Zod schema
(`MikrotikConfigSchema`), which also supplies defaults and coerces types. The
result is a typed `MikrotikConfig`. `setConfig()` stores it as process-wide
state so tools (which run far from the CLI) can read it via `getConfig()`.

## Server & registry (`src/server.ts`, `src/core/registry.ts`)

`createServer()` instantiates an `McpServer` with `tools`, `prompts`, and
`logging` capabilities and a natural-language **instructions** block that tells
the model about the subsystem grouping and the Safe Mode safety model. It then
registers every tool and every prompt.

### `defineTool` + risk presets

Tools are declared with `defineTool()`, which pairs a Zod input schema (used for
both runtime validation and the auto-generated JSON Schema) with a **risk
preset** and wraps the handler so every tool returns the protocol's
`{ content: [...] }` shape and funnels failures through one error path
(`{ isError: true }`). The presets map to MCP
[tool annotations](https://modelcontextprotocol.io/specification) so clients can
reason about each tool's blast radius:

| Preset             | `readOnlyHint` | `destructiveHint` | `idempotentHint` | Meaning                                                                       |
| ------------------ | :------------: | :---------------: | :--------------: | ----------------------------------------------------------------------------- |
| `READ`             |       ✅       |         —         |        ✅        | Inspection only; side-effect free; repeatable.                                |
| `WRITE`            |       —        |        ❌         |        —         | Creates/changes state; not inherently destructive; not idempotent.            |
| `WRITE_IDEMPOTENT` |       —        |        ❌         |        ✅        | Changes state but converges if repeated (set/enable/disable).                 |
| `DESTRUCTIVE`      |       —        |        ✅         |        ✅        | Removes/replaces state; safe to repeat (target already gone).                 |
| `DANGEROUS`        |       —        |        ✅         |        —         | High blast radius and not safely repeatable (restore, import, factory setup). |

`registerTools()` registers every module's tools in one pass and throws on a
duplicate tool name, so the catalog can never ship a collision.

## Tools (`src/tools/*.ts`)

Each registered module exports a flat array of registerable tools for one
RouterOS subsystem (interfaces, firewall-filter, firewall-nat, dhcp, dns,
routes, vlan, wireless, wireguard, queue, users, logs, backup, poe, system,
network-tools, bridge, address-list, scheduler, certificate, ip-address,
ip-pool, ip-service, and safe-mode). `src/tools/index.ts` collects them into
`allToolModules`. The full list is in the [tool reference](/docs/reference).

### The `Cmd` builder (injection-safe quoting)

Tools assemble RouterOS commands with the `Cmd` fluent builder
(`src/core/routeros.ts`) rather than string concatenation. Two reasons:

1. It removes the per-tool boilerplate of conditionally appending `key=value`
   pairs (`.set`, `.opt`, `.flag`, `.bool`, `.raw`).
2. It is the **injection boundary**. The RouterOS console treats `;` as a
   command separator and whitespace as an argument separator, so an unquoted
   user value like `My LAN; /system reset` would split into extra commands.
   `quoteValue()` passes through only bare-safe tokens
   (`[A-Za-z0-9_.\-:/,*@]`) and otherwise quotes the value and escapes embedded
   quotes and backslashes.

This is defense in depth on top of the fact that commands travel over the SSH
protocol (`ssh2`) — there is no local OS shell or `child_process` anywhere in
the command path, so there's no local shell-injection surface to begin with.

## Connector (`src/core/connector.ts`)

`executeMikrotikCommand()` is the single point through which all tools reach the
device. It checks the Safe Mode manager: if Safe Mode is active it sends the
command through the persistent session; otherwise it opens a fresh one-shot SSH
channel, runs the command, and closes it. Either way the command output is
returned as text and errors are surfaced uniformly.

## SSH client & Safe Mode (`src/ssh/`)

- `client.ts` — an `ssh2`-based client with two modes: `run()` (one-shot channel,
  the common path) and `shell()` (persistent interactive PTY, used by Safe Mode).
  Output bytes are decoded through a fallback chain (UTF-8 → Windows-1252 →
  Latin-1) so locale-specific characters don't crash decoding.
- `safe-mode.ts` — a singleton manager that owns the long-lived Safe Mode shell,
  drives the Ctrl+X enable/commit dance, serializes access, and parses prompts.
  See [Safe Mode](/docs/guides/safe-mode).

## Generated artifacts

The `schemas/` JSON Schemas and the [tool reference](/docs/reference) are
**generated from the same source** the server runs on (`bun run gen`), so they
can never drift from the implementation. See [Development](/docs/guides/development).
