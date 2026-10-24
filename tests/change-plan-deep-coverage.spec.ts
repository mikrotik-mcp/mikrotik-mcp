import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { changePlanTools } from "../src/tools/change-plan";

const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  execute: vi.fn(),
  rollback: vi.fn(),
  commit: vi.fn(),
  device: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => mocks }));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  getDevice: mocks.device,
  resolveDeviceName: mocks.resolve,
}));
const ctx: ToolContext = { device: "offline", info: vi.fn(), error: vi.fn() };
const add = "/ip address add address=192.0.2.1/32 interface=lo";
const remove = "/ip address remove [find address=192.0.2.2/32]";

function call(name: string, args: Record<string, unknown>) {
  const tool = changePlanTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.device.mockReturnValue({ host: "localhost" });
  mocks.resolve.mockReturnValue("offline");
  mocks.enable.mockResolvedValue("Safe Mode enabled");
  mocks.execute.mockImplementation(async (command: string) =>
    command === "/export terse" ? "/ip address add address=192.0.2.9/32" : "name=offline",
  );
  mocks.rollback.mockResolvedValue("rolled back");
  mocks.commit.mockResolvedValue({ ok: true, message: "saved" });
});

test("preview merges array and script, ignores comments, and reorders destructive steps", async () => {
  const result = await call("plan_changes", {
    commands: [` ${remove} `, "  "],
    script: `# note\n${add}`,
  });
  expect(result).toMatchObject({ structuredContent: { counts: { total: 2 }, reordered: true } });
  expect(JSON.stringify(result)).toContain("Plan: +1 to add");
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("empty inputs cause no device or safe-mode work", async () => {
  expect(await call("plan_changes", { script: "# comment" })).toBe("No commands provided to plan.");
  expect(await call("apply_plan", { commands: ["  "] })).toBe("No commands provided to apply.");
  expect(mocks.device).not.toHaveBeenCalled();
});

test("MAC-Telnet target is rejected before enabling Safe Mode", async () => {
  mocks.device.mockReturnValue({ mac: "00:11:22:33:44:55" });
  await expect(call("apply_plan", { commands: [add] })).rejects.toThrow("requires SSH");
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("failed Safe Mode enable is an error with no commands applied", async () => {
  mocks.enable.mockResolvedValue("Error: busy");
  await expect(call("apply_plan", { commands: [add] })).rejects.toThrow("Error: busy");
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("dry run executes in safe order, captures exports, and rolls back", async () => {
  const result = await call("apply_plan", { commands: [remove, add], confirm: false });
  expect(result).toContain("DRY-RUN: all changes rolled back");
  expect(mocks.execute.mock.calls.map(([cmd]) => cmd)).toEqual([
    "/export terse",
    add,
    remove,
    "/export terse",
    "/system identity print",
  ]);
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("step failure rolls back and surfaces the failed command", async () => {
  mocks.execute.mockImplementation(async (cmd: string) => (cmd === add ? "failure: denied" : ""));
  await expect(call("apply_plan", { commands: [add], confirm: true })).rejects.toThrow(
    /step .* failed/,
  );
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("unreachable device rolls back rather than committing", async () => {
  mocks.execute.mockImplementation(async (cmd: string) =>
    cmd === "/system identity print" ? "failure: timeout" : "",
  );
  await expect(call("apply_plan", { commands: [add], confirm: true })).rejects.toThrow("ABORTED");
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("successful commit and failed commit report distinct outcomes", async () => {
  expect(await call("apply_plan", { commands: [add], confirm: true })).toContain("COMMITTED");
  expect(mocks.rollback).not.toHaveBeenCalled();
  mocks.commit.mockResolvedValueOnce({ ok: false, message: "session lost" });
  await expect(call("apply_plan", { commands: [add], confirm: true })).rejects.toThrow(
    "COMMIT FAILED",
  );
  expect(mocks.rollback).not.toHaveBeenCalled();
});
