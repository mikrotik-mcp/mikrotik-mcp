import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { securityHardeningTools } from "../src/tools/security-hardening";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  rows: vi.fn(),
  kv: vi.fn(),
  safe: vi.fn(),
  auditCategory: vi.fn(),
  runAudit: vi.fn(),
  render: vi.fn(),
  snapshot: vi.fn(),
  manager: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/utils/safe-exec", () => ({
  fetchRows: mocks.rows,
  fetchKv: mocks.kv,
  safe: mocks.safe,
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: mocks.manager }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mocks.snapshot }));
vi.mock("../src/core/security-hardening", () => ({
  HARDENING_CATEGORIES: [
    "firewall_default_deny",
    "address_list_enforcement",
    "kernel_ip_hardening",
    "ipv6_firewall_baseline",
    "ssh_hardening",
    "ip_service_exposure",
    "connection_tracking_helpers",
    "management_plane_exposure",
    "account_hygiene",
    "certificate_hygiene",
    "network_segmentation",
    "dns_resolver_exposure",
  ],
  emptySecurityState: () => ({}),
  auditCategory: mocks.auditCategory,
  runSecurityHardeningAudit: mocks.runAudit,
  renderHardeningReport: mocks.render,
}));

const finding = {
  finding_id: "fw-tail",
  category: "firewall_default_deny",
  severity: "high",
  title: "Missing input default deny",
  fix: ["/ip firewall filter add chain=input action=drop"],
};
const kernelFinding = {
  finding_id: "kernel-syncookies",
  category: "kernel_ip_hardening",
  severity: "medium",
  title: "TCP syncookies disabled",
  fix: ["/ip settings set tcp-syncookies=yes"],
};
const manualFinding = {
  finding_id: "fw-review",
  category: "firewall_default_deny",
  severity: "low",
  title: "Review firewall",
  fix: [],
};
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
const manager = { enable: vi.fn(), rollback: vi.fn(), commit: vi.fn() };

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = securityHardeningTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown hardening tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.rows.mockResolvedValue([]);
  mocks.kv.mockResolvedValue({});
  mocks.safe.mockResolvedValue("0");
  mocks.auditCategory.mockImplementation((category: string) =>
    category === "firewall_default_deny"
      ? [finding, manualFinding]
      : category === "kernel_ip_hardening"
        ? [kernelFinding]
        : [],
  );
  mocks.runAudit.mockReturnValue({
    findings: [finding, kernelFinding, manualFinding],
    total: 3,
    summary: {},
  });
  mocks.render.mockReturnValue("security audit report");
  mocks.snapshot.mockResolvedValue("snapshot-1");
  mocks.manager.mockReturnValue(manager);
  manager.enable.mockResolvedValue("Safe Mode enabled");
  manager.rollback.mockResolvedValue(undefined);
  manager.commit.mockResolvedValue({ ok: true, message: "committed" });
  mocks.command.mockResolvedValue("");
});
afterEach(() => setConfig(initial));

test("category and fleet audits fetch device state but never write", async () => {
  expect(await call("audit_firewall_default_deny")).toContain("security audit report");
  expect(mocks.auditCategory).toHaveBeenCalledWith("firewall_default_deny", expect.any(Object));
  expect(await call("run_security_hardening_audit", { categories: ["ssh_hardening"] })).toContain(
    "security audit report",
  );
  expect(mocks.runAudit).toHaveBeenCalledWith(expect.any(Object), ["ssh_hardening"]);
  expect(mocks.rows).toHaveBeenCalledWith("/ip firewall filter print detail", ctx);
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

test("fix tool refuses unknown or manual-only findings and previews an exact fix", async () => {
  expect(
    await call("add_firewall_default_deny", { finding_ids: ["wrong", "fw-review"], confirm: true }),
  ).toContain("No applicable findings");
  expect(
    await call("add_firewall_default_deny", {
      finding_ids: ["fw-tail", "wrong", "fw-review"],
      confirm: false,
    }),
  ).toContain("DRY RUN");
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled();
});

test("firewall fix snapshots first and commits only after successful Safe Mode commands", async () => {
  const result = await call("add_firewall_default_deny", {
    finding_ids: ["fw-tail"],
    confirm: true,
  });
  expect(result).toContain("snapshot=snapshot-1");
  expect(result).toContain("safe-mode=committed");
  expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
    manager.enable.mock.invocationCallOrder[0],
  );
  expect(manager.enable.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.command.mock.invocationCallOrder[0],
  );
  expect(mocks.command.mock.invocationCallOrder[0]).toBeLessThan(
    manager.commit.mock.invocationCallOrder[0],
  );
});

test("unavailable Safe Mode never sends a firewall fix", async () => {
  manager.enable.mockResolvedValueOnce("Error: session busy");
  const report = await call("add_firewall_default_deny", {
    finding_ids: ["fw-tail"],
    confirm: true,
  });
  expect(report).toContain("Safe Mode unavailable");
  expect(report).toContain("failed to enable");
  expect(mocks.command).not.toHaveBeenCalled();
  expect(manager.commit).not.toHaveBeenCalled();
});

test("a failed command rolls back the protected session and reports the failed finding", async () => {
  mocks.command.mockResolvedValueOnce("failure: invalid rule");
  const report = await call("add_firewall_default_deny", {
    finding_ids: ["fw-tail"],
    confirm: true,
  });
  expect(report).toContain("rolled back");
  expect(report).toContain("invalid rule");
  expect(manager.rollback).toHaveBeenCalledOnce();
  expect(manager.commit).not.toHaveBeenCalled();
});

test("commit rejection is shown as uncommitted rather than reporting success", async () => {
  manager.commit.mockResolvedValueOnce({ ok: false, message: "lost SSH" });
  const report = await call("add_firewall_default_deny", {
    finding_ids: ["fw-tail"],
    confirm: true,
  });
  expect(report).toContain("commit FAILED");
  expect(report).toContain("lost SSH");
});

test("non-lockout kernel setting does not require Safe Mode but still snapshots", async () => {
  const report = await call("harden_kernel_ip_settings", {
    finding_ids: ["kernel-syncookies"],
    confirm: true,
  });
  expect(report).toContain("safe-mode=not used");
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(mocks.command).toHaveBeenCalledWith("/ip settings set tcp-syncookies=yes", ctx);
  expect(manager.enable).not.toHaveBeenCalled();
});

test("orchestrator keeps explicit finding scope and safe category order", async () => {
  const preview = await call("apply_security_hardening_fixes", {
    finding_ids: ["kernel-syncookies", "fw-tail", "fw-review", "unknown"],
    confirm: false,
  });
  expect(typeof preview).toBe("string");
  if (typeof preview !== "string") throw new Error("Expected text preview");
  expect(preview.indexOf("fw-tail")).toBeLessThan(preview.indexOf("kernel-syncookies"));
  expect(preview).toContain("Unknown finding_id(s): unknown");
  expect(preview).toContain("Manual-review (no auto-fix): fw-review");
  expect(mocks.command).not.toHaveBeenCalled();
  expect(
    await call("apply_security_hardening_fixes", { finding_ids: ["unknown"], confirm: true }),
  ).toContain("No applicable findings");
});
