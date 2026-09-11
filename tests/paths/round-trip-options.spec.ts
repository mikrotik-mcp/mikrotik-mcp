import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { getConfig, setConfig } from "../../src/core/runtime";
import { MikrotikConfigSchema } from "../../src/config";
import { installAccessPolicy } from "../../src/core/access";
import { roundTripRoutes } from "../../src/observability/round-trip-routes";
const store = vi.hoisted(() => ({ list: vi.fn(() => []), get: vi.fn(), close: vi.fn() }));
vi.mock("../../src/snapshots/store", () => ({ openSnapshotStore: vi.fn(async () => store) }));
const original = getConfig();
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, hidden: { host: "192.0.2.2" } },
    }),
  );
  installAccessPolicy({ enabled: true, scope: { devices: ["edge"] } });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});
const request = async (query = "") => {
  const url = new URL(`http://localhost/api/round-trip/options${query}`);
  return roundTripRoutes(new Request(url), url);
};
test("choices only list authorized routers and omit raw configuration", async () => {
  const response = await request();
  expect(await response?.json()).toEqual({ devices: [{ device: "edge", snapshots: [] }] });
  expect(store.list).toHaveBeenCalledTimes(1);
  expect(store.list).toHaveBeenCalledWith("edge", 20, false);
  expect(store.close).toHaveBeenCalled();
});
test("denied and unknown routers cannot read snapshot storage", async () => {
  expect((await request("?device=hidden"))?.status).toBe(403);
  expect((await request("?device=missing"))?.status).toBe(400);
  expect(store.get).not.toHaveBeenCalled();
  expect(store.list).not.toHaveBeenCalled();
});
test("snapshot ownership is enforced before revealing interfaces", async () => {
  store.get.mockReturnValue({ device: "hidden", body: "/interface bridge\nadd name=secret" });
  expect((await request("?device=edge&id=other"))?.status).toBe(404);
});
test("interface choices come from the selected snapshot, never a live router", async () => {
  store.get.mockReturnValue({
    device: "edge",
    body: "/interface bridge\nadd name=lan comment=private\n/interface wireguard\nadd name=tunnel private-key=secret",
  });
  const response = await request("?device=edge&id=s1");
  const data = await response?.json();
  expect(data.interfaces).toContain("lan");
  expect(data.interfaces).toContain("tunnel");
  expect(JSON.stringify(data)).not.toMatch(/private|secret/);
});
