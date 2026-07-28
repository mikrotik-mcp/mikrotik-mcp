#!/usr/bin/env bun
import type { ZodRawShape } from "zod";
/**
 * Generates `docs/tools-reference.md` — the complete, always-accurate catalog of
 * every tool grouped by module, with risk level and parameters — directly from
 * the live tool definitions. Run with `bun run gen:docs`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../src/paths";
import { moduleCatalog } from "../src/tools";
import { VERSION } from "../src/version";

const RISK_BADGE: Record<string, string> = {
  read: "🟢 read",
  write: "🟡 write",
  "write-idempotent": "🟡 write·idem",
  destructive: "🔴 destructive",
  dangerous: "⛔ dangerous",
};

function riskOf(a: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}): string {
  if (a.readOnlyHint) return "read";
  if (a.destructiveHint) return a.idempotentHint ? "destructive" : "dangerous";
  return a.idempotentHint ? "write-idempotent" : "write";
}

function paramsOf(shape: ZodRawShape | undefined): string {
  if (!shape || Object.keys(shape).length === 0) return "_none_";
  const js = z.toJSONSchema(z.object(shape), { target: "draft-2020-12" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(js.required ?? []);
  return Object.keys(js.properties ?? {})
    .map((k) => (required.has(k) ? `\`${k}\`*` : `\`${k}\``))
    .join(", ");
}

const total = moduleCatalog.reduce((a, m) => a + m.tools.length, 0);
const lines: string[] = [];
lines.push("# Tool Reference");
lines.push("");
lines.push(
  `> **Generated** from source by \`scripts/gen-tool-docs.ts\` (\`bun run gen:docs\`) for v${VERSION}. Do not edit by hand.`,
);
lines.push("");
lines.push(
  `**${total} tools** across **${moduleCatalog.length} modules**. A \`*\` marks a required parameter.`,
);
lines.push("");
lines.push(
  "Risk legend: 🟢 read · 🟡 write · 🔴 destructive (removes config) · ⛔ dangerous (high blast radius / not repeatable).",
);
lines.push("");
lines.push("## Modules");
lines.push("");
lines.push("| Module | Group | Tools | Scope |");
lines.push("|--------|-------|------:|-------|");
// Escape `\` and `|` in cell text so a description like "`/interface gre|ipip|eoip`"
// doesn't inject extra table columns. The backslash must be escaped first (as
// `[\\|]` in one pass): a text like `a\|b` escaped naively becomes `a\\|b`,
// where the `\\` renders as a literal backslash and leaves the `|` live again.
const cell = (s: string): string => s.replace(/[\\|]/g, "\\$&");
for (const m of moduleCatalog) {
  lines.push(
    `| [${cell(m.label)}](#${m.slug}) | ${cell(m.group)} | ${m.tools.length} | ${cell(m.description)} |`,
  );
}
lines.push("");

for (const m of moduleCatalog) {
  lines.push(`## ${m.label}`);
  lines.push("");
  lines.push(`<a id="${m.slug}"></a>${m.description}`);
  lines.push("");
  lines.push("| Tool | Risk | Parameters | Description |");
  lines.push("|------|------|------------|-------------|");
  for (const t of m.tools) {
    const firstLine = cell(t.description.split("\n")[0]);
    lines.push(
      `| \`${t.name}\` | ${RISK_BADGE[riskOf(t.annotations)]} | ${paramsOf(t.inputSchema as ZodRawShape)} | ${firstLine} |`,
    );
  }
  lines.push("");
}

writeFileSync(join(PROJECT_ROOT, "docs", "tools-reference.md"), `${lines.join("\n")}\n`);
// eslint-disable-next-line node/prefer-global/process
process.stdout.write(`Wrote docs/tools-reference.md (${total} tools)\n`);
