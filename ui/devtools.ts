import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createA11yDevframe } from "@devframes/plugin-a11y";
import { createDataInspectorDevframe } from "@devframes/plugin-data-inspector";
import type { DataSourceEntry } from "@devframes/plugin-data-inspector/registry";
import { createInspectDevframe } from "@devframes/plugin-inspect";
import { viteDevframeHub } from "@devframes/vite/hub";
import type { Plugin } from "vite-plus";
import { NAV_GROUPS, VIEWS } from "./observability/navigation";
import { mcpInspector } from "./devtools-inspector";

/** Fixed public inputs only. Never expose runtime config, env, handlers or live objects to Jora. */
function dashboardInspector(root: string) {
  const sources: DataSourceEntry[] = [
    {
      id: "mikrotik:catalog",
      title: "MCP tool catalog",
      description:
        "Generated public tool schemas and risk annotations. Run bun run gen:schemas to update.",
      data: async () => JSON.parse(await readFile(join(root, "schemas/tool-catalog.json"), "utf8")),
      queries: [
        { title: "All tools", query: "tools" },
        { title: "Read-only tools", query: "tools.[annotations.readOnlyHint = true]" },
        { title: "Destructive tools", query: "tools.[annotations.destructiveHint = true]" },
        { title: "Tools by risk", query: "tools.group(=>risk)" },
      ],
    },
    {
      id: "mikrotik:navigation",
      title: "Dashboard routes",
      description:
        "Actual navigation groups and pages; restart devtools after changing navigation source.",
      // A detached JSON copy, not the mutable objects used by the app.
      data: () => JSON.parse(JSON.stringify({ groups: NAV_GROUPS, pages: VIEWS })),
      queries: [
        { title: "Pages", query: "pages" },
        { title: "Menu groups", query: "groups" },
      ],
    },
    {
      id: "mikrotik:config-schema",
      title: "Configuration schema",
      description: "Public schema only — never devices.json or effective configuration.",
      data: async () =>
        JSON.parse(await readFile(join(root, "schemas/config.schema.json"), "utf8")),
      queries: [{ title: "Configuration fields", query: "properties" }],
    },
    {
      id: "mikrotik:ui-build",
      title: "UI build artifacts",
      description:
        "Sizes and timestamps of locally built App Views and dashboard. No file contents.",
      data: async () => {
        const directory = join(root, "dist/ui");
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { status: "not-built", hint: "Run bun run build:ui", files: [] };
          }
          throw error;
        }
        const files = await Promise.all(
          entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
            .map(async (entry) => {
              const info = await stat(join(directory, entry.name));
              return { name: entry.name, bytes: info.size, builtAt: info.mtime.toISOString() };
            }),
        );
        return { status: "built", files: files.sort((a, b) => a.name.localeCompare(b.name)) };
      },
      queries: [{ title: "Built views", query: "files" }],
    },
  ].map((source) => ({ ...source, writable: false }));
  return mcpInspector(root, sources);
}

export function dashboardDataSources(root: string): DataSourceEntry[] {
  return dashboardInspector(root).sources;
}

export function dashboardDevtools(root: string): Plugin[] {
  const inspector = dashboardInspector(root);
  let unregisterSources = () => {};
  return [
    {
      name: "mikrotik:devtools-sources",
      configResolved(config) {
        if (!["127.0.0.1", "localhost", "::1", "bot.local"].includes(String(config.server.host))) {
          throw new Error("MikroTik DevTools must bind to loopback; remove --host overrides.");
        }
      },
      closeBundle() {
        unregisterSources();
      },
    },
    viteDevframeHub({
      name: "MikroTik MCP DevTools",
      cwd: root,
      host: "127.0.0.1",
      // Keep interactive OTP auth and origin checks. No second MCP tool execution surface.
      mcp: false,
      build: false,
      quiet: true,
      rpcDeclarations: inspector.rpcs,
      getStorageDir: () => join(root, ".cache/devtools"),
      configure(ctx) {
        const registry = ctx.services.get("devframes:plugin:data-inspector:sources");
        if (!registry) throw new Error("DevFrame Data Inspector failed to initialize.");
        const sources = inspector.sources;
        for (const source of sources) registry.register(source);
        unregisterSources = () => {
          // A late close from an old Vite instance must not remove the new instance's sources.
          for (const source of sources) {
            if (registry.get(source.id) === source) registry.unregister(source.id);
          }
        };
      },
      devframes: [
        createDataInspectorDevframe({ id: "mikrotik-data", exampleSource: false }),
        createInspectDevframe(),
        createA11yDevframe({ logIssues: false }),
      ],
    }),
  ];
}
