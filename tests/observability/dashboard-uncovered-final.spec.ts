import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DashboardConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { runDashboard } from "../../src/observability/dashboard";

const fixture = vi.hoisted(() => ({
  options: null as null | { fetch: (req: Request, server: unknown) => Promise<Response> },
  versions: new Map<string, { ts: number; kind: string; label?: string; config: unknown }>(),
  write: vi.fn(),
  fetchDevices: vi.fn(),
  sample: vi.fn(),
  traffic: vi.fn(),
  operation: vi.fn(),
  aaa: vi.fn(),
  capsman: vi.fn(),
}));

vi.mock("bun", () => ({
  serve: (options: typeof fixture.options) => {
    fixture.options = options;
    return {
      port: 9109,
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
}));
vi.mock("../../src/observability/geo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startGeoLookups: vi.fn(),
  stopGeoLookups: vi.fn(),
}));
vi.mock("../../src/observability/openvpn-history", () => ({
  openOpenVpnHistory: async () => {
    throw new Error("offline");
  },
}));
vi.mock("../../src/observability/usage-store", () => ({
  openUsageStore: async () => {
    throw new Error("offline");
  },
}));
vi.mock("../../src/observability/capsman-store", () => ({
  openCapsmanStore: async () => {
    throw new Error("offline");
  },
}));
vi.mock("../../src/config-write", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  atomicWrite: fixture.write,
}));
vi.mock("../../src/observability/config-history", () => ({
  AUTO_RETENTION: 50,
  isEmpty: () => false,
  historyBytes: () => 128,
  listVersions: () =>
    [...fixture.versions].map(([id, v]) => ({
      id,
      ts: v.ts,
      kind: v.kind,
      label: v.label,
      bytes: 64,
    })),
  readVersion: (id: string) => {
    const v = fixture.versions.get(id);
    if (!v) throw new Error("missing");
    return v;
  },
  recordVersion: (config: unknown, kind: string, ts: number, label?: string) => {
    const id = `v${ts + fixture.versions.size}`;
    fixture.versions.set(id, { ts, kind, label, config });
    return { id, ts, kind, label, bytes: 64 };
  },
  deleteVersion: (id: string) => fixture.versions.delete(id),
}));
vi.mock("../../src/tools/connected-devices", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchDevices: fixture.fetchDevices,
  devicesView: (data: unknown) => ({ rows: data }),
  sampleDeviceTraffic: fixture.sample,
  setDeviceLimits: fixture.operation,
  blockDevice: fixture.operation,
  allowDevice: fixture.operation,
  makeDeviceStatic: fixture.operation,
  removeDeviceLease: fixture.operation,
  setDeviceIp: fixture.operation,
  setDeviceLabel: fixture.operation,
}));
vi.mock("../../src/observability/traffic-hub", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTrafficSample: fixture.traffic,
}));
vi.mock("../../src/tools/aaa-data", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRadiusIncoming: fixture.aaa,
  getUmSettings: fixture.aaa,
  listAaaEntity: fixture.aaa,
  setRadiusIncoming: fixture.aaa,
  setUmSettings: fixture.aaa,
  resetRadiusCounters: fixture.aaa,
  addAaaEntity: fixture.aaa,
  updateAaaEntity: fixture.aaa,
  removeAaaEntity: fixture.aaa,
  toggleAaaEntity: fixture.aaa,
}));
vi.mock("../../src/utils/wifi-query", () => ({ fetchCapsmanState: fixture.capsman }));
vi.mock("../../src/observability/capsman-manager", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCapsmanManagers: fixture.capsman,
  setCapsmanManager: fixture.capsman,
}));

let original: ReturnType<typeof getConfig>;
let handle: Awaited<ReturnType<typeof runDashboard>>;
const server = { port: 9109, upgrade: () => false, requestIP: () => ({ address: "127.0.0.1" }) };

async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  if (!fixture.options) throw new Error("dashboard not started");
  const url = `http://127.0.0.1:9109${path}${path.includes("?") ? "&" : "?"}token=final-token`;
  return fixture.options.fetch(
    new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    server,
  );
}

beforeEach(async () => {
  original = getConfig();
  vi.clearAllMocks();
  fixture.versions.clear();
  fixture.fetchDevices.mockResolvedValue([{ mac: "02:00:00:00:00:01" }]);
  fixture.sample.mockResolvedValue({ rx: 12, tx: 23 });
  fixture.traffic.mockResolvedValue({ sampled: true });
  fixture.operation.mockResolvedValue({ ok: true, message: "applied" });
  fixture.aaa.mockResolvedValue({ ok: true, rows: [] });
  fixture.capsman.mockResolvedValue({ path: "/caps-man", clients: [], radios: [] });
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  handle = await runDashboard(
    DashboardConfigSchema.parse({
      host: "127.0.0.1",
      port: 9109,
      dbPath: ":memory:",
      token: "final-token",
    }),
    "final-fixture",
  );
});

afterEach(() => {
  handle.stop();
  fixture.options = null;
  setConfig(original);
});

test("config history lists drift, checkpoints, retrieves, diffs and deletes snapshots", async () => {
  fixture.versions.set("v1", {
    ts: 1,
    kind: "checkpoint",
    label: "before edit",
    config: { ...getConfig(), defaultDevice: "other" },
  });
  fixture.versions.set("v2", { ts: 2, kind: "auto", config: getConfig() });
  const list = (await (await request("/api/config/history")).json()) as {
    versions: { drift: { added: number } }[];
    bytes: number;
    retention: number;
  };
  expect(list).toMatchObject({ bytes: 128, retention: 50 });
  expect(list.versions).toHaveLength(2);
  expect(list.versions[0].drift.added).toBeGreaterThan(0);
  expect((await request("/api/config/history/get")).status).toBe(400);
  expect((await request("/api/config/history/get?id=missing")).status).toBe(404);
  expect(await (await request("/api/config/history/get?id=v1")).json()).toMatchObject({
    label: "before edit",
  });
  expect((await request("/api/config/history/diff")).status).toBe(400);
  expect((await request("/api/config/history/diff?id=missing")).status).toBe(404);
  expect(await (await request("/api/config/history/diff?id=v1")).json()).toHaveProperty("unified");
  const checkpoint = (await (
    await request("/api/config/history/checkpoint", "POST", { label: "  release gate  " })
  ).json()) as { version: { label: string } };
  expect(checkpoint.version.label).toBe("release gate");
  expect((await request("/api/config/history/delete", "POST", {})).status).toBe(400);
  expect((await request("/api/config/history/delete", "POST", { id: "missing" })).status).toBe(404);
  expect(await (await request("/api/config/history/delete", "POST", { id: "v2" })).json()).toEqual({
    ok: true,
  });
});

test("config restore validates ids and restores a snapshot despite persistence failure", async () => {
  expect((await request("/api/config/history/restore", "POST", {})).status).toBe(400);
  expect((await request("/api/config/history/restore", "POST", { id: "missing" })).status).toBe(
    404,
  );
  fixture.versions.set("invalid", {
    ts: 1,
    kind: "auto",
    config: { ...getConfig(), devices: { fixture: { host: "192.0.2.1", port: -1 } } },
  });
  expect((await request("/api/config/history/restore", "POST", { id: "invalid" })).status).toBe(
    400,
  );
  fixture.versions.set("valid", {
    ts: 2,
    kind: "checkpoint",
    label: "known good",
    config: getConfig(),
  });
  fixture.write.mockImplementationOnce(() => {
    throw new Error("read only");
  });
  expect(
    await (await request("/api/config/history/restore", "POST", { id: "valid" })).json(),
  ).toMatchObject({ ok: true, persisted: false, restored: "valid" });
  expect([...fixture.versions.values()].some((v) => v.label === 'restored "known good"')).toBe(
    true,
  );
});

test("client routes validate targets and return refreshed views only after successful mutations", async () => {
  expect(await (await request("/api/clients")).json()).toEqual({
    rows: [{ mac: "02:00:00:00:00:01" }],
  });
  expect((await request("/api/clients/traffic")).status).toBe(400);
  expect(await (await request("/api/clients/traffic?ip=192.0.2.3")).json()).toEqual({
    rx: 12,
    tx: 23,
  });
  expect(await (await request("/api/clients/traffic-bulk?device=fixture")).json()).toEqual({
    sampled: true,
  });
  expect(fixture.traffic).toHaveBeenCalledWith("fixture");
  expect((await request("/api/clients/limits", "POST", {})).status).toBe(400);
  expect(
    await (
      await request("/api/clients/limits", "POST", { ip: "192.0.2.3", download: "2M" })
    ).json(),
  ).toMatchObject({ ok: true });
  expect((await request("/api/clients/block", "POST", {})).status).toBe(400);
  expect((await request("/api/clients/set-ip", "POST", { mac: "02:00:00:00:00:01" })).status).toBe(
    400,
  );
  expect((await request("/api/clients/label", "POST", { mac: "02:00:00:00:00:01" })).status).toBe(
    400,
  );
  for (const path of ["block", "allow", "pin", "remove", "set-ip", "label"]) {
    const response = await request(`/api/clients/${path}`, "POST", {
      mac: "02:00:00:00:00:01",
      ip: "192.0.2.3",
      label: "printer",
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      view: { rows: [{ mac: "02:00:00:00:00:01" }] },
    });
  }
  fixture.operation.mockResolvedValueOnce({ ok: false, message: "rejected" });
  expect(
    await (await request("/api/clients/block", "POST", { mac: "02:00:00:00:00:01" })).json(),
  ).toEqual({ ok: false, message: "rejected" });
});

test("AAA routes handle metadata, unknown entities, reads, writes and missing ids", async () => {
  const entities = (await (await request("/api/aaa/entities")).json()) as {
    entities: Record<string, unknown>;
  };
  const slug = Object.keys(entities.entities)[0];
  expect(slug).toBeTruthy();
  expect((await request("/api/aaa/list/no-such-entity")).status).toBe(404);
  expect((await request("/api/aaa/add", "POST", { slug: "missing" })).status).toBe(404);
  for (const path of ["radius-incoming", "um-settings", `list/${slug}`]) {
    expect(await (await request(`/api/aaa/${path}?device=fixture`)).json()).toMatchObject({
      ok: true,
    });
  }
  for (const path of ["radius-incoming", "um-settings", "radius-reset-counters"]) {
    expect(
      await (await request(`/api/aaa/${path}`, "POST", { fields: { enabled: "yes" } })).json(),
    ).toMatchObject({ ok: true });
  }
  for (const path of ["update", "remove", "toggle"]) {
    expect((await request(`/api/aaa/${path}`, "POST", { slug })).status).toBe(400);
  }
  for (const path of ["add", "update", "remove", "toggle"]) {
    expect(
      await (
        await request(`/api/aaa/${path}`, "POST", {
          slug,
          id: "*1",
          fields: { name: "alice" },
          enable: true,
        })
      ).json(),
    ).toMatchObject({ ok: true });
  }
  expect(fixture.aaa).toHaveBeenCalled();
});

test("CAPsMAN manager and apply routes validate requests without device writes", async () => {
  expect((await request("/api/capsman/manager")).status).toBe(400);
  expect(await (await request("/api/capsman/manager?device=fixture")).json()).toMatchObject({
    device: "fixture",
  });
  expect((await request("/api/capsman/manager", "POST", {})).status).toBe(400);
  expect((await request("/api/capsman/manager", "PUT")).status).toBe(405);
  expect(
    (await request("/api/capsman/apply/steer", "POST", { mac: "02:00:00:00:00:01" })).status,
  ).toBe(400);
  expect((await request("/api/capsman/apply/channel-plan", "POST", {})).status).toBe(400);
  expect((await request("/api/capsman/trends")).status).toBe(503);
});
