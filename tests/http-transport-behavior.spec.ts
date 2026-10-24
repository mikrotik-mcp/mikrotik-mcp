import { beforeEach, expect, test, vi } from "vite-plus/test";
import { McpServerSettingsSchema } from "../src/config";
import { runHttp } from "../src/transport/http";

const state = vi.hoisted(() => ({
  options: null as null | { fetch: (request: Request) => Promise<Response> },
  transports: [] as {
    config: Record<string, unknown>;
    handleRequest: ReturnType<typeof vi.fn>;
    sessionId: string;
    onclose?: () => void;
  }[],
  connections: 0,
}));
vi.mock("bun", () => ({
  serve: (options: typeof state.options) => {
    state.options = options;
    return { port: 8080 };
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    config: Record<string, unknown>;
    sessionId = "session-1";
    onclose?: () => void;
    initialized = false;
    handleRequest = vi.fn(async () => {
      if (!this.initialized) {
        this.initialized = true;
        (this.config.onsessioninitialized as (id: string) => void)(this.sessionId);
      }
      return new Response("mcp-reply", { status: 202, headers: { "x-mcp": "preserved" } });
    });
    constructor(config: Record<string, unknown>) {
      this.config = config;
      state.transports.push(this);
    }
  },
}));
vi.mock("../src/server", () => ({
  createServer: () => ({
    server: {
      connect: async () => {
        state.connections++;
      },
    },
    toolCount: 3,
    promptCount: 1,
    uiViewCount: 1,
    readOnly: true,
  }),
}));
vi.mock("../src/core/update-check", () => ({ checkForUpdate: async () => ({ release: null }) }));

function options(overrides: Record<string, unknown> = {}) {
  return McpServerSettingsSchema.parse({
    transport: "streamable-http",
    host: "127.0.0.1",
    port: 8080,
    ...overrides,
  });
}
async function request(path: string, init: RequestInit = {}) {
  if (!state.options) throw new Error("server not registered");
  return state.options.fetch(new Request(`http://127.0.0.1:8080${path}`, init));
}

beforeEach(() => {
  state.options = null;
  state.transports = [];
  state.connections = 0;
});

test("preflight and health never create an MCP session", async () => {
  await runHttp(options());
  const preflight = await request("/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://chatgpt.com" },
  });
  expect(preflight.status).toBe(204);
  expect(await (await request("/health")).text()).toBe("OK");
  expect((await request("/other")).status).toBe(404);
  expect(state.transports).toHaveLength(0);
});

test("localhost security and CORS preserve MCP response headers across a reused session", async () => {
  await runHttp(options({ corsOrigins: "*" }));
  const first = await request("/mcp", {
    method: "POST",
    headers: { origin: "https://app.example" },
  });
  expect(first.status).toBe(202);
  expect(first.headers.get("x-mcp")).toBe("preserved");
  expect(first.headers.get("access-control-allow-origin")).toBe("*");
  expect(state.transports[0].config).toMatchObject({
    enableDnsRebindingProtection: true,
    allowedHosts: ["127.0.0.1:*", "localhost:*", "[::1]:*"],
  });
  await request("/mcp/", { method: "POST", headers: { "mcp-session-id": "session-1" } });
  expect(state.transports).toHaveLength(1);
  expect(state.connections).toBe(1);
  state.transports[0].onclose?.();
  await request("/mcp", { method: "POST", headers: { "mcp-session-id": "session-1" } });
  expect(state.transports).toHaveLength(2);
});

test("explicit allowlists and wildcard host configure rebinding protection separately", async () => {
  await runHttp(
    options({
      host: "0.0.0.0",
      allowedHosts: "router.example",
      allowedOrigins: "https://app.example",
    }),
  );
  await request("/mcp", { method: "POST" });
  expect(state.transports[0].config).toMatchObject({
    enableDnsRebindingProtection: true,
    allowedHosts: ["router.example"],
    allowedOrigins: ["https://app.example"],
  });
  state.transports = [];
  await runHttp(options({ host: "0.0.0.0", allowedHosts: "*" }));
  await request("/mcp", { method: "POST" });
  expect(state.transports[0].config.enableDnsRebindingProtection).toBe(false);
});
