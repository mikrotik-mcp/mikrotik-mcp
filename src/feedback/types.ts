/**
 * Shared contracts and Zod schemas for the LLM tool-feedback & telemetry loop.
 * Pure and dependency-free (no `bun:sqlite`, no device I/O) so it loads under
 * both Bun and Node test runners.
 */
import { z } from "zod";
import { assertMemorySafe } from "../memory/knowledge";
import { redactAuditText } from "../observability/event";

export const feedbackKinds = [
  "bug",
  "missing_tool",
  "missing_param",
  "confusing_schema",
  "unexpected_output",
  "performance",
  "docs_gap",
  "feature_request",
] as const;
export type FeedbackKind = (typeof feedbackKinds)[number];

export const feedbackImpacts = ["blocker", "degraded", "friction", "suggestion"] as const;
export type FeedbackImpact = (typeof feedbackImpacts)[number];

export const feedbackStatuses = ["open", "in_progress", "resolved", "wont_fix"] as const;
export type FeedbackStatus = (typeof feedbackStatuses)[number];

export const feedbackSources = ["llm", "operator"] as const;
export type FeedbackSource = (typeof feedbackSources)[number];

const shortText = z.string().trim().min(1).max(300);
const longText = z.string().trim().min(1).max(8000);
const optionalShortText = z.string().trim().max(300).optional();
const optionalLongText = z.string().trim().max(8000).optional();

export const SubmitFeedbackSchema = z
  .object({
    kind: z
      .enum(feedbackKinds)
      .describe(
        "Category of the feedback: 'bug' (tool error or broken behavior), 'missing_tool' (needed capability has no dedicated tool), 'missing_param' (tool exists but lacks a parameter/filter), 'confusing_schema' (description or arguments are ambiguous), 'unexpected_output' (output format/content was surprising or incomplete), 'performance' (timeout or slow execution), 'docs_gap' (missing guidance), or 'feature_request'.",
      ),
    impact: z
      .enum(feedbackImpacts)
      .default("friction")
      .describe(
        "Operational impact on the current task: 'blocker' (task could not be completed), 'degraded' (had to fall back to raw command or manual workaround), 'friction' (took extra retries/calls), or 'suggestion' (improvement idea).",
      ),
    operation: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Exact MCP tool name (e.g. 'list_firewall_rules') or RouterOS menu path (e.g. '/ip/firewall/filter') involved. Omit only for general server feedback.",
      ),
    tool: optionalShortText.describe("Alias for `operation` (MCP tool name or RouterOS path)."),
    tool_name: optionalShortText.describe(
      "Alias for `operation` (MCP tool name or RouterOS path).",
    ),
    title: z
      .string()
      .trim()
      .min(3)
      .max(240)
      .describe(
        "Concise one-line summary of the issue or missing capability (e.g. 'create_wireguard_peer rejects preshared-key with base64 padding').",
      ),
    detail: optionalLongText.describe(
      "Clear explanation of what you were trying to accomplish, what happened, and why the current tool behavior or catalog fell short. Never include plaintext passwords, private keys, or tokens.",
    ),
    summary: optionalLongText.describe(
      "Alias for `detail` when `detail` is omitted — explanation of the issue or missing capability.",
    ),
    description: optionalLongText.describe(
      "Alias for `detail` when `detail` is omitted — explanation of the issue or missing capability.",
    ),
    message: optionalLongText.describe(
      "Alias for `detail` when `detail` is omitted — explanation of the issue or missing capability.",
    ),
    expected: optionalLongText.describe(
      "What the tool or server should have done or returned instead.",
    ),
    actual_error: optionalLongText.describe(
      "Exact error string or RouterOS parser message returned, if any (secrets will be redacted).",
    ),
    error: optionalLongText.describe(
      "Alias for `actual_error` — exact error string or RouterOS parser message returned.",
    ),
    workaround: optionalLongText.describe(
      "How you worked around the issue in this session (e.g. 'Used run_routeros_command with /ip/dns/cache/flush' or 'Filtered client-side'). Helps future sessions and operators.",
    ),
    suggested_fix: optionalLongText.describe(
      "Concrete proposal for how the tool schema, command builder, or catalog should be improved.",
    ),
    call_id: optionalShortText.describe(
      "Tool call ID from the failed or problematic invocation, if available.",
    ),
    device: optionalShortText.describe(
      "Configured device name where the issue occurred, if applicable.",
    ),
    device_name: optionalShortText.describe(
      "Alias for `device` — configured device name where the issue occurred.",
    ),
    routeros_version: optionalShortText.describe(
      "RouterOS version of the target device (e.g. '7.16.2'), if known.",
    ),
    agent_model: optionalShortText.describe(
      "Identifier of the AI model or client submitting the feedback, if known.",
    ),
    tags: z
      .array(z.string().trim().min(1).max(64))
      .max(12)
      .default([])
      .describe("Optional subsystem tags (e.g. ['wireguard', 'ipv6', 'safe-mode'])."),
    force_new: z
      .boolean()
      .default(false)
      .describe(
        "When true, bypass fuzzy deduplication and force creation of a distinct feedback issue (exact fingerprint duplicates still merge).",
      ),
  })
  .strict();

export type SubmitFeedbackInput = z.input<typeof SubmitFeedbackSchema>;

export interface NormalizedSubmitFeedbackInput {
  kind: FeedbackKind;
  impact: FeedbackImpact;
  operation?: string;
  title: string;
  detail: string;
  expected?: string;
  actual_error?: string;
  workaround?: string;
  suggested_fix?: string;
  call_id?: string;
  device?: string;
  routeros_version?: string;
  agent_model?: string;
  tags: string[];
  force_new: boolean;
}

/**
 * Parse and normalize a `submit_feedback` payload, resolving common LLM parameter
 * aliases (`summary`/`description`/`message` → `detail`, `device_name` → `device`,
 * `tool`/`tool_name` → `operation`, `error` → `actual_error`).
 */
export function normalizeSubmitFeedbackInput(raw: unknown): NormalizedSubmitFeedbackInput {
  const parsed = SubmitFeedbackSchema.parse(raw);
  const detail = (
    parsed.detail ||
    parsed.summary ||
    parsed.description ||
    parsed.message ||
    ""
  ).trim();
  if (!detail) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["detail"],
        message: "Required (supply `detail` or `summary`)",
      },
    ]);
  }
  return {
    kind: parsed.kind,
    impact: parsed.impact,
    operation: parsed.operation || parsed.tool || parsed.tool_name,
    title: parsed.title,
    detail,
    expected: parsed.expected,
    actual_error: parsed.actual_error || parsed.error,
    workaround: parsed.workaround,
    suggested_fix: parsed.suggested_fix,
    call_id: parsed.call_id,
    device: parsed.device || parsed.device_name,
    routeros_version: parsed.routeros_version,
    agent_model: parsed.agent_model,
    tags: parsed.tags,
    force_new: parsed.force_new,
  };
}

export const FindFeedbackSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(500)
      .default("")
      .describe("Keywords, tool name, error message, or subsystem to search for."),
    operation: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Filter by exact or normalized tool name / RouterOS path."),
    kind: z.enum(feedbackKinds).optional().describe("Filter by feedback kind."),
    impact: z.enum(feedbackImpacts).optional().describe("Filter by impact level."),
    status: z
      .enum(["open", "in_progress", "resolved", "wont_fix", "all"])
      .default("all")
      .describe("Filter by resolution status ('all' includes resolved issues with workarounds)."),
    sort: z
      .enum(["occurrences", "recent", "impact", "first_seen"])
      .default("occurrences")
      .describe(
        "Sort order: 'occurrences' (most frequent first), 'recent' (latest seen first), 'impact' (highest severity first), or 'first_seen'.",
      ),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export type FindFeedbackInput = z.infer<typeof FindFeedbackSchema>;

export const UpdateFeedbackSchema = z
  .object({
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Numeric ID of the feedback issue to update (e.g. `1`)."),
    issue_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Alias for `id` — numeric ID of the feedback issue to update."),
    status: z
      .enum(feedbackStatuses)
      .optional()
      .describe(
        "New workflow status: `'open'`, `'in_progress'`, `'resolved'`, or `'wont_fix'`. Setting `'resolved'` records `resolvedAt` and syncs the fix into MCP Memory (`mcp-tool-feedback`).",
      ),
    impact: z.enum(feedbackImpacts).optional().describe("Updated impact severity."),
    kind: z.enum(feedbackKinds).optional().describe("Updated feedback category."),
    title: shortText.optional().describe("Updated concise one-line title."),
    detail: longText
      .optional()
      .describe("Updated problem description (Markdown bold/code supported)."),
    summary: optionalLongText.describe("Alias for `detail` when updating the problem description."),
    description: optionalLongText.describe(
      "Alias for `detail` when updating the problem description.",
    ),
    expected: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe("Updated expected behavior (or `null` to clear)."),
    workaround: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe(
        "Documented workaround for AI sessions (returned automatically on `find_feedback` and `submit_feedback`).",
      ),
    suggested_fix: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe("Updated engineering fix proposal (or `null` to clear)."),
    resolution_note: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe(
        "Resolution note explaining what was fixed or added, how agents should use it, or why it was closed. Format important tool names, file paths, and key terms in **bold** (`**...**`).",
      ),
    resolution: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe("Alias for `resolution_note`."),
    note: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional()
      .describe("Alias for `resolution_note`."),
    fixed_in_version: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .describe("Version or commit where the fix or new tool was added (e.g. `'v6.22.0'`)."),
    version: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .describe("Alias for `fixed_in_version`."),
    replacement_tool: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .describe(
        "Newly implemented or replacement MCP tool name(s) that agents should call instead of raw CLI workarounds (e.g. `'update_script, update_scheduler'`).",
      ),
    github_issue_url: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .optional()
      .describe("Linked GitHub Issue URL, if filed."),
    sync_to_memory: z
      .boolean()
      .optional()
      .describe(
        "Whether to sync this resolution/guidance into MCP Knowledge Memory (`mcp-tool-feedback` policy entity). Defaults to `true` when resolving or updating resolution/workaround fields.",
      ),
    tags: z
      .array(z.string().trim().min(1).max(64))
      .max(12)
      .optional()
      .describe("Replacement subsystem tags list."),
  })
  .strict();

export type UpdateFeedbackInput = z.input<typeof UpdateFeedbackSchema>;

/**
 * Normalize an `update_feedback` payload, resolving common LLM parameter aliases
 * (`issue_id` → `id`, `summary`/`description` → `detail`, `resolution`/`note` →
 * `resolution_note`, `version` → `fixed_in_version`).
 */
export function normalizeUpdateFeedbackInput(raw: unknown): z.infer<typeof UpdateFeedbackSchema> {
  const parsed = UpdateFeedbackSchema.parse(raw);
  const id = parsed.id ?? parsed.issue_id;
  const detail = parsed.detail ?? parsed.summary ?? parsed.description;
  const resolution_note =
    parsed.resolution_note !== undefined
      ? parsed.resolution_note
      : parsed.resolution !== undefined
        ? parsed.resolution
        : parsed.note;
  const fixed_in_version =
    parsed.fixed_in_version !== undefined ? parsed.fixed_in_version : parsed.version;
  return {
    ...parsed,
    ...(id !== undefined ? { id } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(resolution_note !== undefined ? { resolution_note } : {}),
    ...(fixed_in_version !== undefined ? { fixed_in_version } : {}),
  };
}

export const GithubIssueFeedbackSchema = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Must be in 'owner/repo' format")
      .default("mikrotik-mcp/mikrotik-mcp"),
    title: z.string().trim().min(3).max(256).optional(),
    body: z.string().trim().min(10).max(32000).optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
    token: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type GithubIssueFeedbackInput = z.infer<typeof GithubIssueFeedbackSchema>;

export const BatchFeedbackSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    action: z.enum(["update", "sync_memory", "github_issue", "merge", "delete"]),
    patch: UpdateFeedbackSchema.optional(),
    target_id: z.number().int().positive().optional(),
    github: GithubIssueFeedbackSchema.optional(),
  })
  .strict();

export type BatchFeedbackInput = z.infer<typeof BatchFeedbackSchema>;

export interface FeedbackOccurrence {
  id: number;
  issueId: number;
  ts: number;
  source: FeedbackSource;
  callId: string | null;
  device: string | null;
  routerosVersion: string | null;
  agentModel: string | null;
  detail: string | null;
  actualError: string | null;
  workaround: string | null;
}

export interface FeedbackIssue {
  id: number;
  fingerprint: string;
  kind: FeedbackKind;
  impact: FeedbackImpact;
  status: FeedbackStatus;
  operation: string | null;
  title: string;
  detail: string;
  expected: string | null;
  actualError: string | null;
  workaround: string | null;
  suggestedFix: string | null;
  resolutionNote: string | null;
  fixedInVersion: string | null;
  replacementTool: string | null;
  memoryFactId: number | null;
  githubIssueUrl: string | null;
  tags: string[];
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  reopenedCount: number;
  lastSource: FeedbackSource;
  lastCallId: string | null;
  lastDevice: string | null;
  lastRouterosVersion: string | null;
  lastAgentModel: string | null;
}

export interface SubmitFeedbackResult {
  action: "created" | "Incremented existing" | "Reopened existing";
  deduplicated: boolean;
  matchStage: "none" | "exact_fingerprint" | "fuzzy_similarity";
  similarity: number;
  issue: FeedbackIssue;
  advice: string;
}

export interface FeedbackSummary {
  totalIssues: number;
  totalOccurrences: number;
  openIssues: number;
  inProgressIssues: number;
  resolvedIssues: number;
  wontFixIssues: number;
  blockersOpen: number;
  repeatOccurrencesSaved: number;
  byKind: Record<FeedbackKind, number>;
  byImpact: Record<FeedbackImpact, number>;
  topOperations: {
    operation: string;
    issues: number;
    occurrences: number;
    openIssues: number;
    highestImpact: FeedbackImpact;
  }[];
}

export interface FeedbackListResult {
  items: FeedbackIssue[];
  total: number;
  limit: number;
  offset: number;
  summary: FeedbackSummary;
}

/** Validate and sanitize free-text fields so credentials never land in feedback.db. */
export function sanitizeFeedbackText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  assertMemorySafe(trimmed);
  return redactAuditText(trimmed);
}
