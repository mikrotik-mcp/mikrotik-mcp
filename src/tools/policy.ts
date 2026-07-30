/**
 * Policy Engine — an organisation's OWN compliance rules, evaluated against a
 * config snapshot.
 *
 * `Compliance Auditor` and `Security Hardening` run the checks this repo chose.
 * These six tools run the checks YOUR network team chose, written as YAML and
 * versioned next to the config they govern.
 *
 * **Every tool is READ, and the feature never writes to a device.** Remediation
 * is what `Security Hardening` and `Change Plan` are for; keeping the linter
 * strictly read-only is what makes it safe to run anywhere, including CI against
 * an export with no router in the loop.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { evaluatePolicies } from "../policy/evaluate";
import type { Finding, PolicyReport } from "../policy/evaluate";
import { loadPolicies } from "../policy/load";
import type { PolicySet } from "../policy/load";
import { parseExport } from "../policy/parse";
import { explainFinding, renderReport } from "../policy/report";
import { validatePolicyText } from "../policy/schema";
import { packagedPolicyPaths, rememberReport, recentReports } from "../policy/session";
import { openSnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";

let storePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  storePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Load the configured rule files plus (unless disabled) the bundled pack. */
export function currentPolicySet(): PolicySet {
  const cfg = getConfig().policy;
  const patterns = [...cfg.paths, ...(cfg.includeStarterPack ? packagedPolicyPaths() : [])];
  return loadPolicies(patterns);
}

function noRulesMessage(set: PolicySet): string {
  const missing =
    set.emptyPatterns.length > 0 ? ` No files matched: ${set.emptyPatterns.join(", ")}.` : "";
  const broken = set.files.filter((f) => !f.ok);
  const invalid =
    broken.length > 0
      ? ` ${broken.length} file(s) failed validation — run validate_policy_file on ${broken
          .map((f) => f.path)
          .join(", ")}.`
      : "";
  return (
    `No policy rules are loaded.${missing}${invalid} ` +
    "Point `policy.paths` (or MIKROTIK_POLICY_PATHS) at a rule file, or use the bundled starter pack."
  );
}

/** Render a report plus the one-line follow-up a reader needs. */
function summarise(report: PolicyReport, set: PolicySet): string {
  const body = renderReport(report, "markdown");
  const dupes =
    set.duplicateIds.length > 0
      ? `\n\n> Rule id(s) defined in more than one file (later definitions ignored): ${set.duplicateIds.join(", ")}`
      : "";
  const failing = report.findings.filter((f) => f.status === "fail");
  const next =
    failing.length > 0
      ? `\n\nUse explain_policy_finding with rule_id=<id> for the offending lines and the fix.`
      : "";
  return body + dupes + next;
}

export const policyTools: ToolModule = [
  defineTool({
    name: "list_policies",
    title: "List Loaded Policy Rules",
    annotations: READ,
    description:
      "Lists every loaded policy rule file and the rules inside it — id, severity, what it asserts " +
      "and which section it applies to. " +
      "Rules come from `policy.paths` (or MIKROTIK_POLICY_PATHS) plus the bundled starter pack. " +
      "A file that failed validation is listed WITH its errors rather than dropped, so a policy set " +
      "that silently shrank is visible. Contacts no device.",
    inputSchema: {
      tag: z.string().optional().describe("Only rules carrying this tag"),
      severity: z
        .enum(["critical", "high", "medium", "low", "info"])
        .optional()
        .describe("Only rules of this severity"),
    },
    handler(a, ctx) {
      const set = currentPolicySet();
      ctx.info(`Loaded ${set.policies.length} policy rule(s) from ${set.files.length} file(s)`);
      if (set.files.length === 0) return noRulesMessage(set);

      const lines: string[] = [
        `POLICY RULES — ${set.policies.length} rule(s) in ${set.files.length} file(s)`,
        "",
      ];
      for (const file of set.files) {
        lines.push(`${file.path}${file.name ? ` — ${file.name}` : ""}`);
        if (!file.ok) {
          lines.push(`  INVALID (${file.issues.length} issue(s)):`);
          for (const issue of file.issues.slice(0, 10)) {
            lines.push(`    ${issue.path}: ${issue.message}`);
          }
          lines.push("");
          continue;
        }
        const shown = file.policies.filter(
          (p) =>
            (a.tag === undefined || p.tags.includes(a.tag)) &&
            (a.severity === undefined || p.severity === a.severity),
        );
        for (const policy of shown) {
          lines.push(
            `  [${policy.severity}] ${policy.id} — ${policy.description ?? "(no description)"}`,
            `      section ${policy.match.section}${policy.tags.length > 0 ? ` · tags: ${policy.tags.join(", ")}` : ""}`,
          );
        }
        if (shown.length === 0) lines.push("  (no rules match the filter)");
        lines.push("");
      }
      if (set.duplicateIds.length > 0) {
        lines.push(
          `Duplicate ids across files (ignored after the first): ${set.duplicateIds.join(", ")}`,
        );
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "validate_policy_file",
    title: "Validate a Policy Rule File",
    annotations: READ,
    description:
      "Schema-checks a policy rule file — as inline text or a path — and reports each problem with " +
      "the path into the document (`policies.2.assert.field`), so a rule file can be authored " +
      "iteratively without running it against anything. " +
      "Catches what silently breaks a rule set: duplicate ids, two predicates in one leaf, an " +
      "unknown key, an over-long or invalid regex. Contacts no device and reads no config.",
    inputSchema: {
      content: z.string().optional().describe("Rule file text (YAML or JSON)"),
      path: z.string().optional().describe("Path to a rule file to read instead"),
    },
    handler(a, ctx) {
      let text = a.content;
      if (text === undefined) {
        if (!a.path) return "Provide either `content` (the rule text) or `path` (a file to read).";
        // node:fs, not Bun.file — this module is imported by the catalog test
        // on the Node runner, where the Bun global does not exist.
        try {
          text = readFileSync(a.path, "utf8");
        } catch (e) {
          return `Cannot read ${a.path}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      ctx.info("Validating policy rule file");
      const result = validatePolicyText(text);
      if (result.ok) {
        const rules = result.file?.policies ?? [];
        return [
          `VALID — ${rules.length} rule(s).`,
          "",
          ...rules.map((p) => `  [${p.severity}] ${p.id} → ${p.match.section}`),
        ].join("\n");
      }
      return [
        `INVALID — ${result.issues.length} issue(s):`,
        "",
        ...result.issues.map((i) => `  ${i.path}: ${i.message}`),
      ].join("\n");
    },
  }),

  defineTool({
    name: "check_policy_snapshot",
    title: "Check Policies Against a Snapshot",
    annotations: READ,
    description:
      "Evaluates the loaded policy rules against a STORED configuration snapshot — no device is " +
      "contacted at all, which is what makes this runnable in CI. " +
      "Pass `snapshot_id` (from list_config_snapshots), or `config_text` to check an export you " +
      "already have. " +
      "Reports a compliance score, the failing rules by severity, and the offending config line for " +
      "each. A rule matching nothing is reported as NOT APPLICABLE, never as a pass.",
    inputSchema: {
      snapshot_id: z.string().optional().describe("Snapshot id to evaluate"),
      config_text: z.string().optional().describe("Raw `/export` text to evaluate instead"),
      device: z.string().optional().describe("Label the report with this device name"),
    },
    async handler(a, ctx) {
      const set = currentPolicySet();
      if (set.policies.length === 0) return noRulesMessage(set);

      let text = a.config_text;
      let device = a.device;
      if (text === undefined) {
        if (!a.snapshot_id) {
          return "Provide `snapshot_id` (see list_config_snapshots) or `config_text`.";
        }
        const snapshot = (await snapshots()).get(a.snapshot_id);
        if (!snapshot) return `No snapshot '${a.snapshot_id}'.`;
        text = snapshot.body;
        device ??= snapshot.device;
      }

      ctx.info(`Evaluating ${set.policies.length} rule(s) against a snapshot`);
      const report = evaluatePolicies(set.policies, parseExport(text), {
        device,
        ts: Date.now(),
      });
      rememberReport(report);
      return summarise(report, set);
    },
  }),

  defineTool({
    name: "run_policy_check",
    title: "Run a Policy Check on a Device",
    annotations: READ,
    description:
      "Captures the device's current configuration (`/export terse`, a read-only print — it writes " +
      "nothing and leaves no file on the router) and evaluates every loaded policy rule against it. " +
      "This is the live version of check_policy_snapshot: same rules, same report, freshest config. " +
      "Nothing is ever written to the device — remediation belongs to the hardening and change-plan " +
      "tools, and keeping this read-only is what makes it safe to run against production.",
    inputSchema: {
      tag: z.string().optional().describe("Only evaluate rules carrying this tag"),
    },
    async handler(a, ctx) {
      const set = currentPolicySet();
      if (set.policies.length === 0) return noRulesMessage(set);

      const device = resolveDeviceName(ctx.device);
      ctx.info(`[${device}] Capturing configuration for a policy check`);
      const body = await executeMikrotikCommand("/export terse", ctx);
      if (looksLikeError(body) || body.trim() === "") {
        return `Failed to read the configuration from '${device}': ${body.trim() || "empty export"}`;
      }

      const rules = a.tag ? set.policies.filter((p) => p.tags.includes(a.tag ?? "")) : set.policies;
      if (rules.length === 0) return `No rules carry the tag '${a.tag}'.`;

      const report = evaluatePolicies(rules, parseExport(body), { device, ts: Date.now() });
      rememberReport(report);
      return summarise(report, set);
    },
  }),

  defineTool({
    name: "explain_policy_finding",
    title: "Explain a Policy Finding",
    annotations: READ,
    description:
      "Explains one finding from the most recent policy check in depth: the rule, the offending " +
      "configuration line, why it failed (expected versus actual) and the remediation. " +
      "Use it after run_policy_check or check_policy_snapshot when a finding needs to become an " +
      "action. Reads the cached report — no device is contacted.",
    inputSchema: {
      rule_id: z.string().describe("Rule id from the report"),
      device: z.string().optional().describe("Which device's report, when several were checked"),
    },
    handler(a, _ctx) {
      const reports = recentReports();
      if (reports.length === 0) {
        return "No policy check has run yet — call run_policy_check or check_policy_snapshot first.";
      }
      const report =
        (a.device
          ? reports.find((r) => r.device === resolveDeviceName(a.device ?? ""))
          : undefined) ?? reports[0];
      const matching = report.findings.filter((f) => f.ruleId === a.rule_id);
      if (matching.length === 0) {
        const ids = [...new Set(report.findings.map((f) => f.ruleId))];
        return `No finding for rule '${a.rule_id}' in the last report. Rules evaluated: ${ids.join(", ")}`;
      }

      const failing = matching.filter((f) => f.status === "fail");
      const shown: Finding[] = failing.length > 0 ? failing : matching;
      return [
        `${shown.length} occurrence(s) of '${a.rule_id}'${report.device ? ` on ${report.device}` : ""}:`,
        "",
        ...shown.map((f) => explainFinding(f)),
      ].join("\n\n");
    },
  }),

  defineTool({
    name: "export_policy_report",
    title: "Export the Policy Report",
    annotations: READ,
    description:
      "Renders the most recent policy check as Markdown, JSON or **SARIF 2.1.0**. " +
      "SARIF is the format GitHub code-scanning ingests, so a router's configuration can be linted " +
      "in a pull request exactly like source code — each finding lands on the line of the export " +
      "that caused it. Reads the cached report; no device is contacted.",
    inputSchema: {
      format: z.enum(["markdown", "json", "sarif"]).default("markdown"),
      device: z.string().optional().describe("Which device's report, when several were checked"),
      artifact: z
        .string()
        .optional()
        .describe("SARIF artifact path the findings point at (default `<device>.rsc`)"),
    },
    handler(a, _ctx) {
      const reports = recentReports();
      if (reports.length === 0) {
        return "No policy check has run yet — call run_policy_check or check_policy_snapshot first.";
      }
      const report =
        (a.device
          ? reports.find((r) => r.device === resolveDeviceName(a.device ?? ""))
          : undefined) ?? reports[0];
      return renderReport(report, a.format, { artifact: a.artifact });
    },
  }),
];
