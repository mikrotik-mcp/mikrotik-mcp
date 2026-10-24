import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { applyCommandsDirect, applyWritesSafely } from "../src/utils/safe-mode-apply";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  enable: vi.fn(),
  execute: vi.fn(),
  rollback: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    enable: mocks.enable,
    execute: mocks.execute,
    rollback: mocks.rollback,
    commit: mocks.commit,
  }),
}));
const ctx: ToolContext = { device: "ssh", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
const commands = [
  "/ip firewall address-list add list=lab address=192.0.2.1",
  "/ip firewall address-list add list=lab address=192.0.2.2",
];

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { ssh: { host: "192.0.2.10", port: 22 }, mac: { mac: "02:00:00:00:00:01" } },
      defaultDevice: "ssh",
    }),
  );
  mocks.command.mockResolvedValue("");
  mocks.enable.mockResolvedValue("Safe Mode enabled");
  mocks.execute.mockResolvedValue("");
  mocks.rollback.mockResolvedValue(undefined);
  mocks.commit.mockResolvedValue({ ok: true, message: "committed" });
});
afterEach(() => setConfig(initial));

test("empty batch succeeds without opening Safe Mode", async () => {
  expect(await applyWritesSafely(ctx, "ssh", [])).toMatchObject({
    applied: 0,
    committed: true,
    fellBack: false,
  });
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("direct writes stop at first device failure and never replay later commands", async () => {
  mocks.command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
  expect(
    await applyCommandsDirect(ctx, [
      ...commands,
      "/ip firewall address-list add list=lab address=192.0.2.3",
    ]),
  ).toEqual({ applied: 1, error: "failure: denied" });
  expect(mocks.command).toHaveBeenCalledTimes(2);
});

test("MAC-Telnet refuses unsafe fallback and uses direct writes only when explicitly allowed", async () => {
  expect(await applyWritesSafely(ctx, "mac", commands)).toMatchObject({
    committed: false,
    applied: 0,
    fellBack: false,
  });
  expect(mocks.command).not.toHaveBeenCalled();
  expect(
    await applyWritesSafely(ctx, "mac", commands, { allowDirectFallback: true }),
  ).toMatchObject({ committed: true, applied: 2, fellBack: false });
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("Safe Mode enable failure defaults to fail-closed and optional fallback is explicit", async () => {
  mocks.enable.mockResolvedValue("Error: unavailable");
  expect(await applyWritesSafely(ctx, "ssh", commands)).toMatchObject({
    committed: false,
    applied: 0,
    fellBack: false,
  });
  expect(mocks.command).not.toHaveBeenCalled();
  expect(
    await applyWritesSafely(ctx, "ssh", commands, { allowDirectFallback: true }),
  ).toMatchObject({ committed: true, applied: 2, fellBack: true });
});

test("mid-apply error rolls back without direct replay even if fallback was allowed", async () => {
  mocks.execute.mockResolvedValueOnce("").mockResolvedValueOnce("failure: invalid rule");
  const result = await applyWritesSafely(ctx, "ssh", commands, { allowDirectFallback: true });
  expect(result).toMatchObject({
    committed: false,
    applied: 1,
    fellBack: false,
    error: "failure: invalid rule",
  });
  expect(mocks.rollback).toHaveBeenCalledOnce();
  expect(mocks.command).not.toHaveBeenCalled();
});

test("successful batch commits and ambiguous commit is not claimed as successful", async () => {
  expect(await applyWritesSafely(ctx, "ssh", commands)).toMatchObject({
    committed: true,
    applied: 2,
    safeMode: "committed",
  });
  mocks.commit.mockResolvedValueOnce({ ok: false, message: "session lost" });
  expect(await applyWritesSafely(ctx, "ssh", commands)).toMatchObject({
    committed: false,
    applied: 2,
    fellBack: false,
  });
  expect(mocks.command).not.toHaveBeenCalled();
});
