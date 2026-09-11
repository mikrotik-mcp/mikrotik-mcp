import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { investigationRoutes } from "../../src/observability/investigation-routes";
import type { Investigation } from "../../src/investigations/model";

const local = vi.hoisted(() => ({ cases: new Map<string, Investigation>() }));
vi.mock("../../src/investigations/store", () => ({
  investigationStore: async () => ({
    get: (id: string) => local.cases.get(id),
    list: (device: string) => [...local.cases.values()].filter((c) => c.device === device),
    save: (c: Investigation) => local.cases.set(c.id, c),
  }),
}));
const original = getConfig();
beforeEach(() => {
  local.cases.clear();
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, core: { host: "192.0.2.2" } },
    }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});
function saved(): Investigation {
  return {
    id: randomUUID(),
    createdAt: 1,
    finishedAt: 2,
    device: "edge",
    devices: ["edge", "core"],
    client: "192.0.2.10",
    target: "example.com",
    service: "Checkout",
    clientOutcome: "unverified",
    evidence: [],
    nextTests: [],
  };
}
async function request(path: string, options?: RequestInit): Promise<Response> {
  const req = new Request(`http://localhost${path}`, options);
  return (await investigationRoutes(req, new URL(req.url)))!;
}
describe("investigation HTTP and shared handlers", () => {
  test("lists and reads historical cases without router I/O", async () => {
    const c = saved();
    local.cases.set(c.id, c);
    const list = await request("/api/investigations?device=edge");
    expect((await list.json()).cases).toHaveLength(1);
    const get = await request(`/api/investigations/${c.id}?device=edge`);
    expect(await get.json()).toEqual(c);
    expect(get.headers.get("cache-control")).toBe("no-store");
  });
  test("cannot retrieve a case using a different primary router", async () => {
    const c = saved();
    local.cases.set(c.id, c);
    expect((await request(`/api/investigations/${c.id}?device=core`)).status).toBe(400);
  });
  test("denied secondary evidence cannot leak through history", async () => {
    const c = saved();
    local.cases.set(c.id, c);
    installAccessPolicy({ enabled: true, scope: { devices: ["edge"] } });
    expect((await (await request("/api/investigations?device=edge")).json()).cases).toEqual([]);
    expect((await request(`/api/investigations/${c.id}?device=edge`)).status).toBe(400);
  });
  test("checks tool allowlists and unknown devices on dashboard reads", async () => {
    installAccessPolicy({ enabled: true, scope: { tools: ["get_system_identity"] } });
    expect((await request("/api/investigations?device=edge")).status).toBe(400);
    expect((await request("/api/investigations?device=typo")).status).toBe(400);
  });
  test("rejects invalid bodies, oversized bodies and unsupported methods", async () => {
    expect((await request("/api/investigations", { method: "POST", body: "{" })).status).toBe(400);
    expect(
      (
        await request("/api/investigations", {
          method: "POST",
          body: JSON.stringify({ target: "invalid; /system reboot" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/investigations", { method: "POST", body: "a".repeat(8193) })).status,
    ).toBe(413);
    expect((await request("/api/investigations", { method: "DELETE" })).status).toBe(405);
  });
});
