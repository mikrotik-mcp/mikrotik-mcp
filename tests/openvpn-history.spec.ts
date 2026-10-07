import { afterEach, expect, test, vi } from "vite-plus/test";
import { openVpnRoutes } from "../src/observability/openvpn-routes";
import { startOpenVpnHistorySampler } from "../src/observability/openvpn-history-sampler";
import type { OpenVpnHistoryStore } from "../src/observability/openvpn-history";

const { read, access, safe } = vi.hoisted(() => ({
  read: vi.fn(),
  access: vi.fn(),
  safe: { isActive: false },
}));
vi.mock("../src/core/openvpn-sessions", async (original) => ({
  ...(await original<object>()),
  listOpenVpnSessions: read,
}));
vi.mock("../src/core/scoped-access", () => ({ assertDeviceAccess: access }));
vi.mock("../src/core/runtime", () => ({
  getConfig: () => ({ devices: { home: {}, disabled: { disabled: true }, mac: { mac: "AA" } } }),
  resolveDeviceName: (name: string) => {
    if (name !== "home") throw new Error("Unknown");
    return name;
  },
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => safe }));
vi.mock("../src/observability/geo", () => ({
  getIpGeo: () => ({ status: "private" }),
  sourceIpLiteral: (ip: string) => ip,
}));
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  safe.isActive = false;
  access.mockReset();
});
function fakeStore() {
  return {
    ingest: vi.fn(),
    failure: vi.fn(),
    enrich: vi.fn(),
    report: vi.fn(() => ({ allTime: 12 })),
  };
}
test("history is local, validates filters, enforces access on every request and never reads a router", async () => {
  const store = fakeStore();
  const call = (query: string) => {
    const url = new URL(`http://localhost/api/openvpn/history?${query}`);
    return openVpnRoutes(new Request(url), url, store as unknown as OpenVpnHistoryStore);
  };
  expect((await call("device=home&user=ali&from=100&to=200"))?.status).toBe(200);
  expect(store.report).toHaveBeenCalledWith({
    device: "home",
    user: "ali",
    from: 100,
    to: 200,
    offset: 0,
  });
  for (const query of [
    "device=unknown",
    "device=home&from=200&to=100",
    "device=home&offset=-1",
    "device=home&from=NaN",
    "device=home&offset=1.5",
  ])
    expect((await call(query))?.status).toBe(400);
  access.mockImplementation(() => {
    throw new Error("denied");
  });
  expect((await call("device=home"))?.status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});
test("background sampler persists without viewers, skips disabled/MAC devices and backs off errors", async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  read.mockResolvedValueOnce({ device: "home", observedAt: 1, sessions: [], canDisconnect: false });
  stop = startOpenVpnHistorySampler(store as unknown as OpenVpnHistoryStore);
  await vi.advanceTimersByTimeAsync(1);
  expect(store.ingest).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValue(new Error("offline"));
  await vi.advanceTimersByTimeAsync(15000);
  expect(store.failure).toHaveBeenCalledWith("home");
  await vi.advanceTimersByTimeAsync(15000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.ingest).toHaveBeenCalledTimes(1);
});
test("shutdown discards in-flight reads before the database is closed", async () => {
  const store = fakeStore();
  let finish!: (value: unknown) => void;
  read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  stop = startOpenVpnHistorySampler(store as unknown as OpenVpnHistoryStore);
  stop();
  finish({ device: "home", observedAt: 1, sessions: [], canDisconnect: false });
  await Promise.resolve();
  expect(store.ingest).not.toHaveBeenCalled();
});
