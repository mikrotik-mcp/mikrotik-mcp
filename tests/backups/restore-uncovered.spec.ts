import { beforeEach, expect, test, vi } from "vite-plus/test";
import { restoreLocalBackup } from "../../src/backups/restore";

const rig = vi.hoisted(() => ({
  mac: false,
  body: "/system identity\nset name=Lab\n/ip firewall filter\nadd chain=input action=accept",
  enable: vi.fn(async () => "Safe mode ENABLED"),
  execute: vi.fn(async (_command: string) => ""),
  rollback: vi.fn(async () => ({ ok: true })),
  commit: vi.fn(async () => ({ ok: true, message: "saved" })),
  read: vi.fn(() => rig.body),
}));
vi.mock("../../src/core/runtime", () => ({
  getDevice: () => ({ mac: rig.mac ? "00:11:22:33:44:55" : undefined }),
}));
vi.mock("../../src/backups/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/vault")>()),
  readBackup: rig.read,
}));
vi.mock("../../src/ssh/safe-mode", () => ({ getSafeModeManager: () => rig }));

beforeEach(() => {
  rig.mac = false;
  rig.body = "/system identity\nset name=Lab\n/ip firewall filter\nadd chain=input action=accept";
  vi.clearAllMocks();
  rig.enable.mockResolvedValue("Safe mode ENABLED");
  rig.execute.mockResolvedValue("");
  rig.commit.mockResolvedValue({ ok: true, message: "saved" });
  rig.read.mockImplementation(() => rig.body);
});

test("dry run replays both export commands, checks reachability, and rolls back", async () => {
  expect(await restoreLocalBackup("lab", "before.rsc", false)).toMatchObject({
    ok: true,
    applied: 2,
    committed: false,
  });
  expect(rig.execute.mock.calls.map(([command]) => command)).toEqual([
    "/system identity set name=Lab",
    "/ip firewall filter add chain=input action=accept",
    "/system identity print",
  ]);
  expect(rig.rollback).toHaveBeenCalledOnce();
  expect(rig.commit).not.toHaveBeenCalled();
});

test("confirmed restore commits only after identity responds", async () => {
  expect(await restoreLocalBackup("lab", "before.rsc", true)).toMatchObject({
    ok: true,
    applied: 2,
    committed: true,
  });
  expect(rig.commit).toHaveBeenCalledOnce();
  expect(rig.rollback).not.toHaveBeenCalled();
});

test("command rejection reports partial progress and rolls back", async () => {
  rig.execute.mockImplementation(async (command) =>
    command.includes("firewall") ? "failure: bad rule" : "",
  );
  const result = await restoreLocalBackup("lab", "before.rsc", true);
  expect(result).toMatchObject({ ok: false, applied: 1, committed: false });
  expect(result.message).toContain("2/2");
  expect(rig.rollback).toHaveBeenCalledOnce();
  expect(rig.commit).not.toHaveBeenCalled();
});

test("unreachable device rolls back; failed commit stays unconfirmed", async () => {
  rig.execute.mockImplementation(async (command) =>
    command === "/system identity print" ? "failure: timeout" : "",
  );
  expect(await restoreLocalBackup("lab", "before.rsc", true)).toMatchObject({
    ok: false,
    applied: 2,
    committed: false,
  });
  expect(rig.rollback).toHaveBeenCalledOnce();
  rig.execute.mockResolvedValue("");
  rig.commit.mockResolvedValue({ ok: false, message: "session dropped" });
  const result = await restoreLocalBackup("lab", "before.rsc", true);
  expect(result.message).toContain("COMMIT FAILED");
  expect(rig.rollback).toHaveBeenCalledTimes(1);
});

test("rejects MAC transport, missing or empty backup, and Safe Mode refusal before replay", async () => {
  rig.mac = true;
  expect((await restoreLocalBackup("lab", "before.rsc", true)).message).toContain("requires SSH");
  rig.mac = false;
  rig.read.mockImplementation(() => {
    throw new Error("missing");
  });
  expect((await restoreLocalBackup("lab", "missing.rsc", true)).message).toContain("not found");
  rig.read.mockReturnValue("# only a comment");
  expect((await restoreLocalBackup("lab", "empty.rsc", true)).message).toContain(
    "no applicable commands",
  );
  rig.read.mockImplementation(() => rig.body);
  rig.enable.mockResolvedValue("Error: busy");
  expect((await restoreLocalBackup("lab", "before.rsc", true)).message).toBe("Error: busy");
  expect(rig.execute).not.toHaveBeenCalled();
});

test("unexpected SSH exception rolls back and reports the cause", async () => {
  rig.execute.mockRejectedValue(new Error("connection reset"));
  expect((await restoreLocalBackup("lab", "before.rsc", true)).message).toContain(
    "connection reset",
  );
  expect(rig.rollback).toHaveBeenCalledOnce();
});
