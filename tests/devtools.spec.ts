import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runQuery } from "@devframes/plugin-data-inspector/engine";
import { viteDevframeHub } from "@devframes/vite/hub";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readDashboardRuntime } from "../ui/devtools-inspector";
import { buildDevtoolsManifest } from "../scripts/devtools-manifest";
import { dashboardDataSources, dashboardDevtools } from "../ui/devtools";
import dashboardConfig from "../ui/vite.observability.config";

vi.mock("@devframes/vite/hub", () => ({
  viteDevframeHub: vi.fn(() => ({ name: "devframes:hub" })),
}));

describe("development-only dashboard tooling", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps generated capabilities aligned with the real MCP declarations", async () => {
    const generated = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../schemas/devtools-manifest.json"), "utf8"),
    );
    expect(generated).toEqual(JSON.parse(JSON.stringify(buildDevtoolsManifest())));
  });
  it("keeps normal development and every production build free of DevFrame", async () => {
    if (typeof dashboardConfig !== "function") throw new Error("Expected a config factory");
    for (const [command, mode] of [
      ["build", "production"],
      ["build", "devtools"],
      ["serve", "development"],
      ["serve", "devtools"],
    ] as const) {
      const config = await dashboardConfig({ command, mode });
      const names = config.plugins?.flat().map((plugin) => (plugin as { name?: string })?.name);
      expect(names?.includes("devframes:hub")).toBe(command === "serve" && mode === "devtools");
    }
  });

  it("exposes only detached, read-only public data and working query recipes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const sources = dashboardDataSources(resolve(import.meta.dirname, ".."));
    expect(sources.map((source) => source.id)).toEqual([
      "mikrotik:catalog",
      "mikrotik:navigation",
      "mikrotik:config-schema",
      "mikrotik:ui-build",
      "mikrotik:summary",
      "mikrotik:modules",
      "mikrotik:prompts",
      "mikrotik:app-views",
      "mikrotik:requirements",
      "mikrotik:diagnostics",
      "mikrotik:runtime",
    ]);
    for (const source of sources) {
      expect(source.writable).toBe(false);
      const data = await (source.data as () => Promise<unknown>)();
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
      for (const recipe of source.queries ?? []) {
        const result = await runQuery(data, recipe.query);
        expect(result, `${source.id}: ${recipe.title}`).not.toHaveProperty("error");
      }
    }
    const readNavigation = sources[1].data as () => { pages: { label: string }[] };
    readNavigation().pages[0].label = "mutated";
    expect(readNavigation().pages[0].label).not.toBe("mutated");
  });

  it("reports missing builds, but does not hide missing schemas", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mikrotik-devtools-"));
    try {
      const sources = dashboardDataSources(root);
      await expect((sources[3].data as () => Promise<unknown>)()).resolves.toMatchObject({
        status: "not-built",
        files: [],
      });
      await expect((sources[0].data as () => Promise<unknown>)()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains authentication, disables MCP/build embedding, and rejects remote binding", () => {
    const [guard] = dashboardDevtools("/project");
    const options = vi.mocked(viteDevframeHub).mock.calls.at(-1)![0]!;
    expect(options.auth).not.toBe(false);
    expect(options.mcp).toBe(false);
    expect(options.build).toBe(false);
    expect(options.devframes).toHaveLength(3);
    const check = guard.configResolved as (config: unknown) => void;
    expect(() => check({ server: { host: "127.0.0.1" } })).not.toThrow();
    for (const host of [true, "0.0.0.0", "::", "192.168.1.1"]) {
      expect(() => check({ server: { host } })).toThrow("loopback");
    }
  });

  it("does not remove replacement sources when an old server closes", async () => {
    const entries = new Map();
    const registry = {
      register: (source: { id: string }) => entries.set(source.id, source),
      get: (id: string) => entries.get(id),
      unregister: (id: string) => entries.delete(id),
    };
    const context = { services: { get: () => registry } };
    const [old] = dashboardDevtools("/project");
    await vi.mocked(viteDevframeHub).mock.calls.at(-1)![0]!.configure!(context as never);
    const [current] = dashboardDevtools("/project");
    await vi.mocked(viteDevframeHub).mock.calls.at(-1)![0]!.configure!(context as never);
    (old.closeBundle as () => void)();
    expect(entries.size).toBe(11);
    (current.closeBundle as () => void)();
    expect(entries.size).toBe(0);
  });

  it("registers read-only MCP queries with bounded search and complete tool metadata", async () => {
    dashboardDevtools(resolve(import.meta.dirname, ".."));
    const declarations = vi.mocked(viteDevframeHub).mock.calls.at(-1)![0]!.rpcDeclarations!;
    expect(declarations).toHaveLength(13);
    const invoke = async (name: string, ...args: unknown[]) => {
      const definition = (declarations as any[]).find((rpc) => rpc.name === name);
      expect(definition.type).toBe("query");
      expect(definition.agent.safety).toBe("read");
      return (await definition.setup({})).handler(...args);
    };
    const overview = await invoke("mikrotik:summary");
    const first = await invoke("mikrotik:search-tools", { limit: 1 });
    expect(first.total).toBe(overview.tools);
    expect(first.tools).toHaveLength(1);
    const second = await invoke("mikrotik:search-tools", { limit: 1, offset: 1 });
    expect(second.tools[0].name).not.toBe(first.tools[0].name);
    const tool = await invoke("mikrotik:describe-tool", first.tools[0].name);
    expect(tool).toHaveProperty("inputSchema");
    expect(tool).toHaveProperty("module");
    expect(tool).toHaveProperty("requires");
    expect(tool).toHaveProperty("ui");
    const filtered = await invoke("mikrotik:search-tools", {
      risk: "read",
      hasAppView: true,
      limit: 100,
    });
    expect(filtered.tools.length).toBeGreaterThan(0);
    expect(filtered.tools.every((item: any) => item.risk === "read" && item.ui)).toBe(true);
    await expect(invoke("mikrotik:search-tools", { limit: 101 })).rejects.toThrow();
    await expect(invoke("mikrotik:search-tools", { execute: "reboot" })).rejects.toThrow();
    await expect(invoke("mikrotik:describe-tool", "not_a_tool")).rejects.toThrow("Unknown tool");
    const views = await invoke("mikrotik:app-views");
    expect(views.views.flatMap((view: any) => view.tools).length + views.withoutView.length).toBe(
      overview.tools,
    );
    const modules = await invoke("mikrotik:modules");
    expect(modules.reduce((sum: number, module: any) => sum + module.toolCount, 0)).toBe(
      overview.tools,
    );
  });

  it("limits live reads to public counters and respects backend authentication", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/meta")
              ? {
                  version: "test",
                  total: 12,
                  liveClients: 1,
                  transport: "stdio",
                  devices: ["private-router"],
                  secret: "hidden",
                }
              : {
                  total: 1,
                  enabledModules: 1,
                  enabledTools: 2,
                  totalTools: 2,
                  hasAllowList: false,
                  appViews: true,
                  source: { path: "/private/config" },
                  modules: [
                    {
                      slug: "system",
                      enabled: true,
                      toolCount: 2,
                      unsupported: ["private-router"],
                    },
                  ],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await readDashboardRuntime();
    expect(result.server.status).toBe("available");
    expect(result.surface.status).toBe("available");
    expect(JSON.stringify(result)).not.toMatch(/private|secret|hidden/);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9091\/api\/(meta|modules)$/);
      expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
    }
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    expect((await readDashboardRuntime()).server.status).toBe("authentication-required");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await readDashboardRuntime()).server.status).toBe("unavailable");
  });
});
