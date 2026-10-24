import { beforeEach, expect, test, vi } from "vite-plus/test";
import { backupTools } from "../src/tools/backup";

const mocks = vi.hoisted(() => ({
  disk: vi.fn(),
  command: vi.fn(),
  write: vi.fn(),
  dir: vi.fn(),
  resolve: vi.fn(),
  stamp: vi.fn(),
}));
vi.mock("../src/backups/disk-check", () => ({ checkDiskSpace: mocks.disk }));
vi.mock("../src/core/datestamp", () => ({ deviceDateStamp: mocks.stamp }));
vi.mock("../src/backups/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/backups/vault")>()),
  writeBackup: mocks.write,
  backupDir: mocks.dir,
}));
vi.mock("../src/core/connector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/connector")>()),
  executeMikrotikCommand: mocks.command,
}));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  resolveDeviceName: mocks.resolve,
}));

const ctx = { device: "lab", info: vi.fn() };
const tool = backupTools.find((entry) => entry.name === "export_section");
if (!tool) throw new Error("export_section missing");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.disk.mockResolvedValue({ low: true, usedPct: 96 });
  mocks.resolve.mockReturnValue("lab");
  mocks.dir.mockReturnValue("/private/vault");
  mocks.write.mockReturnValue("lab_export.rsc");
  mocks.stamp.mockResolvedValue("2026-10-24");
});

test("low disk backup failure recommends local export without claiming a saved file", async () => {
  const create = backupTools.find((entry) => entry.name === "create_backup");
  if (!create) throw new Error("create_backup missing");
  mocks.command.mockResolvedValueOnce("failure: not enough space");
  const result = await create.handler(
    { dont_encrypt: false, include_password: true },
    ctx as never,
  );
  expect(result).toContain("device disk is 96% used");
  expect(result).toContain("create_local_backup");
  expect(mocks.command.mock.calls[0][0]).toContain("backup_2026-10-24");
  expect(mocks.write).not.toHaveBeenCalled();
});

test("low disk streams section export into local vault without a router file", async () => {
  mocks.command.mockResolvedValueOnce("/ip address add address=192.0.2.1/24");
  const result = await tool.handler(
    { section: "ip address", name: "export", hide_sensitive: true, compact: false },
    ctx as never,
  );
  expect(result).toContain("LOCAL VAULT");
  expect(result).toContain("96% used");
  expect(mocks.command.mock.calls[0][0]).toBe("/ip address export");
  expect(mocks.write).toHaveBeenCalledWith(
    "lab_export.rsc",
    "/ip address add address=192.0.2.1/24",
  );
});

test("low-disk export handles empty/error output without writing the vault", async () => {
  mocks.command.mockResolvedValueOnce("failure: denied");
  const result = await tool.handler(
    { section: "ip firewall filter", name: "filter", hide_sensitive: false, compact: true },
    ctx as never,
  );
  expect(result).toContain("Failed to export section");
  expect(mocks.command.mock.calls[0][0]).toContain("show-sensitive compact");
  expect(mocks.write).not.toHaveBeenCalled();
});

test("unnamed section export derives a stable device-local filename", async () => {
  mocks.command.mockResolvedValueOnce("/ip address print");
  const result = await tool.handler(
    { section: "ip/address", hide_sensitive: true, compact: false },
    ctx as never,
  );
  expect(result).toContain("LOCAL VAULT");
  expect(mocks.stamp).toHaveBeenCalledWith(ctx);
  expect(mocks.write.mock.calls[0][0]).toContain("export_ip_address_2026-10-24.rsc");
});

test("normal-disk section export reports a RouterOS write failure", async () => {
  mocks.disk.mockResolvedValueOnce({ low: false, usedPct: 40 });
  mocks.command.mockResolvedValueOnce("failure: permission denied");
  const result = await tool.handler(
    { section: "ip address", name: "addresses", hide_sensitive: true, compact: false },
    ctx as never,
  );
  expect(result).toContain("Failed to export section: failure: permission denied");
  expect(mocks.command.mock.calls[0][0]).toContain("file=addresses");
  expect(mocks.write).not.toHaveBeenCalled();
});

test("backup listing narrows names without including script exports", async () => {
  const list = backupTools.find((entry) => entry.name === "list_backups");
  if (!list) throw new Error("list_backups missing");
  mocks.command.mockResolvedValueOnce("name=daily.backup type=backup");
  const result = await list.handler({ name_filter: "daily", include_exports: false }, ctx as never);
  expect(result).toContain("daily.backup");
  expect(mocks.command.mock.calls[0][0]).toBe('/file print where type=backup and name~"daily"');
});

test("full export surfaces a RouterOS failure without claiming a saved script", async () => {
  const create = backupTools.find((entry) => entry.name === "create_export");
  if (!create) throw new Error("create_export missing");
  mocks.disk.mockResolvedValueOnce({ low: false, usedPct: 40 });
  mocks.command.mockResolvedValueOnce("failure: permission denied");
  const result = await create.handler(
    { name: "full", hide_sensitive: true, compact: false, verbose: false },
    ctx as never,
  );
  expect(result).toContain("Failed to create export");
  expect(mocks.write).not.toHaveBeenCalled();
});
