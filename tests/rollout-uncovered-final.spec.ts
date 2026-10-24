import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { rolloutTools } from "../src/tools/rollout";

const probe = vi.hoisted(() => vi.fn());
const contract = vi.hoisted(() => vi.fn());
vi.mock("../src/rollout/executor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeReachability: probe,
}));
vi.mock("../src/services/contracts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runServiceContract: contract,
}));
const original = getConfig();
const ctx: ToolContext = { device: "home", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown>) => {
  const tool = rolloutTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
};
beforeEach(() => {
  probe.mockReset().mockResolvedValue({ home: true, edge: true });
  contract.mockReset().mockResolvedValue({ status: "pass" });
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: { host: "192.0.2.1", port: 22 }, edge: { host: "192.0.2.2", port: 22 } },
      defaultDevice: "home",
    }),
  );
});
afterEach(() => setConfig(original));

test("confirmed rollout rejects a contract owner outside the target set", async () => {
  await expect(
    run("start_rollout", {
      targets: ["home"],
      commands: ["/system identity print"],
      confirm: true,
      service_contracts: [{ id: "00000000-0000-4000-8000-000000000001", device: "edge" }],
    }),
  ).rejects.toThrow("among the rollout targets");
  expect(probe).not.toHaveBeenCalled();
});

test("confirmed rollout refuses contract gates with continue strategy", async () => {
  await expect(
    run("start_rollout", {
      targets: ["home"],
      commands: ["/system identity print"],
      confirm: true,
      strategy: { onFailure: "continue" },
      service_contracts: [{ id: "00000000-0000-4000-8000-000000000001", device: "home" }],
    }),
  ).rejects.toThrow("onFailure=continue");
  expect(probe).not.toHaveBeenCalled();
});
