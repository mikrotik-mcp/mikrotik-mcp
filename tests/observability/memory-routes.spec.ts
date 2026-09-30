import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig, getConfig } from "../../src/core/runtime";
import { memoryRoutes } from "../../src/observability/memory-routes";
import { getMemoryStore, installMemoryStore } from "../../src/memory/accessor";
import { openMemoryStore } from "../../src/memory/store";
import { atomicWrite } from "../../src/config-write";

vi.mock("../../src/memory/accessor", () => ({
  getMemoryStore: vi.fn(),
  installMemoryStore: vi.fn(),
  closeMemoryStore: vi.fn(),
}));
vi.mock("../../src/memory/store", () => ({ openMemoryStore: vi.fn() }));
vi.mock("../../src/config-write", () => ({ atomicWrite: vi.fn(), serializeConfig: () => "{}" }));
const store = {
  facts: vi.fn(() => ({ items: [], total: 0 })),
  remember: vi.fn(() => ({ id: 1 })),
  revise: vi.fn(() => ({ id: 1 })),
  stats: vi.fn(() => ({})),
  close: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { test: { host: "127.0.0.1" } },
      defaultDevice: "test",
      memory: { enabled: true, dbPath: ":memory:" },
    }),
  );
  vi.mocked(getMemoryStore).mockResolvedValue(store as never);
  vi.mocked(openMemoryStore).mockResolvedValue(store as never);
  vi.mocked(atomicWrite).mockImplementation(() => {});
});
async function request(path: string, data?: unknown, raw?: string) {
  const url = new URL(`http://localhost/api/memory/${path}`);
  return (await memoryRoutes(
    new Request(
      url,
      data === undefined && raw === undefined
        ? {}
        : {
            method: "POST",
            body: raw ?? JSON.stringify(data),
            headers: { "content-type": "application/json" },
          },
    ),
    url,
  ))!;
}
test("memory REST validates untrusted inputs, pagination and malformed JSON before mutation", async () => {
  expect(
    (await request("facts", { entityName: "router", content: "x", confidence: 12 })).status,
  ).toBe(400);
  expect((await request("facts", undefined, "{")).status).toBe(400);
  expect((await request("facts?limit=-1")).status).toBe(400);
  expect(store.remember).not.toHaveBeenCalled();
  expect((await request("facts?limit=12&state=review&entityName=test")).status).toBe(200);
  expect(store.facts).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 12, state: "review", entityName: "test" }),
  );
  expect(
    (await request("facts", { entityName: "test", content: "Valid note", kind: "lesson" })).status,
  ).toBe(200);
  expect(store.remember).toHaveBeenCalledWith(
    expect.objectContaining({ source: "unspecified", confidence: 0.5 }),
  );
});
test("configuration is readable and re-enableable while memory is disabled", async () => {
  setConfig({ ...getConfig(), memory: { enabled: false, dbPath: ":memory:" } });
  expect((await (await request("config")).json()).enabled).toBe(false);
  expect(getMemoryStore).not.toHaveBeenCalled();
  expect((await request("facts")).status).toBe(503);
  expect((await request("config", { enabled: true })).status).toBe(200);
  expect(atomicWrite).toHaveBeenCalledOnce();
  expect(installMemoryStore).toHaveBeenCalledWith(store);
  expect(getConfig().memory.enabled).toBe(true);
});
test("failed persistence never publishes a new store or reports saved configuration", async () => {
  vi.mocked(atomicWrite).mockImplementation(() => {
    throw new Error("disk full");
  });
  expect((await request("config", { dbPath: "/tmp/isolated-memory-test.db" })).status).toBe(500);
  expect(getConfig().memory.dbPath).toBe(":memory:");
  expect(installMemoryStore).not.toHaveBeenCalled();
  expect(store.close).toHaveBeenCalledOnce();
});
test("revision conflict is surfaced as a conflict, not a successful write", async () => {
  store.revise.mockImplementationOnce(() => {
    throw new Error("Memory changed since you opened it. Refresh before editing.");
  });
  const response = await request("facts/revise", { id: 1, expectedRevision: 1, verified: true });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("Refresh");
});
test("broken storage does not hide settings and unchanged settings never replace the store", async () => {
  vi.mocked(getMemoryStore).mockRejectedValueOnce(new Error("cannot open database"));
  const config = await request("config");
  expect(config.status).toBe(200);
  expect(await config.json()).toMatchObject({ enabled: true, stats: null });
  expect((await request("config", { enabled: true, dbPath: ":memory:" })).status).toBe(200);
  expect(openMemoryStore).not.toHaveBeenCalled();
  expect(installMemoryStore).not.toHaveBeenCalled();
  expect(atomicWrite).not.toHaveBeenCalled();
});
