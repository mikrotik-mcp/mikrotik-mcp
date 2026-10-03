/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, serializeConfig } from "../../src/config-write";
import { getConfigSource, loadConfig, MikrotikConfigSchema } from "../../src/config";
import { createConfigAdmin } from "../../src/observability/config-admin";
import { createMcpSettingsService } from "../../src/core/mcp-settings";
import { PROJECT_ROOT } from "../../src/paths";

// Simulate Linux refusing rename over a single-file bind mount, keeping all
// other filesystem operations real so bytes, backups and inode tests matter.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeSync: vi.fn(actual.writeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

let dir: string;
let path: string;
beforeEach(() => {
  vi.resetAllMocks();
  dir = fs.mkdtempSync(join(tmpdir(), "mcp-mounted-config-"));
  path = join(dir, "devices.json");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function mockMount(code = "EBUSY") {
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (to === path) throw Object.assign(new Error("simulated mount error"), { code });
    return rename(from, to);
  });
}

describe("bind-mounted configuration persistence", () => {
  test.each(["short", "Unicode: فارسی 🔒".repeat(100)])(
    "preserves the inode and backs up before saving: %s",
    (next) => {
      fs.writeFileSync(path, "previous configuration".repeat(100), { mode: 0o600 });
      const before = fs.readFileSync(path, "utf8");
      const inode = fs.statSync(path).ino;
      mockMount();
      atomicWrite(path, next);
      expect(fs.readFileSync(path, "utf8")).toBe(next);
      expect(fs.statSync(path).ino).toBe(inode);
      const backup = fs.readdirSync(dir).find((p) => p.startsWith("devices.json.bak-mounted-"))!;
      expect(fs.readFileSync(join(dir, backup), "utf8")).toBe(before);
      expect(fs.statSync(join(dir, backup)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).some((p) => p.includes(".tmp-"))).toBe(false);
    },
  );

  test.each(["EROFS", "EACCES", "EPERM", "EIO"])(
    "does not downgrade %s to an in-place write",
    (code) => {
      fs.writeFileSync(path, "unchanged");
      mockMount(code);
      expect(() => atomicWrite(path, "new")).toThrow("simulated mount error");
      expect(fs.readFileSync(path, "utf8")).toBe("unchanged");
      expect(fs.readdirSync(dir)).toEqual(["devices.json"]);
    },
  );

  test("restores original bytes after a partial write failure", () => {
    fs.writeFileSync(path, "old configuration");
    mockMount();
    const write = vi.mocked(fs.writeSync).getMockImplementation()!;
    vi.mocked(fs.writeSync).mockImplementationOnce((...args: Parameters<typeof fs.writeSync>) => {
      write(...args);
      throw new Error("disk error");
    });
    expect(() => atomicWrite(path, "new much longer configuration")).toThrow(
      "previous contents restored",
    );
    expect(fs.readFileSync(path, "utf8")).toBe("old configuration");
  });

  test("does not change mounted bytes when a durable backup cannot be written", () => {
    fs.writeFileSync(path, "unchanged");
    mockMount();
    const write = vi.mocked(fs.writeFileSync).getMockImplementation()!;
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (String(file).includes(".bak-mounted-")) throw new Error("backup unavailable");
      return write(file, data, options);
    });
    expect(() => atomicWrite(path, "new")).toThrow("backup unavailable");
    expect(fs.readFileSync(path, "utf8")).toBe("unchanged");
    expect(fs.writeSync).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["devices.json"]);
  });

  test("refuses symlinks and non-files on the mount fallback", () => {
    fs.mkdirSync(path);
    mockMount();
    expect(() => atomicWrite(path, "new")).toThrow();
    expect(fs.statSync(path).isDirectory()).toBe(true);
    fs.rmdirSync(path);
    const target = join(dir, "target.json");
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, path);
    expect(() => atomicWrite(path, "new")).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });

  test("full settings survive safe apply, keep, fresh load and rollback on the same JSON", () => {
    // Ignore workstation credentials/flags; this test is offline.
    for (const name of Object.keys(process.env)) {
      if (/^(MIKROTIK_|MCP_TRANSPORT|S3_|AWS_)/.test(name)) vi.stubEnv(name, undefined);
    }
    vi.stubEnv("MIKROTIK_CONFIG_FILE", path);
    const initial = MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", password: "fixture-secret", disabled: true } },
      defaultDevice: "fixture",
      mcp: { transport: "streamable-http", port: 8123 },
      dashboard: { port: 9199, enabled: false },
    });
    fs.writeFileSync(path, serializeConfig(initial));
    let current = loadConfig([]);
    const source = () => getConfigSource();
    const admin = createConfigAdmin({
      getConfig: () => current,
      setConfig: (value) => {
        current = value;
      },
      source,
      readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
      writeText: atomicWrite,
      now: Date.now,
      schedule: () => null,
      cancel: () => {},
    });
    mockMount();
    const changed = MikrotikConfigSchema.parse({
      ...current,
      ssh: { ...current.ssh, idleTimeout: 72000 },
      memory: { enabled: false, dbPath: join(dir, "memory.db") },
      tools: { disabledModules: ["container"] },
      disableUpdateCheck: true,
      backupDir: join(dir, "backups"),
      mcp: { ...current.mcp, port: 8222 },
      dashboard: { ...current.dashboard, port: 9299 },
    });
    const applied = admin.applyConfig(changed, 30000);
    expect(admin.keepConfig(applied.pendingId)).toBe(true);
    expect(loadConfig([])).toEqual(changed);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject(changed);
    expect(source()).toEqual({ path, fromFile: true });
    const second = admin.applyConfig(initial, 30000);
    expect(admin.rollback(second.pendingId)).toBe(true);
    expect(loadConfig([])).toEqual(changed);
    const service = createMcpSettingsService({ admin, getConfig: () => current, source });
    expect(service.read().persistence).toMatchObject({ path, fromFile: true });
    service.update({
      revision: service.read().revision,
      changes: { ssh: { idleTimeout: 81000 } },
      confirm: true,
      rollback_seconds: 30,
    });
    const pending = service.read();
    expect(
      service.finish({ pending_id: pending.pending!.id, revision: pending.revision }, "confirm").ok,
    ).toBe(true);
    expect(loadConfig([]).ssh.idleTimeout).toBe(81000);
    expect(loadConfig([]).devices.fixture.password).toBe("fixture-secret");
    vi.stubEnv("MIKROTIK_MCP__PORT", "8333");
    expect(loadConfig([]).mcp.port).toBe(8333); // explicit operator override still wins
  });

  test("Docker defaults allow legacy environment credentials without masking them", () => {
    for (const name of Object.keys(process.env)) {
      if (/^(MIKROTIK_|MCP_TRANSPORT|S3_|AWS_)/.test(name)) vi.stubEnv(name, undefined);
    }
    vi.stubEnv("MIKROTIK_CONFIG_FILE", join(PROJECT_ROOT, "docker/devices.example.json"));
    vi.stubEnv("MIKROTIK_HOST", "192.0.2.80");
    vi.stubEnv("MIKROTIK_USERNAME", "fixture");
    const config = loadConfig([]);
    expect(config.devices.default).toMatchObject({ host: "192.0.2.80", username: "fixture" });
    expect(config.mcp.port).toBe(8000);
    expect(config.dashboard.port).toBe(9090);
  });
});
