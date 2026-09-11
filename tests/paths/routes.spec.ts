import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { roundTripRoutes } from "../../src/observability/round-trip-routes";
import { contentSha } from "../../src/snapshots/format";

const db = vi.hoisted(() => ({ open: vi.fn(), get: vi.fn(), close: vi.fn() }));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => {
    db.open();
    return { get: db.get, close: db.close };
  },
}));
const original = getConfig();
const body =
  "/ip address\nadd address=192.0.2.1/24 interface=lan\nadd address=198.51.100.1/24 interface=servers\n";
function input() {
  return {
    snapshots: [{ device: "edge", id: "snap-1" }],
    forward: [{ device: "edge", ingress: "lan", egress: "servers" }],
    reverse: [{ device: "edge", ingress: "servers", egress: "lan" }],
    packet: {
      srcAddress: "192.0.2.10",
      dstAddress: "198.51.100.10",
      protocol: "tcp",
      srcPort: 49152,
      dstPort: 443,
    },
  };
}
async function request(value: unknown = input(), device = "edge", origin?: string) {
  const req = new Request(`http://localhost/api/round-trip?device=${device}`, {
    method: "POST",
    body: JSON.stringify(value),
    headers: origin ? { origin } : {},
  });
  return (await roundTripRoutes(req, new URL(req.url)))!;
}
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, other: { host: "192.0.2.2" } },
    }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
  db.get.mockReturnValue({
    id: "snap-1",
    device: "edge",
    ts: Date.now(),
    body,
    sha: contentSha(body),
  });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});
test("dashboard returns evidence without network I/O and closes snapshot store", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("modelled");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(db.close).toHaveBeenCalledOnce();
});
test("unknown selected device fails before snapshot lookup", async () => {
  expect((await request(input(), "typo")).status).toBe(400);
  expect(db.open).not.toHaveBeenCalled();
});
test("every secondary device is authorized before any snapshot is read", async () => {
  const i = input();
  i.snapshots.push({ device: "other", id: "snap-2" });
  i.forward.push({ device: "other", ingress: "transit", egress: "servers" });
  i.reverse.unshift({ device: "other", ingress: "servers", egress: "transit" });
  installAccessPolicy({ enabled: true, scope: { devices: ["edge"] } });
  expect((await request(i)).status).toBe(400);
  expect(db.open).not.toHaveBeenCalled();
});
test("wrong snapshot owner is rejected and store still closes", async () => {
  db.get.mockReturnValue({ id: "snap-1", device: "other" });
  expect((await request()).status).toBe(400);
  expect(db.close).toHaveBeenCalledOnce();
});
test("cross-origin and oversized requests fail before snapshot access", async () => {
  expect((await request(input(), "edge", "http://evil.test")).status).toBe(403);
  expect((await request({ excessive: "x".repeat(9000) })).status).toBe(413);
  expect(db.open).not.toHaveBeenCalled();
});
test("read-only mode allows offline analysis but tool denial does not", async () => {
  setConfig({ ...getConfig(), readOnly: true });
  expect((await request()).status).toBe(200);
  installAccessPolicy({ enabled: true, scope: { denyTools: ["trace_round_trip"] } });
  expect((await request()).status).toBe(400);
  expect(db.open).toHaveBeenCalledOnce();
});
