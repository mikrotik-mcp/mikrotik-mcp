import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { s3BackupTools } from "../src/tools/s3-backup";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  configured: vi.fn(),
  presign: vi.fn(),
  list: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/core/datestamp", () => ({ deviceDateStamp: async () => "20261024-120000" }));
vi.mock("../src/core/s3", () => ({
  isS3Configured: mocks.configured,
  s3Target: () => "s3://fixture/backups",
  s3Key: (name: string) => `backups/fixture/${name}`,
  s3DevicePrefix: () => "backups/fixture/",
  presignExpiresIn: () => 300,
  getS3Client: () => ({
    presign: mocks.presign,
    list: mocks.list,
    exists: mocks.exists,
    stat: mocks.stat,
    delete: mocks.delete,
  }),
}));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = s3BackupTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.resetAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.configured.mockReturnValue(true);
  mocks.presign.mockReturnValue("https://s3.example.test/presigned");
  mocks.command.mockImplementation(async (command: string) =>
    command.includes("count-only") ? "1" : "status: finished",
  );
  mocks.list.mockResolvedValue({ contents: [], isTruncated: false });
  mocks.exists.mockResolvedValue(true);
  mocks.stat.mockResolvedValue({
    size: 42,
    type: "application/octet-stream",
    etag: "etag-1",
    lastModified: new Date("2026-10-24T00:00:00Z"),
  });
  mocks.delete.mockResolvedValue(undefined);
});
afterEach(() => setConfig(initial));

test("unconfigured S3 refuses every operation before router or cloud I/O", async () => {
  mocks.configured.mockReturnValue(false);
  for (const name of s3BackupTools.map((tool) => tool.name)) {
    expect(
      await call(name, { filename: "daily.backup", key: "backups/daily.backup", max_keys: 100 }),
    ).toContain("S3 is not configured");
  }
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.presign).not.toHaveBeenCalled();
});

test("upload checks device file before presigning and uses a scoped PUT", async () => {
  mocks.command.mockResolvedValueOnce("0");
  expect(await call("upload_backup_to_s3", { filename: "daily.backup" })).toContain(
    "not found on the device",
  );
  expect(mocks.presign).not.toHaveBeenCalled();
  const output = await call("upload_backup_to_s3", {
    filename: "daily.backup",
    key: "chosen/daily.backup",
    expires_in: 600,
  });
  expect(output).toContain("Uploaded 'daily.backup'");
  expect(mocks.presign).toHaveBeenCalledWith("chosen/daily.backup", {
    method: "PUT",
    expiresIn: 600,
  });
  const issued = mocks.command.mock.calls.map(([command]) => String(command));
  expect(issued.at(-1)).toContain("http-method=put");
  expect(issued.at(-1)).toContain("src-path=daily.backup");
  expect(issued.at(-1)).not.toContain("mode=");
});

test("upload and download distinguish presign errors from incomplete RouterOS fetch", async () => {
  mocks.presign.mockImplementationOnce(() => {
    throw new Error("credential expired");
  });
  expect(await call("upload_backup_to_s3", { filename: "daily.backup", key: "k" })).toContain(
    "credential expired",
  );
  mocks.command.mockImplementation(async (command: string) =>
    command.includes("count-only") ? "1" : "status: failed",
  );
  expect(await call("upload_backup_to_s3", { filename: "daily.backup", key: "k" })).toContain(
    "Failed to upload",
  );
  mocks.presign.mockImplementationOnce(() => {
    throw new Error("presign blocked");
  });
  expect(await call("download_backup_from_s3", { key: "backups/daily.backup" })).toContain(
    "presign blocked",
  );
  expect(await call("download_backup_from_s3", { key: "backups/daily.backup" })).toContain(
    "Failed to download",
  );
});

test("download uses the object basename and does not add a conflicting fetch mode", async () => {
  expect(await call("download_backup_from_s3", { key: "backups/fixture/daily.backup" })).toContain(
    "device file 'daily.backup'",
  );
  expect(mocks.presign).toHaveBeenCalledWith("backups/fixture/daily.backup", {
    method: "GET",
    expiresIn: 300,
  });
  const command = String(mocks.command.mock.calls.at(-1)?.[0]);
  expect(command).toContain("dst-path=daily.backup");
  expect(command).not.toContain("mode=");
});

test("listing and metadata stay server-side and disclose empty, truncated and missing objects", async () => {
  expect(await call("list_s3_backups", { max_keys: 10 })).toContain("No S3 objects");
  mocks.list.mockResolvedValue({
    contents: [{ key: "k", size: 42, lastModified: "2026-10-24" }],
    isTruncated: true,
  });
  expect(await call("list_s3_backups", { prefix: "", max_keys: 10 })).toContain(
    "more results available",
  );
  expect(mocks.list).toHaveBeenLastCalledWith({ prefix: undefined, maxKeys: 10 });
  mocks.exists.mockResolvedValueOnce(false);
  expect(await call("s3_backup_info", { key: "missing" })).toContain("not found");
  expect(await call("s3_backup_info", { key: "k" })).toContain("42 bytes");
  expect(mocks.command).not.toHaveBeenCalled();
});

test("delete only targets an existing key and reports cloud failures", async () => {
  mocks.exists.mockResolvedValueOnce(false);
  expect(await call("delete_s3_backup", { key: "missing" })).toContain("not found");
  expect(mocks.delete).not.toHaveBeenCalled();
  expect(await call("delete_s3_backup", { key: "k" })).toContain("deleted successfully");
  expect(mocks.delete).toHaveBeenCalledWith("k");
  mocks.delete.mockRejectedValueOnce(new Error("access denied"));
  expect(await call("delete_s3_backup", { key: "k" })).toContain("access denied");
});
