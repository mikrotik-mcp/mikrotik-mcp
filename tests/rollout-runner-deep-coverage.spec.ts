import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDeviceExecutor, deviceAnswers, probeReachability } from "../src/rollout/runner";

const mock = vi.hoisted(() => ({
  commands: [] as string[],
  rollback: vi.fn(async () => undefined),
  commit: vi.fn(async () => ({ ok: true, message: "ok" })),
  enable: vi.fn(async () => "Safe mode ENABLED"),
  execute: vi.fn(async (command: string) => {
    mock.commands.push(command);
    return "ok";
  }),
  probe: vi.fn(async () => ({ reachable: true })),
  connector: vi.fn(async () => "identity"),
  snapshot: vi.fn(async () => "snapshot-1"),
}));
vi.mock("../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    enable: mock.enable,
    execute: mock.execute,
    commit: mock.commit,
    rollback: mock.rollback,
  }),
}));
vi.mock("../src/core/runtime", () => ({
  resolveDeviceName: (device: string) => device,
  getDevice: (device: string) => ({ name: device }),
}));
vi.mock("../src/observability/health", () => ({ probeDevice: mock.probe }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mock.connector }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mock.snapshot }));
vi.mock("../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({ get: () => undefined }),
}));
vi.mock("../src/logger", () => ({ logger: { info: vi.fn() } }));

const ctx = { device: "original" } as Parameters<typeof createDeviceExecutor>[0];
beforeEach(() => {
  mock.commands = [];
  vi.clearAllMocks();
  mock.enable.mockResolvedValue("Safe mode ENABLED");
  mock.execute.mockImplementation(async (command: string) => {
    mock.commands.push(command);
    return "ok";
  });
  mock.commit.mockResolvedValue({ ok: true, message: "ok" });
  mock.probe.mockResolvedValue({ reachable: true });
  mock.connector.mockResolvedValue("identity");
});

describe("rollout device adapter", () => {
  it("snapshots the selected device and verifies reachability before committing", async () => {
    const executor = createDeviceExecutor(ctx, "roll-1");
    expect(await executor.snapshot("edge")).toBe("snapshot-1");
    expect(mock.snapshot).toHaveBeenCalledWith({ device: "edge" }, "pre-rollout roll-1");
    await executor.apply("edge", ["/first", "/second"]);
    expect(mock.commands).toEqual(["/first", "/second", "/system identity print"]);
    expect(mock.commit).toHaveBeenCalledTimes(1);
    expect(mock.rollback).not.toHaveBeenCalled();
    await expect(executor.apply("edge", [])).rejects.toThrow("no commands");
  });

  it("rolls back parser errors and a failed identity probe without committing", async () => {
    const executor = createDeviceExecutor(ctx, "roll-1");
    mock.execute.mockResolvedValueOnce("failure: bad value");
    await expect(executor.apply("edge", ["/bad"])).rejects.toThrow(/bad value/);
    expect(mock.rollback).toHaveBeenCalledTimes(1);
    expect(mock.commit).not.toHaveBeenCalled();
    mock.execute.mockResolvedValueOnce("ok").mockResolvedValueOnce("failure: disconnected");
    await expect(executor.apply("edge", ["/good"])).rejects.toThrow(/not committed/);
    expect(mock.rollback).toHaveBeenCalledTimes(2);
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it("reports Safe Mode acquisition and commit failures", async () => {
    const executor = createDeviceExecutor(ctx, "roll-1");
    mock.enable.mockResolvedValueOnce("Error: busy");
    await expect(executor.apply("edge", ["/good"])).rejects.toThrow("Error: busy");
    expect(mock.execute).not.toHaveBeenCalled();
    mock.commit.mockResolvedValueOnce({ ok: false, message: "commit lost" });
    await expect(executor.apply("edge", ["/good"])).rejects.toThrow("commit lost");
  });

  it("treats failed probes and command errors as unreachable", async () => {
    mock.probe.mockRejectedValueOnce(new Error("offline"));
    expect(await probeReachability(["a", "b"])).toEqual({ a: false, b: true });
    const health = await createDeviceExecutor(ctx, "roll-1").health(["a", "a"], ["b"]);
    expect(health.map((item) => item.device)).toEqual(["a", "b"]);
    mock.connector.mockResolvedValueOnce("failure: no route");
    expect(await deviceAnswers(ctx, "a")).toBe(false);
    mock.connector.mockResolvedValueOnce("  ");
    expect(await deviceAnswers(ctx, "a")).toBe(false);
    mock.connector.mockRejectedValueOnce(new Error("offline"));
    expect(await deviceAnswers(ctx, "a")).toBe(false);
    expect(await deviceAnswers(ctx, "b")).toBe(true);
    expect(mock.connector).toHaveBeenLastCalledWith("/system identity print", { device: "b" });
  });

  it("refuses missing snapshot references before opening a restore session", async () => {
    await expect(createDeviceExecutor(ctx, "roll-1").revert("edge", undefined)).rejects.toThrow(
      /no pre-change snapshot/,
    );
    expect(mock.enable).not.toHaveBeenCalled();
  });
});
