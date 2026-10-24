import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { parseVersion } from "../src/core/firmware-lifecycle";
import { getConfig, setConfig } from "../src/core/runtime";
import type { ToolContext } from "../src/core/context";
import { beginRollout } from "../src/rollout/model";
import { dropRollout, putRollout } from "../src/rollout/session";
import { resolveTargets, rolloutTools } from "../src/tools/rollout";

const capabilities = vi.hoisted(() => vi.fn());
vi.mock("../src/core/capability-cache", () => ({ peekCapabilities: capabilities }));
const ctx: ToolContext = { device: "home", info: vi.fn(), error: vi.fn() };
const original = getConfig();
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = rolloutTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
beforeEach(() => {
  capabilities.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        home: { host: "192.0.2.1", port: 22, tags: ["lab"] },
        edge: { host: "192.0.2.2", port: 22, tags: ["lab"] },
      },
      defaultDevice: "home",
    }),
  );
});
afterEach(() => {
  dropRollout("uncovered-rollout");
  setConfig(original);
});

test("cached version selector excludes newer and unknown versions without router I/O", async () => {
  capabilities.mockImplementation((name: string) =>
    name === "home" ? { version: parseVersion("7.13") } : { version: parseVersion("7.21") },
  );
  expect(resolveTargets({ versionBelow: "7.20" }).devices).toEqual(["home"]);
  expect(resolveTargets({ versionBelow: "invalid" }).devices).toEqual([]);
  const preview = await run("plan_rollout", {
    targets: { tags: ["lab"], exclude: ["edge"] },
    commands: ["/system identity print"],
  });
  expect(preview).toContain("Selection:");
  expect(preview).toContain("excluded edge");
});

test("in-flight status renders label, wave and notes from a local rollout", async () => {
  const state = beginRollout({ id: "uncovered-rollout", devices: ["home"], strategy: {} });
  state.notes.push("waiting for health gate");
  putRollout({ state, commands: ["/system identity print"], ts: Date.now(), label: "lab change" });
  expect(await run("rollout_status")).toContain("uncovered-rollout (lab change)");
  const detail = await run("rollout_status", { rollout_id: "uncovered-rollout" });
  expect(detail).toContain("waiting for health gate");
  expect(detail).toContain("lab change");
});
