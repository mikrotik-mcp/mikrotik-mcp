import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { McpServerSettingsSchema } from "../src/config";
import { runHttp } from "../src/transport/http";

const state = vi.hoisted(() => ({
  options: null as null | { fetch: (request: Request) => Promise<Response> },
  transports: [] as {
    config: Record<string, unknown>;
    handleRequest: ReturnType<typeof vi.fn>;
    sessionId: string;
    onclose?: () => void;
    close: () => Promise<void>;
  }[],
  connections: 0,
  serverCloses: 0,
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
    sessionId: string;
    onclose?: () => void;
    initialized = false;
    closed = false;
    close = async () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    };
    handleRequest = vi.fn(async (req: Request) => {
      if (req.method === "DELETE") {
        await this.close();
        return new Response(null, { status: 200 });
      }
      if (!this.initialized) {
        this.initialized = true;
        (this.config.onsessioninitialized as (id: string) => void)(this.sessionId);
      }
      return new Response("mcp-reply", { status: 202, headers: { "x-mcp": "preserved" } });
    });
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.sessionId = `session-${state.transports.length + 1}`;
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
      close: async () => {
        state.serverCloses++;
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
const rpc = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method });
const initialize = (headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers,
  body: rpc("initialize"),
});
const inSession = (id: string, method = "POST"): RequestInit => ({
  method,
  headers: { "mcp-session-id": id },
  body: method === "POST" ? rpc("tools/list") : undefined,
});

beforeEach(() => {
  state.options = null;
  state.transports = [];
  state.connections = 0;
  state.serverCloses = 0;
});
afterEach(() => vi.useRealTimers());

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
  const first = await request("/mcp", initialize({ origin: "https://app.example" }));
  expect(first.status).toBe(202);
  expect(first.headers.get("x-mcp")).toBe("preserved");
  expect(first.headers.get("access-control-allow-origin")).toBe("*");
  expect(state.transports[0].config).toMatchObject({
    enableDnsRebindingProtection: true,
    allowedHosts: ["127.0.0.1:*", "localhost:*", "[::1]:*"],
  });
  // The body was read to find `initialize`, so the transport must get it parsed.
  expect(state.transports[0].handleRequest.mock.calls[0][1]).toEqual({
    parsedBody: { jsonrpc: "2.0", id: 1, method: "initialize" },
  });
  expect((await request("/mcp/", inSession("session-1"))).status).toBe(202);
  expect(state.transports).toHaveLength(1);
  expect(state.connections).toBe(1);
});

test("explicit allowlists and wildcard host configure rebinding protection separately", async () => {
  await runHttp(
    options({
      host: "0.0.0.0",
      allowedHosts: "router.example",
      allowedOrigins: "https://app.example",
    }),
  );
  await request("/mcp", initialize());
  expect(state.transports[0].config).toMatchObject({
    enableDnsRebindingProtection: true,
    allowedHosts: ["router.example"],
    allowedOrigins: ["https://app.example"],
  });
  state.transports = [];
  await runHttp(options({ host: "0.0.0.0", allowedHosts: "*" }));
  await request("/mcp", initialize());
  expect(state.transports[0].config.enableDnsRebindingProtection).toBe(false);
});

test("an unknown session id gets 404 -32001 and creates nothing", async () => {
  await runHttp(options({ corsOrigins: "*" }));
  for (const method of ["POST", "GET", "DELETE"]) {
    const res = await request("/mcp", {
      ...inSession("0b0e7c9e-0000-4000-8000-000000000000", method),
      headers: {
        "mcp-session-id": "0b0e7c9e-0000-4000-8000-000000000000",
        origin: "https://app.example",
      },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
  }
  expect(state.transports).toHaveLength(0);
  expect(state.connections).toBe(0);
});

test("a request without a session id that is not initialize gets 400 and creates nothing", async () => {
  await runHttp(options());
  const cases: RequestInit[] = [
    { method: "POST", body: rpc("tools/list") },
    { method: "POST", body: JSON.stringify([JSON.parse(rpc("tools/list"))]) },
    { method: "POST", body: "{not json" },
    { method: "POST" },
    { method: "GET" },
    { method: "DELETE" },
  ];
  for (const init of cases) {
    const res = await request("/mcp", init);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBeLessThan(0);
  }
  expect(state.transports).toHaveLength(0);
  expect(state.connections).toBe(0);
  // A batch that contains initialize does open a session.
  const batch = JSON.stringify([JSON.parse(rpc("initialize"))]);
  expect((await request("/mcp", { method: "POST", body: batch })).status).toBe(202);
  expect(state.transports).toHaveLength(1);
});

test("DELETE and a transport close both evict the session and close its server", async () => {
  await runHttp(options());
  await request("/mcp", initialize());
  expect((await request("/mcp", inSession("session-1", "DELETE"))).status).toBe(200);
  expect(state.serverCloses).toBe(1);
  expect((await request("/mcp", inSession("session-1"))).status).toBe(404);
  expect((await request("/mcp", inSession("session-1", "DELETE"))).status).toBe(404);

  await request("/mcp", initialize());
  await state.transports[1].close();
  expect(state.serverCloses).toBe(2);
  expect((await request("/mcp", inSession("session-2"))).status).toBe(404);
  expect(state.transports).toHaveLength(2);
});

test("a session past its idle TTL is evicted and its server closed; a request resets the TTL", async () => {
  vi.useFakeTimers();
  await runHttp(options({ sessionIdleTimeout: 10_000 }));
  await request("/mcp", initialize());
  await vi.advanceTimersByTimeAsync(8_000);
  expect((await request("/mcp", inSession("session-1"))).status).toBe(202);
  await vi.advanceTimersByTimeAsync(8_000);
  expect((await request("/mcp", inSession("session-1"))).status).toBe(202);
  expect(state.serverCloses).toBe(0);
  await vi.advanceTimersByTimeAsync(21_000);
  expect(state.serverCloses).toBe(1);
  expect((await request("/mcp", inSession("session-1"))).status).toBe(404);
});

test("a failed initialize leaves no server behind", async () => {
  await runHttp(options());
  const failing = vi.fn(async () => {
    throw new Error("boom");
  });
  const original = state.transports;
  const pushed: unknown[] = [];
  state.transports = new Proxy(original, {
    get(target, key, receiver) {
      if (key === "push")
        return (transport: { handleRequest: unknown }) => {
          transport.handleRequest = failing;
          pushed.push(transport);
          return target.push(transport as never);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  await expect(request("/mcp", initialize())).rejects.toThrow("boom");
  expect(pushed).toHaveLength(1);
  expect(state.serverCloses).toBe(1);
});

test("1,000 requests with random unknown session ids create nothing and keep memory flat", async () => {
  await runHttp(options());
  await request("/mcp", initialize());
  const unknown = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const res = await request("/mcp", inSession(crypto.randomUUID()));
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    }
  };
  await unknown(200); // warm-up, so the measured run is steady state
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  await unknown(1000);
  globalThis.gc?.();
  const grown = process.memoryUsage().heapUsed - before;
  expect(state.transports).toHaveLength(1);
  expect(state.connections).toBe(1);
  // The one real session is still the only one, and still answers.
  expect((await request("/mcp", inSession("session-1"))).status).toBe(202);
  // The old code built a full server per request: several megabytes each.
  expect(grown).toBeLessThan(20 * 1024 * 1024);
});
