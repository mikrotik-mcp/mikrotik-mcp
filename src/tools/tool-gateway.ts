/**
 * Tool gateway — a high-precision hybrid of the "dynamic discovery" and
 * "consolidation/dispatcher" patterns for large MCP catalogs.
 *
 * The problem: an MCP host ranks tools by embedding similarity and only shows
 * the model the top matches; with several hundred tools the right one is often
 * never surfaced, so the model "can't find" it. Instead of shrinking the
 * catalog, this exposes THREE always-discoverable meta-tools that let the model
 * reach every tool reliably:
 *
 *   • `find_tools`    — search the FULL catalog by intent (our deterministic
 *                       ranker, not the host's), returning the best-matching
 *                       tool names + how to call them.
 *   • `describe_tool` — the exact input schema + risk for one tool name, so the
 *                       model builds a correct call before running it.
 *   • `invoke_tool`   — run any tool by name with its real Zod validation and
 *                       handler. Unlike a raw-CLI escape hatch, the arguments are
 *                       schema-checked, so execution is as precise as calling the
 *                       dedicated tool directly — the gateway just removes the
 *                       discovery bottleneck.
 *
 * Flow: find_tools → (optional) describe_tool → invoke_tool. Each step is cheap
 * and precise; together they make the whole catalog usable through a handful of
 * tools the host can always surface.
 *
 * The catalog is imported lazily (dynamic `import("./index")`) because the
 * catalog imports this module — the index is built once on first use and cached.
 */
import { z } from "zod";
import { WRITE, READ, defineTool } from "../core/registry";
import type { RegisterableTool, ToolModule } from "../core/registry";
import { buildToolIndex, searchToolIndex } from "../core/tool-search";
import type { ToolForIndex, ToolSearchIndex } from "../core/tool-search";
import { getConfig } from "../core/runtime";
import { looksLikeError } from "../core/routeros";

/** Meta-tool names — excluded from search results and from being invoked. */
const META_NAMES = new Set(["find_tools", "describe_tool", "invoke_tool"]);

interface GatewayState {
  index: ToolSearchIndex;
  byName: Map<string, RegisterableTool>;
}

let cache: GatewayState | null = null;

/**
 * Build (once) the search index and the name→tool map from the live catalog.
 * Lazy + cached: the dynamic import breaks the catalog↔gateway cycle, and the
 * catalog is static for the process so a single build is correct.
 */
async function gateway(): Promise<GatewayState> {
  if (cache) return cache;
  const { moduleCatalog } = await import("./index");
  const forIndex: ToolForIndex[] = [];
  const byName = new Map<string, RegisterableTool>();
  for (const mod of moduleCatalog) {
    for (const tool of mod.tools) {
      if (META_NAMES.has(tool.name)) continue;
      byName.set(tool.name, tool);
      forIndex.push({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        module: mod.slug,
        group: mod.group,
        params: Object.keys(tool.inputSchema ?? {}),
      });
    }
  }
  cache = { index: buildToolIndex(forIndex), byName };
  return cache;
}

/** Reset the memoised index — used by tests; harmless in production. */
export function resetToolGatewayCache(): void {
  cache = null;
}

/** Whether a field in a Zod raw shape is optional (parses `undefined`). */
function isOptional(field: z.ZodTypeAny): boolean {
  return field.safeParse(undefined).success;
}

/** Compact, model-friendly parameter list for a tool's raw input shape. */
function describeParams(
  shape: Record<string, z.ZodTypeAny> | undefined,
): { name: string; required: boolean; description?: string }[] {
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => ({
    name,
    required: !isOptional(field),
    description: field.description,
  }));
}

export const toolGatewayTools: ToolModule = [
  defineTool({
    name: "find_tools",
    title: "Find Tools (catalog search)",
    annotations: READ,
    description:
      "🔍 START HERE — this is the PRIMARY entry point for ANY MikroTik / RouterOS task. " +
      "ALWAYS call this tool FIRST before attempting any other tool. This server has several hundred " +
      "dedicated tools with full validation and structured output, but the host only surfaces a small " +
      "subset — this tool searches the FULL catalog and finds the best match for your intent.\n\n" +
      "Describe what you want to do in natural language or keywords, e.g. 'block a LAN client by MAC', " +
      "'add an IPv4 firewall filter rule', 'import a TLS certificate', 'list DHCP leases', " +
      "'create a WireGuard peer'. Returns each match's exact tool name, description, and parameters — " +
      "then call it directly if available, or via `invoke_tool`.\n\n" +
      "Workflow: find_tools → (optional) describe_tool → invoke_tool. " +
      "Only fall back to run_routeros_command if this search returns zero results. " +
      "For IPv4 vs IPv6, include 'ipv4' or 'ipv6' to disambiguate. " +
      "For authorized changes that must be coordinated across multiple routers, search " +
      "'begin_transaction' BEFORE individual write tools (VPN tunnels, peering, routes or fleet ACLs). " +
      "Discovery does not authorize verify_transaction or commit_transaction.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          "What you want to do, in words or keywords (e.g. 'add ipv4 nat masquerade rule').",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("Max results to return (default 8)."),
    },
    async handler(a) {
      const { index } = await gateway();
      const hits = searchToolIndex(index, a.query, a.limit ?? 8);
      if (hits.length === 0) {
        return (
          `No tools matched "${a.query}". Try different keywords (a RouterOS scope like ` +
          "'firewall', 'dhcp', 'wireguard', 'certificate'), or use run_routeros_command for a raw CLI command."
        );
      }
      const lines = hits.map((h, i) => {
        const params = h.params.length ? ` · params: ${h.params.join(", ")}` : " · params: none";
        const desc = h.description.replace(/\s+/g, " ").slice(0, 200);
        return `${i + 1}. ${h.name}  [${h.module}]\n   ${h.title} — ${desc}${params}`;
      });
      const plural = hits.length === 1 ? "" : "s";
      return `Found ${hits.length} tool${plural} for "${a.query}" (best first). Call one directly if available, or via invoke_tool:\n\n${lines.join("\n\n")}`;
    },
  }),

  defineTool({
    name: "describe_tool",
    title: "Describe a Tool (exact schema)",
    annotations: READ,
    description:
      "Return the exact input schema, parameters (name · required · description), risk level and " +
      "purpose of ONE tool by its exact name — use it after find_tools to build a correct call " +
      "before running a tool you can't see listed. Pass the tool's snake_case name, e.g. " +
      "'create_filter_rule'.",
    inputSchema: {
      name: z.string().min(1).describe("Exact tool name, e.g. 'add_dhcp_lease'."),
    },
    async handler(a) {
      const { index, byName } = await gateway();
      const tool = byName.get(a.name.trim());
      if (!tool) {
        const near = searchToolIndex(index, a.name, 5)
          .map((h) => h.name)
          .join(", ");
        return `No tool named "${a.name}".${near ? ` Did you mean: ${near}?` : ""} Use find_tools to search.`;
      }
      const params = describeParams(tool.inputSchema as Record<string, z.ZodTypeAny> | undefined);
      const schema = z.toJSONSchema(z.object((tool.inputSchema ?? {}) as z.ZodRawShape), {
        target: "draft-2020-12",
      });
      const risk = tool.annotations.readOnlyHint
        ? "READ (no changes)"
        : tool.annotations.destructiveHint
          ? "DESTRUCTIVE / DANGEROUS"
          : "WRITE";
      const paramLines = params.length
        ? params
            .map(
              (p) =>
                `  • ${p.name}${p.required ? " (required)" : " (optional)"}${
                  p.description ? ` — ${p.description}` : ""
                }`,
            )
            .join("\n")
        : "  (no parameters)";
      return (
        `${tool.name} — ${tool.title}\n` +
        `risk: ${risk}\n\n` +
        `${tool.description}\n\n` +
        `Parameters:\n${paramLines}\n\n` +
        `JSON schema:\n${JSON.stringify(schema, null, 2)}\n\n` +
        `Run it with invoke_tool: { "name": "${tool.name}", "arguments": { … } }`
      );
    },
  }),

  defineTool({
    name: "invoke_tool",
    title: "Invoke a Tool by Name",
    annotations: WRITE,
    description:
      "Execute ANY tool in the catalog by its exact name with the given arguments — the precise way " +
      "to run a tool you found via find_tools but the host hasn't surfaced for a direct call. The " +
      "arguments are validated against that tool's real schema and run through its real handler, so " +
      "this is exactly as safe/accurate as calling the tool directly (unlike raw CLI). " +
      "To target a specific device in a multi-device setup, set the top-level `device` parameter on " +
      "THIS call — not inside `arguments`. If validation fails you get the expected parameters back; " +
      "fix and retry. For a one-off raw command with no dedicated tool, prefer run_routeros_command.",
    inputSchema: {
      name: z.string().min(1).describe("Exact tool name to run, e.g. 'create_filter_rule'."),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The tool's arguments as an object (omit for a no-argument tool)."),
    },
    async handler(a, ctx) {
      const { index, byName } = await gateway();
      const name = a.name.trim();
      if (META_NAMES.has(name)) {
        return `"${name}" is a gateway meta-tool and cannot be invoked through invoke_tool.`;
      }
      const tool = byName.get(name);
      if (!tool) {
        const near = searchToolIndex(index, name, 5)
          .map((h) => h.name)
          .join(", ");
        return `No tool named "${name}".${near ? ` Closest matches: ${near}.` : ""} Use find_tools to search the catalog.`;
      }

      // Safety: never let the dispatcher run a write tool when the server is in
      // read-only mode (invoke_tool is itself withheld in that mode, but enforce
      // here too so a config change can't open a hole).
      if (getConfig().readOnly && tool.annotations.readOnlyHint !== true) {
        return `Refused: the server is in read-only mode and "${name}" is a write/destructive tool.`;
      }

      // Validate the arguments against the target tool's own schema — the same
      // check the MCP server applies, so invocation precision is identical.
      const shape = (tool.inputSchema ?? {}) as z.ZodRawShape;
      const parsed = z.object(shape).safeParse(a.arguments ?? {});
      if (!parsed.success) {
        const params = describeParams(shape as Record<string, z.ZodTypeAny>)
          .map((p) => `${p.name}${p.required ? " (required)" : ""}`)
          .join(", ");
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return (
          `Invalid arguments for "${name}": ${issues}. ` +
          `Expected parameters: ${params || "(none)"}. Use describe_tool("${name}") for the full schema.`
        );
      }

      ctx.info(`invoke_tool → ${name}`);
      const raw = await tool.handler(parsed.data, ctx);
      const text = typeof raw === "string" ? raw : raw.text;
      if (looksLikeError(text)) return `Tool "${name}" reported an error: ${text}`;
      return text.trim() ? text : `(${name} completed with no output)`;
    },
  }),
];
