import { afterEach, beforeEach, expect, test } from "bun:test";
import { openBandwidthStore } from "../../src/bandwidth/store";
import type { BandwidthStore } from "../../src/bandwidth/store";
import { bandwidthRoutes } from "../../src/observability/bandwidth-routes";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
let store: BandwidthStore;
const job = {
  id: "wg",
  name: "WireGuard",
  source: "a",
  destination: "b",
  sourceInterface: "wg0",
  sourceAddress: "10.0.0.1",
  destinationAddress: "10.0.0.2",
  enabled: false,
};
beforeEach(async () => {
  store = await openBandwidthStore(":memory:");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { a: { host: "192.0.2.1" }, b: { host: "192.0.2.2" } },
      defaultDevice: "a",
    }),
  );
});
afterEach(() => store.close());
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await bandwidthRoutes(req, new URL(req.url), async () => store))!;
}
test("save/list/delete preserve definitions and never perform live reads", async () => {
  expect((await request("/api/bandwidth/save", { job })).status).toBe(200);
  const state = await (await request("/api/bandwidth")).json();
  expect(state.jobs[0]).toMatchObject(job);
  expect(state.jobs[0].nextRunAt).toBeGreaterThan(Date.now());
  expect(state.devices).toEqual(["a", "b"]);
  expect(state.runs).toEqual([]);
  expect((await request("/api/bandwidth/delete", { id: "wg" })).status).toBe(200);
  expect(store.jobs()).toHaveLength(0);
});
test("rejects cross-origin, unbounded payload, unknown secret fields, missing impact consent and cursor abuse", async () => {
  expect(
    (await request("/api/bandwidth/save", { job }, { origin: "https://evil.invalid" })).status,
  ).toBe(403);
  expect(
    (await request("/api/bandwidth/save", { job: { ...job, name: "x".repeat(9000) } })).status,
  ).toBe(413);
  expect(
    (await request("/api/bandwidth/save", { job: { ...job, password: "secret" } })).status,
  ).toBe(400);
  expect((await request("/api/bandwidth/save", { job: { ...job, enabled: true } })).status).toBe(
    400,
  );
  expect(
    (
      await request("/api/bandwidth/save", {
        job: { ...job, enabled: true },
        acknowledgeImpact: true,
      })
    ).status,
  ).toBe(200);
  expect((await request("/api/bandwidth/run", { id: "wg" })).status).toBe(400);
  expect((await request("/api/bandwidth/notifications?after=-1")).status).toBe(400);
  expect((await request("/api/bandwidth/notifications?limit=10000")).status).toBe(400);
});
test("read-only server refuses saving schedules even though no router config changes occur", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      readOnly: true,
      devices: { a: { host: "192.0.2.1" }, b: { host: "192.0.2.2" } },
      defaultDevice: "a",
    }),
  );
  expect((await request("/api/bandwidth/save", { job })).status).toBe(400);
  expect(store.jobs()).toEqual([]);
});
