# Schemas

Machine-readable JSON Schemas for `@usex/mikrotik-mcp`, **generated** from the
TypeScript source by `scripts/gen-schemas.ts` (`bun run gen:schemas`). Do not
edit by hand — regenerate instead.

| File                 | Contents                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `config.schema.json` | The runtime configuration object (env vars / CLI flags).                                   |
| `tool-catalog.json`  | Every one of the 842 tools: `name`, `risk`, `title`, `description`, and input JSON Schema. |
| `tools/<name>.json`  | The input JSON Schema for a single tool.                                                   |

`risk` is derived from the MCP tool annotations:
`read` · `write` · `write-idempotent` · `destructive` · `dangerous`.
