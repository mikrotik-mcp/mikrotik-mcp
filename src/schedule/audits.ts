/**
 * Which auditors a schedule can run, and how their findings become comparable.
 *
 * A scheduled job names an MCP tool, but it does NOT go through that tool's
 * text renderer: the runner needs a finding SET to diff, and most auditors
 * render straight to prose for a human. So each adapter reuses the tool's own
 * fetch helper and its pure engine — the same code path the tool takes, one
 * layer earlier — and maps the result onto the common `AuditFinding` shape with
 * a stable id from `./identity`.
 *
 * Only tools listed here can be scheduled. That is deliberate on top of the
 * runner's READ check: an arbitrary READ tool would produce a run with zero
 * findings every night and a timeline that looks healthy because nothing is
 * being measured, which is worse than refusing the job.
 */
import { auditFirewall, rulesFromRows } from "../core/firewall-audit";
import { runComplianceAudit } from "../core/compliance-checks";
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { runSecurityHardeningAudit } from "../core/security-hardening";
import { looksLikeError } from "../core/routeros";
import { parseExport } from "../policy/parse";
import { evaluatePolicies } from "../policy/evaluate";
import { currentPolicySet } from "../tools/policy";
import { fetchComplianceState } from "../tools/compliance-audit";
import { fetchInterfaceListMembers, fetchRules } from "../tools/firewall-audit";
import { fetchSecurityState } from "../tools/security-hardening";
import { complianceFindingId, hardeningFindingId, policyFindingId } from "./identity";
import type { AuditFinding, Severity } from "./model";

export interface AuditAdapter {
  /** The MCP tool this schedules — also what the runner risk-checks. */
  tool: string;
  /** One-line summary for `list_schedules` and the tool description. */
  summary: string;
  run(ctx: ToolContext, device: string): Promise<AuditFinding[]>;
}

/**
 * Compliance and firewall severities are the same words as ours; anything
 * unrecognised becomes `info` rather than being guessed upward, so a new
 * severity string can never masquerade as critical in a regression alert.
 */
function severity(value: string | undefined): Severity {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return "info";
  }
}

const ADAPTERS: AuditAdapter[] = [
  {
    tool: "run_security_hardening_audit",
    summary: "Device security posture — services, firewall defaults, credentials, helpers.",
    async run(ctx, device) {
      const report = runSecurityHardeningAudit(await fetchSecurityState(ctx));
      return report.findings.map((f) => ({
        id: hardeningFindingId(f.finding_id, device),
        severity: severity(f.severity),
        title: f.title,
        device,
        detail: [f.current, f.proposed].filter(Boolean).join(" → ") || undefined,
      }));
    },
  },
  {
    tool: "run_compliance_audit",
    summary: "Scored pass/fail compliance checks across 10 categories.",
    async run(ctx, device) {
      const report = runComplianceAudit(await fetchComplianceState(ctx));
      // Only failures and warnings are findings. A passing check is the absence
      // of a problem — recording it would make every run's diff dominated by
      // checks that are fine.
      return report.evaluatedChecks
        .filter((e) => e.result.status === "fail" || e.result.status === "warn")
        .map((e) => ({
          id: complianceFindingId(e.check.id, device),
          // A warn is a softer signal than the check's nominal severity; it must
          // not page someone at the check's `critical` rating.
          severity: e.result.status === "warn" ? "low" : severity(e.check.severity),
          title: e.check.title,
          device,
          detail: e.result.detail ?? e.result.label,
        }));
    },
  },
  {
    tool: "firewall_audit",
    summary: "Shadowed, unreachable, overly-broad and dead firewall rules.",
    async run(ctx, device) {
      const [filterRows, natRows, interfaceLists] = await Promise.all([
        fetchRules("/ip firewall filter", ctx),
        fetchRules("/ip firewall nat", ctx),
        fetchInterfaceListMembers(ctx),
      ]);
      const report = auditFirewall({
        filter: rulesFromRows(filterRows),
        nat: rulesFromRows(natRows),
        interfaceLists,
      });
      return report.findings.map((f) => ({
        // `findingId` is assigned by auditFirewall and is content-derived; the
        // fallback should be unreachable, and is scoped so it cannot collide.
        id: f.findingId ?? `fw:${device}:${f.kind}:${f.table}:${f.chain}`,
        severity: severity(f.severity),
        title: f.title,
        device,
        detail: f.detail,
      }));
    },
  },
  {
    tool: "run_policy_check",
    summary: "Loaded policy-as-code rules against the device's live configuration.",
    async run(ctx, device) {
      const set = currentPolicySet();
      if (set.policies.length === 0) return [];
      const body = await executeMikrotikCommand("/export terse", ctx);
      if (looksLikeError(body) || body.trim() === "") {
        throw new Error(`could not read the configuration: ${body.trim() || "empty export"}`);
      }
      const report = evaluatePolicies(set.policies, parseExport(body), { device, ts: Date.now() });
      return report.findings
        .filter((f) => f.status === "fail")
        .map((f) => ({
          id: policyFindingId({
            ruleId: f.ruleId,
            section: f.section,
            evidence: f.evidence,
            device,
          }),
          severity: severity(f.severity),
          title: f.ruleId,
          device,
          detail: f.reason,
        }));
    },
  },
];

const BY_TOOL = new Map(ADAPTERS.map((a) => [a.tool, a]));

export function auditAdapter(tool: string): AuditAdapter | undefined {
  return BY_TOOL.get(tool);
}

export function schedulableTools(): AuditAdapter[] {
  return [...ADAPTERS];
}
