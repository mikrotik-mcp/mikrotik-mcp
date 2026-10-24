import { beforeEach, expect, test, vi } from "vite-plus/test";
import { localBackupTools } from "../src/tools/local-backup";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  restore: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../src/backups/create", () => ({ createLocalBackup: mocks.create }));
vi.mock("../src/backups/restore", () => ({ restoreLocalBackup: mocks.restore }));
vi.mock("../src/backups/vault", () => ({
  backupDir: () => "/fixture-vault",
  listBackups: mocks.list,
  readBackup: mocks.read,
  renameBackup: mocks.rename,
  deleteBackup: mocks.remove,
}));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  resolveDeviceName: mocks.resolve,
}));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown> = {}) {
  const tool = localBackupTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolve.mockReturnValue("lab");
  mocks.list.mockReturnValue([]);
});

test("creation passes export options and reports the saved host-side file or capture failure", async () => {
  mocks.create
    .mockResolvedValueOnce({ ok: true, name: "lab_1.rsc", bytes: 42, device: "lab" })
    .mockResolvedValueOnce({ ok: false, error: "export denied" });
  expect(
    await call("create_local_backup", {
      label: "before",
      show_sensitive: false,
      verbose: true,
      compact: false,
      terse: true,
    }),
  ).toContain("lab_1.rsc' (42 bytes)");
  expect(mocks.create).toHaveBeenCalledWith(ctx, {
    label: "before",
    showSensitive: false,
    verbose: true,
    compact: false,
    terse: true,
  });
  expect(await call("create_local_backup")).toContain("export denied");
});

test("listing formats the device and capture time while empty vault directs creation", async () => {
  expect(await call("list_local_backups")).toContain("No local backups");
  mocks.list.mockReturnValue([
    { name: "lab.rsc", bytes: 12, device: "lab", modified: "2026-01-01T00:00:00Z" },
  ]);
  expect(await call("list_local_backups")).toContain(
    "lab.rsc  (12 bytes, lab, 2026-01-01T00:00:00.000Z)",
  );
});

test("read, rename, and delete distinguish success, missing file, and vault errors", async () => {
  mocks.read
    .mockReturnValueOnce("/ip address\nadd address=192.0.2.1")
    .mockImplementationOnce(() => {
      throw new Error("missing");
    });
  expect(await call("get_local_backup", { name: "lab.rsc" })).toContain("add address=192.0.2.1");
  expect(await call("get_local_backup", { name: "missing.rsc" })).toContain("not found");
  mocks.rename.mockReturnValueOnce("renamed.rsc").mockImplementationOnce(() => {
    throw new Error("target exists");
  });
  expect(await call("rename_local_backup", { name: "lab.rsc", new_name: "renamed" })).toContain(
    "renamed.rsc",
  );
  expect(mocks.rename).toHaveBeenCalledWith("lab.rsc", "renamed");
  expect(await call("rename_local_backup", { name: "lab.rsc", new_name: "renamed" })).toContain(
    "target exists",
  );
  mocks.remove
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      throw new Error("read only");
    });
  expect(await call("delete_local_backup", { name: "missing.rsc" })).toContain("not found");
  expect(await call("delete_local_backup", { name: "lab.rsc" })).toContain("Deleted local backup");
  expect(await call("delete_local_backup", { name: "lab.rsc" })).toContain("read only");
});

test("restore reports failed, rolled-back, and committed outcomes for the selected device", async () => {
  mocks.restore
    .mockResolvedValueOnce({ ok: false, message: "cannot enter Safe Mode" })
    .mockResolvedValueOnce({ ok: true, committed: false, applied: 4 })
    .mockResolvedValueOnce({ ok: true, committed: true, message: "reachable" });
  expect(await call("restore_local_backup", { name: "lab.rsc", confirm: false })).toContain(
    "FAILED: cannot enter Safe Mode",
  );
  expect(await call("restore_local_backup", { name: "lab.rsc", confirm: false })).toContain(
    "applied 4 command(s) then rolled everything back",
  );
  expect(await call("restore_local_backup", { name: "lab.rsc", confirm: true })).toContain(
    "COMMITTED",
  );
  expect(mocks.restore).toHaveBeenNthCalledWith(3, "lab", "lab.rsc", true);
});
