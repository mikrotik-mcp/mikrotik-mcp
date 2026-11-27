# Contributing to `@usex/mikrotik-mcp`

Thanks for helping out! This is a Bun-native MCP server that exposes MikroTik
RouterOS as tools. This guide covers the layout and the one workflow that matters
most: **adding a tool**.

## Setup

```bash
bun install
bun run test:types     # tsc --noEmit
bun test               # offline smoke tests
bun run start          # serve from source (set MIKROTIK_* first)
```

Requires **Bun ≥ 1.3**. No device is needed for tests or type-checks.

## Project layout

```
src/
  cli.ts            entry point (serve / auth-check / tools / version)
  config.ts         env + flag parsing (MIKROTIK_*)
  server.ts         assembles the McpServer
  core/
    registry.ts     defineTool() + risk presets + registration
    connector.ts    the single choke point to the device (Safe Mode aware)
    routeros.ts     Cmd builder + injection-safe quoting helpers
    context.ts, runtime.ts
  ssh/
    client.ts       ssh2 wrapper (run / shell / decode)
    safe-mode.ts    persistent Ctrl+X session
  tools/            one module per RouterOS subsystem (the catalog)
    index.ts        moduleCatalog — the single source of truth
  prompts/          MCP prompt loader (reads ../prompts/*.md)
  transport/        stdio + Bun-native HTTP
scripts/            schema & doc generators
docs/               handwritten + generated reference
```

## Adding a tool

1. Find the right module in `src/tools/` (or add a new one and register it in
   `src/tools/index.ts`'s `moduleCatalog`).
2. Add a `defineTool({ ... })` entry. Use [`src/tools/vlan.ts`](src/tools/vlan.ts)
   as the canonical example:
   - `name` — snake_case, stable (clients depend on it).
   - `title` — short display label.
   - `description` — what the model reads to decide when to call it.
   - `annotations` — one of `READ` / `WRITE` / `WRITE_IDEMPOTENT` / `DESTRUCTIVE`
     / `DANGEROUS`. Pick honestly; clients gate on these.
   - `inputSchema` — a Zod shape; keep param names snake_case and add `.describe()`.
   - `handler(args, ctx)` — build the command with the `Cmd` builder (it quotes
     values, which is the injection boundary) and run it via
     `executeMikrotikCommand(cmd, ctx)`.
3. **Never** interpolate a user value into a command unquoted. Prefer `Cmd.set/.opt`;
   for `where`/`[find ...]` selectors, follow the existing quoted patterns.
4. Regenerate the generated artifacts and run the checks:

```bash
bun run gen           # schemas/ + docs/tools-reference.md (REQUIRED — CI fails if stale)
bun run lint
bun run test:types
bun test
```

`schemas/` and `docs/tools-reference.md` are generated from the tool definitions,
so a tool change must be followed by `bun run gen` and a commit of the result —
CI re-runs the generator and fails the build if anything would change.

## Adding a prompt

MCP prompts are guided workflows authored as Markdown in [`prompts/`](prompts/) —
no code change needed. Drop in a `name.md` file with frontmatter (`name`, `title`,
`description`, optional `arguments`) and a body that references arguments with
`{{placeholder}}`. The loader (`src/prompts/index.ts`) registers it on the next
start. See [`prompts/harden-router.md`](prompts/harden-router.md) for the shape.

## Conventions

- Logs go to **stderr** only (stdout is the stdio JSON-RPC channel). Use `ctx.info`
  / `ctx.error` inside handlers.
- Match the surrounding style: small, useful comments; no dead code.
- Keep tool descriptions accurate — they're the model's only guidance.

## Continuous integration

Every PR runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on Ubuntu and
macOS: `lint` → `test:types` → `test` → `build` → a generated-artifact drift
check. Run the same locally before pushing and you won't be surprised.

## Submitting

Open a PR using the [template](.github/PULL_REQUEST_TEMPLATE.md). Make sure the
local checks above pass, describe the RouterOS commands your change runs, and say
how you verified them (device model + RouterOS version, or why no device was
needed). Be kind — this project follows a
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Publishing the SchemaStore configuration schema

After a release, `bun run release` compares the tagged Zod configuration input
with the schema in [SchemaStore](https://github.com/SchemaStore/schemastore).
A changed schema is formatted and validated with SchemaStore's own checker,
then pushed to the release operator's fork and proposed to upstream. The hook
uses the current Git identity and authenticated GitHub CLI account. The machine
running the release needs Git, Bun, Node.js, npm and `gh` with fork and PR access.

Matching schemas produce no PR. If this account already has a matching open
sync PR, the hook prints its URL. Further schema changes update that branch and
preserve the existing review. Formatting and the source commit alone do not
trigger updates.

To preview or retry the sync from a release tag (including a release published
directly on GitHub), substitute its package version below. A retry only runs
the SchemaStore step.

```sh
bun run schemastore:sync 6.26.0 --check
bun run schemastore:sync 6.26.0
```
