import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { backupTools } from "../src/tools/backup";

const state = vi.hoisted(() => ({ low: false, downloaded: Buffer.from("backup-data") }));
const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
const download = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({
  executeMikrotikCommand: command,
  downloadFileFromDevice: download,
  uploadFileToDevice: upload,
}));
vi.mock("../src/backups/disk-check", () => ({
  checkDiskSpace: async () => ({ low: state.low, usedPct: state.low ? 94 : 20 }),
}));
vi.mock("../src/backups/vault", () => ({
  backupDir: () => "/fixture-vault",
  writeBinaryBackup: () => "saved.backup",
  writeBackup: () => "saved.rsc",
}));

const ctx: ToolContext = { device: "backup-fixture", info: vi.fn(), error: vi.fn() };
const original = getConfig();
function tool(name: string) {
  const found = backupTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown backup tool ${name}`);
  return found;
}

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { "backup-fixture": { host: "192.0.2.1", port: 22 } },
      defaultDevice: "backup-fixture",
    }),
  );
  state.low = false;
  command.mockReset();
  download.mockReset().mockResolvedValue(state.downloaded);
  upload.mockReset().mockResolvedValue(undefined);
  command.mockImplementation(async (text) => {
    if (text.includes("count-only")) return "1";
    if (text.startsWith("/file print detail")) return "0 name=fixture.backup size=11";
    return "";
  });
});
afterEach(() => setConfig(original));

test("backup creation confirms the file and reports a device-side failure", async () => {
  const ok = await tool("create_backup").handler(
    { name: "fixture", dont_encrypt: true, include_password: true },
    ctx,
  );
  expect(ok).toContain("Backup created successfully");
  expect(command.mock.calls.map(([text]) => text)).toContain(
    "/system backup save name=fixture dont-encrypt=yes",
  );
  expect(command.mock.calls.map(([text]) => text)).toContain(
    "/file print detail where name=fixture.backup",
  );

  command.mockImplementation(async (text) =>
    text.startsWith("/system backup save") ? "failure: no disk" : "",
  );
  expect(await tool("create_backup").handler({ name: "fixture" }, ctx)).toContain(
    "Failed to create backup: failure: no disk",
  );
});

test("low disk backup is downloaded to local vault and removed only after successful transfer", async () => {
  state.low = true;
  const result = await tool("create_backup").handler({ name: "fixture" }, ctx);
  expect(result).toContain("saved.backup");
  expect(download).toHaveBeenCalledWith(ctx.device, "fixture.backup");
  expect(command.mock.calls.map(([text]) => text)).toContain("/file remove fixture.backup");

  command.mockClear();
  download.mockRejectedValueOnce(new Error("SFTP refused"));
  const failed = await tool("create_backup").handler({ name: "fixture" }, ctx);
  expect(failed).toContain("SFTP refused");
  expect(command.mock.calls.map(([text]) => text)).not.toContain("/file remove fixture.backup");
});

test("backup listing handles type and name filters and empty results", async () => {
  expect(
    await tool("list_backups").handler({ name_filter: "safe", include_exports: true }, ctx),
  ).toBe("No backup files found.");
  expect(command.mock.calls.at(-1)?.[0]).toContain("type=script");
  expect(command.mock.calls.at(-1)?.[0]).toContain('name~"safe"');
  command.mockResolvedValueOnce("0 name=safe.backup type=backup");
  expect(await tool("list_backups").handler({ include_exports: false }, ctx)).toContain(
    "BACKUP FILES",
  );
});

test("full export and section export use plain RouterOS script commands", async () => {
  const full = await tool("create_export").handler(
    {
      name: "full",
      file_format: "rsc",
      export_type: "full",
      hide_sensitive: true,
      verbose: false,
      compact: false,
    },
    ctx,
  );
  expect(full).toContain("Export created successfully");
  expect(command.mock.calls.map(([text]) => text)).toContain("/export file=full");
  const section = await tool("export_section").handler(
    { section: "ip address", name: "addresses", hide_sensitive: true, compact: true },
    ctx,
  );
  expect(section).toContain("Section export created successfully");
  expect(command.mock.calls.map(([text]) => text)).toContain(
    "/ip address export file=addresses compact",
  );
});

test("low disk exports stream text into the vault without writing a device file", async () => {
  state.low = true;
  command.mockResolvedValueOnce("/ip address\nadd address=192.0.2.1/24");
  expect(
    await tool("create_export").handler({ name: "full", hide_sensitive: true }, ctx),
  ).toContain("LOCAL VAULT");
  expect(command.mock.calls.map(([text]) => text)).toContain("/export");
  expect(command.mock.calls.some(([text]) => text.includes("file=full"))).toBe(false);
});

test("SFTP download and upload validate device file presence", async () => {
  command.mockResolvedValueOnce("0");
  expect(await tool("download_file").handler({ filename: "fixture.backup" }, ctx)).toContain(
    "not found",
  );
  expect(download).not.toHaveBeenCalled();
  expect(await tool("download_file").handler({ filename: "fixture.backup" }, ctx)).toBe(
    `FILE_CONTENT_BASE64:${state.downloaded.toString("base64")}`,
  );
  expect(
    await tool("upload_file").handler({ filename: "fixture.rsc", content_base64: "" }, ctx),
  ).toContain("Nothing to upload");
  expect(upload).not.toHaveBeenCalled();
  const uploaded = await tool("upload_file").handler(
    {
      filename: "fixture.rsc",
      content_base64: Buffer.from("/ip address print").toString("base64"),
    },
    ctx,
  );
  expect(uploaded).toContain("uploaded successfully");
  expect(upload).toHaveBeenCalledOnce();
});

test("restore, import and remove verify existence before any destructive command", async () => {
  for (const [name, args] of [
    ["restore_backup", { filename: "fixture.backup" }],
    ["import_configuration", { filename: "fixture.rsc" }],
    ["remove_file", { filename: "fixture.rsc" }],
  ] as const) {
    command.mockClear();
    command.mockResolvedValueOnce("0");
    expect(await tool(name).handler(args, ctx)).toContain("not found");
    expect(command).toHaveBeenCalledTimes(1);
  }
  expect(await tool("restore_backup").handler({ filename: "fixture.backup" }, ctx)).toContain(
    "System will reboot",
  );
  expect(await tool("import_configuration").handler({ filename: "fixture.rsc" }, ctx)).toContain(
    "imported successfully",
  );
  expect(await tool("remove_file").handler({ filename: "fixture.rsc" }, ctx)).toContain(
    "removed successfully",
  );
});

test("backup info distinguishes missing metadata from a real file", async () => {
  command.mockResolvedValueOnce("");
  expect(await tool("backup_info").handler({ filename: "missing.backup" }, ctx)).toContain(
    "not found",
  );
  expect(await tool("backup_info").handler({ filename: "fixture.backup" }, ctx)).toContain(
    "size=11",
  );
});
