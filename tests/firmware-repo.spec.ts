/// <reference types="bun" />
/** The local firmware repository: download once, stage by SFTP, finish after the reboot. */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";

const command = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("../src/core/connector", () => ({
  executeMikrotikCommand: command,
  uploadFileToDevice: upload,
}));
vi.mock("../src/core/runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveDeviceName: (name?: string) => name ?? "edge",
}));

const { architectureOf, firmwareRepoTools, listRepo, packageFile } =
  await import("../src/tools/firmware-repo");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-repo-"));
  vi.stubEnv("MIKROTIK_FIRMWARE_DIR", dir);
  command.mockReset();
  upload.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ctx = { device: "edge", info() {}, error() {} };
const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const tool = firmwareRepoTools.find((t) => t.name === name)!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool.inputSchema).parse(args),
    ctx,
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};

test("file names follow MikroTik's, and the architecture is read from the router", () => {
  expect(packageFile("routeros", "7.25.1", "arm64")).toBe("routeros-7.25.1-arm64.npk");
  expect(packageFile("wireless", "7.25.1", "x86")).toBe("wireless-7.25.1.npk");
  expect(architectureOf("x86_64")).toBe("x86");
  expect(architectureOf("arm64")).toBe("arm64");
  expect(architectureOf("riscv")).toBeUndefined();
});

test("fetch downloads only from MikroTik, keeps a checksum, and skips what it has", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("wireless") ? new Response("no", { status: 404 }) : new Response("PACKAGE-BYTES"),
  );
  vi.stubGlobal("fetch", fetchMock);
  const text = await run("firmware_repo_fetch", {
    version: "7.25.1",
    architecture: "arm64",
    packages: ["routeros", "wireless"],
  });
  expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
    "https://download.mikrotik.com/routeros/7.25.1/routeros-7.25.1-arm64.npk",
    "https://download.mikrotik.com/routeros/7.25.1/wireless-7.25.1-arm64.npk",
  ]);
  expect(text).toMatch(/routeros-7\.25\.1-arm64\.npk {2}0\.0 MiB {2}sha256 [0-9a-f]{64}/);
  expect(text).toContain("wireless-7.25.1-arm64.npk  NOT downloaded: HTTP 404");
  expect(readdirSync(dir)).toEqual(["routeros-7.25.1-arm64.npk"]);
  expect(listRepo()[0]!.bytes).toBe(13);

  fetchMock.mockClear();
  expect(await run("firmware_repo_fetch", { version: "7.25.1", architecture: "arm64" })).toContain(
    "already in the repository",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await run("firmware_repo_list", {})).toContain("routeros-7.25.1-arm64.npk");

  // Only a plain version and package name can reach the URL.
  const tool = firmwareRepoTools.find((t) => t.name === "firmware_repo_fetch")!;
  const schema = z.object(tool.inputSchema);
  expect(schema.safeParse({ version: "7.25.1/../../x", architecture: "arm64" }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({ version: "7.25.1", architecture: "arm64", packages: ["../x"] }).success,
  ).toBe(false);
});

const router = (version: string) => async (cmd: string) => {
  if (cmd === "/system resource print")
    return `  version: ${version} (stable)\n  architecture-name: arm64\n  free-hdd-space: 90000000`;
  if (cmd === "/system package print detail")
    return ' 0 name="routeros" version="7.24"\n 1 name="wireless" version="7.24"\n 2 X name="iot" disabled=yes';
  if (cmd.startsWith("/file print count-only")) return "1";
  return "";
};

test("staging needs every installed package, shows a plan first, then uploads and verifies", async () => {
  command.mockImplementation(router("7.24"));
  writeFileSync(join(dir, "routeros-7.25.1-arm64.npk"), "A".repeat(100));
  const missing = await run("firmware_stage_from_repo", { version: "7.25.1", apply: true });
  expect(missing).toContain("wireless-7.25.1-arm64.npk  MISSING from the repository");
  expect(missing).toContain(
    'firmware_repo_fetch version=7.25.1 architecture=arm64 packages=["wireless"]',
  );
  expect(upload).not.toHaveBeenCalled();

  writeFileSync(join(dir, "wireless-7.25.1-arm64.npk"), "B".repeat(50));
  expect(await run("firmware_stage_from_repo", { version: "7.25.1" })).toContain("DRY RUN");
  expect(upload).not.toHaveBeenCalled();

  const staged = await run("firmware_stage_from_repo", { version: "7.25.1", apply: true });
  // The disabled package is not staged.
  expect(upload.mock.calls.map((c) => c[1])).toEqual([
    "routeros-7.25.1-arm64.npk",
    "wireless-7.25.1-arm64.npk",
  ]);
  expect(staged).toContain("Staged 2 package(s)");
  expect(staged).toContain("still runs 7.24");
  // Nothing rebooted the router.
  expect(command.mock.calls.some((c) => /reboot/.test(String(c[0])))).toBe(false);

  command.mockImplementation(router("7.25.1"));
  expect(await run("firmware_stage_from_repo", { version: "7.25.1", apply: true })).toContain(
    "already runs RouterOS 7.25.1",
  );
});

test("a failed upload says not to reboot", async () => {
  command.mockImplementation(router("7.24"));
  writeFileSync(join(dir, "routeros-7.25.1-arm64.npk"), "A");
  writeFileSync(join(dir, "wireless-7.25.1-arm64.npk"), "B");
  upload
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
  const text = await run("firmware_stage_from_repo", { version: "7.25.1", apply: true });
  expect(text).toContain("Uploaded 1 of 2, then FAILED at wireless-7.25.1-arm64.npk: disk full");
  expect(text).toContain("Do not reboot");
});

test("after the reboot: version check, RouterBOOT after RouterOS, then checked commands", async () => {
  const sent: string[] = [];
  const board = (current: string) => async (cmd: string) => {
    sent.push(cmd);
    if (cmd === "/system resource print") return "  version: 7.25.1 (stable)";
    if (cmd === "/system routerboard print")
      return `  current-firmware: ${current}\n  upgrade-firmware: 7.25.1`;
    if (cmd.startsWith(":put [:parse"))
      return cmd.includes("adress")
        ? "(<%% bad command name adress (line 1 column 5))"
        : "(evl ok)";
    return "";
  };
  command.mockImplementation(board("7.24"));
  expect(await run("firmware_post_upgrade", { expected_version: "7.26" })).toContain(
    "the upgrade did not take effect",
  );
  expect(await run("firmware_post_upgrade", { expected_version: "7.25.1" })).toContain(
    "RouterBOOT: 7.24; 7.25.1 is available",
  );

  sent.length = 0;
  const done = await run("firmware_post_upgrade", {
    upgrade_routerboard: true,
    commands: ["/system note set note=upgraded"],
  });
  expect(done).toContain("RouterBOOT: 7.24 to 7.25.1 queued");
  expect(done).toContain("Ran 1 command(s).");
  expect(sent.indexOf("/system routerboard upgrade")).toBeGreaterThan(
    sent.indexOf("/system resource print"),
  );

  sent.length = 0;
  command.mockImplementation(board("7.25.1"));
  const refused = await run("firmware_post_upgrade", {
    commands: ["/system note set note=a", "/ip adress print"],
  });
  expect(refused).toContain("up to date");
  expect(refused).toContain("No command was run");
  expect(sent).not.toContain("/system note set note=a");
});
