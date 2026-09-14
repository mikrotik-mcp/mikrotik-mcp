#!/usr/bin/env bun
/**
 * Offline release gate: inspect the actual bundles and list every tool through
 * the built library's MCP server. No user config, CLI services or device calls.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const transpiler = new globalThis.Bun.Transpiler({ loader: "js", target: "bun" });
const coupledDependency = /^(?:zod|@modelcontextprotocol\/sdk)(?:\/|$)/;

// Include shared chunks: checking only dist/cli.js misses external imports that
// the bundler moves into a split module. scanImports ignores comments/strings.
const files = readdirSync(dist, { recursive: true, encoding: "utf8" });
assert(files.includes("cli.js") && files.includes("index.js"), "Build both entry points first");
for (const file of files.filter((name) => name.endsWith(".js"))) {
  // The CLI has a hashbang, which scanImports does not accept.
  const source = readFileSync(join(dist, file), "utf8").replace(/^#![^\n]*(?:\n|$)/, "");
  for (const dependency of transpiler.scanImports(source)) {
    assert(
      !coupledDependency.test(dependency.path),
      `${file} resolves ${dependency.path} at runtime: bundle the MCP SDK and Zod together`,
    );
  }
}

const { createServer, setConfig, MikrotikConfigSchema, allToolModules } = (await import(
  pathToFileURL(join(dist, "index.js")).href
)) as typeof import("../src/index");
const expected = allToolModules
  .flat()
  .map((tool) => tool.name)
  .sort();

const cases = (["annotate", "off"] as const).flatMap((capabilityGating) =>
  [0, 50, 100].map((toolPageSize) => ({ capabilityGating, toolPageSize })),
);
for (const { capabilityGating, toolPageSize } of cases) {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { offline: { host: "127.0.0.1", port: 1 } },
      defaultDevice: "offline",
      disableUpdateCheck: true,
      memory: { enabled: false },
      mcp: { capabilityGating, toolPageSize },
    }),
  );
  const { server } = createServer();
  const client = new Client({ name: "build-tools-list-check", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    const expectedPages = toolPageSize === 0 ? 1 : Math.ceil(expected.length / toolPageSize);
    let pages = 0;
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      assert.equal(
        page.tools.length,
        toolPageSize === 0
          ? expected.length
          : Math.min(toolPageSize, expected.length - tools.length),
      );
      pages += 1;
      assert(pages <= expectedPages, "Pagination must finish within the expected page count");
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (toolPageSize === 0) assert.equal(cursor, undefined);
      if (cursor) {
        assert(!cursors.has(cursor), "Pagination must make progress");
        cursors.add(cursor);
      }
    } while (cursor);
    assert.equal(pages, expectedPages);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), expected);
    for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
    assert.deepEqual(
      tools.find((tool) => tool.name === "set_aaa_settings")?.inputSchema.properties?.fields,
      {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "string" },
      },
    );
    process.stdout.write(
      `✓ Built MCP: ${tools.length} tools in ${pages} page(s), pageSize=${toolPageSize}, capabilityGating=${capabilityGating}\n`,
    );
  } finally {
    await client.close();
    await server.close();
  }
}
