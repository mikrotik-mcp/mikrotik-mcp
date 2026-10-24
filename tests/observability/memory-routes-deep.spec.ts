import { beforeEach, expect, test, vi } from "vite-plus/test";
import { memoryRoutes } from "../../src/observability/memory-routes";

const state = vi.hoisted(() => ({ enabled: true, failure: "" }));
const store = vi.hoisted(() => ({
  stats: vi.fn(() => ({ facts: 2 })),
  health: vi.fn(() => ({ ok: true })),
  facts: vi.fn(() => ({ items: [], total: 0 })),
  listEntities: vi.fn(() => [{ name: "router" }]),
  searchNodes: vi.fn(() => []),
  activity: vi.fn(() => []),
  readGraph: vi.fn(() => ({ entities: [] })),
  openNodes: vi.fn(() => ({ entities: [], relations: [] })),
  createEntities: vi.fn((items: unknown[]) => items),
  createRelations: vi.fn((items: unknown[]) => items),
  deleteRelations: vi.fn(() => 1),
  deleteEntities: vi.fn(() => 1),
  addObservations: vi.fn(() => [{ name: "router" }]),
  deleteObservations: vi.fn(() => 1),
  remember: vi.fn(() => ({ id: 1 })),
  revise: vi.fn(() => ({ id: 1 })),
  recall: vi.fn(() => []),
  history: vi.fn(() => []),
  scope: vi.fn(() => ({ scope: "device" })),
  setScope: vi.fn(() => ({ scope: "shared" })),
}));
vi.mock("../../src/core/runtime", () => ({
  getConfig: () => ({ memory: { enabled: state.enabled, dbPath: ":memory:" } }),
  setConfig: vi.fn(),
}));
vi.mock("../../src/memory/accessor", () => ({
  getMemoryStore: async () => {
    if (state.failure) throw new Error(state.failure);
    return store;
  },
  installMemoryStore: vi.fn(),
  closeMemoryStore: vi.fn(),
}));

async function request(path: string, init?: RequestInit) {
  const url = new URL(`http://localhost${path}`);
  return memoryRoutes(new Request(url, init), url);
}
beforeEach(() => {
  state.enabled = true;
  state.failure = "";
  vi.clearAllMocks();
});

test("configuration remains readable with broken storage and disabled memory blocks data", async () => {
  state.failure = "cannot open";
  expect(await (await request("/api/memory/config"))?.json()).toMatchObject({
    enabled: true,
    stats: null,
  });
  state.enabled = false;
  expect((await request("/api/memory/summary"))?.status).toBe(503);
  expect(await (await request("/api/memory/config"))?.json()).toMatchObject({
    enabled: false,
    stats: null,
  });
  expect(await request("/api/elsewhere")).toBeNull();
});
test("summary and compatibility reads return store data", async () => {
  expect(await (await request("/api/memory/summary"))?.json()).toEqual({
    stats: { facts: 2 },
    health: { ok: true },
  });
  expect(await (await request("/api/memory/stats"))?.json()).toEqual({ facts: 2 });
  expect(await (await request("/api/memory/graph"))?.json()).toEqual({ entities: [] });
  expect((await request("/api/memory/entity/missing"))?.status).toBe(404);
});
test("browse pagination and activity filters reach the store", async () => {
  expect((await request("/api/memory/facts?limit=12&offset=3&token=secret"))?.status).toBe(200);
  expect(store.facts).toHaveBeenCalledWith(expect.objectContaining({ limit: 12, offset: 3 }));
  expect(store.facts).toHaveBeenCalledWith(
    expect.not.objectContaining({ token: expect.anything() }),
  );
  expect((await request("/api/memory/activity?limit=5&since=12&changesOnly=true"))?.status).toBe(
    200,
  );
  expect(store.activity).toHaveBeenCalledWith(5, 12, true);
  expect((await request("/api/memory/facts?limit=101"))?.status).toBe(400);
  expect((await request("/api/memory/entities?q=router&limit=4&offset=1"))?.status).toBe(200);
  expect(store.listEntities).toHaveBeenCalledWith("router", 4, 1);
});
test("entity creation validates input and passes a valid batch through", async () => {
  const invalid = await request("/api/memory/entities", {
    method: "POST",
    body: JSON.stringify({ entities: [{ name: "" }] }),
  });
  expect(invalid?.status).toBe(400);
  expect(store.createEntities).not.toHaveBeenCalled();
  const valid = await request("/api/memory/entities", {
    method: "POST",
    body: JSON.stringify({
      entities: [{ name: "router", entityType: "device", observations: ["online"] }],
    }),
  });
  expect(await valid?.json()).toMatchObject({ count: 1, created: [{ name: "router" }] });
});
test("request and storage failures map to stable HTTP errors", async () => {
  expect((await request("/api/memory/entities", { method: "POST", body: "{" }))?.status).toBe(400);
  store.createEntities.mockImplementationOnce(() => {
    throw new Error("UNIQUE constraint failed");
  });
  expect(
    (
      await request("/api/memory/entities", {
        method: "POST",
        body: JSON.stringify({ entities: [{ name: "router", entityType: "device" }] }),
      })
    )?.status,
  ).toBe(409);
  state.failure = "disk offline";
  expect((await request("/api/memory/summary"))?.status).toBe(503);
  expect((await request("/api/memory/unknown"))?.status).toBe(503);
  state.failure = "";
  expect((await request("/api/memory/unknown"))?.status).toBe(404);
});
