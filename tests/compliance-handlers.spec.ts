import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { complianceAuditTools, fetchComplianceState } from "../src/tools/compliance-audit";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const ctx: ToolContext = { device: "edge", info: vi.fn(), error: vi.fn() };
const original = getConfig();

function invoke(name: string, args: Record<string, unknown>, context = ctx): Promise<string> {
  const tool = complianceAuditTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing compliance tool ${name}`);
  return Promise.resolve(tool.handler(args as never, context)).then((value) =>
    typeof value === "string" ? value : value.text,
  );
}

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "192.0.2.1", port: 22 }, branch: { host: "192.0.2.2", port: 22 } },
      defaultDevice: "edge",
    }),
  );
  command.mockReset();
  command.mockImplementation(async (text) => {
    if (text === "/ip ssh print") return "strong-crypto: no\nallow-none-crypto: yes";
    if (text === "/ip service print detail")
      return "0 name=telnet disabled=no\n1 name=ssh disabled=no address=192.0.2.0/24";
    if (text === "/ip firewall filter print detail") return "0 chain=input action=drop";
    if (text === "/user print detail") return "0 name=admin group=full disabled=no";
    if (text === "/ip dns print") return "allow-remote-requests: no\nservers: 1.1.1.1";
    if (text === "/system identity print") return "name: edge-router";
    if (text === "/snmp print") return "enabled: no";
    return "";
  });
});
afterEach(() => setConfig(original));

describe("compliance tools with offline RouterOS transcripts", () => {
  test("collector issues exactly the documented read-only commands and parses multiple shapes", async () => {
    const state = await fetchComplianceState(ctx);
    expect(command.mock.calls).toHaveLength(18);
    expect(command.mock.calls.every(([text]) => /\bprint\b/.test(text))).toBe(true);
    expect(state.ssh).toMatchObject({ "strong-crypto": "no", "allow-none-crypto": "yes" });
    expect(state.services.map((row) => row.name)).toEqual(["telnet", "ssh"]);
    expect(state.firewallFilter[0]).toMatchObject({ chain: "input", action: "drop" });
    expect(state.dns.servers).toBe("1.1.1.1");
    expect(state.identity.name).toBe("edge-router");
  });

  test("single-device report filters findings and previews fix commands without executing them", async () => {
    const report = await invoke("run_compliance_audit", {
      categories: ["ssh_security"],
      severity_threshold: "high",
      generate_fix_script: true,
    });
    expect(report).toContain("Strong crypto disabled");
    expect(report).toContain("allow-none-crypto is enabled");
    expect(report).toContain("FIX SCRIPT");
    expect(report).not.toContain("Telnet enabled");
    expect(command.mock.calls.every(([text]) => /\bprint\b/.test(text))).toBe(true);
  });

  test("unknown fleet members are rejected before any router command", async () => {
    const report = await invoke("audit_fleet", { devices: ["edge", "typo-router"] });
    expect(report).toContain("Unknown device(s): typo-router");
    expect(command).not.toHaveBeenCalled();
  });

  test("fleet report preserves the failing label, not the desired pass-state title", async () => {
    const report = await invoke("audit_fleet", {
      devices: ["edge", "branch"],
      severity_threshold: "critical",
    });
    expect(report).toContain("MOST COMMON FAILURES");
    expect(report).toContain("Telnet enabled");
    expect(report).toContain("should be: Telnet disabled");
    expect(report).toContain("INDIVIDUAL DEVICE REPORTS");
    expect(command.mock.calls).toHaveLength(36);
  });

  test("dry-run remediation lists an SSH fix but cannot send a write", async () => {
    const report = await invoke("audit_remediate", { categories: ["ssh_security"], dry_run: true });
    expect(report).toContain("DRY RUN");
    expect(report).toContain("/ip ssh set strong-crypto=yes");
    expect(command.mock.calls.every(([text]) => /\bprint\b/.test(text))).toBe(true);
  });

  test("offline apply path counts success and rejection separately", async () => {
    command.mockImplementation(async (text) => {
      if (text === "/ip ssh print") return "strong-crypto: no\nallow-none-crypto: yes";
      if (text.includes("set strong-crypto")) return "";
      if (text.includes("set allow-none-crypto")) return "failure: permission denied";
      return "";
    });
    const report = await invoke("audit_remediate", {
      categories: ["ssh_security"],
      dry_run: false,
    });
    expect(report).toContain("Applied: 1  |  Failed: 1  |  Total: 2");
    expect(report).toContain("permission denied");
    expect(command.mock.calls.filter(([text]) => text.startsWith("/ip ssh set"))).toHaveLength(2);
  });

  test("check catalog needs no router access and respects category selection", async () => {
    const catalog = await invoke("list_compliance_checks", { category: "ssh_security" });
    expect(catalog).toContain("ssh-strong-crypto");
    expect(catalog).not.toContain("svc-telnet-disabled");
    expect(command).not.toHaveBeenCalled();
  });
});
