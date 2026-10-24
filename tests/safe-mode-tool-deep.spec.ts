import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { safeModeTools } from "../src/tools/safe-mode";

const manager = vi.hoisted(() => ({
  status: vi.fn(),
  enable: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  setTimeouts: vi.fn(),
}));
const getManager = vi.hoisted(() => vi.fn(() => manager));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: getManager }));
const initial = getConfig();
const ctx: ToolContext = { device: "branch", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) =>
  safeModeTools.find((t) => t.name === name)!.handler(args as never, ctx);
beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { main: { host: "192.0.2.1" }, branch: { host: "192.0.2.2" } },
      defaultDevice: "main",
    }),
  );
  manager.status.mockReturnValue("inactive");
  manager.enable.mockResolvedValue("enabled");
  manager.commit.mockResolvedValue({ ok: true, message: "committed" });
  manager.rollback.mockResolvedValue("rollback requested");
  manager.setTimeouts.mockReturnValue("timeouts set");
});
afterEach(() => setConfig(initial));

test("status and timeout changes target the selected device", async () => {
  expect(await run("safe_mode_status")).toBe("inactive");
  expect(await run("set_safe_mode_timeout", { commandTimeoutMs: 5000, idleTimeoutMs: 2000 })).toBe(
    "timeouts set",
  );
  expect(getManager).toHaveBeenCalledWith("branch");
  expect(manager.setTimeouts).toHaveBeenCalledExactlyOnceWith(5000, 2000);
});

test("enable, commit and rollback delegate without changing their response", async () => {
  expect(await run("enable_safe_mode")).toBe("enabled");
  expect(await run("commit_safe_mode")).toBe("committed");
  expect(await run("rollback_safe_mode")).toBe("rollback requested");
  expect(getManager.mock.calls.map((args) => (args as unknown[])[0])).toEqual([
    "branch",
    "branch",
    "branch",
  ]);
  expect(manager.enable).toHaveBeenCalledOnce();
  expect(manager.commit).toHaveBeenCalledOnce();
  expect(manager.rollback).toHaveBeenCalledOnce();
});

test("unknown selected device fails before manager access", () => {
  expect(() => run("safe_mode_status", {})).not.toThrow();
  getManager.mockClear();
  const unknown = { ...ctx, device: "missing" };
  const tool = safeModeTools.find((t) => t.name === "safe_mode_status")!;
  expect(() => tool.handler({} as never, unknown)).toThrow();
  expect(getManager).not.toHaveBeenCalled();
});
