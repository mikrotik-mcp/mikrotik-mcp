import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcFunction } from "devframe";
import { z } from "zod";
import type { DataSourceEntry } from "@devframes/plugin-data-inspector/registry";

const risk = z.enum(["read", "write", "write-idempotent", "destructive", "dangerous"]);
const toolSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  risk,
  annotations: z.record(z.string(), z.boolean()),
  inputSchema: z.record(z.string(), z.unknown()),
});
const manifestSchema = z.object({
  format: z.literal(1),
  version: z.string(),
  modules: z.array(
    z.object({
      slug: z.string(),
      label: z.string(),
      group: z.string(),
      description: z.string(),
      alwaysOn: z.boolean(),
      tools: z.array(z.string()),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string(),
      module: z.string(),
      group: z.string(),
      noDevice: z.boolean(),
      requires: z.record(z.string(), z.unknown()).nullable(),
      ui: z
        .object({
          resourceUri: z.string(),
          automatic: z.boolean(),
          visibility: z.array(z.string()).optional(),
        })
        .nullable(),
    }),
  ),
  appViews: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  prompts: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      body: z.string(),
      arguments: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          required: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
const searchSchema = z
  .object({
    query: z.string().max(200).optional(),
    module: z.string().max(100).optional(),
    group: z.string().max(100).optional(),
    risk: risk.optional(),
    hasAppView: z.boolean().optional(),
    serverOnly: z.boolean().optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

/** Fixed local API reads only: no client-supplied URL, token, config path or RouterOS call. */
export async function readDashboardRuntime() {
  const read = async (path: "/api/meta" | "/api/modules") => {
    try {
      const response = await fetch(`http://127.0.0.1:9091${path}`, {
        signal: AbortSignal.timeout(2500),
        redirect: "error",
        credentials: "omit",
      });
      if (!response.ok)
        return {
          status:
            response.status === 401 || response.status === 403
              ? "authentication-required"
              : "http-error",
          httpStatus: response.status,
        };
      const schema =
        path === "/api/meta"
          ? z.object({
              version: z.string(),
              total: z.number(),
              liveClients: z.number(),
              transport: z.string(),
            })
          : z.object({
              total: z.number(),
              enabledModules: z.number(),
              enabledTools: z.number(),
              totalTools: z.number(),
              hasAllowList: z.boolean(),
              appViews: z.boolean(),
              modules: z.array(
                z.object({ slug: z.string(), enabled: z.boolean(), toolCount: z.number() }),
              ),
            });
      return { status: "available", data: schema.parse(await response.json()) };
    } catch {
      return {
        status: "unavailable",
        hint: "Start the dashboard backend on localhost:9091; no credentials are read or forwarded.",
      };
    }
  };
  const [server, surface] = await Promise.all([read("/api/meta"), read("/api/modules")]);
  return {
    sampledAt: new Date().toISOString(),
    server,
    surface,
    note: "Module exposure is not permission to execute. Access scope, read-only mode and device capabilities are separate checks.",
  };
}

/** No source/runtime imports here: Vite reads only the generated public contract. */
export function mcpInspector(root: string, baseSources: DataSourceEntry[]) {
  const builtViews = baseSources.find((source) => source.id === "mikrotik:ui-build")!
    .data as () => Promise<unknown>;
  const readJson = async (file: string) => JSON.parse(await readFile(join(root, file), "utf8"));
  const readCatalog = async () => {
    const [rawManifest, rawCatalog] = await Promise.all([
      readJson("schemas/devtools-manifest.json"),
      readJson("schemas/tool-catalog.json"),
    ]);
    const manifest = manifestSchema.parse(rawManifest);
    const catalog = z.object({ version: z.string(), tools: z.array(toolSchema) }).parse(rawCatalog);
    if (manifest.version !== catalog.version)
      throw new Error("Catalog versions differ. Run bun run gen:schemas.");
    const metadata = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    if (
      metadata.size !== catalog.tools.length ||
      catalog.tools.some((tool) => !metadata.has(tool.name))
    ) {
      throw new Error("Tool metadata is stale. Run bun run gen:schemas.");
    }
    return {
      ...manifest,
      tools: catalog.tools.map((tool) => ({ ...tool, ...metadata.get(tool.name)! })),
    };
  };
  const modules = async () => {
    const catalog = await readCatalog();
    return catalog.modules.map((module) => ({
      ...module,
      toolCount: module.tools.length,
      risks: Object.fromEntries(
        risk.options.map((level) => [
          level,
          catalog.tools.filter((tool) => tool.module === module.slug && tool.risk === level).length,
        ]),
      ),
    }));
  };
  const appViews = async () => {
    const catalog = await readCatalog();
    return {
      views: catalog.appViews.map((view) => ({
        ...view,
        tools: catalog.tools
          .filter((tool) => tool.ui?.resourceUri.split("/").pop()?.split(".html")[0] === view.id)
          .map((tool) => ({
            name: tool.name,
            automatic: tool.ui!.automatic,
            visibility: tool.ui!.visibility ?? ["model"],
          })),
      })),
      withoutView: catalog.tools
        .filter((tool) => !tool.ui)
        .map((tool) => ({ name: tool.name, risk: tool.risk, module: tool.module })),
      note: "Declared coverage, not runtime availability. App Views may be disabled in server configuration; many write tools intentionally have no view.",
    };
  };
  const summary = async () => {
    const catalog = await readCatalog();
    return {
      version: catalog.version,
      tools: catalog.tools.length,
      modules: catalog.modules.length,
      groups: [...new Set(catalog.modules.map((module) => module.group))].sort(),
      prompts: catalog.prompts.length,
      appViews: catalog.appViews.length,
      toolsWithViews: catalog.tools.filter((tool) => tool.ui).length,
      serverOnlyTools: catalog.tools.filter((tool) => tool.noDevice).length,
      capabilityGuardedTools: catalog.tools.filter((tool) => tool.requires).length,
      risks: Object.fromEntries(
        risk.options.map((level) => [
          level,
          catalog.tools.filter((tool) => tool.risk === level).length,
        ]),
      ),
      provenance:
        "Generated source declarations — run bun run gen:schemas after tool changes. Not a connected-device capability probe.",
    };
  };
  const diagnostics = async () => {
    const [catalog, pkg, bundle, build] = await Promise.all([
      readCatalog(),
      readJson("package.json"),
      readJson("manifest.json"),
      builtViews(),
    ]);
    const files = z
      .object({ files: z.array(z.object({ name: z.string() })) })
      .parse(build)
      .files.map((file) => file.name);
    return {
      versions: {
        package: String(pkg.version),
        catalog: catalog.version,
        mcpBundle: String(bundle.version),
      },
      checks: [
        { id: "catalog-version", ok: pkg.version === catalog.version, fix: "bun run gen:schemas" },
        {
          id: "bundle-version",
          ok: pkg.version === bundle.version,
          fix: "Align manifest.json with the release version before packaging.",
        },
        ...[...catalog.appViews.map((view) => view.id), "observability"].map((id) => ({
          id: `build:${id}`,
          ok: files.includes(`${id}.html`),
          fix: "bun run build:ui",
        })),
      ],
    };
  };
  const sources: DataSourceEntry[] = [
    ...baseSources,
    {
      id: "mikrotik:summary",
      title: "MCP capability overview",
      data: summary,
      queries: [{ title: "Risk distribution", query: "risks" }],
    },
    {
      id: "mikrotik:modules",
      title: "All MCP modules",
      data: modules,
      queries: [
        { title: "Module groups", query: "group(=>group)" },
        { title: "Always-on modules", query: ".[alwaysOn]" },
      ],
    },
    {
      id: "mikrotik:prompts",
      title: "MCP workflow prompts",
      data: async () => (await readCatalog()).prompts,
    },
    {
      id: "mikrotik:app-views",
      title: "App View coverage",
      data: appViews,
      queries: [
        { title: "Tools without views", query: "withoutView" },
        { title: "View bindings", query: "views" },
      ],
    },
    {
      id: "mikrotik:requirements",
      title: "Device requirements",
      data: async () =>
        (await readCatalog()).tools
          .filter((tool) => tool.requires)
          .map(({ name, module, requires }) => ({ name, module, requires })),
    },
    {
      id: "mikrotik:diagnostics",
      title: "Release & build diagnostics",
      data: diagnostics,
      queries: [{ title: "Failed checks", query: "checks.[ok = false]" }],
    },
    { id: "mikrotik:runtime", title: "Live MCP server surface", data: readDashboardRuntime },
  ].map((source) => ({ ...source, writable: false }));
  const rpcs = sources.map((source) =>
    defineRpcFunction({
      name: source.id,
      type: "query",
      jsonSerializable: true,
      agent: {
        title: source.title,
        description: `Read-only inspection: ${source.title}. Never executes a MikroTik tool.`,
        safety: "read",
      },
      setup: () => ({ handler: source.data as () => Promise<unknown> }),
    }),
  );
  return {
    sources,
    rpcs: [
      ...rpcs,
      defineRpcFunction({
        name: "mikrotik:search-tools",
        type: "query",
        jsonSerializable: true,
        args: [searchSchema],
        returns: z.unknown(),
        agent: {
          title: "Search MCP tools",
          description:
            "Search public tool declarations by name/description, module, group, risk, App View or server-only status. Paginated; never invokes a tool.",
          safety: "read",
        },
        setup: () => ({
          handler: async (input: z.input<typeof searchSchema>) => {
            const filter = searchSchema.parse(input);
            const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
            const tools = (await readCatalog()).tools.filter(
              (tool) =>
                words.every((word) =>
                  `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(word),
                ) &&
                (!filter.module || tool.module === filter.module) &&
                (!filter.group || tool.group === filter.group) &&
                (!filter.risk || tool.risk === filter.risk) &&
                (filter.hasAppView === undefined || Boolean(tool.ui) === filter.hasAppView) &&
                (filter.serverOnly === undefined || tool.noDevice === filter.serverOnly),
            );
            return {
              total: tools.length,
              offset: filter.offset,
              limit: filter.limit,
              tools: tools.slice(filter.offset, filter.offset + filter.limit),
            };
          },
        }),
      }),
      defineRpcFunction({
        name: "mikrotik:describe-tool",
        type: "query",
        jsonSerializable: true,
        args: [z.string().min(1).max(150)],
        returns: z.unknown(),
        agent: {
          title: "Describe MCP tool",
          description:
            "Read one exact tool's schema, risk, module, device requirements and effective App View. No execution.",
          safety: "read",
        },
        setup: () => ({
          handler: async (name: string) => {
            z.string().min(1).max(150).parse(name);
            const tool = (await readCatalog()).tools.find((item) => item.name === name);
            if (!tool) throw new Error("Unknown tool name; use mikrotik:search-tools.");
            return tool;
          },
        }),
      }),
    ],
  };
}
