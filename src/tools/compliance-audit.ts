/**
 * Network Compliance Auditor — `run_compliance_audit`, `audit_fleet`,
 * `audit_remediate` & `list_compliance_checks`.
 *
 * Fetches 18 RouterOS commands covering SSH, services, firewall, users, DNS,
 * certificates, network services, SNMP, system hardening and VPN, then
 * delegates to the pure analysis engine in `src/core/compliance-checks.ts` for
 * scored pass/fail/warn reporting with fix commands.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import {
  ALL_CHECKS,
  CATEGORY_LABELS,
  COMPLIANCE_CATEGORIES,
  renderComplianceReport,
  runComplianceAudit,
} from "../core/compliance-checks";
import type {
  CertInfo,
  ComplianceCategory,
  ComplianceReport,
  ComplianceSeverity,
  DeviceComplianceState,
} from "../core/compliance-checks";
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { listDevices, resolveDeviceName } from "../core/runtime";
import { looksLikeError } from "../core/routeros";
import { parseCertExpiry, parseKeyValues, parseRecords } from "../core/routeros-parse";
import { safe } from "../utils/safe-exec";

/** Fetch all device state slices needed by the compliance engine. */
export async function fetchComplianceState(ctx: ToolContext): Promise<DeviceComplianceState> {
  // Fire all commands in parallel for speed
  const [
    sshRaw,
    servicesRaw,
    firewallRaw,
    usersRaw,
    dnsRaw,
    certsRaw,
    upnp,
    socks,
    proxy,
    macServer,
    macWinbox,
    identityRaw,
    ntpClient,
    discoverySettings,
    bandwidthServer,
    pptpServer,
    snmp,
    snmpCommunityRaw,
  ] = await Promise.all([
    safe("/ip ssh print", ctx),
    safe("/ip service print detail", ctx),
    safe("/ip firewall filter print detail", ctx),
    safe("/user print detail", ctx),
    safe("/ip dns print", ctx),
    safe("/certificate print detail", ctx),
    safe("/ip upnp print", ctx),
    safe("/ip socks print", ctx),
    safe("/ip proxy print", ctx),
    safe("/tool mac-server print", ctx),
    safe("/tool mac-server mac-winbox print", ctx),
    safe("/system identity print", ctx),
    safe("/system ntp client print", ctx),
    safe("/ip neighbor discovery-settings print", ctx),
    safe("/tool bandwidth-server print", ctx),
    safe("/interface pptp-server server print", ctx),
    safe("/snmp print", ctx),
    safe("/snmp community print detail", ctx),
  ]);

  // Parse structured outputs
  const ssh = parseKeyValues(sshRaw);
  const services = servicesRaw ? parseRecords(servicesRaw).rows : [];
  const firewallFilter = firewallRaw ? parseRecords(firewallRaw).rows : [];
  const users = usersRaw ? parseRecords(usersRaw).rows : [];
  const dns = parseKeyValues(dnsRaw);
  const identity = parseKeyValues(identityRaw);
  const snmpCommunity = snmpCommunityRaw ? parseRecords(snmpCommunityRaw).rows : [];

  // Parse certificate expiry info
  const certificates: CertInfo[] = certsRaw
    ? parseCertExpiry(certsRaw, Date.now()).map((c) => ({
        name: c.name,
        daysLeft: c.daysLeft,
      }))
    : [];

  return {
    ssh,
    services,
    firewallFilter,
    users,
    dns,
    certificates,
    upnp,
    socks,
    proxy,
    macServer,
    macWinbox,
    identity,
    ntpClient,
    discoverySettings,
    bandwidthServer,
    pptpServer,
    snmp,
    snmpCommunity,
  };
}

// ── Shared schema fragments ─────────────────────────────────────────────────

const categoryEnum = z
  .enum(COMPLIANCE_CATEGORIES as unknown as [string, ...string[]])
  .describe("Category slug to filter by.");

const severityEnum = z
  .enum(["critical", "high", "medium", "low"])
  .describe("Only include checks at or above this severity.");

// ── Tools ───────────────────────────────────────────────────────────────────

export const complianceAuditTools: ToolModule = [
  defineTool({
    name: "run_compliance_audit",
    title: "Run Network Compliance Audit",
    annotations: READ,
    description:
      "Deep-scan a single device's security posture across SSH, management services, firewall, " +
      "users, DNS, certificates, network services, SNMP, system hardening and VPN — 36 checks " +
      "scored A+ through F with per-check pass/fail/warn and fix commands. " +
      "Returns a scored compliance report. Optionally narrow by category or severity, " +
      "and generate a combined RouterOS fix script. " +
      "For fleet-wide audit across all devices use `audit_fleet`. " +
      "For firewall-specific analysis use `firewall_audit`; for certificate lifecycle " +
      "use `cert_expiry_audit`; for hardening use `security_shield`. This tool ties " +
      "them all together into a unified compliance grade.",
    inputSchema: {
      categories: z
        .array(categoryEnum)
        .optional()
        .describe(
          `Narrow the audit to specific categories. ` +
            `Available: ${COMPLIANCE_CATEGORIES.join(", ")}. Omit to audit all.`,
        ),
      severity_threshold: severityEnum
        .optional()
        .describe("Only report checks at or above this severity (default: all)."),
      generate_fix_script: z
        .boolean()
        .default(false)
        .describe("Append a combined RouterOS fix script for all failing checks."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Running compliance audit on '${device}'`);

      const state = await fetchComplianceState(ctx);
      const report = runComplianceAudit(state, {
        categories: a.categories as ComplianceCategory[] | undefined,
        severityThreshold: a.severity_threshold as ComplianceSeverity | undefined,
      });

      return renderComplianceReport(report, device, {
        generateFixScript: a.generate_fix_script,
      });
    },
  }),

  defineTool({
    name: "audit_fleet",
    title: "Fleet-wide Compliance Audit",
    annotations: READ,
    description:
      "Run the compliance audit across ALL configured devices (or a specified subset) and " +
      "return a consolidated fleet report with per-device grades, an aggregate fleet score, " +
      "and a summary of the most common failures across the fleet. " +
      "For single-device audit use `run_compliance_audit`.",
    inputSchema: {
      devices: z
        .array(z.string())
        .optional()
        .describe("Subset of device names to audit. Omit to audit all configured devices."),
      severity_threshold: severityEnum
        .optional()
        .describe("Only report checks at or above this severity (default: all)."),
      generate_fix_script: z.boolean().default(false).describe("Append per-device fix scripts."),
    },
    async handler(a, ctx) {
      const all = listDevices();
      const targets = a.devices?.length ? a.devices : all.names;

      // Validate device names
      const unknown = targets.filter((d: string) => {
        try {
          resolveDeviceName(d);
          return false;
        } catch {
          return true;
        }
      });
      if (unknown.length) return `Unknown device(s): ${unknown.join(", ")}`;

      ctx.info(`Fleet compliance audit: ${targets.length} device(s)`);

      // Audit each device — sequential to avoid overwhelming connections
      const results: { device: string; report: ComplianceReport; text: string }[] = [];
      const failTally = new Map<string, number>();

      for (const deviceName of targets) {
        const resolved = resolveDeviceName(deviceName);
        const dctx = createContext(undefined, deviceName);

        try {
          const state = await fetchComplianceState(dctx);
          const report = runComplianceAudit(state, {
            severityThreshold: a.severity_threshold as ComplianceSeverity | undefined,
          });
          const text = renderComplianceReport(report, resolved, {
            generateFixScript: a.generate_fix_script,
          });
          results.push({ device: resolved, report, text });

          // Tally failures across fleet
          for (const e of report.evaluatedChecks) {
            if (e.result.status === "fail" || e.result.status === "warn") {
              failTally.set(e.check.id, (failTally.get(e.check.id) ?? 0) + 1);
            }
          }
        } catch (err) {
          results.push({
            device: resolved,
            report: {
              score: { earned: 0, total: 0, percentage: 0, grade: "F" },
              totalChecks: 0,
              passCount: 0,
              failCount: 0,
              warnCount: 0,
              skipCount: 0,
              categories: [],
              evaluatedChecks: [],
            },
            text: `NETWORK COMPLIANCE AUDIT — ${resolved}\nError: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Build fleet summary
      const lines: string[] = [];
      lines.push("╔═══════════════════════════════════════════════════════════════╗");
      lines.push("║              FLEET COMPLIANCE AUDIT REPORT                  ║");
      lines.push("╚═══════════════════════════════════════════════════════════════╝");
      lines.push("");

      // Per-device summary table
      lines.push("── DEVICE SCORES ──────────────────────────────────────────────");
      const totalPct: number[] = [];
      for (const r of results) {
        const { score } = r.report;
        const bar =
          score.percentage > 0
            ? "█".repeat(Math.round(score.percentage / 5)) +
              "░".repeat(20 - Math.round(score.percentage / 5))
            : "░".repeat(20);
        lines.push(
          `  ${r.device.padEnd(20)} ${score.grade.padEnd(3)} ${String(score.percentage).padStart(3)}%  ${bar}  ` +
            `${r.report.passCount}P ${r.report.failCount}F ${r.report.warnCount}W`,
        );
        if (score.percentage > 0 || r.report.totalChecks > 0) totalPct.push(score.percentage);
      }
      lines.push("");

      // Fleet aggregate
      if (totalPct.length > 0) {
        const avg = Math.round(totalPct.reduce((a, b) => a + b, 0) / totalPct.length);
        const min = Math.min(...totalPct);
        const max = Math.max(...totalPct);
        lines.push(`── FLEET AGGREGATE ────────────────────────────────────────────`);
        lines.push(`  Average: ${avg}%  |  Lowest: ${min}%  |  Highest: ${max}%`);
        lines.push(`  Devices audited: ${results.length}`);
        lines.push("");
      }

      // Most common failures
      if (failTally.size > 0) {
        const sorted = [...failTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        lines.push("── MOST COMMON FAILURES ───────────────────────────────────────");
        for (const [id, count] of sorted) {
          const check = ALL_CHECKS.find((c) => c.id === id);
          lines.push(
            `  ${String(count).padStart(2)}/${targets.length} devices  ${id.padEnd(30)}  ${check?.title ?? ""}`,
          );
        }
        lines.push("");
      }

      // Individual reports
      lines.push("═══════════════════════════════════════════════════════════════");
      lines.push("INDIVIDUAL DEVICE REPORTS");
      lines.push("═══════════════════════════════════════════════════════════════");
      for (const r of results) {
        lines.push("");
        lines.push(r.text);
      }

      return lines.join("\n");
    },
  }),

  defineTool({
    name: "audit_remediate",
    title: "Apply Compliance Fixes",
    annotations: WRITE,
    description:
      "Run the compliance audit on a device and automatically apply fix commands for all " +
      "failing/warning checks that have a known fix. Returns the audit report followed by " +
      "the result of each applied fix command. " +
      "Use `run_compliance_audit` with `generate_fix_script=true` first to preview fixes, " +
      "then call this tool to apply them. Only applies fixes for checks that actually fail; " +
      "checks that already pass are untouched.",
    inputSchema: {
      categories: z
        .array(categoryEnum)
        .optional()
        .describe("Narrow remediation to specific categories."),
      severity_threshold: severityEnum
        .optional()
        .describe("Only remediate checks at or above this severity."),
      dry_run: z
        .boolean()
        .default(true)
        .describe("Preview fix commands without applying (default: true). Set false to apply."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Compliance remediation on '${device}' (dry_run=${a.dry_run})`);

      const state = await fetchComplianceState(ctx);
      const report = runComplianceAudit(state, {
        categories: a.categories as ComplianceCategory[] | undefined,
        severityThreshold: a.severity_threshold as ComplianceSeverity | undefined,
      });

      // Collect actionable fixes
      const fixes = report.evaluatedChecks
        .filter((e) => e.result.fix && e.result.status !== "pass" && e.result.status !== "skip")
        .map((e) => ({
          id: e.check.id,
          severity: e.check.severity,
          title: e.check.title,
          fix: e.result.fix!,
        }));

      const lines: string[] = [];
      lines.push(renderComplianceReport(report, device, { generateFixScript: false }));
      lines.push("");

      if (fixes.length === 0) {
        lines.push("No actionable fixes — all checks pass or have no automated fix.");
        return lines.join("\n");
      }

      if (a.dry_run) {
        lines.push(`═══ DRY RUN — ${fixes.length} fix(es) would be applied ═══`);
        lines.push("# Set dry_run=false to apply these commands:");
        for (const f of fixes) {
          lines.push(`# [${f.severity.toUpperCase()}] ${f.title}`);
          lines.push(f.fix);
        }
        return lines.join("\n");
      }

      // Apply fixes
      lines.push(`═══ APPLYING ${fixes.length} FIX(ES) ═══`);
      let applied = 0;
      let failed = 0;

      for (const f of fixes) {
        const out = await executeMikrotikCommand(f.fix, ctx);
        const ok = !looksLikeError(out);
        if (ok) applied++;
        else failed++;
        lines.push(`  ${ok ? "OK  " : "ERR "}  ${f.id}: ${f.fix}`);
        if (!ok) lines.push(`         ${out.trim().split("\n")[0]}`);
      }

      lines.push("");
      lines.push(`Applied: ${applied}  |  Failed: ${failed}  |  Total: ${fixes.length}`);
      if (applied > 0) {
        lines.push("");
        lines.push("Re-run `run_compliance_audit` to verify the new score.");
      }

      return lines.join("\n");
    },
  }),

  defineTool({
    name: "list_compliance_checks",
    title: "List Compliance Checks",
    annotations: READ,
    description:
      "Reference listing of all compliance checks — ID, category, severity and title. " +
      "No device connection needed. Use to understand available checks before running " +
      "`run_compliance_audit` with category or severity filters.",
    inputSchema: {
      category: categoryEnum.optional().describe("Filter to a single category."),
    },
    handler(a) {
      let checks = ALL_CHECKS;
      if (a.category) {
        checks = checks.filter((c) => c.category === a.category);
      }

      const lines: string[] = ["COMPLIANCE CHECKS", ""];
      let currentCat: string | null = null;

      for (const c of checks) {
        if (c.category !== currentCat) {
          currentCat = c.category;
          lines.push(`── ${CATEGORY_LABELS[c.category]} ──`);
        }
        lines.push(`  ${c.severity.toUpperCase().padEnd(8)}  ${c.id.padEnd(30)}  ${c.title}`);
      }

      lines.push("", `Total: ${checks.length} check(s)`);
      return lines.join("\n");
    },
  }),
];
