import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { drDrillTools, parsePingSummary } from "../src/tools/dr-drill";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  enable: vi.fn(),
  safeExecute: vi.fn(),
  rollback: vi.fn(),
  device: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.execute }));
vi.mock("../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    enable: mocks.enable,
    execute: mocks.safeExecute,
    rollback: mocks.rollback,
  }),
}));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  getDevice: mocks.device,
  resolveDeviceName: mocks.resolve,
}));
const ctx: ToolContext = { device: "offline", info: vi.fn(), error: vi.fn() };
const args = {
  target_type: "interface",
  target: "wan1",
  verify_host: "192.0.2.1",
  ping_count: 3,
  confirm: true,
};

function run(input: Record<string, unknown>) {
  const tool = drDrillTools.find((entry) => entry.name === "run_failover_drill");
  if (!tool) throw new Error("Missing drill tool");
  return tool.handler(input as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue("offline");
  mocks.device.mockReturnValue({ host: "localhost" });
  mocks.enable.mockResolvedValue("enabled");
  mocks.safeExecute.mockImplementation(async (cmd: string) =>
    cmd.startsWith("/ping") ? "sent=3 received=3 packet-loss=0%" : "",
  );
  mocks.rollback.mockResolvedValue("rolled back");
  mocks.execute.mockImplementation(async (cmd: string) =>
    cmd.startsWith("/ping") ? "sent=3 received=3 packet-loss=0%" : "",
  );
});

test("preview describes interface and route drill without any I/O", async () => {
  expect(await run({ ...args, confirm: false })).toContain('/interface disable "wan1"');
  expect(await run({ ...args, target_type: "route", target: "*A", confirm: false })).toContain(
    "/ip route disable [find .id=*A]",
  );
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("safe-mode pass always rolls back and never uses direct commands", async () => {
  expect(await run(args)).toContain("PASS — Backup path HELD");
  expect(mocks.safeExecute.mock.calls.map(([cmd]) => cmd)).toEqual([
    '/interface disable "wan1"',
    "/ping address=192.0.2.1 count=3",
  ]);
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("safe-mode missing target rolls back without pinging", async () => {
  mocks.safeExecute.mockResolvedValueOnce("no such item");
  expect(await run(args)).toContain("Could not disable target");
  expect(mocks.safeExecute).toHaveBeenCalledTimes(1);
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
});

test("zero replies fail the drill, including when the summary is unparseable", async () => {
  mocks.safeExecute
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("sent=3 received=0 packet-loss=100%");
  expect(await run(args)).toContain("FAIL — NO connectivity");
  mocks.safeExecute.mockResolvedValueOnce("").mockResolvedValueOnce("timeout");
  expect(await run(args)).toContain("could not parse ping result");
  expect(parsePingSummary("sent=4 received=2")).toEqual({ sent: 4, received: 2, lossPct: 100 });
});

test("unavailable Safe Mode falls back to direct route disable, ping, and enable", async () => {
  mocks.enable.mockResolvedValue("Error: unavailable");
  expect(await run({ ...args, target_type: "route", target: "*A" })).toContain(
    "PASS — Backup path HELD",
  );
  expect(mocks.execute.mock.calls.map(([cmd]) => cmd)).toEqual([
    "/ip route disable [find .id=*A]",
    "/ping address=192.0.2.1 count=3",
    "/ip route enable [find .id=*A]",
  ]);
  expect(mocks.execute.mock.calls[1]?.[2]).toEqual({ maxMs: 7500 });
});

test("MAC-Telnet skips Safe Mode; failed disable never pings or enables", async () => {
  mocks.device.mockReturnValue({ mac: "00:11:22:33:44:55" });
  mocks.execute.mockResolvedValueOnce("failure: denied");
  expect(await run(args)).toContain("Could not disable target");
  expect(mocks.enable).not.toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

test("direct fallback re-enables target even when ping throws", async () => {
  mocks.enable.mockResolvedValue("Error: unavailable");
  mocks.execute.mockResolvedValueOnce("").mockRejectedValueOnce(new Error("ping timed out"));
  await expect(run(args)).rejects.toThrow("ping timed out");
  expect(mocks.execute.mock.calls[2]?.[0]).toBe('/interface enable "wan1"');
});

test("drill schema enforces target type and bounded ping count", () => {
  const tool = drDrillTools.find((entry) => entry.name === "run_failover_drill")!;
  const schema = z.object(tool.inputSchema);
  expect(schema.safeParse({ ...args, ping_count: 0 }).success).toBe(false);
  expect(schema.safeParse({ ...args, ping_count: 51 }).success).toBe(false);
  expect(schema.safeParse({ ...args, target_type: "bridge" }).success).toBe(false);
});
