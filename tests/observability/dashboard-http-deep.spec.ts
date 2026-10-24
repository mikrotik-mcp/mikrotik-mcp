import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DashboardConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { runDashboard } from "../../src/observability/dashboard";

const state = vi.hoisted(() => ({
  options: null as null | { fetch: (req: Request, server: unknown) => Promise<Response> },
  latest: vi.fn(),
  releases: vi.fn(),
  capabilities: vi.fn(),
  invalidate: vi.fn(),
  probe: vi.fn(),
  closeDevice: vi.fn(),
}));

vi.mock("bun", () => ({
  serve: (options: typeof state.options) => {
    state.options = options;
    return {
      port: 9092,
      upgrade: () => false,
      requestIP: () => ({ address: "127.0.0.1" }),
      stop: vi.fn(),
    };
  },
}));
vi.mock("../../src/observability/store", () => ({
  openSqliteStore: async () => ({
    query: () => [],
    total: () => 0,
    get: () => null,
    delete: () => 0,
    clear: () => 0,
    close: vi.fn(),
  }),
}));
vi.mock("../../src/observability/health", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startHealthChecks: vi.fn(),
  stopHealthChecks: vi.fn(),
  probeDevice: state.probe,
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
}));
vi.mock("../../src/core/update-check", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLatestRelease: state.latest,
  fetchAllReleases: state.releases,
}));
vi.mock("../../src/core/capability-cache", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCapabilities: state.capabilities,
  invalidateCapabilities: state.invalidate,
}));
vi.mock("../../src/core/connection-pool", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  closeDevice: state.closeDevice,
}));

let original: ReturnType<typeof getConfig>;
let handle: Awaited<ReturnType<typeof runDashboard>>;
const server = { port: 9092, upgrade: () => false, requestIP: () => ({ address: "127.0.0.1" }) };

async function request(path: string, init?: RequestInit): Promise<Response> {
  if (!state.options) throw new Error("dashboard was not started");
  return state.options.fetch(new Request(`http://127.0.0.1:9092${path}`, init), server);
}

function post(path: string, body: unknown): Promise<Response> {
  return request(`${path}?token=deep-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  original = getConfig();
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  handle = await runDashboard(
    DashboardConfigSchema.parse({
      host: "127.0.0.1",
      port: 9092,
      dbPath: ":memory:",
      token: "deep-token",
    }),
    "deep-fixture",
  );
});

afterEach(() => {
  handle.stop();
  state.options = null;
  setConfig(original);
});

test("release routes return their upstream data and sanitize failures", async () => {
  state.latest.mockResolvedValue({ version: "1.4.4" });
  state.releases.mockResolvedValue([{ version: "1.4.4" }, { version: "1.4.3" }]);
  expect(await (await request("/api/releases/latest?token=deep-token")).json()).toEqual({
    version: "1.4.4",
  });
  expect(await (await request("/api/releases?token=deep-token")).json()).toEqual([
    { version: "1.4.4" },
    { version: "1.4.3" },
  ]);

  state.latest.mockRejectedValue(new Error("registry unavailable\nsecret second line"));
  state.releases.mockRejectedValue(new Error("release feed unavailable\nsecret second line"));
  const latest = await request("/api/releases/latest?token=deep-token");
  const releases = await request("/api/releases?token=deep-token");
  expect(latest.status).toBe(502);
  expect(await latest.json()).toEqual({ error: "registry unavailable" });
  expect(releases.status).toBe(502);
  expect(await releases.json()).toEqual({ error: "release feed unavailable" });
});

test("capability refresh invalidates the selected cache and returns a sanitized probe error", async () => {
  state.capabilities.mockResolvedValue({
    version: null,
    channel: "stable",
    board: "fixture",
    arch: "arm64",
    isRouterBoard: true,
    packages: new Set(["routeros"]),
    wirelessStack: "none",
    deviceMode: null,
    probedAt: 123,
  });
  const success = await post("/api/capabilities/refresh", { device: "fixture" });
  expect(success.status).toBe(200);
  expect(await success.json()).toMatchObject({
    device: "fixture",
    capabilities: { packages: ["routeros"], board: "fixture", probedAt: 123 },
  });
  expect(state.invalidate).toHaveBeenCalledWith("fixture");
  expect(state.capabilities).toHaveBeenCalledWith("fixture");

  state.capabilities.mockRejectedValue(new Error("probe denied\nprivate detail"));
  const failed = await post("/api/capabilities/refresh", { device: "fixture" });
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "probe denied" });
  expect(state.invalidate).toHaveBeenCalledTimes(2);
});

test("device test probes once while reconnect closes the pooled connection first", async () => {
  state.probe.mockResolvedValue({ reachable: true });
  const tested = await post("/api/devices/test", { device: "fixture" });
  expect(tested.status).toBe(200);
  expect(await tested.json()).toMatchObject({ ok: true, status: { reachable: true } });
  expect(state.probe).toHaveBeenCalledWith("fixture", getConfig().devices.fixture);
  expect(state.closeDevice).not.toHaveBeenCalled();

  const reconnected = await post("/api/devices/reconnect", { device: "fixture" });
  expect(reconnected.status).toBe(200);
  expect(await reconnected.json()).toMatchObject({ ok: true, status: { reachable: true } });
  expect(state.closeDevice).toHaveBeenCalledExactlyOnceWith("fixture");
  expect(state.probe).toHaveBeenCalledTimes(2);

  const missing = await post("/api/devices/reconnect", {});
  expect(missing.status).toBe(404);
  expect(state.closeDevice).toHaveBeenCalledTimes(1);
  expect(state.probe).toHaveBeenCalledTimes(2);
});
