import { describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { serializeConfig } from "../src/config-write";
import { createMcpSettingsService, McpSettingsPatchSchema } from "../src/core/mcp-settings";
import { createConfigAdmin } from "../src/observability/config-admin";
import type { AdminDeps } from "../src/observability/config-admin";
import { mcpSettingsTools } from "../src/tools/mcp-settings";

// All config I/O is injected; no router, real config file or background timer.
function harness() {
  let config = MikrotikConfigSchema.parse({
    devices: { offline: { host: "127.0.0.1", password: "device-secret" } },
    defaultDevice: "offline",
    dashboard: { token: "dashboard-secret", maxEvents: 4567 },
    ssh: { keepAlive: true, idleTimeout: 90000, keepAliveInterval: 12000 },
    mcp: { toolPageSize: 37 },
    memory: { enabled: true },
  });
  const original = config;
  const source = { path: "/fake/config.json", fromFile: true };
  const files = new Map([[source.path, serializeConfig(config)]]);
  let timer: { fn: () => void; cancelled: boolean } | undefined;
  const deps: AdminDeps = {
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    source: () => source,
    readFile: (path) => files.get(path) ?? null,
    writeText: vi.fn((path, text) => {
      files.set(path, text);
    }),
    now: () => 1000,
    schedule: vi.fn((fn) => {
      timer = { fn, cancelled: false };
      return timer;
    }),
    cancel: (handle) => {
      if (handle) (handle as typeof timer)!.cancelled = true;
    },
  };
  const admin = createConfigAdmin(deps);
  const service = createMcpSettingsService({
    admin,
    getConfig: deps.getConfig,
    source: deps.source,
  });
  return {
    deps,
    admin,
    service,
    files,
    original,
    source,
    update: (changes: unknown = { ssh: { idleTimeout: 60000 } }) =>
      service.update({ changes, revision: service.read().revision, confirm: true }),
    finish: (action: "confirm" | "rollback") => {
      const state = service.read();
      return service.finish({ pending_id: state.pending?.id, revision: state.revision }, action);
    },
    expire: () => {
      if (timer && !timer.cancelled) timer.fn();
    },
  };
}

describe("MCP settings safe workflow", () => {
  test("read/schema/preview are secret-free and side-effect-free; omitted values stay unchanged", () => {
    const h = harness();
    const result = h.service.preview({ ssh: { idleTimeout: 60000 } });
    expect(result.after.ssh).toEqual({
      keepAlive: true,
      keepAliveInterval: 12000,
      idleTimeout: 60000,
    });
    expect(result.after.mcp.toolPageSize).toBe(37);
    expect(result.after.dashboard.maxEvents).toBe(4567);
    expect(result.changedPaths).toEqual(["ssh.idleTimeout"]);
    expect(result.restartRequired).toBe(false);
    expect(result.unified).toContain("60000");
    expect(h.service.read().persistence.path).toBe(h.source.path);
    expect(JSON.stringify([result, h.service.read(), h.service.schema()])).not.toMatch(
      /device-secret|dashboard-secret/,
    );
    expect(h.deps.writeText).not.toHaveBeenCalled();
    expect(h.deps.schedule).not.toHaveBeenCalled();
    expect(h.deps.getConfig()).toBe(h.original);
  });

  test.each([
    { devices: {} },
    { readOnly: false },
    { access: {} },
    { tools: {} },
    { serviceProbes: {} },
    { dashboard: { token: "do-not-echo" } },
    { mcp: { host: "0.0.0.0" } },
    { memory: { path: "/tmp/other" } },
    { ssh: { idleTimeout: -1 } },
    { dashboard: { feedLimit: 10001 } },
    { mcp: { capabilityGating: "invalid" } },
    { dashboard: { redactInput: false } },
  ])("rejects invalid/protected patches without writes: %j", (changes) => {
    const h = harness();
    expect(McpSettingsPatchSchema.safeParse(changes).success).toBe(false);
    expect(() => h.service.preview(changes)).toThrow("Invalid or protected MCP setting");
    expect(() => h.update(changes)).toThrow("Invalid settings update");
    expect(h.deps.writeText).not.toHaveBeenCalled();
  });

  test("requires approval and bounded rollback; rejects empty changes without side effects", () => {
    const h = harness();
    const input = {
      changes: { memory: { enabled: false } },
      revision: h.service.read().revision,
      confirm: true,
    };
    for (const invalid of [
      { confirm: false },
      { rollback_seconds: 0 },
      { rollback_seconds: 601 },
      { revision: "stale" },
    ]) {
      expect(() => h.service.update({ ...input, ...invalid })).toThrow();
    }
    expect(h.update({}).applied).toBe(false);
    expect(h.deps.writeText).not.toHaveBeenCalled();
    expect(h.deps.schedule).not.toHaveBeenCalled();
  });

  test("backs up, readbacks, confirms; keeps unrelated secrets and permissions", () => {
    const h = harness();
    const before = h.service.read().revision;
    const result = h.update();
    expect(result.applied).toBe(true);
    expect(result.revision).not.toBe(before);
    expect(result.pending).toMatchObject({ owned: true, expiresAt: 61000 });
    expect(h.deps.schedule).toHaveBeenCalledWith(expect.any(Function), 60000);
    expect(h.files.get("/fake/config.json.bak-1000")).toBe(serializeConfig(h.original));
    const current = h.deps.getConfig();
    expect(current.devices).toEqual(h.original.devices);
    expect(current.access).toEqual(h.original.access);
    expect(current.dashboard.token).toBe("dashboard-secret");
    expect(current.ssh.idleTimeout).toBe(60000);
    expect(h.finish("confirm").ok).toBe(true);
    h.expire();
    expect(h.deps.getConfig().ssh.idleTimeout).toBe(60000);
    expect(h.service.read().pending).toBeNull();
  });

  test.each(["manual", "timeout"])("restores disk and runtime on %s rollback", (mode) => {
    const h = harness();
    h.update();
    if (mode === "manual") expect(h.finish("rollback").ok).toBe(true);
    else h.expire();
    expect(h.deps.getConfig()).toEqual(h.original);
    expect(h.files.get(h.source.path)).toBe(serializeConfig(h.original));
    expect(h.admin.pendingId()).toBeNull();
  });

  test("blocks concurrent dashboard changes and cannot finish a dashboard-owned transaction", () => {
    const h = harness();
    h.admin.applyConfig({ ...h.original, disableUpdateCheck: true }, 60000);
    expect(h.service.read().pending?.owned).toBe(false);
    expect(() => h.update()).toThrow("Another configuration change");
    expect(() => h.finish("confirm")).toThrow("not pending in MCP settings");
    expect(() => h.finish("rollback")).toThrow("not pending in MCP settings");
    expect(() => h.admin.applyConfig(h.original, 60000)).toThrow("awaits confirmation");
    h.expire();
    expect(h.deps.getConfig()).toEqual(h.original);
  });

  test.each(["file", "runtime"])(
    "rejects stale previews and never rolls back newer %s edits",
    (location) => {
      const h = harness();
      const old = h.service.read().revision;
      h.update();
      expect(() => h.service.update({ changes: {}, revision: old, confirm: true })).toThrow(
        "changed",
      );
      const pending = h.service.read();
      if (location === "file") h.files.set(h.source.path, "newer operator file");
      else h.deps.setConfig({ ...h.deps.getConfig(), disableUpdateCheck: true });
      expect(() =>
        h.service.finish(
          { pending_id: pending.pending?.id, revision: pending.revision },
          "rollback",
        ),
      ).toThrow("changed");
      h.expire();
      expect(h.admin.pendingId()).toBeNull();
      if (location === "file") expect(h.files.get(h.source.path)).toBe("newer operator file");
      else expect(h.deps.getConfig().disableUpdateCheck).toBe(true);
    },
  );

  test("failed apply preserves runtime; failed rollback retains its retryable transaction", () => {
    const h = harness();
    const write = h.deps.writeText;
    h.deps.writeText = () => {
      throw new Error("disk full");
    };
    expect(() => h.update()).toThrow("disk full");
    expect(h.deps.getConfig()).toEqual(h.original);
    expect(h.admin.pendingId()).toBeNull();
    h.deps.writeText = write;
    h.update();
    h.deps.writeText = () => {
      throw new Error("disk full");
    };
    expect(() => h.finish("rollback")).toThrow("disk full");
    expect(h.admin.pendingId()).not.toBeNull();
    h.deps.writeText = write;
    h.finish("rollback");
    expect(h.deps.getConfig()).toEqual(h.original);
  });

  test("missing backup is never reported as successful rollback; same-ms updates have unique backups", () => {
    const h = harness();
    h.update();
    const backup = h.files.get("/fake/config.json.bak-1000")!;
    h.files.delete("/fake/config.json.bak-1000");
    expect(() => h.finish("rollback")).toThrow("backup is unavailable");
    expect(h.admin.pendingId()).not.toBeNull();
    h.files.set("/fake/config.json.bak-1000", backup);
    h.finish("rollback");
    h.update();
    expect(h.files.has("/fake/config.json.bak-1001")).toBe(true);
    expect(h.files.get("/fake/config.json.bak-1000")).toBe(backup);
  });

  test("read-only mode blocks direct service writes; capture requires redaction", () => {
    const h = harness();
    h.deps.setConfig({ ...h.original, readOnly: true });
    expect(() => h.update()).toThrow("read-only");
    h.deps.setConfig({ ...h.original, dashboard: { ...h.original.dashboard, redactInput: false } });
    expect(() => h.update({ dashboard: { captureBody: true } })).toThrow("redactInput=true");
    expect(h.deps.writeText).not.toHaveBeenCalled();
    expect(h.update({ dashboard: { captureBody: true, redactInput: true } }).restartRequired).toBe(
      true,
    );
  });

  test("all six tools are host-only with correct risk annotations", () => {
    expect(mcpSettingsTools).toHaveLength(6);
    for (const tool of mcpSettingsTools) {
      expect(tool.noDevice).toBe(true);
      expect(tool.annotations.readOnlyHint === true).toBe(/^(get|preview)_/.test(tool.name));
    }
  });
});
