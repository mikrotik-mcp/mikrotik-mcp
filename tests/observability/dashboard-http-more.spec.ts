import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DashboardConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { runDashboard } from "../../src/observability/dashboard";
import { moduleCatalog } from "../../src/tools";

const fixture = vi.hoisted(() => ({
  options: null as null | { fetch: (req: Request, server: unknown) => Promise<Response> },
  rows: [] as {
    id: string;
    tool: string;
    device?: string;
    ts: number;
    durationMs: number;
    isError: boolean;
    risk?: string;
  }[],
  filters: [] as Record<string, unknown>[],
  writes: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("bun", () => ({
  serve: (options: typeof fixture.options) => {
    fixture.options = options;
    return {
      port: 9093,
      upgrade: () => false,
      requestIP: () => ({ address: "127.0.0.1" }),
      stop: vi.fn(),
    };
  },
}));
vi.mock("../../src/config-write", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  atomicWrite: fixture.writes,
}));
vi.mock("../../src/observability/store", () => ({
  openSqliteStore: async () => ({
    query: (filter: Record<string, unknown>) => {
      fixture.filters.push(filter);
      return fixture.rows
        .filter(
          (row) =>
            (!filter.tool || row.tool === filter.tool) &&
            (!filter.device || row.device === filter.device) &&
            (!filter.status || (filter.status === "error") === row.isError),
        )
        .slice(
          Number(filter.offset ?? 0),
          Number(filter.offset ?? 0) + Number(filter.limit ?? 100),
        );
    },
    total: () => fixture.rows.length,
    get: (id: string) => fixture.rows.find((row) => row.id === id) ?? null,
    delete: (ids: string[]) => {
      const previous = fixture.rows.length;
      fixture.rows = fixture.rows.filter((row) => !ids.includes(row.id));
      return previous - fixture.rows.length;
    },
    clear: () => {
      const count = fixture.rows.length;
      fixture.rows = [];
      return count;
    },
    close: vi.fn(),
  }),
}));
vi.mock("../../src/observability/health", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startHealthChecks: vi.fn(),
  stopHealthChecks: vi.fn(),
  probeDevice: fixture.probe,
}));
vi.mock("../../src/observability/geo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startGeoLookups: vi.fn(),
  stopGeoLookups: vi.fn(),
}));
vi.mock("../../src/observability/openvpn-history", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openOpenVpnHistory: async () => {
    throw new Error("fixture disabled");
  },
}));
vi.mock("../../src/observability/usage-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openUsageStore: async () => {
    throw new Error("fixture disabled");
  },
}));
vi.mock("../../src/observability/capsman-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openCapsmanStore: async () => {
    throw new Error("fixture disabled");
  },
}));
vi.mock("../../src/observability/config-history", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEmpty: () => false,
  recordVersion: vi.fn(),
}));

let original: ReturnType<typeof getConfig>;
let handle: Awaited<ReturnType<typeof runDashboard>>;
const server = { port: 9093, upgrade: () => false, requestIP: () => ({ address: "127.0.0.1" }) };

async function request(path: string, init?: RequestInit): Promise<Response> {
  if (!fixture.options) throw new Error("dashboard not started");
  return fixture.options.fetch(new Request(`http://127.0.0.1:9093${path}`, init), server);
}

function post(path: string, body: unknown): Promise<Response> {
  return request(`${path}${path.includes("?") ? "&" : "?"}token=more-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  original = getConfig();
  fixture.rows = [];
  fixture.filters = [];
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        edge: { host: "192.0.2.10", port: 22, username: "admin", password: "private-password" },
        backup: { host: "192.0.2.11", port: 2222, disabled: true },
      },
      defaultDevice: "edge",
      memory: { enabled: false },
    }),
  );
  handle = await runDashboard(
    DashboardConfigSchema.parse({
      host: "127.0.0.1",
      port: 9093,
      dbPath: ":memory:",
      token: "more-token",
    }),
    "more-fixture",
  );
});

afterEach(() => {
  handle.stop();
  fixture.options = null;
  setConfig(original);
});

test("event query forwards every filter, normalizes invalid status, and keeps total unfiltered", async () => {
  fixture.rows = [
    { id: "a", tool: "ping", device: "edge", ts: 10, durationMs: 10, isError: false },
    { id: "b", tool: "ping", device: "edge", ts: 20, durationMs: 20, isError: true },
    { id: "c", tool: "other", device: "backup", ts: 30, durationMs: 30, isError: false },
  ];
  const filtered = await request(
    "/api/events?token=more-token&tool=ping&device=edge&risk=READ&status=error&q=fail&since=2&until=40&limit=5&offset=0",
  );
  expect(await filtered.json()).toEqual({ events: [fixture.rows[1]], total: 3 });
  expect(fixture.filters.at(-1)).toEqual({
    tool: "ping",
    device: "edge",
    risk: "READ",
    status: "error",
    q: "fail",
    since: 2,
    until: 40,
    limit: 5,
    offset: 0,
  });
  await request("/api/events?token=more-token&status=unknown&limit=&offset=");
  expect(fixture.filters.at(-1)).toMatchObject({
    status: undefined,
    limit: undefined,
    offset: undefined,
  });
});

test("metadata facets sort distinct tools and devices from the bounded event window", async () => {
  fixture.rows = [
    { id: "1", tool: "zeta", device: "backup", ts: 1, durationMs: 2, isError: false },
    { id: "2", tool: "alpha", device: "edge", ts: 2, durationMs: 3, isError: true },
    { id: "3", tool: "alpha", ts: 3, durationMs: 4, isError: false },
  ];
  const meta = (await (await request("/api/meta?token=more-token")).json()) as Record<
    string,
    unknown
  >;
  expect(meta).toMatchObject({
    tools: ["alpha", "zeta"],
    devices: ["backup", "edge"],
    total: 3,
    transport: "more-fixture",
  });
  expect(meta.risks).toContain("DESTRUCTIVE");
  expect(fixture.filters.at(-1)).toEqual({ limit: 5000 });
});

test("device cards aggregate errors, latency, last activity and redact credentials", async () => {
  fixture.rows = [
    { id: "1", tool: "ping", device: "edge", ts: 20, durationMs: 10, isError: false },
    { id: "2", tool: "ping", device: "edge", ts: 30, durationMs: 30, isError: true },
    { id: "3", tool: "ping", ts: 40, durationMs: 100, isError: true },
  ];
  const payload = (await (await request("/api/devices?token=more-token")).json()) as {
    defaultDevice: string;
    devices: {
      name: string;
      address: string;
      disabled: boolean;
      activity: Record<string, number>;
      authMode: string;
    }[];
  };
  expect(payload.defaultDevice).toBe("edge");
  expect(payload.devices[0]).toMatchObject({
    name: "edge",
    address: "192.0.2.10:22",
    authMode: "password",
    disabled: false,
    activity: { calls: 2, errors: 1, lastSeen: 30, avgMs: 20 },
  });
  expect(payload.devices[1]).toMatchObject({
    name: "backup",
    address: "192.0.2.11:2222",
    disabled: true,
    activity: { calls: 0, errors: 0, lastSeen: 0, avgMs: 0 },
  });
  expect(JSON.stringify(payload)).not.toContain("private-password");
  expect(fixture.probe).not.toHaveBeenCalled();
});

test("config response is complete and redacted; schema and validate remain offline", async () => {
  const config = (await (await request("/api/config?token=more-token")).json()) as Record<
    string,
    unknown
  >;
  expect(config).toHaveProperty("devices");
  expect(config).toHaveProperty("memory");
  expect(JSON.stringify(config)).not.toContain("private-password");
  const schema = (await (await request("/api/config-schema?token=more-token")).json()) as Record<
    string,
    unknown
  >;
  expect(schema).toMatchObject({ title: "MikrotikConfig" });
  const valid = (await (
    await post("/api/config/validate?scope=devices", {
      devices: { edge: { host: "198.51.100.4" } },
    })
  ).json()) as { ok: boolean };
  expect(valid.ok).toBe(true);
  expect(getConfig().devices.edge.host).toBe("192.0.2.10");
  expect(fixture.probe).not.toHaveBeenCalled();
});

test("config validation rejects unknown scope and invalid draft without applying it", async () => {
  const scope = await post("/api/config/validate?scope=bogus", {});
  expect(scope.status).toBe(400);
  expect(await scope.json()).toEqual({ ok: false, error: "Unknown configuration scope" });
  const invalid = await post("/api/config/validate?scope=devices", {
    devices: { edge: { port: -1 } },
  });
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toMatchObject({ ok: false });
  expect(getConfig().devices.edge.port).toBe(22);
  expect(fixture.writes).not.toHaveBeenCalled();
});

test("SSH key selection rejects foreign origin and cross-site fetch metadata", async () => {
  for (const headers of [
    new Headers({ origin: "https://evil.example" }),
    new Headers({ "sec-fetch-site": "cross-site" }),
  ]) {
    const response = await request("/api/config/ssh-keys?token=more-token", { headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "SSH key selection requires a same-origin dashboard request.",
    });
  }
});

test("device toggle applies live state and reports persistence failure without touching disk", async () => {
  fixture.writes.mockImplementationOnce(() => {
    throw new Error("read-only fixture");
  });
  const response = await post("/api/devices/toggle", { device: "edge", disabled: true });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    ok: boolean;
    persisted: boolean;
    requiresReconnect: boolean;
    devices: { name: string; disabled: boolean }[];
    warning: string;
  };
  expect(result).toMatchObject({ ok: true, persisted: false, requiresReconnect: true });
  expect(result.warning).toContain("read-only fixture");
  expect(result.devices.find((device) => device.name === "edge")?.disabled).toBe(true);
  expect(getConfig().devices.edge.disabled).toBe(true);
  expect(fixture.writes).toHaveBeenCalledTimes(1);
  expect(fixture.probe).not.toHaveBeenCalled();
});

test("device toggle can re-enable a saved disabled device", async () => {
  const response = await post("/api/devices/toggle", { device: "backup", disabled: false });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    persisted: true,
    requiresReconnect: true,
  });
  expect(getConfig().devices.backup.disabled).toBeUndefined();
  expect(fixture.writes).toHaveBeenCalledTimes(1);
});

test("memory settings are readable while disabled and memory operations fail closed", async () => {
  const config = await request("/api/memory/config?token=more-token");
  expect(config.status).toBe(200);
  expect(await config.json()).toMatchObject({ enabled: false, stats: null });
  const facts = await request("/api/memory/facts?token=more-token");
  expect(facts.status).toBe(503);
  expect(await facts.json()).toEqual({
    error: "Knowledge memory is disabled. Enable it in Memory settings.",
  });
});

test("memory settings reject unknown fields and accept a no-op update without persistence", async () => {
  const invalid = await post("/api/memory/config", { enabled: false, surprise: true });
  expect(invalid.status).toBe(400);
  const same = await post("/api/memory/config", { enabled: false });
  expect(same.status).toBe(200);
  expect(await same.json()).toMatchObject({ ok: true, enabled: false });
  expect(fixture.writes).not.toHaveBeenCalled();
});

test("config test-device probes only the validated draft with the supplied inventory", async () => {
  fixture.probe.mockResolvedValue({ reachable: true, identity: "draft-router" });
  const response = await post("/api/config/test-device", {
    name: "candidate",
    config: { host: "198.51.100.8", port: 2222 },
    devices: { edge: { host: "192.0.2.10" } },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    status: { reachable: true, identity: "draft-router" },
  });
  expect(fixture.probe).toHaveBeenCalledTimes(1);
  expect(fixture.probe).toHaveBeenCalledWith(
    "config-test:candidate",
    expect.objectContaining({ host: "198.51.100.8", port: 2222 }),
    expect.objectContaining({ candidate: expect.objectContaining({ host: "198.51.100.8" }) }),
  );
  expect(getConfig().devices).not.toHaveProperty("candidate");
});

test("config test-device rejects malformed inventory before probing", async () => {
  const response = await post("/api/config/test-device", {
    name: "candidate",
    config: { host: "198.51.100.8" },
    devices: { bad: { port: -1 } },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toHaveProperty("errors");
  expect(fixture.probe).not.toHaveBeenCalled();
});

test("module toggle resolves names case-insensitively and exposes persistence failure", async () => {
  const current = getConfig();
  setConfig({
    ...current,
    devices: { ...current.devices, backup: { ...current.devices.backup, disabled: undefined } },
  });
  const slug = moduleCatalog[0]?.slug;
  expect(slug).toBeTypeOf("string");
  fixture.writes.mockImplementationOnce(() => {
    throw new Error("read-only fixture");
  });
  const response = await post("/api/modules/toggle", { slug: slug?.toUpperCase(), enabled: false });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    persisted: false,
    requiresReconnect: true,
    slug,
    enabled: false,
  });
  expect(fixture.writes).toHaveBeenCalledTimes(1);
});

test("app views toggle updates runtime and reports a reconnect requirement", async () => {
  const response = await post("/api/modules/app-views", { enabled: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    persisted: true,
    requiresReconnect: true,
    appViews: true,
  });
  expect(getConfig().mcp.appViews).toBe(true);
  expect(fixture.writes).toHaveBeenCalledTimes(1);
});

test("memory settings keep previous runtime config when persistence fails", async () => {
  fixture.writes.mockImplementationOnce(() => {
    throw new Error("read-only fixture");
  });
  const prior = getConfig().memory.dbPath;
  const response = await post("/api/memory/config", { dbPath: "/tmp/unused-memory-test.db" });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "Could not persist memory configuration; the previous configuration is still active.",
  });
  expect(getConfig().memory.dbPath).toBe(prior);
  expect(fixture.writes).toHaveBeenCalledTimes(1);
});
