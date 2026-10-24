import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DashboardConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { runDashboard } from "../../src/observability/dashboard";

const state = vi.hoisted(() => ({
  options: null as null | { fetch: (req: Request, server: unknown) => Promise<Response> },
  rows: [] as Record<string, unknown>[],
}));

vi.mock("bun", () => ({
  serve: (options: typeof state.options) => {
    state.options = options;
    return {
      port: 9091,
      upgrade: () => false,
      requestIP: () => ({ address: "127.0.0.1" }),
      stop: vi.fn(),
    };
  },
}));

vi.mock("../../src/observability/store", () => ({
  openSqliteStore: async () => ({
    query: (filter: { limit?: number; offset?: number; tool?: string }) =>
      state.rows
        .filter((row) => !filter.tool || row.tool === filter.tool)
        .slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100)),
    total: () => state.rows.length,
    get: (id: string) => state.rows.find((row) => row.id === id) ?? null,
    delete: (ids: string[]) => {
      const before = state.rows.length;
      state.rows = state.rows.filter((row) => !ids.includes(String(row.id)));
      return before - state.rows.length;
    },
    clear: () => {
      const before = state.rows.length;
      state.rows = [];
      return before;
    },
    close: vi.fn(),
  }),
}));
vi.mock("../../src/observability/health", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startHealthChecks: vi.fn(),
  stopHealthChecks: vi.fn(),
}));
vi.mock("../../src/observability/geo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startGeoLookups: vi.fn(),
  stopGeoLookups: vi.fn(),
}));
vi.mock("../../src/observability/openvpn-history", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openOpenVpnHistory: async () => {
    throw new Error("optional store disabled in fixture");
  },
}));
vi.mock("../../src/observability/usage-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openUsageStore: async () => {
    throw new Error("optional store disabled in fixture");
  },
}));
vi.mock("../../src/observability/capsman-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openCapsmanStore: async () => {
    throw new Error("optional store disabled in fixture");
  },
}));
vi.mock("../../src/observability/config-history", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEmpty: () => false,
}));

let original: ReturnType<typeof getConfig>;
let handle: Awaited<ReturnType<typeof runDashboard>>;
const server = {
  port: 9091,
  upgrade: () => false,
  requestIP: () => ({ address: "127.0.0.1" }),
};

async function request(path: string, init?: RequestInit) {
  if (!state.options) throw new Error("dashboard was not started");
  return state.options.fetch(new Request(`http://127.0.0.1:9091${path}`, init), server);
}

beforeEach(async () => {
  original = getConfig();
  state.rows = [];
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  handle = await runDashboard(
    DashboardConfigSchema.parse({
      host: "127.0.0.1",
      port: 9091,
      dbPath: ":memory:",
      token: "test-token",
    }),
    "fixture-transport",
  );
});
afterEach(() => {
  handle.stop();
  state.options = null;
  setConfig(original);
});

test("health is public while API requests require a valid token", async () => {
  expect(await (await request("/health")).text()).toBe("OK");
  expect((await request("/api/events")).status).toBe(401);
  expect((await request("/api/events?token=wrong")).status).toBe(401);
  const accepted = await request("/api/events", {
    headers: { authorization: "Bearer test-token" },
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ events: [], total: 0 });
});

test("event API filters, pages, looks up and deletes only selected records", async () => {
  state.rows = [
    { id: "a", tool: "ping", ts: 1, device: "fixture", durationMs: 4, isError: false },
    { id: "b", tool: "list_users", ts: 2, device: "fixture", durationMs: 6, isError: true },
    { id: "c", tool: "ping", ts: 3, device: "fixture", durationMs: 8, isError: false },
  ];
  const filtered = await request("/api/events?token=test-token&tool=ping&limit=1&offset=1");
  expect(
    ((await filtered.json()) as { events: { id: string }[] }).events.map((row) => row.id),
  ).toEqual(["c"]);
  expect((await request("/api/event/b?token=test-token")).status).toBe(200);
  expect((await request("/api/event/missing?token=test-token")).status).toBe(404);
  const deleted = await request("/api/events?token=test-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["b", 123, "unknown"] }),
  });
  expect(await deleted.json()).toEqual({ removed: 1, total: 2 });
  expect((await request("/api/event/b?token=test-token")).status).toBe(404);
});

test("catalog and metadata describe the actual registered tool set", async () => {
  const catalog = (await (await request("/api/catalog?token=test-token")).json()) as {
    counts: { modules: number; tools: number };
    modules: { tools: { name: string }[] }[];
  };
  expect(catalog.counts.modules).toBe(catalog.modules.length);
  expect(catalog.counts.tools).toBe(catalog.modules.reduce((n, m) => n + m.tools.length, 0));
  expect(catalog.modules.flatMap((m) => m.tools).some((tool) => tool.name === "list_users")).toBe(
    true,
  );
  const meta = (await (await request("/api/meta?token=test-token")).json()) as {
    transport: string;
    total: number;
  };
  expect(meta.transport).toBe("fixture-transport");
  expect(meta.total).toBe(0);
});

test("device mutation validation rejects unknown and malformed targets", async () => {
  const malformed = await request("/api/devices/toggle?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: "fixture", disabled: "yes" }),
  });
  expect(malformed.status).toBe(400);
  const unknown = await request("/api/devices/toggle?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: "not-configured", disabled: true }),
  });
  expect(unknown.status).toBe(404);
  expect(getConfig().devices.fixture.disabled).toBeUndefined();
});

test("dashboard reads current fleet and connection-pool state without probing routers", async () => {
  const devices = (await (await request("/api/devices?token=test-token")).json()) as {
    devices: { name: string; host: string }[];
  };
  expect(devices.devices.map((device) => device.name)).toEqual(["fixture"]);
  expect(devices.devices[0].host).toBe("192.0.2.1");

  const pool = (await (await request("/api/ssh-pool?token=test-token")).json()) as {
    aggregate: { totalConnections: number };
  };
  expect(pool.aggregate.totalConnections).toBe(0);

  const capabilities = (await (await request("/api/capabilities?token=test-token")).json()) as {
    devices: { device: string }[];
  };
  expect(capabilities.devices.map((entry) => entry.device)).toEqual(["fixture"]);
});

test("capability and device probes fail closed for an unknown device", async () => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ device: "unknown" });
  const capabilities = await request("/api/capabilities/refresh?token=test-token", {
    method: "POST",
    headers,
    body,
  });
  expect(capabilities.status).toBe(404);
  expect(await capabilities.json()).toEqual({ error: "unknown device: unknown" });

  const device = await request("/api/devices/test?token=test-token", {
    method: "POST",
    headers,
    body,
  });
  expect(device.status).toBe(404);
});

test("statistics use the selected time window and absent routes return 404", async () => {
  const stats = await request("/api/stats?token=test-token&window=60000&buckets=6");
  expect(stats.status).toBe(200);
  const data = (await stats.json()) as Record<string, unknown>;
  expect(data).toHaveProperty("total");
  expect((await request("/api/missing?token=test-token")).status).toBe(404);
});

test("invalid upgrade versions and failed WebSocket upgrades cannot change the host", async () => {
  const upgrade = await request("/api/upgrade?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.3; reboot" }),
  });
  expect(upgrade.status).toBe(400);
  expect(((await upgrade.json()) as { error: string }).error).toContain("Invalid version");

  const stream = await request("/api/stream?token=test-token");
  expect(stream.status).toBe(400);
  expect(await stream.text()).toContain("upgrade failed");
});

test("authorization also protects the dashboard document and non-event APIs", async () => {
  expect((await request("/")).status).toBe(401);
  expect((await request("/api/config")).status).toBe(401);
  expect((await request("/api/topology")).status).toBe(401);
  const page = await request("/?token=test-token");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const config = await request("/api/config?token=test-token");
  expect(config.status).toBe(200);
  expect((await config.json()) as Record<string, unknown>).not.toHaveProperty("password");
});

test("event deletion handles malformed selections and explicit clear-all independently", async () => {
  state.rows = [
    { id: "first", tool: "ping" },
    { id: "second", tool: "ping" },
  ];
  const invalid = await request("/api/events?token=test-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "not-json",
  });
  expect(await invalid.json()).toEqual({ removed: 0, total: 2 });
  const ignored = await request("/api/events?token=test-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [44, null] }),
  });
  expect(await ignored.json()).toEqual({ removed: 0, total: 2 });
  const all = await request("/api/events?token=test-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ all: true, ids: ["first"] }),
  });
  expect(await all.json()).toEqual({ removed: 2, total: 0 });
});

test("specific event ids are URL-decoded while invalid flags and missing stream device fail closed", async () => {
  state.rows = [{ id: "call/one", tool: "ping" }];
  const event = await request("/api/event/call%2Fone?token=test-token");
  expect(((await event.json()) as { id: string }).id).toBe("call/one");
  expect((await request("/api/flag/INVALID.svg?token=test-token")).status).toBe(404);
  const stream = await request("/api/interfaces/stream?token=test-token");
  expect(stream.status).toBe(400);
  expect(await stream.json()).toEqual({ error: "device required" });
});

test("capability refresh validates the body before asking for a device probe", async () => {
  const response = await request("/api/capabilities/refresh?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: 123 }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "device (string) is required" });
});

test("configuration schema and module inventory are readable without device I/O", async () => {
  const schema = await request("/api/config-schema?token=test-token");
  expect(schema.status).toBe(200);
  expect(await schema.json()).toBeTypeOf("object");
  const modules = await request("/api/modules?token=test-token");
  expect(modules.status).toBe(200);
  expect(await modules.json()).toBeTypeOf("object");
});

test("backup vault exposes inventory but rejects incomplete mutations", async () => {
  const inventory = await request("/api/backups?token=test-token");
  expect(inventory.status).toBe(200);
  const body = (await inventory.json()) as { devices: string[]; backups: unknown[] };
  expect(body.devices).toContain("fixture");
  expect(Array.isArray(body.backups)).toBe(true);
  const requests: [string, Record<string, unknown>, string][] = [
    ["/api/backups/dir", {}, "dir required"],
    ["/api/backups/upload", { name: "test" }, "name and content"],
    ["/api/backups/rename", { name: "test.rsc" }, "name and new_name"],
    ["/api/backups/delete", {}, "name required"],
    ["/api/backups/restore", {}, "name required"],
  ];
  for (const [path, payload, message] of requests) {
    const response = await request(`${path}?token=test-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(message);
  }
  expect((await request("/api/backups/get?token=test-token")).status).toBe(400);
  expect((await request("/api/backups/raw?token=test-token")).status).toBe(400);
});

test("unconfigured S3 paths fail closed without attempting remote writes", async () => {
  for (const path of ["/api/s3", "/api/s3/list"]) {
    const response = await request(`${path}?token=test-token`);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeTypeOf("object");
  }
  const presign = await request("/api/s3/presign?token=test-token&key=fixture");
  expect(presign.status).toBe(400);
  expect(((await presign.json()) as { error: string }).error).toContain("S3 not configured");
  const deleted = await request("/api/s3/delete?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "fixture" }),
  });
  expect(deleted.status).toBe(400);
  expect(((await deleted.json()) as { error: string }).error).toContain("S3 not configured");
});

test("configuration studio previews a scoped draft without persisting or exposing secrets", async () => {
  const body = JSON.stringify({ devices: { fixture: { host: "198.51.100.10" } } });
  const preview = await request("/api/config/preview?scope=devices&token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(preview.status).toBe(200);
  const diff = (await preview.json()) as { unified: string; summary: Record<string, number> };
  expect(diff.unified).toContain("198.51.100.10");
  expect(diff.unified).toContain("192.0.2.1");
  expect(getConfig().devices.fixture.host).toBe("192.0.2.1");
  const invalidScope = await request("/api/config/preview?scope=everything&token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(invalidScope.status).toBe(400);
  expect(await invalidScope.json()).toEqual({ ok: false, error: "Unknown configuration scope" });
});

test("config test-device requires a target and validates draft before probing", async () => {
  const empty = await request("/api/config/test-device?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "draft", config: {} }),
  });
  expect(empty.status).toBe(400);
  expect(((await empty.json()) as { error: string }).error).toContain("Host / IP or MAC");
  const invalid = await request("/api/config/test-device?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "draft", config: { host: "192.0.2.2", port: -1 } }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toHaveProperty("errors");
});

test("configuration history rejects missing and unknown ids before any restore", async () => {
  const readPaths = ["/api/config/history/get", "/api/config/history/diff"];
  for (const path of readPaths) {
    const missing = await request(`${path}?token=test-token`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "id required" });
    const unknown = await request(`${path}?id=not-a-snapshot&token=test-token`);
    expect(unknown.status).toBe(404);
  }
  for (const path of ["/api/config/history/restore", "/api/config/history/delete"]) {
    const missing = await request(`${path}?token=test-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(400);
  }
  const history = await request("/api/config/history?token=test-token");
  expect(history.status).toBe(200);
  expect(await history.json()).toHaveProperty("versions");
});

test("module mutations reject malformed and unknown names while inventory stays available", async () => {
  for (const body of [
    { slug: 1, enabled: true },
    { slug: "not-a-module", enabled: true },
  ]) {
    const response = await request("/api/modules/toggle?token=test-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(typeof body.slug === "number" ? 400 : 404);
  }
  const inventory = await request("/api/modules?token=test-token");
  expect(inventory.status).toBe(200);
});

test("capture studio serves empty status, packet ring and a valid pcap header without binding a port", async () => {
  const status = await request("/api/capture/status?token=test-token");
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ running: false, packets: 0 });
  const packets = await request("/api/capture/packets?limit=5&token=test-token");
  expect(await packets.json()).toMatchObject({ packets: [], stats: { running: false } });
  const pcap = await request("/api/capture/pcap?token=test-token");
  expect(pcap.headers.get("content-type")).toContain("application/vnd.tcpdump.pcap");
  expect((await pcap.arrayBuffer()).byteLength).toBe(24);
});

test("read-only dashboard routes reject missing device and invalid identifiers before router I/O", async () => {
  for (const path of [
    "/api/capsman/manager",
    "/api/clients/traffic",
    "/api/usage/client",
    "/api/usage/um-user",
  ]) {
    const response = await request(`${path}?token=test-token`);
    expect([400, 503]).toContain(response.status);
  }
  const invalidModule = await request("/api/modules/app-views?token=test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  expect(invalidModule.status).toBe(400);
  expect(getConfig().mcp.appViews).toBeDefined();
});
