# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A **Bun-native MCP server** that exposes MikroTik **RouterOS** (over SSH) as several
hundred risk-annotated tools, one module per RouterOS scope, so an MCP client can
read and configure a router in natural language. Runs on **Bun ≥ 1.3** — there is no
npm/Node build; do not introduce `child_process`/OS-shell usage (all device I/O is
SSH via `ssh2`). The live tool/module counts are whatever the catalog
(`src/tools/index.ts`) holds.

## Commands

```bash
bun run test                      # all tests — Vitest via vite-plus (offline, no device)
bunx vp test run tests/catalog.spec.ts   # a single test file
bunx vp test run -t "quoteValue"  # tests matching a name
bun run test:watch                # Vitest watch mode
bun run test:types                # tsc --noEmit typecheck
bun run lint                      # vp lint (vite-plus / oxlint); lint:fix to autofix
bun run gen                       # regenerate schemas/ + docs/tools-reference.md
bun run build                     # bunup -> dist/cli.js (+ build:ui single-file views)
bun run build:mcp                 # .mcpb bundle for this platform (build:mcp:all for every target)
bun run start                     # serve (stdio transport by default)
bun run inspect                   # MCP Inspector against the server
```

Tests are **Vitest** (`tests/**/*.spec.ts`, helpers imported from `vite-plus/test`);
`vitest.config.ts` aliases the Bun-native `"bun"` module to an inert stub so the
Node runner can load Bun-importing source. Pre-commit gate: `bun run test:types &&
bun run test && bun run lint`.
Run each **un-piped** in the `&&` chain — piping through `tail` masks the exit code
and lets a failing check pass the gate.

## Architecture

**One choke point for the device.** Every tool reaches RouterOS through
`executeMikrotikCommand(command, ctx)` in `src/core/connector.ts` — never by
opening a transport directly. It routes the command through Safe Mode's persistent
session when active (`src/ssh/safe-mode.ts`), otherwise `runOnce()` opens a fresh
one-shot connection. The default transport is an SSH channel (`src/ssh/client.ts`);
when the resolved device config carries a `mac` (instead of a routable `host`),
`runOnce` instead uses **MAC-Telnet** — a Layer-2 terminal over UDP 20561 that
reaches a device by MAC with no IP. `MikroTikMacTelnetClient` mirrors
`MikroTikSSHClient`'s `connect/run/disconnect/lastError` shape so the branch is one
line and every tool inherits it. The MAC-Telnet **wire codec, session, and MTWEI/MD5
auth come from the `@tikoci/centrs` package** (`@tikoci/centrs/protocols`), the
de-facto MikroTik reference; `src/mac-telnet/` keeps only the local layers that
package doesn't provide — `console.ts` (turns the interactive console stream into
one-shot command/response) and `client.ts` (the SSH-shaped facade). Safe Mode is
SSH-only. The target device rides on `ctx.device`.

Three knobs make the Bun-native `@tikoci/centrs` consumable here: it ships raw
`.ts`, so `tsconfig` sets `allowImportingTsExtensions`, `vitest.config.ts` inlines
it (`server.deps.inline`), and `bunup.config.ts` marks it `external` (Bun resolves
it from `node_modules` at runtime — bunup mis-bundles its `export *`). Import its
symbols by **named** import, never `export *`. Caveat: centrs' MAC-Telnet route
resolution may shell out (`Bun.spawnSync(["ifconfig", …])`) as a fallback when the
OS reports a zero MAC, so the "all device I/O is SSH, no OS-shell" rule no longer
holds strictly for the MAC path.

**Command construction is the injection boundary.** Build every device command
with the `Cmd` builder in `src/core/routeros.ts` (`.set/.opt/.flag/.bool/.raw/
.build`) — never string-concatenate user input. `quoteValue` quotes/escapes any
non-bare-safe value, including control chars/newlines (a raw `\n` would otherwise
terminate the command mid-string over the SSH exec channel). Detect device-side
failures in handler output with `looksLikeError()`; other shared helpers are
`whereClause()`, `isEmpty()`, `yesno()`, `commandUnsupported()`,
`containsRawParserError()`.

**Tools.** Each `src/tools/<scope>.ts` exports a `ToolModule` (an array of
`defineTool({...})`, `src/core/registry.ts`). A tool has: `name` (snake_case,
globally unique), `title`, `description` (the prompt the model reads to decide when
to call), `annotations` (one risk preset: `READ` / `WRITE` / `WRITE_IDEMPOTENT` /
`DESTRUCTIVE` / `DANGEROUS`), `inputSchema` (a Zod raw shape), and
`handler(args, ctx) => string`. In multi-device setups the registry auto-injects an
optional `device` enum and peels it off before the handler runs; a backstop turns
raw RouterOS parser errors into `isError` results.

**The catalog is the single source of truth.** `src/tools/index.ts` `moduleCatalog`
registers every module exactly once (`{label, slug, group, description, tools}`).
The catalog test enforces unique slugs, unique snake_case tool names, valid
Zod→JSON-Schema, and `moduleCatalog.length === allToolModules.length`.

**MCP Bundle (`.mcpb`) packaging.** `manifest.json` + `scripts/build-mcpb.ts` pack a
one-click bundle. The server can **not** run on the Node runtime an MCPB host
supplies — `src/core/s3.ts` does `import { S3Client } from "bun"` (bunup lowers it to
a module-scope `globalThis.Bun` destructure) and `@tikoci/centrs` ships raw `.ts` that
Node refuses to type-strip inside `node_modules`; both throw at import, before any
tool runs. So the manifest is `server.type: "binary"` and each bundle **vendors the
Bun binary** pinned by `packageManager`, running `runtime/bun dist/cli.js serve`.
The build stages `package.json` + `dist/` + `prompts/` + prod `node_modules` (installed
with **npm**, since Bun's `catalog:` protocol isn't npm-parseable and its isolated
linker leaves symlinks a zip may not survive), so `src/paths.ts`'s walk-up-to-
`package.json` root resolution works unchanged. `tests/mcpb-manifest.spec.ts` pins
these invariants; bundles are per-platform/arch because `platform_overrides` has no
arch axis. Never switch the manifest back to `type: "node"`.

**Config & runtime.** `src/config.ts` `loadConfig()` layers defaults → env → CLI
flags: single-device (`MIKROTIK_*`), multi-device (`--config`/`MIKROTIK_CONFIG_FILE`
JSON or `MIKROTIK_DEVICES`), an `mcp` transport block, an optional `s3` block, and a
`dashboard` block. The result is installed once via `setConfig()` and read globally
through `src/core/runtime.ts` (`getConfig`, `getDevice`, `resolveDeviceName`) —
handlers get connection details from runtime, not parameters.

**Observability (optional).** `src/observability/` is an opt-in, localhost dashboard
that records every tool call. The registry callback is the choke point: it calls
`recordToolCall()` (a no-op unless `--dashboard` is set), which `buildEvent()`
(redacts secrets, truncates bodies) → persists to `bun:sqlite` (`store.ts`) →
fans out to live WebSocket subscribers. `dashboard.ts` serves the SPA + REST +
a live stream on its own `Bun.serve` port (started from `cli.ts serve`) — both a
Bun-native WebSocket (`/api/stream`) and an SSE fallback (`/api/sse`), plus
`/api/devices` and `/api/config` (config redacted via `redact()`). `health.ts`
SSH-probes each device for the connectivity graph. Analytics live in the pure
`stats.ts`. The default DB path is `~/.mikrotik-mcp/events.db` (`DEFAULT_DASHBOARD_DB`).
The dashboard UI is a **React** app (`ui/observability/main.tsx`) built _separately_
(`ui/vite.observability.config.ts`, single-input + `inlineDynamicImports`) so it
inlines into one self-contained HTML — the other `ui/*` views are ext-apps and
build via `ui/vite.config.ts`. `bun run build:ui` runs both. **Test constraint:** `bun:sqlite` is imported only via
the dynamic `import()` in `store.ts`, so the Node/Vitest import graph (which aliases
`"bun"`) never loads it — keep it that way (recorder/registry import store _types_
only).

**Tests are offline.** `tests/` validate the static catalog shape and the command
builder against no live device. "Tested" here means these pass — on-device behavior
is not exercised in CI.

## Adding or changing a tool module

1. Create `src/tools/<scope>.ts` exporting a `ToolModule`. **Mirror the closest
   existing sibling** — the per-tool shape is highly regular: `add/create`, `list`,
   `get`, `update`, `remove`, often `enable/disable`; `remove` does a `count-only`
   existence check then `[find ...]`; ordered rules (firewall-style) verify creation
   by the returned `.id` or a last-row `count`.
2. Register it in `src/tools/index.ts` (import + one `moduleCatalog` entry).
3. Run the gate, then `bun run gen` and commit the regenerated `schemas/` and
   `docs/tools-reference.md` (and `schemas/config.schema.json` if the config schema
   changed) — these generated artifacts are tracked.

Note: eslint's `perfectionist/sort-named-imports` enforces a specific named-import
order (e.g. `yesno` before `quoteValue`); new modules commonly trip it — run
`bun run lint:fix`.
