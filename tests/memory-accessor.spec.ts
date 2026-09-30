import { afterEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { closeMemoryStore, getMemoryStore } from "../src/memory/accessor";
import { openMemoryStore } from "../src/memory/store";

vi.mock("../src/memory/store", () => ({ openMemoryStore: vi.fn() }));
afterEach(() => {
  closeMemoryStore();
  vi.clearAllMocks();
});
test("a failed open is retryable and disabling memory blocks an already open store", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { demo: { host: "127.0.0.1" } },
      defaultDevice: "demo",
      memory: { enabled: true, dbPath: ":memory:" },
    }),
  );
  const store = { close: vi.fn() };
  vi.mocked(openMemoryStore)
    .mockRejectedValueOnce(new Error("locked"))
    .mockResolvedValueOnce(store as never);
  await expect(getMemoryStore()).rejects.toThrow("locked");
  await expect(getMemoryStore()).resolves.toBe(store);
  setConfig({ ...getConfig(), memory: { ...getConfig().memory, enabled: false } });
  await expect(getMemoryStore()).rejects.toThrow("disabled");
  expect(openMemoryStore).toHaveBeenCalledTimes(2);
});
