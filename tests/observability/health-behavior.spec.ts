import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DeviceConfigSchema, MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getDeviceHistory,
  getDeviceNeighbors,
  getDeviceStatus,
  probeAll,
  probeDevice,
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
afterEach(() => setConfig(initial));

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
  expect(mocks.create.mock.calls[0][0].timeoutMs).toBe(8_000);
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
