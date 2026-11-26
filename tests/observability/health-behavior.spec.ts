import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DeviceConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { endpointOptions, noteAnswered } from "../../src/core/device-endpoints";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getDeviceHistory,
  getDeviceNeighbors,
  getDeviceStatus,
  probeAll,
  probeDevice,
  startHealthChecks,
  stopHealthChecks,
} from "../../src/observability/health";

const mocks = vi.hoisted(() => ({ create: vi.fn(), alert: vi.fn() }));
vi.mock("../../src/core/transport", () => ({ createDeviceClient: mocks.create }));
vi.mock("../../src/alerts/engine", () => ({ emitAlertEvent: mocks.alert }));
const initial = getConfig();
const config = DeviceConfigSchema.parse({ host: "192.0.2.1", port: 22, timeoutMs: 20_000 });

function client(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(async () => true),
    run: vi.fn(
      async (command: string) =>
        ({
          "/system resource print":
            "version: 7.20\nboard-name: ax3\ncpu-load: 20%\ntotal-memory: 1024MiB\nfree-memory: 512MiB",
          "/system identity print": "name: fixture-router",
          "/ip neighbor print detail": "0 interface=ether1 identity=next-hop address=192.0.2.2",
          "/disk print detail": "",
        })[command] ?? "",
    ),
    disconnect: vi.fn(),
    connectedHost: "192.0.2.1",
    lastError: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(MikrotikConfigSchema.parse({ devices: { fixture: config }, defaultDevice: "fixture" }));
  mocks.create.mockImplementation(() => client());
});
afterEach(() => {
  stopHealthChecks();
  setConfig(initial);
});

test("successful probe reads resources first, then optional identity, neighbors and disks", async () => {
  const fake = client();
  mocks.create.mockReturnValue(fake);
  const result = await probeDevice("fixture", config);
  expect(result).toMatchObject({
    reachable: true,
    connectedHost: "192.0.2.1",
    identity: "fixture-router",
    version: "7.20",
    cpuLoad: 20,
    memUsedPct: 50,
  });
  expect(fake.run.mock.calls.map(([command]) => command)).toEqual([
    "/system resource print",
    "/system identity print",
    "/ip neighbor print detail",
    "/disk print detail",
  ]);
  expect(mocks.create.mock.calls[0][0].timeoutMs).toBe(20_000);
  expect(getDeviceStatus("fixture")).toEqual(result);
  expect(getDeviceHistory("fixture").at(-1)).toMatchObject({ cpuLoad: 20, memUsedPct: 50 });
  expect(getDeviceNeighbors("fixture")).toHaveLength(1);
  expect(fake.disconnect).toHaveBeenCalledOnce();
});

test("optional read failures preserve reachable state and cached topology", async () => {
  const fake = client({
    run: vi.fn(async (command: string) => {
      if (command === "/system resource print") return "version: 7.20\ncpu-load: 5%";
      throw new Error("secondary read failed");
    }),
  });
  mocks.create.mockReturnValue(fake);
  const result = await probeDevice("fixture", config);
  expect(result).toMatchObject({ reachable: true, version: "7.20", cpuLoad: 5 });
  expect(getDeviceNeighbors("fixture")).toHaveLength(1);
  expect(fake.disconnect).toHaveBeenCalledOnce();
});

test("failed connection and thrown probe both record offline state, with transition-only alerts", async () => {
  const unavailable = client({ connect: vi.fn(async () => false), lastError: "denied" });
  mocks.create.mockReturnValue(unavailable);
  expect(await probeDevice("fixture", config)).toMatchObject({ reachable: false, error: "denied" });
  expect(mocks.alert).toHaveBeenCalledWith(
    expect.objectContaining({ to: "offline", device: "fixture" }),
  );
  const count = mocks.alert.mock.calls.length;
  await probeDevice("fixture", config);
  expect(mocks.alert).toHaveBeenCalledTimes(count);
  mocks.create.mockReturnValue(client());
  expect(await probeDevice("fixture", config)).toMatchObject({ reachable: true });
  expect(mocks.alert).toHaveBeenLastCalledWith(expect.objectContaining({ to: "online" }));
  mocks.create.mockReturnValue(
    client({
      connect: vi.fn(async () => {
        throw new Error("timeout");
      }),
    }),
  );
  expect(await probeDevice("fixture", config)).toMatchObject({
    reachable: false,
    error: "timeout",
  });
});

test("fleet probe reads configured devices without changing their configuration", async () => {
  await probeAll();
  expect(mocks.create).toHaveBeenCalled();
  expect(getDeviceStatus("fixture").reachable).toBe(true);
});

test("a command that returns after a failed probe marks the router reachable at once", async () => {
  const dc = getConfig().devices.fixture;
  mocks.create.mockReturnValue(client({ connect: vi.fn(async () => false), lastError: "slow" }));

  // An open session is not enough: it can open and never answer.
  const release = endpointOptions(dc, "ssh", 22).onConnected!("192.0.2.9");
  expect(await probeDevice("fixture", dc)).toMatchObject({ reachable: false, error: "slow" });
  expect(getDeviceStatus("fixture")).toMatchObject({ reachable: false });
  release();

  await new Promise((resolve) => setTimeout(resolve, 5));
  noteAnswered(dc);
  expect(getDeviceStatus("fixture")).toMatchObject({ reachable: true, error: undefined });

  // The next failed probe is newer than that command, so it stands.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await probeDevice("fixture", dc)).toMatchObject({ reachable: false });
});

test("a router whose probe is still running is skipped, the others are probed", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { slow: { host: "192.0.2.20" }, quick: { host: "192.0.2.21" } },
      defaultDevice: "slow",
    }),
  );
  let finish = (): void => {};
  mocks.create.mockImplementation((dc: { host: string }) =>
    dc.host === "192.0.2.20"
      ? client({ connect: vi.fn(() => new Promise<boolean>((r) => (finish = () => r(true)))) })
      : client(),
  );
  const first = probeAll();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await probeAll();
  const hosts = mocks.create.mock.calls.map(([dc]) => dc.host);
  expect(hosts.filter((host) => host === "192.0.2.20")).toHaveLength(1);
  expect(hosts.filter((host) => host === "192.0.2.21")).toHaveLength(2);
  finish();
  await first;
});

test("disabled devices are skipped by probeAll, report UNKNOWN status, and are probed immediately when re-enabled", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        active: { host: "192.0.2.30" },
        disabledRouter: { host: "192.0.2.31", disabled: true },
      },
      defaultDevice: "active",
    }),
  );
  mocks.create.mockClear();
  await probeAll();
  const hosts = mocks.create.mock.calls.map(([dc]) => dc.host);
  expect(hosts).toEqual(["192.0.2.30"]);
  expect(getDeviceStatus("disabledRouter")).toEqual({
    reachable: null,
    checkedAt: null,
    latencyMs: null,
  });
  expect(getDeviceNeighbors("disabledRouter")).toEqual([]);

  // Start health checks and re-enable the disabled router — it should be probed immediately.
  startHealthChecks(60_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  mocks.create.mockClear();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        active: { host: "192.0.2.30" },
        disabledRouter: { host: "192.0.2.31" },
      },
      defaultDevice: "active",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mocks.create.mock.calls.map(([dc]) => dc.host)).toContain("192.0.2.31");
  expect(getDeviceStatus("disabledRouter").reachable).toBe(true);
});
