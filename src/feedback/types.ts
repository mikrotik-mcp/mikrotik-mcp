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
    title: z
      .string()
      .trim()
      .min(3)
      .max(240)
      .describe(
        "Concise one-line summary of the issue or missing capability (e.g. 'create_wireguard_peer rejects preshared-key with base64 padding').",
      ),
    detail: longText.describe(
      "Clear explanation of what you were trying to accomplish, what happened, and why the current tool behavior or catalog fell short. Never include plaintext passwords, private keys, or tokens.",
    ),
    expected: optionalLongText.describe(
      "What the tool or server should have done or returned instead.",
    ),
    actual_error: optionalLongText.describe(
      "Exact error string or RouterOS parser message returned, if any (secrets will be redacted).",
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

export type SubmitFeedbackInput = z.infer<typeof SubmitFeedbackSchema>;

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

/** Validate and sanitize free-text fields so credentials never land in feedback.db. */
export function sanitizeFeedbackText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  assertMemorySafe(trimmed);
  return redactAuditText(trimmed);
}
