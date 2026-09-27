#!/usr/bin/env bun
/**
 * Generates the JSON-Schema artifacts under `schemas/` directly from the live
 * tool definitions and config schema. Because the schemas are *derived* from
 * the same Zod shapes the server validates against, they can never drift from
 * the implementation.
 *
 * Run with: `bun run gen:schemas`
 *
 * Outputs:
 *   schemas/config.schema.json     — runtime configuration (MIKROTIK_* / flags)
 *   schemas/tool-catalog.json      — every tool: name, risk, title, description, input JSON Schema
 *   schemas/devtools-manifest.json — public modules, prompts, requirements and App View bindings
 *   schemas/tools/<name>.json       — one input JSON Schema per tool
 *   schemas/README.md              — what these files are
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import { SCHEMAS_DIR } from "../src/paths";
import { allToolModules } from "../src/tools";
import { VERSION } from "../src/version";
import { buildDevtoolsManifest } from "./devtools-manifest";

function riskOf(a: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}): string {
  if (a.readOnlyHint) return "read";
  if (a.destructiveHint) return a.idempotentHint ? "destructive" : "dangerous";
  return a.idempotentHint ? "write-idempotent" : "write";
}

// Build EVERYTHING in memory first. All the code that can throw (z.toJSONSchema
// on each tool + the config schema) runs here, BEFORE any file is deleted — so a
// generation failure aborts with the existing schemas/ untouched.
const catalog: unknown[] = [];
const toolFiles: { name: string; content: string }[] = [];
let count = 0;

for (const mod of allToolModules) {
  for (const tool of mod) {
    const shape = tool.inputSchema ?? {};
    const inputSchema = z.toJSONSchema(z.object(shape as z.ZodRawShape), {
      target: "draft-2020-12",
    });
    const entry = {
      name: tool.name,
      title: tool.title,
      risk: riskOf(tool.annotations),
      annotations: tool.annotations,
      description: tool.description,
      inputSchema,
    };
    catalog.push(entry);
    toolFiles.push({
      name: tool.name,
      content: `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: tool.name, ...inputSchema }, null, 2)}\n`,
    });
    count++;
  }
}

const catalogContent = `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", version: VERSION, generated: "by scripts/gen-schemas.ts — do not edit by hand", toolCount: count, tools: catalog }, null, 2)}\n`;

const configContent = `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "MikrotikConfig", ...z.toJSONSchema(MikrotikConfigSchema, { target: "draft-2020-12" }) }, null, 2)}\n`;
const devtoolsContent = `${JSON.stringify(buildDevtoolsManifest(), null, 2)}\n`;

// Only now, with all content generated, touch the filesystem. Write the per-tool
// files into a fresh temp dir and atomically swap it in: the live schemas/tools/
// is removed only in the instant before the rename, so a failure mid-write leaves
// the old dir in place, never an empty one. The temp dir is cleaned up on error.
const toolsDir = join(SCHEMAS_DIR, "tools");
const toolsTmp = join(SCHEMAS_DIR, ".tools.tmp");
rmSync(toolsTmp, { recursive: true, force: true });
mkdirSync(toolsTmp, { recursive: true });
try {
  for (const f of toolFiles) {
    writeFileSync(join(toolsTmp, `${f.name}.json`), f.content);
  }
  rmSync(toolsDir, { recursive: true, force: true });
  renameSync(toolsTmp, toolsDir);
} catch (e) {
  rmSync(toolsTmp, { recursive: true, force: true });
  throw e;
}

writeFileSync(join(SCHEMAS_DIR, "tool-catalog.json"), catalogContent);

writeFileSync(join(SCHEMAS_DIR, "config.schema.json"), configContent);
writeFileSync(join(SCHEMAS_DIR, "devtools-manifest.json"), devtoolsContent);

writeFileSync(
  join(SCHEMAS_DIR, "README.md"),
  `# Schemas

Machine-readable JSON Schemas for \`@usex/mikrotik-mcp\`, **generated** from the
TypeScript source by \`scripts/gen-schemas.ts\` (\`bun run gen:schemas\`). Do not
edit by hand — regenerate instead.

| File | Contents |
|------|----------|
| \`config.schema.json\` | The runtime configuration object (env vars / CLI flags). |
| \`tool-catalog.json\` | Every one of the ${count} tools: \`name\`, \`risk\`, \`title\`, \`description\`, and input JSON Schema. |
| \`tools/<name>.json\` | The input JSON Schema for a single tool. |

\`risk\` is derived from the MCP tool annotations:
\`read\` · \`write\` · \`write-idempotent\` · \`destructive\` · \`dangerous\`.
`,
);

// eslint-disable-next-line node/prefer-global/process
process.stdout.write(`Generated schemas for ${count} tools into ${SCHEMAS_DIR}\n`);
