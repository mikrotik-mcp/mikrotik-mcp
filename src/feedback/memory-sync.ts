/**
 * Synchronizes resolved or guided tool-feedback items into the MCP Knowledge
 * Memory (`~/.mikrotik-mcp/memory.db`) under a shared `mcp-tool-feedback`
 * policy entity, and builds structured GitHub issue / AI Prompt Engineering
 * payloads.
 */
import { getMemoryStore, isMemoryEnabled } from "../memory/accessor";
import type { FeedbackIssue, FeedbackKind, FeedbackOccurrence } from "./types";

export const FEEDBACK_MEMORY_ENTITY = "mcp-tool-feedback";

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Bug",
  missing_tool: "Missing Tool",
  missing_param: "Missing Parameter",
  confusing_schema: "Confusing Schema",
  unexpected_output: "Unexpected Output",
  performance: "Performance",
  docs_gap: "Documentation Gap",
  feature_request: "Feature Request",
};

/**
 * Format a concise, high-signal lesson for the MCP knowledge graph so that any
 * future AI session calling `memory_recall` immediately learns that a reported
 * bug/suggestion was fixed, what replacement tool to use, or what workaround
 * applies.
 */
export function formatFeedbackMemoryContent(issue: FeedbackIssue): string {
  const op = issue.operation ? `[${issue.operation}] ` : "";
  const statusTag =
    issue.status === "resolved"
      ? `RESOLVED${issue.fixedInVersion ? ` in ${issue.fixedInVersion}` : ""}`
      : issue.status === "wont_fix"
        ? "WONT_FIX"
        : issue.status.toUpperCase();
  const lines: string[] = [`${op}Feedback #${issue.id} (${statusTag}): ${issue.title}.`];
  if (issue.replacementTool) {
    lines.push(
      `Implemented tool / capability: use \`${issue.replacementTool}\` (via find_tools / invoke_tool) instead of raw CLI workarounds.`,
    );
  }
  if (issue.resolutionNote) {
    lines.push(`Resolution: ${issue.resolutionNote}`);
  }
  if (issue.workaround) {
    lines.push(`Workaround: ${issue.workaround}`);
  }
  return lines.join(" ").slice(0, 7500);
}

/**
 * Upsert a resolved or guided feedback item into the MCP Knowledge Memory
 * (`mcp-tool-feedback` entity, `shared` scope) so every future `memory_recall`
 * automatically surfaces the fix or workaround.
 */
export async function syncFeedbackToMemory(issue: FeedbackIssue): Promise<number | null> {
  if (!isMemoryEnabled()) return null;
  if (
    !issue.resolutionNote &&
    !issue.workaround &&
    !issue.replacementTool &&
    !issue.fixedInVersion &&
    issue.status !== "resolved"
  ) {
    return null;
  }

  const mem = await getMemoryStore();
  mem.createEntities([{ name: FEEDBACK_MEMORY_ENTITY, entityType: "policy" }]);
  const currentScope = mem.scope(FEEDBACK_MEMORY_ENTITY);
  if (currentScope.scope !== "shared") {
    mem.setScope({
      entityName: FEEDBACK_MEMORY_ENTITY,
      scope: "shared",
      members: [],
      expectedRevision: currentScope.revision,
      confirmSharing: true,
    });
  }

  const content = formatFeedbackMemoryContent(issue);
  const saved = mem.remember({
    entityName: FEEDBACK_MEMORY_ENTITY,
    key: `feedback.issue.${issue.id}`,
    kind: "lesson",
    content,
    source: `dashboard:feedback#${issue.id}`,
    confidence: 1,
    pinned: issue.status === "resolved" || issue.impact === "blocker",
    expiresAt: null,
    supersedes: [],
  });
  const verified = mem.revise({
    id: saved.id,
    expectedRevision: saved.revision,
    verified: true,
  });
  return verified.id;
}

/**
 * Build a GitHub Issue title and Markdown body with full telemetry, device
 * context, occurrence history, and an embedded Prompt-Engineering block.
 */
export function buildGithubIssuePayload(
  issue: FeedbackIssue,
  occurrences: FeedbackOccurrence[] = [],
): {
  title: string;
  body: string;
  labels: string[];
} {
  const prefix = `[${KIND_LABELS[issue.kind]}]`;
  const opPart = issue.operation ? ` ${issue.operation}:` : "";
  const title = `${prefix}${opPart} ${issue.title}`.slice(0, 240);

  const devices = [
    ...new Set(
      [issue.lastDevice, ...occurrences.map((o) => o.device)].filter((x): x is string =>
        Boolean(x),
      ),
    ),
  ];
  const rosVersions = [
    ...new Set(
      [issue.lastRouterosVersion, ...occurrences.map((o) => o.routerosVersion)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
  const models = [
    ...new Set(
      [issue.lastAgentModel, ...occurrences.map((o) => o.agentModel)].filter((x): x is string =>
        Boolean(x),
      ),
    ),
  ];

  const lines: string[] = [
    `## Summary`,
    issue.detail,
    "",
    `## Telemetry & Device Context`,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| **Feedback ID** | \`#${issue.id}\` (\`${issue.fingerprint}\`) |`,
    `| **Category** | \`${issue.kind}\` (${KIND_LABELS[issue.kind]}) |`,
    `| **Impact** | \`${issue.impact}\` |`,
    `| **Status** | \`${issue.status}\` |`,
    `| **Operation / Tool** | \`${issue.operation ?? "(general)"}\` |`,
    `| **Deduplicated Sightings** | \`×${issue.occurrences}\`${issue.reopenedCount > 0 ? ` (reopened \`${issue.reopenedCount}×\`)` : ""} |`,
    `| **Devices Affected** | ${devices.length ? devices.map((d) => `\`${d}\``).join(", ") : "—"} |`,
    `| **RouterOS Versions** | ${rosVersions.length ? rosVersions.map((v) => `\`v${v}\``).join(", ") : "—"} |`,
    `| **AI Agent Models** | ${models.length ? models.map((m) => `\`${m}\``).join(", ") : "—"} |`,
    `| **First / Last Seen** | ${new Date(issue.firstSeenAt).toISOString()} → ${new Date(issue.lastSeenAt).toISOString()} |`,
  ];

  if (issue.actualError) {
    lines.push("", "## Actual Error / RouterOS Output", "```text", issue.actualError, "```");
  }
  if (issue.expected) {
    lines.push("", "## Expected Behavior", issue.expected);
  }
  if (issue.workaround) {
    lines.push("", "## Current Workaround", issue.workaround);
  }
  if (issue.suggestedFix) {
    lines.push("", "## Suggested Fix", issue.suggestedFix);
  }
  if (issue.resolutionNote || issue.fixedInVersion || issue.replacementTool) {
    lines.push(
      "",
      "## Operator Resolution Notes",
      ...(issue.fixedInVersion ? [`- **Fixed in version:** \`${issue.fixedInVersion}\``] : []),
      ...(issue.replacementTool ? [`- **Replacement tool:** \`${issue.replacementTool}\``] : []),
      ...(issue.resolutionNote ? [`- **Note:** ${issue.resolutionNote}`] : []),
    );
  }

  const labelMap: Record<FeedbackKind, string> = {
    bug: "bug",
    missing_tool: "enhancement",
    missing_param: "enhancement",
    confusing_schema: "documentation",
    unexpected_output: "bug",
    performance: "performance",
    docs_gap: "documentation",
    feature_request: "enhancement",
  };
  const labels = [...new Set(["llm-feedback", labelMap[issue.kind], ...issue.tags.slice(0, 4)])];

  return {
    title,
    body: lines.join("\n"),
    labels,
  };
}

/**
 * Build a combined GitHub Issue title and Markdown body for a batch of selected
 * feedback items, preserving per-item telemetry, device context, RouterOS
 * versions, and error outputs.
 */
export function buildBatchGithubIssuePayload(
  entries: { issue: FeedbackIssue; occurrences?: FeedbackOccurrence[] }[],
): {
  title: string;
  body: string;
  labels: string[];
} {
  if (entries.length === 1) {
    return buildGithubIssuePayload(entries[0]!.issue, entries[0]!.occurrences ?? []);
  }

  const issues = entries.map((e) => e.issue);
  const allOccurrences = entries.flatMap((e) => e.occurrences ?? []);
  const totalSightings = issues.reduce((sum, i) => sum + i.occurrences, 0);
  const uniqueOps = [
    ...new Set(issues.map((i) => i.operation).filter((x): x is string => Boolean(x))),
  ];
  const devices = [
    ...new Set(
      [...issues.map((i) => i.lastDevice), ...allOccurrences.map((o) => o.device)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
  const rosVersions = [
    ...new Set(
      [
        ...issues.map((i) => i.lastRouterosVersion),
        ...allOccurrences.map((o) => o.routerosVersion),
      ].filter((x): x is string => Boolean(x)),
    ),
  ];
  const models = [
    ...new Set(
      [...issues.map((i) => i.lastAgentModel), ...allOccurrences.map((o) => o.agentModel)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];

  const opSummary =
    uniqueOps.length === 1
      ? uniqueOps[0]!
      : uniqueOps.length > 1
        ? `${uniqueOps.slice(0, 2).join(", ")}${uniqueOps.length > 2 ? ` +${uniqueOps.length - 2}` : ""}`
        : "Multiple tools";

  const title =
    `[Batch Feedback] ${issues.length} tool issues (${opSummary}) — ×${totalSightings} sightings`.slice(
      0,
      240,
    );

  const lines: string[] = [
    `## Batch Feedback Summary (${issues.length} issues · ×${totalSightings} total sightings)`,
    `| # | Category | Impact | Operation / Tool | Sightings | Device / RouterOS | Title |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
    ...issues.map(
      (i) =>
        `| \`#${i.id}\` | \`${i.kind}\` | \`${i.impact}\` | \`${i.operation ?? "(general)"}\` | \`×${i.occurrences}\` | ${
          [i.lastDevice, i.lastRouterosVersion ? `v${i.lastRouterosVersion}` : null]
            .filter(Boolean)
            .join(" / ") || "—"
        } | ${i.title.replace(/\|/g, "\\|")} |`,
    ),
    "",
    `## Aggregated Environment & Device Telemetry`,
    `- **Feedback IDs:** ${issues.map((i) => `\`#${i.id}\``).join(", ")}`,
    `- **Devices Affected:** ${devices.length ? devices.map((d) => `\`${d}\``).join(", ") : "—"}`,
    `- **RouterOS Versions:** ${rosVersions.length ? rosVersions.map((v) => `\`v${v}\``).join(", ") : "—"}`,
    `- **AI Agent Models:** ${models.length ? models.map((m) => `\`${m}\``).join(", ") : "—"}`,
  ];

  for (const { issue } of entries) {
    lines.push(
      "",
      `---`,
      `### Issue #${issue.id}: ${issue.title}`,
      `- **Category:** \`${issue.kind}\` (${KIND_LABELS[issue.kind]}) · **Impact:** \`${issue.impact}\` · **Status:** \`${issue.status}\``,
      `- **Operation / Tool:** \`${issue.operation ?? "(general)"}\` · **Sightings:** \`×${issue.occurrences}\` · **Fingerprint:** \`${issue.fingerprint}\``,
      `- **Device / RouterOS:** ${issue.lastDevice ?? "—"} / ${issue.lastRouterosVersion ? `v${issue.lastRouterosVersion}` : "—"}`,
      "",
      issue.detail,
    );
    if (issue.actualError) {
      lines.push("", "**Actual Error:**", "```text", issue.actualError, "```");
    }
    if (issue.expected) {
      lines.push("", `**Expected:** ${issue.expected}`);
    }
    if (issue.workaround) {
      lines.push("", `**Workaround:** ${issue.workaround}`);
    }
    if (issue.suggestedFix) {
      lines.push("", `**Suggested Fix:** ${issue.suggestedFix}`);
    }
  }

  const labelMap: Record<FeedbackKind, string> = {
    bug: "bug",
    missing_tool: "enhancement",
    missing_param: "enhancement",
    confusing_schema: "documentation",
    unexpected_output: "bug",
    performance: "performance",
    docs_gap: "documentation",
    feature_request: "enhancement",
  };
  const labels = [
    ...new Set([
      "llm-feedback",
      ...issues.map((i) => labelMap[i.kind]),
      ...issues.flatMap((i) => i.tags).slice(0, 4),
    ]),
  ].slice(0, 10);

  return {
    title,
    body: lines.join("\n"),
    labels,
  };
}
