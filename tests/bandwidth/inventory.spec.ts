import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { ParsedRecords } from "../../src/core/routeros-parse";
import { bandwidthInventory } from "../../src/bandwidth/inventory";
import { executeMikrotikJson } from "../../src/core/connector";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
vi.mock("../../src/core/connector", () => ({
  executeMikrotikJson: vi.fn(),
  executeMikrotikCommand: vi.fn(),
}));
const config = () =>
  MikrotikConfigSchema.parse({
    devices: { a: { host: "192.0.2.1", description: "Router A" } },
    defaultDevice: "a",
  });
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(config());
  vi.mocked(executeMikrotikJson).mockImplementation(async (command): Promise<ParsedRecords> => ({
    format: "detail",
    columns: [],
    rows: command.startsWith("/interface")
      ? [
          { name: "wg1", flags: "R" },
          { name: "ether1", flags: "R" },
          { name: "disabled", flags: "X" },
        ]
      : [
          { address: "10.0.0.1/24", interface: "wg1" },
          { address: "10.0.0.9/24", interface: "wg1", disabled: "yes" },
        ],
  }));
});
afterEach(() => vi.useRealTimers());
test("keeps all interfaces including unaddressed/disabled; coalesces aliases and concurrent selector reads", async () => {
  const [a, b] = await Promise.all([bandwidthInventory("a"), bandwidthInventory("Router A")]);
  expect(a).toEqual(b);
  expect(a.interfaces).toHaveLength(3);
  expect(a.interfaces[2]).toEqual({ name: "disabled", disabled: true, running: false });
  expect(a.addresses).toEqual([{ interface: "wg1", address: "10.0.0.1" }]);
  expect(executeMikrotikJson).toHaveBeenCalledTimes(2);
  for (const [command] of vi.mocked(executeMikrotikJson).mock.calls)
    expect(command).toMatch(/ print detail$/);
});
test("expires 30 seconds after completed load and invalidates cache on config changes", async () => {
  vi.useFakeTimers();
  await bandwidthInventory("a");
  await vi.advanceTimersByTimeAsync(29999);
  await bandwidthInventory("a");
  expect(executeMikrotikJson).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await bandwidthInventory("a");
  expect(executeMikrotikJson).toHaveBeenCalledTimes(4);
  setConfig(config());
  await bandwidthInventory("a");
  expect(executeMikrotikJson).toHaveBeenCalledTimes(6);
});
test("failed inventory can be retried and disabled devices cannot reuse cached results", async () => {
  vi.mocked(executeMikrotikJson).mockRejectedValueOnce(new Error("offline"));
  await expect(bandwidthInventory("a")).rejects.toThrow("offline");
  expect((await bandwidthInventory("a")).interfaces).toHaveLength(3);
  const cfg = config();
  cfg.devices.a.disabled = true;
  setConfig(cfg);
  await expect(bandwidthInventory("a")).rejects.toThrow();
});
