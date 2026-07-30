/**
 * Policy findings → a rendered report. PURE.
 *
 * Three formats, each for a different reader:
 *
 * - **Markdown** — what the model shows a human in chat.
 * - **JSON** — what a script consumes.
 * - **SARIF** — what GitHub code-scanning ingests, which is what lets a network
 *   config be linted in a pull request like source code. That is the whole reason
 *   this feature runs against a snapshot instead of a device.
 */
import type { Finding, PolicyReport } from "./evaluate";
import type { Severity } from "./schema";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_MARK: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

/** Failures first, worst severity first, then by rule id for a stable order. */
export function sortFindings(findings: Finding[]): Finding[] {
  const statusRank = { fail: 0, "not-applicable": 2, pass: 1 } as const;
  return [...findings].sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** The one-line verdict every format opens with. */
export function headline(report: PolicyReport): string {
  const { summary } = report;
  const device = report.device ? ` — ${report.device}` : "";
  const applicable = summary.passed + summary.failed;
  const skipped = summary.notApplicable > 0 ? `, ${summary.notApplicable} not applicable` : "";
  return `POLICY CHECK${device}: ${summary.score}% (${summary.passed}/${applicable} applicable rules passed)${skipped}`;
}

export function renderMarkdown(report: PolicyReport): string {
  const { summary } = report;
  const failures = sortFindings(report.findings.filter((f) => f.status === "fail"));

  const lines = [
    `# ${headline(report)}`,
    "",
    `| Severity | Failing rules |`,
    `| --- | ---: |`,
    ...SEVERITY_ORDER.filter((s) => summary.bySeverity[s] > 0).map(
      (s) => `| ${SEVERITY_MARK[s]} ${s} | ${summary.bySeverity[s]} |`,
    ),
  ];
  if (SEVERITY_ORDER.every((s) => summary.bySeverity[s] === 0)) {
    lines.push(`| — | 0 |`);
  }

  if (failures.length === 0) {
    lines.push("", "No violations.");
  } else {
    lines.push("", "## Findings", "");
    for (const f of failures) {
      lines.push(
        `### ${SEVERITY_MARK[f.severity]} \`${f.ruleId}\`${f.description ? ` — ${f.description}` : ""}`,
        "",
        `- **Where:** \`${f.section}\`${f.line ? ` (line ${f.line})` : ""}`,
        `- **Why:** ${f.reason}`,
        ...(f.evidence ? ["", "```", f.evidence, "```"] : []),
        ...(f.remediation ? ["", `**Fix:** ${f.remediation}`] : []),
        "",
      );
    }
  }

  if (report.unparsedLines > 0) {
    lines.push(
      "",
      `> ${report.unparsedLines} line(s) of the export could not be parsed, so this check did not read the whole config.`,
    );
  }
  return lines.join("\n");
}

export function renderJson(report: PolicyReport): string {
  return JSON.stringify(
    {
      device: report.device,
      ts: report.ts,
      summary: report.summary,
      unparsedLines: report.unparsedLines,
      findings: sortFindings(report.findings),
    },
    null,
    2,
  );
}

/** SARIF severity levels; anything below `medium` is a note, not a warning. */
function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

/**
 * SARIF 2.1.0. `artifactLocation` points at the export the check ran against, so
 * a finding lands on the right line in a code-scanning view — which is why the
 * parser keeps line numbers at all.
 */
export function renderSarif(report: PolicyReport, opts: { artifact?: string } = {}): string {
  const artifact = opts.artifact ?? `${report.device ?? "device"}.rsc`;
  const failures = sortFindings(report.findings.filter((f) => f.status === "fail"));

  // One rule descriptor per rule id, even when it failed on many lines.
  const rules = new Map<
    string,
    { id: string; shortDescription: string; help: string; level: string }
  >();
  for (const f of failures) {
    if (rules.has(f.ruleId)) continue;
    rules.set(f.ruleId, {
      id: f.ruleId,
      shortDescription: f.description ?? f.ruleId,
      help: f.remediation ?? f.reason,
      level: sarifLevel(f.severity),
    });
  }

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "mikrotik-mcp policy engine",
              informationUri: "https://github.com/",
              rules: [...rules.values()].map((r) => ({
                id: r.id,
                shortDescription: { text: r.shortDescription },
                help: { text: r.help },
                defaultConfiguration: { level: r.level },
              })),
            },
          },
          results: failures.map((f) => ({
            ruleId: f.ruleId,
            level: sarifLevel(f.severity),
            message: { text: f.reason },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: artifact },
                  // SARIF requires a positive line; a set-level finding with no
                  // record still has to point somewhere, so it points at line 1.
                  region: {
                    startLine: f.line ?? 1,
                    snippet: f.evidence ? { text: f.evidence } : undefined,
                  },
                },
              },
            ],
            properties: { severity: f.severity, section: f.section, tags: f.tags },
          })),
        },
      ],
    },
    null,
    2,
  );
}

/** One finding in depth — the `explain_policy_finding` body. */
export function explainFinding(finding: Finding): string {
  return [
    `${SEVERITY_MARK[finding.severity]} ${finding.ruleId} — ${finding.status.toUpperCase()}`,
    finding.description ? `\n${finding.description}` : "",
    "",
    `Device:  ${finding.device ?? "(snapshot)"}`,
    `Section: ${finding.section}${finding.line ? ` (line ${finding.line})` : ""}`,
    `Reason:  ${finding.reason}`,
    ...(finding.evidence ? ["", "Offending configuration:", `  ${finding.evidence}`] : []),
    ...(finding.remediation ? ["", `Fix: ${finding.remediation}`] : []),
    ...(finding.tags.length > 0 ? ["", `Tags: ${finding.tags.join(", ")}`] : []),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export type ReportFormat = "markdown" | "json" | "sarif";

export function renderReport(
  report: PolicyReport,
  format: ReportFormat,
  opts: { artifact?: string } = {},
): string {
  switch (format) {
    case "json":
      return renderJson(report);
    case "sarif":
      return renderSarif(report, opts);
    case "markdown":
      return renderMarkdown(report);
  }
}
