import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getAccessPolicy,
  hasSessionNarrowing,
  narrowSession,
  previewAccessPolicy,
  recentDenials,
  resetSessionScope,
} from "../../src/core/access";
import { createConfigAdmin } from "../../src/observability/config-admin";
import { createAccessSettingsRoutes } from "../../src/observability/access-settings";

const original = getConfig();
let route: ReturnType<typeof createAccessSettingsRoutes>;
let admin: ReturnType<typeof createConfigAdmin>;
let files: Map<string, string>;
let fire: () => void;
let record = vi.fn<(...args: unknown[]) => void>();
let clock = 1000;
beforeEach(() => {
  resetSessionScope();
  clock = 1000;
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        lab: { host: "192.0.2.1", password: "keep-secret" },
        edge: { host: "192.0.2.2", disabled: true },
      },
      defaultDevice: "lab",
      backupDir: "/keep-me",
      serviceProbes: { targets: {} },
    }),
  );
  files = new Map();
  record = vi.fn();
  fire = () => {};
  const source = () => ({ path: "/fake-config.json", fromFile: true });
  admin = createConfigAdmin({
    getConfig,
    setConfig,
    source,
    readFile: (path) => files.get(path) ?? null,
    writeText: (path, text) => {
      files.set(path, text);
    },
    now: () => clock,
    schedule: (fn) => {
      const timer = { cancelled: false };
      fire = () => {
        if (!timer.cancelled) fn();
      };
      return timer;
    },
    cancel: (timer) => {
      if (timer) (timer as { cancelled: boolean }).cancelled = true;
    },
  });
  route = createAccessSettingsRoutes(admin, {
    getConfig,
    getConfigSource: source,
    getAccessPolicy,
    hasSessionNarrowing,
    previewAccessPolicy,
    recentDenials,
    recordVersion: record,
    now: () => clock,
  });
});
afterEach(() => {
  resetSessionScope();
  setConfig(original);
});
const call = async (suffix = "", body?: unknown, headers?: Record<string, string>) => {
  const url = new URL(`http://localhost/api/access/settings${suffix}`);
  return (await route(
    new Request(url, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    }),
    url,
  ))!;
};
const edit = async (patch = {}) => ({
  revision: (await (await call()).json()).revision,
  access: { ...getConfig().access, ...patch },
});

describe("access settings administration", () => {
  test("returns configured and effective policies without router credentials or probes", async () => {
    const settings = await (await call()).json();
    expect(settings.tools.length).toBeGreaterThan(800);
    expect(settings.devices).toEqual([
      { name: "lab", disabled: false },
      { name: "edge", disabled: true },
    ]);
    expect(settings.configured.enabled).toBe(false);
    expect(settings.effective.enabled).toBe(false);
    expect(JSON.stringify(settings)).not.toContain("keep-secret");
    expect(JSON.stringify(settings)).not.toContain("192.0.2.1");
    expect(files.size).toBe(0);
  });
  test("preview evaluates current and proposed ceilings without changing config or audit", async () => {
    const before = getConfig();
    const count = recentDenials().length;
    const res = await (
      await call("/preview", {
        ...(await edit({ enabled: true, maxRisk: "READ" })),
        device: "lab",
        tool: "run_routeros_command",
      })
    ).json();
    expect(res.preview.check.allowed).toBe(false);
    expect(res.preview.check.rule).toBe("risk");
    expect(res.preview.newlyBlocked).toBeGreaterThan(0);
    expect(getConfig()).toBe(before);
    expect(recentDenials().length).toBe(count);
    expect(files.size).toBe(0);
  });
  test("explicit denials win and disabled device lookup is case insensitive", async () => {
    const blocked = await (
      await call("/preview", {
        ...(await edit({ enabled: true, tools: ["*"], denyTools: ["get_*"] })),
        tool: "get_system_identity",
        device: "lab",
      })
    ).json();
    expect(blocked.preview.check.rule).toBe("tool");
    const disabled = await (
      await call("/preview", { ...(await edit()), tool: "get_system_identity", device: "EDGE" })
    ).json();
    expect(disabled.preview.blocked).toBeGreaterThan(0);
    expect(disabled.preview.check.reason).toContain("disabled");
  });
  test("server readOnly is not bypassed by a permissive preview", async () => {
    setConfig({ ...getConfig(), readOnly: true });
    const r = await (
      await call("/preview", { ...(await edit()), tool: "run_routeros_command" })
    ).json();
    expect(r.preview.check.allowed).toBe(false);
    expect(r.preview.check.reason).toContain("read-only");
  });
  test("no-device tools ignore router exclusions, while omitted targets use the default router", async () => {
    const body = await edit({ enabled: true, denyDevices: ["lab", "edge"] });
    const local = await (
      await call("/preview", { ...body, device: "edge", tool: "get_access_scope" })
    ).json();
    expect(local.preview.check.allowed).toBe(true);
    const targeted = await (
      await call("/preview", { ...body, tool: "get_system_identity" })
    ).json();
    expect(targeted.preview.check.rule).toBe("device");
  });
  test("changing configured devices to a disjoint set does not reopen a narrowed session", async () => {
    narrowSession({ devices: ["lab"] });
    const body = await edit({ enabled: true, devices: ["edge"] });
    const result = await (
      await call("/preview", { ...body, device: "lab", tool: "get_system_identity" })
    ).json();
    expect(result.preview.effective.scope.noDevices).toBe(true);
    expect(result.preview.check.allowed).toBe(false);
  });
  test("session globs and operator globs must both match after hot apply", async () => {
    narrowSession({ tools: ["get_*"] });
    const body = await edit({ enabled: true, tools: ["list_*"] });
    const result = await (
      await call("/preview", { ...body, device: "lab", tool: "get_system_identity" })
    ).json();
    expect(result.preview.check.allowed).toBe(false);
    await call("/apply", body);
    expect(getAccessPolicy().scope.toolAllowGroups).toContainEqual(["list_*"]);
  });
  test("narrowing remains active during preview, apply, keep and later config changes", async () => {
    narrowSession({ maxRisk: "READ", denyTools: ["remove_*"], expiresAt: 2000 });
    const settings = await (await call()).json();
    expect(settings.narrowed).toBe(true);
    const body = await edit({ enabled: false });
    const preview = await (
      await call("/preview", { ...body, tool: "run_routeros_command" })
    ).json();
    expect(preview.preview.effective.enabled).toBe(true);
    expect(preview.preview.effective.scope.expiresAt).toBe(2000);
    const applied = await (await call("/apply", body)).json();
    await call("/keep", { pendingId: applied.settings.pending.id });
    expect(getAccessPolicy().scope.maxRisk).toBe("READ");
    expect(getAccessPolicy().scope.denyTools).toContain("remove_*");
  });
  test("apply updates only access, creates backup, hot-applies and reverts on timeout", async () => {
    const before = getConfig();
    const r = await (await call("/apply", await edit({ enabled: true, maxRisk: "READ" }))).json();
    expect(r.settings.pending).toEqual({ id: "cfg_1000", expiresAt: 61000, owned: true });
    expect(getAccessPolicy().enabled).toBe(true);
    expect(getConfig().devices).toBe(before.devices);
    expect(getConfig().backupDir).toBe("/keep-me");
    expect(getConfig().devices.lab.password).toBe("keep-secret");
    expect(files.size).toBe(2);
    fire();
    expect(getConfig()).toBe(before);
    expect((await (await call()).json()).pending).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
  test("keep cancels rollback and records config history", async () => {
    const applied = await (await call("/apply", await edit({ enabled: true }))).json();
    const kept = await call("/keep", { pendingId: applied.settings.pending.id });
    expect(kept.status).toBe(200);
    fire();
    expect(getConfig().access.enabled).toBe(true);
    expect(record).toHaveBeenCalledOnce();
  });
  test("explicit rollback restores and stale confirmations fail closed", async () => {
    const applied = await (await call("/apply", await edit({ enabled: true }))).json();
    const id = applied.settings.pending.id;
    expect((await call("/rollback", { pendingId: id })).status).toBe(200);
    expect(getConfig().access.enabled).toBe(false);
    expect((await call("/keep", { pendingId: id })).status).toBe(409);
  });
  test("concurrent or session changes invalidate an editor revision", async () => {
    const stale = await edit({ enabled: true });
    setConfig({ ...getConfig(), backupDir: "/new-location" });
    expect((await call("/apply", stale)).status).toBe(409);
    const second = await edit({ enabled: true });
    narrowSession({ maxRisk: "READ" });
    expect((await call("/apply", second)).status).toBe(409);
    expect(files.size).toBe(0);
  });
  test("does not supersede or confirm an unrelated Config Studio change", async () => {
    const other = admin.applyConfig({ ...getConfig(), backupDir: "/pending" }, 60000);
    expect((await call("/apply", await edit({ enabled: true }))).status).toBe(409);
    expect((await call("/keep", { pendingId: other.pendingId })).status).toBe(409);
    expect((await (await call()).json()).pending.owned).toBe(false);
  });
  test.each([
    { devices: ["missing-router"] },
    { denyDevices: ["missing-router"] },
    { tools: [""] },
    { maxRisk: "bogus" },
    { label: "x".repeat(201) },
    { enabled: "true" },
    { expiresAt: 123 },
  ])("rejects malformed policy %j", async (patch) => {
    expect((await call("/apply", await edit(patch))).status).toBe(400);
    expect(files.size).toBe(0);
  });
  test("rejects forged risk and unknown tools, without executing anything", async () => {
    expect((await call("/preview", { ...(await edit()), tool: "invented_tool" })).status).toBe(400);
    expect(
      (await call("/preview", { ...(await edit()), risk: "READ", tool: "run_routeros_command" }))
        .status,
    ).toBe(400);
  });
  test("rejects cross-site and form writes", async () => {
    expect((await call("/apply", await edit(), { "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
    expect((await call("/apply", await edit(), { "content-type": "text/plain" })).status).toBe(415);
    expect(files.size).toBe(0);
  });
});
