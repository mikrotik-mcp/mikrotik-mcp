/**
 * Pure formatting, prompt-engineering, and JQL-style query helpers for the
 * Raycast Tool Feedback command (`raycast/src/feedback.tsx`). Kept pure and free
 * of Raycast runtime side effects so unit tests can verify every behavior.
 */
import type {
  FeedbackImpact,
  FeedbackIssue,
  FeedbackKind,
  FeedbackOccurrence,
  FeedbackStatus,
} from "./types";

export const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Bug",
  missing_tool: "Missing Tool",
  missing_param: "Missing Parameter",
  confusing_schema: "Confusing Schema",
  unexpected_output: "Unexpected Output",
  performance: "Performance",
  docs_gap: "Docs Gap",
  feature_request: "Feature Request",
};

export const KIND_DESCRIPTIONS: Record<FeedbackKind, string> = {
  bug: "Tool threw an error or generated invalid RouterOS CLI",
  missing_tool: "No dedicated MCP tool exists for this RouterOS operation",
  missing_param: "Dedicated tool exists, but lacks a needed RouterOS flag",
  confusing_schema: "Parameter names, types, or descriptions misled the model",
  unexpected_output: "Tool succeeded, but output format was truncated or unclear",
  performance: "Slow response, timeout, or excessive token payload",
  docs_gap: "Missing guidance in tool description or knowledge resources",
  feature_request: "New workflow helper, composite tool, or safety guard",
};

export const IMPACT_LABELS: Record<FeedbackImpact, string> = {
  blocker: "Blocker",
  degraded: "Degraded",
  friction: "Friction",
  suggestion: "Suggestion",
};

export const IMPACT_HINTS: Record<FeedbackImpact, string> = {
  blocker: "Task failed completely",
  degraded: "Needed raw CLI fallback",
  friction: "Extra calls or retries",
  suggestion: "Polish or ergonomics",
};

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  wont_fix: "Won’t Fix",
};

export const LANE_SUBTITLES: Record<FeedbackStatus, string> = {
  open: "Triaged reports awaiting fix or dedicated tool",
  in_progress: "Active engineering work & schema updates",
  resolved: "Shipped fixes & MCP Memory-synced guidance",
  wont_fix: "Closed by design or handled via existing tools",
};

export function formatAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export interface ParsedSearch {
  plainQuery: string;
  tokens: { key: string; value: string; raw: string }[];
}

/**
 * Parse JQL-style filter tokens from a search query:
 * `kind:bug`, `impact:blocker`, `status:open`, `tool:wireguard`,
 * `device:home-ax3`, `ros:7.16`, `tag:ipv6`, `is:hot`, `is:reopened`,
 * `has:memory`, `has:github`, `has:workaround`, `has:fix`.
 */
export function parseSmartQuery(raw: string): ParsedSearch {
  const tokens: { key: string; value: string; raw: string }[] = [];
  const plainParts: string[] = [];
  const regex =
    /\b(kind|impact|status|tool|op|device|ros|tag|is|has):([^\s]+)|([^\s]+)/gi;
  for (const match of raw.matchAll(regex)) {
    if (match[1] && match[2]) {
      tokens.push({
        key: match[1].toLowerCase(),
        value: match[2].toLowerCase(),
        raw: match[0],
      });
    } else if (match[3]) {
      plainParts.push(match[3]);
    }
  }
  return {
    plainQuery: plainParts.join(" ").trim(),
    tokens,
  };
}

export function matchesSmartFeedbackQuery(
  item: FeedbackIssue,
  rawQuery: string,
  dropdownFilter = "all",
): boolean {
  if (dropdownFilter.startsWith("status:")) {
    const st = dropdownFilter.slice("status:".length);
    if (item.status !== st) return false;
  } else if (dropdownFilter.startsWith("impact:")) {
    const imp = dropdownFilter.slice("impact:".length);
    if (item.impact !== imp) return false;
  } else if (dropdownFilter.startsWith("kind:")) {
    const k = dropdownFilter.slice("kind:".length);
    if (item.kind !== k) return false;
  } else if (dropdownFilter === "preset:hot") {
    if (item.occurrences < 3) return false;
  } else if (dropdownFilter === "preset:reopened") {
    if (item.reopenedCount === 0) return false;
  } else if (dropdownFilter === "preset:has_fix") {
    if (!item.resolutionNote && !item.workaround && !item.replacementTool)
      return false;
  } else if (dropdownFilter === "preset:memory_synced") {
    if (!item.memoryFactId) return false;
  } else if (dropdownFilter === "preset:github_linked") {
    if (!item.githubIssueUrl) return false;
  } else if (dropdownFilter === "preset:unresolved") {
    if (item.status === "resolved" || item.status === "wont_fix") return false;
  }

  const { plainQuery, tokens } = parseSmartQuery(rawQuery);

  for (const { key, value } of tokens) {
    if (key === "kind" && !item.kind.toLowerCase().includes(value))
      return false;
    if (key === "impact" && !item.impact.toLowerCase().includes(value))
      return false;
    if (key === "status" && !item.status.toLowerCase().includes(value))
      return false;
    if (
      (key === "tool" || key === "op") &&
      !(item.operation ?? "").toLowerCase().includes(value) &&
      !(item.replacementTool ?? "").toLowerCase().includes(value)
    ) {
      return false;
    }
    if (
      key === "device" &&
      !(item.lastDevice ?? "").toLowerCase().includes(value)
    ) {
      return false;
    }
    if (
      key === "ros" &&
      !(item.lastRouterosVersion ?? "").toLowerCase().includes(value)
    ) {
      return false;
    }
    if (
      key === "tag" &&
      !item.tags.some((t) => t.toLowerCase().includes(value))
    ) {
      return false;
    }
    if (key === "is" || key === "has") {
      if (value === "hot" && item.occurrences < 3) return false;
      if (value === "blocker" && item.impact !== "blocker") return false;
      if (value === "reopened" && item.reopenedCount === 0) return false;
      if (value === "memory" && !item.memoryFactId) return false;
      if (value === "github" && !item.githubIssueUrl) return false;
      if (value === "workaround" && !item.workaround) return false;
      if (
        value === "fix" &&
        !item.resolutionNote &&
        !item.replacementTool &&
        !item.fixedInVersion
      ) {
        return false;
      }
    }
  }

  if (plainQuery) {
    const needle = plainQuery.toLowerCase();
    const haystack = [
      `#${item.id}`,
      item.title,
      item.detail,
      item.operation ?? "",
      item.actualError ?? "",
      item.expected ?? "",
      item.workaround ?? "",
      item.suggestedFix ?? "",
      item.resolutionNote ?? "",
      item.replacementTool ?? "",
      item.lastDevice ?? "",
      item.lastRouterosVersion ?? "",
      item.lastAgentModel ?? "",
      ...item.tags,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

export function buildAiFixPrompt(
  issue: FeedbackIssue,
  occurrences: FeedbackOccurrence[] = [],
): string {
  const devices = [
    ...new Set(
      [issue.lastDevice, ...occurrences.map((o) => o.device)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
  const rosVersions = [
    ...new Set(
      [
        issue.lastRouterosVersion,
        ...occurrences.map((o) => o.routerosVersion),
      ].filter((x): x is string => Boolean(x)),
    ),
  ];
  const models = [
    ...new Set(
      [issue.lastAgentModel, ...occurrences.map((o) => o.agentModel)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];

  const lines = [
    "# Role",
    "You are a Staff TypeScript, MCP (Model Context Protocol), and MikroTik RouterOS Systems Engineer working on the `mikrotik-mcp` repository.",
    "You have deep expertise in RouterOS v6/v7 CLI command builders (`Cmd`), Zod strict input schemas, multi-router SSH execution, and MCP tool registration.",
    "",
    "# Objective",
    `Resolve LLM tool-feedback issue #${issue.id}: **${issue.title}**`,
    "",
    "# Telemetry & Environment Context",
    `- **Feedback ID:** #${issue.id} (fingerprint \`${issue.fingerprint}\`)`,
    `- **Category:** ${KIND_LABELS[issue.kind]} (\`${issue.kind}\`)`,
    `- **Impact Severity:** ${IMPACT_LABELS[issue.impact]} (\`${issue.impact}\`)`,
    `- **Status:** ${STATUS_LABELS[issue.status]} (\`${issue.status}\`)`,
    `- **Operation / Tool / CLI Path:** \`${issue.operation ?? "(general)"}\``,
    `- **Deduplicated Sightings:** ×${issue.occurrences}${issue.reopenedCount > 0 ? ` (reopened ${issue.reopenedCount}× after prior fix)` : ""}`,
    `- **First / Last Seen:** ${formatDate(issue.firstSeenAt)} → ${formatDate(issue.lastSeenAt)}`,
    `- **Devices Affected:** ${devices.length ? devices.join(", ") : "—"}`,
    `- **RouterOS Versions:** ${rosVersions.length ? rosVersions.map((v) => `v${v}`).join(", ") : "—"}`,
    `- **Reporting AI Models:** ${models.length ? models.join(", ") : "—"}`,
    ...(issue.tags.length
      ? [`- **Subsystem Tags:** ${issue.tags.join(", ")}`]
      : []),
    "",
    "# Problem Description",
    issue.detail,
  ];
  if (issue.actualError) {
    lines.push(
      "",
      "# Actual Error / RouterOS Output",
      "```text",
      issue.actualError,
      "```",
    );
  }
  if (issue.expected) {
    lines.push("", "# Expected Behavior", issue.expected);
  }
  if (issue.workaround) {
    lines.push("", "# Current Workaround Used by LLM", issue.workaround);
  }
  if (issue.suggestedFix) {
    lines.push("", "# Suggested Fix Proposal", issue.suggestedFix);
  }
  lines.push(
    "",
    "# Engineering Requirements & Constraints",
    "1. **Root-Cause Investigation:** Locate the relevant tool module in `src/tools/` (or create a dedicated tool if `kind` is `missing_tool`) and inspect how arguments are validated and compiled into RouterOS CLI commands.",
    "2. **Safe Command Building:** Use `Cmd` builders (`src/core/cmd.ts`) and strict Zod schemas so no unsanitized argument can ever reach RouterOS in command position.",
    "3. **Schema & Catalog Sync:** If you add or modify tool schemas, run `bun run gen` to regenerate `schemas/` and reference docs.",
    "4. **Verification Gate:** Add or update unit tests in `tests/` covering the exact failure or new capability, then run `bun run test:types && bun run test && bun run lint`.",
  );
  return lines.join("\n");
}

export function buildBatchAiFixPrompt(issues: FeedbackIssue[]): string {
  if (issues.length === 0) return "";
  if (issues.length === 1) return buildAiFixPrompt(issues[0]!);

  const totalSightings = issues.reduce((sum, i) => sum + i.occurrences, 0);
  const devices = [
    ...new Set(
      issues.map((i) => i.lastDevice).filter((x): x is string => Boolean(x)),
    ),
  ];
  const rosVersions = [
    ...new Set(
      issues
        .map((i) => i.lastRouterosVersion)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const models = [
    ...new Set(
      issues
        .map((i) => i.lastAgentModel)
        .filter((x): x is string => Boolean(x)),
    ),
  ];

  const lines: string[] = [
    "# Role",
    "You are a Staff TypeScript, MCP (Model Context Protocol), and MikroTik RouterOS Systems Engineer working on the `mikrotik-mcp` repository.",
    "You have deep expertise in RouterOS v6/v7 CLI command builders (`Cmd`), Zod strict input schemas, multi-router SSH execution, and MCP tool registration.",
    "",
    "# Objective",
    `Resolve a batch of **${issues.length} LLM tool-feedback issues** (totaling **×${totalSightings}** sightings):`,
    ...issues.map(
      (i) =>
        `- **#${i.id}** [${KIND_LABELS[i.kind]} · ${IMPACT_LABELS[i.impact]} · ×${i.occurrences}] \`${i.operation ?? "(general)"}\` — ${i.title}`,
    ),
    "",
    "# Aggregated Telemetry & Environment Context",
    `- **Selected Issue IDs:** ${issues.map((i) => `#${i.id}`).join(", ")}`,
    `- **Total Sightings:** ×${totalSightings}`,
    `- **Devices Affected:** ${devices.length ? devices.join(", ") : "—"}`,
    `- **RouterOS Versions:** ${rosVersions.length ? rosVersions.map((v) => `v${v}`).join(", ") : "—"}`,
    `- **Reporting AI Models:** ${models.length ? models.join(", ") : "—"}`,
  ];

  for (const issue of issues) {
    lines.push(
      "",
      "---",
      `## Issue #${issue.id}: ${issue.title}`,
      `- **Category:** ${KIND_LABELS[issue.kind]} (\`${issue.kind}\`) · **Impact:** ${IMPACT_LABELS[issue.impact]} (\`${issue.impact}\`) · **Status:** ${STATUS_LABELS[issue.status]} (\`${issue.status}\`)`,
      `- **Operation / Tool / CLI Path:** \`${issue.operation ?? "(general)"}\``,
      `- **Sightings:** ×${issue.occurrences}${issue.reopenedCount > 0 ? ` (reopened ${issue.reopenedCount}×)` : ""} · **Fingerprint:** \`${issue.fingerprint}\``,
      `- **Device / RouterOS / Agent:** ${issue.lastDevice ?? "—"} / ${issue.lastRouterosVersion ? `v${issue.lastRouterosVersion}` : "—"} / ${issue.lastAgentModel ?? "—"}`,
      "",
      "### Problem Description",
      issue.detail,
    );
    if (issue.actualError) {
      lines.push(
        "",
        "### Actual Error / RouterOS Output",
        "```text",
        issue.actualError,
        "```",
      );
    }
    if (issue.expected) {
      lines.push("", "### Expected Behavior", issue.expected);
    }
    if (issue.workaround) {
      lines.push("", "### Current Workaround", issue.workaround);
    }
    if (issue.suggestedFix) {
      lines.push("", "### Suggested Fix", issue.suggestedFix);
    }
  }

  lines.push(
    "",
    "---",
    "# Engineering Requirements & Constraints",
    "1. **Root-Cause Investigation:** Address each feedback item above in `src/tools/` (fixing existing tool schemas/builders or adding dedicated tools for `missing_tool` items).",
    "2. **Safe Command Building:** Use `Cmd` builders (`src/core/cmd.ts`) and strict Zod schemas so no unsanitized argument can ever reach RouterOS in command position.",
    "3. **Schema & Catalog Sync:** Run `bun run gen` after adding or modifying tool schemas.",
    "4. **Verification Gate:** Add or update unit tests in `tests/` covering every resolved item, then run `bun run test:types && bun run test && bun run lint`.",
  );

  return lines.join("\n");
}

export function buildIssueDetailMarkdown(
  issue: FeedbackIssue,
  occurrences: FeedbackOccurrence[] = [],
): string {
  const parts: string[] = [
    `# #${issue.id} · ${issue.title}`,
    "",
    `**${STATUS_LABELS[issue.status]}** · **${IMPACT_LABELS[issue.impact]}** · **${KIND_LABELS[issue.kind]}**${
      issue.operation ? ` · \`${issue.operation}\`` : ""
    }`,
    "",
    issue.detail,
  ];

  if (issue.actualError) {
    parts.push(
      "",
      "## Actual Error / RouterOS Output",
      "```text",
      issue.actualError,
      "```",
    );
  }
  if (issue.expected) {
    parts.push("", "## Expected Behavior", issue.expected);
  }
  if (issue.workaround) {
    parts.push("", "## Workaround (Shared with AI)", issue.workaround);
  }
  if (issue.suggestedFix) {
    parts.push("", "## Suggested Engineering Fix", issue.suggestedFix);
  }
  if (issue.resolutionNote || issue.replacementTool || issue.fixedInVersion) {
    parts.push(
      "",
      "## Resolution & MCP Memory Guidance",
      ...(issue.replacementTool
        ? [`- **Replacement Tool:** \`${issue.replacementTool}\``]
        : []),
      ...(issue.fixedInVersion
        ? [`- **Fixed in Version:** \`${issue.fixedInVersion}\``]
        : []),
      ...(issue.resolutionNote
        ? [`- **Resolution Note:** ${issue.resolutionNote}`]
        : []),
    );
  }

  if (occurrences.length > 0) {
    parts.push(
      "",
      `## Sighting Timeline (${occurrences.length} recent)`,
      "",
      "| Time | Source | Device | RouterOS | Agent | Call ID |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      ...occurrences.slice(0, 12).map((o) => {
        const time = new Date(o.ts).toLocaleString();
        return `| ${time} | ${o.source.toUpperCase()} | ${o.device ?? "—"} | ${
          o.routerosVersion ? `v${o.routerosVersion}` : "—"
        } | ${o.agentModel ?? "—"} | ${o.callId ? `\`${o.callId}\`` : "—"} |`;
      }),
    );
  }

  return parts.join("\n");
}
