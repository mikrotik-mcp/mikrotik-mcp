import { beforeEach, expect, test, vi } from "vite-plus/test";
import { busyDevices, createDeviceExecutor, runAssertion } from "../../src/txn/coordinator";

const rig = vi.hoisted(() => ({
  active: new Set<string>(),
  enable: vi.fn(async () => "Safe mode ENABLED"),
  execute: vi.fn(async (_command: string) => ""),
  commit: vi.fn(async () => ({ ok: true, message: "saved" })),
  rollback: vi.fn(async () => ({ ok: true })),
  snapshot: vi.fn(async () => "snapshot-1"),
  command: vi.fn(async () => ""),
}));
vi.mock("../../src/core/runtime", () => ({ resolveDeviceName: (name: string) => name }));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: (device: string) => ({
    get isActive() {
      return rig.active.has(device);
    },
    enable: rig.enable,
    execute: rig.execute,
    commit: rig.commit,
    rollback: rig.rollback,
  }),
}));
vi.mock("../../src/snapshots/capture", () => ({ captureSnapshot: rig.snapshot }));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: rig.command }));

const ctx = { device: "edge" } as Parameters<typeof createDeviceExecutor>[0];
beforeEach(() => {
  rig.active.clear();
  vi.clearAllMocks();
  rig.enable.mockResolvedValue("Safe mode ENABLED");
  rig.execute.mockResolvedValue("");
  rig.commit.mockResolvedValue({ ok: true, message: "saved" });
  rig.command.mockResolvedValue("");
});

test("refuses a device already owned by another Safe Mode session", () => {
  rig.active.add("edge");
  expect(busyDevices(["edge", "spare"])).toEqual(["edge"]);
});

test("real executor snapshots before applying steps and commits a prepared device", async () => {
  const executor = createDeviceExecutor(ctx, "txn-7");
  expect(await executor.snapshot("edge")).toBe("snapshot-1");
  expect(rig.snapshot).toHaveBeenCalledWith(
    expect.objectContaining({ device: "edge" }),
    "pre-txn txn-7",
  );
  await executor.prepare("edge", ["/ip address add address=192.0.2.1/32", "/ip route print"]);
  expect(rig.execute.mock.calls.map(([command]) => command)).toEqual([
    "/ip address add address=192.0.2.1/32",
    "/ip route print",
  ]);
  await executor.commit("edge");
  expect(rig.commit).toHaveBeenCalledOnce();
});

test("prepare stops at a rejected RouterOS command without applying later steps", async () => {
  rig.execute.mockResolvedValueOnce("").mockResolvedValueOnce("failure: bad gateway");
  await expect(
    createDeviceExecutor(ctx, "txn-7").prepare("edge", ["first", "second", "third"]),
  ).rejects.toThrow("second -> failure: bad gateway");
  expect(rig.execute).toHaveBeenCalledTimes(2);
});

test("Safe Mode refusal and commit rejection propagate; restore points require manual recovery", async () => {
  const executor = createDeviceExecutor(ctx, "txn-7");
  rig.enable.mockResolvedValue("Error: already active");
  await expect(executor.prepare("edge", ["change"])).rejects.toThrow("already active");
  expect(rig.execute).not.toHaveBeenCalled();
  rig.commit.mockResolvedValue({ ok: false, message: "connection lost" });
  await expect(executor.commit("edge")).rejects.toThrow("connection lost");
  await expect(executor.restore("edge", undefined)).rejects.toThrow("No pre-change snapshot");
  await expect(executor.restore("edge", "snapshot-1")).rejects.toThrow("snapshot-1");
  await executor.rollback("edge");
  expect(rig.rollback).toHaveBeenCalledOnce();
});

test("declarative assertions distinguish successful evidence from RouterOS failures", async () => {
  const ping = { kind: "ping" as const, from: "edge", to: "192.0.2.2" };
  rig.command
    .mockResolvedValueOnce("sent=3 received=2 packet-loss=33%")
    .mockResolvedValueOnce("sent=3 received=0 packet-loss=100%")
    .mockResolvedValueOnce("failure: timeout");
  expect((await runAssertion(ctx, ping)).ok).toBe(true);
  expect((await runAssertion(ctx, ping)).ok).toBe(false);
  expect((await runAssertion(ctx, ping)).detail).toContain("timeout");
  rig.command.mockResolvedValueOnce("last-handshake=3s").mockResolvedValueOnce("interface=wg0");
  const handshake = { kind: "wireguard-peer-handshake" as const, device: "edge", peer: "key" };
  expect((await runAssertion(ctx, handshake)).ok).toBe(true);
  expect((await runAssertion(ctx, handshake)).ok).toBe(false);
  rig.command.mockResolvedValueOnce("1").mockResolvedValueOnce("0");
  const route = { kind: "route-present" as const, device: "edge", dst: "198.51.100.0/24" };
  expect((await runAssertion(ctx, route)).ok).toBe(true);
  expect((await runAssertion(ctx, route)).ok).toBe(false);
  rig.command.mockResolvedValueOnce("name=edge").mockResolvedValueOnce("");
  const reachable = { kind: "reachable" as const, device: "edge" };
  expect((await runAssertion(ctx, reachable)).ok).toBe(true);
  expect((await runAssertion(ctx, reachable)).ok).toBe(false);
  rig.command.mockRejectedValueOnce(new Error("SSH unavailable"));
  expect((await runAssertion(ctx, reachable)).detail).toBe("SSH unavailable");
});
