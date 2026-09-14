import { defineConfig } from "bunup";

// `@tikoci/centrs` ships raw TypeScript (Bun-native). Keep it external so bunup
// doesn't inline its namespace re-export (which it mis-bundles); Bun resolves the
// package from node_modules at runtime, and npm/bunx install it alongside us.
const external = ["@tikoci/centrs"];

// Zod schemas and the MCP SDK's JSON Schema converter must travel together.
// Resolving them independently at install time can mix Zod 4.5+ record
// processors with a 4.4 converter context (`ctx.deferred.push` in tools/list).
// Match subpaths too: the SDK imports `zod/v4-mini`, not only `zod`.
const noExternal = [/^zod(?:\/|$)/, /^@modelcontextprotocol\/sdk(?:\/|$)/];

export default defineConfig([
  {
    name: "library",
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    target: "bun",
    // Keep public dependency types as imports; only runtime code is bundled.
    dts: { resolve: false },
    clean: true,
    external,
    noExternal,
  },
  {
    name: "cli",
    entry: ["src/cli.ts"],
    format: ["esm"],
    outDir: "dist",
    target: "bun",
    dts: false,
    clean: false,
    external,
    noExternal,
  },
]);
