import { LoadingState } from "./loading-state";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, ReactElement, ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  ExternalLink,
  Filter,
  Flame,
  GitMerge,
  GripVertical,
  History,
  Layers,
  List,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import type {
  FeedbackImpact,
  FeedbackIssue,
  FeedbackKind,
  FeedbackListResult,
  FeedbackOccurrence,
  FeedbackStatus,
  FeedbackSummary,
  SubmitFeedbackResult,
} from "../../src/feedback/types";
import { feedbackImpacts, feedbackKinds, feedbackStatuses } from "../../src/feedback/types";
import { api, deleteJson, postJson, withToken } from "./api";
import { CopyButton, HBars } from "./atoms";
import { ScrollArea, ScrollBar } from "./components/ui/scroll-area";
import {
  Checkbox,
  DetailBlock,
  DetailList,
  Field,
  RowDrawer,
  RowMenu,
  RowMore,
  Select,
  SelectionBar,
  TextArea,
  TextInput,
} from "./kit";
import {
  Donut,
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  MonitorTabs,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import "./monitoring.css";

const LIST_PAGE_SIZE = 24;
const BOARD_PAGE_SIZE = 100;

type ViewMode = "board" | "list";
type SwimlaneBy = "none" | "impact" | "kind" | "device";
type StatusTab = FeedbackStatus | "all";
type SortBy = "occurrences" | "recent" | "impact" | "first_seen";

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Bug",
  missing_tool: "Missing tool",
  missing_param: "Missing param",
  confusing_schema: "Confusing schema",
  unexpected_output: "Unexpected output",
  performance: "Performance",
  docs_gap: "Docs gap",
  feature_request: "Feature request",
};

const IMPACT_LABELS: Record<FeedbackImpact, string> = {
  blocker: "Blocker",
  degraded: "Degraded",
  friction: "Friction",
  suggestion: "Suggestion",
};

const IMPACT_HINTS: Record<FeedbackImpact, string> = {
  blocker: "Task failed completely",
  degraded: "Needed raw CLI fallback",
  friction: "Extra calls or retries",
  suggestion: "Polish or ergonomics",
};

const KIND_DESCRIPTIONS: Record<FeedbackKind, string> = {
  bug: "Tool threw an error or generated invalid RouterOS CLI",
  missing_tool: "No dedicated MCP tool exists for this RouterOS operation",
  missing_param: "Dedicated tool exists, but lacks a needed RouterOS flag",
  confusing_schema: "Parameter names, types, or descriptions misled the model",
  unexpected_output: "Tool succeeded, but output format was truncated or unclear",
  performance: "Slow response, timeout, or excessive token payload",
  docs_gap: "Missing guidance in tool description or knowledge resources",
  feature_request: "New workflow helper, composite tool, or safety guard",
};

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  wont_fix: "Won’t fix",
};

const LANE_SUBTITLES: Record<FeedbackStatus, string> = {
  open: "Triaged reports awaiting fix or dedicated tool",
  in_progress: "Active engineering work & schema updates",
  resolved: "Shipped fixes & MCP Memory-synced guidance",
  wont_fix: "Closed by design or handled via existing tools",
};

const KIND_RISK: Record<FeedbackKind, string> = {
  bug: "destructive",
  missing_tool: "write",
  missing_param: "write",
  confusing_schema: "idem",
  unexpected_output: "idem",
  performance: "write",
  docs_gap: "read",
  feature_request: "read",
};

function impactTone(impact: FeedbackImpact): Tone {
  if (impact === "blocker") return "bad";
  if (impact === "degraded" || impact === "friction") return "warn";
  return "default";
}

function statusTone(status: FeedbackStatus): Tone {
  if (status === "resolved") return "good";
  if (status === "in_progress") return "brand";
  if (status === "open") return "warn";
  return "default";
}

function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

async function patchFeedback(
  id: number,
  body: Record<string, unknown>,
): Promise<{
  ok?: boolean;
  issue?: FeedbackIssue;
  memorySynced?: boolean;
  summary?: FeedbackSummary;
  error?: string;
}> {
  const res = await fetch(withToken(`/api/feedback/${id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    issue?: FeedbackIssue;
    memorySynced?: boolean;
    summary?: FeedbackSummary;
    error?: string;
  };
}

function buildAiFixPrompt(issue: FeedbackIssue, occurrences: FeedbackOccurrence[] = []): string {
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
    ...(issue.tags.length ? [`- **Subsystem Tags:** ${issue.tags.join(", ")}`] : []),
    "",
    "# Problem Description",
    issue.detail,
  ];
  if (issue.actualError) {
    lines.push("", "# Actual Error / RouterOS Output", "```text", issue.actualError, "```");
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

function buildBatchAiFixPrompt(issues: FeedbackIssue[]): string {
  if (issues.length === 0) return "";
  if (issues.length === 1) return buildAiFixPrompt(issues[0]!);

  const totalSightings = issues.reduce((sum, i) => sum + i.occurrences, 0);
  const devices = [
    ...new Set(issues.map((i) => i.lastDevice).filter((x): x is string => Boolean(x))),
  ];
  const rosVersions = [
    ...new Set(issues.map((i) => i.lastRouterosVersion).filter((x): x is string => Boolean(x))),
  ];
  const models = [
    ...new Set(issues.map((i) => i.lastAgentModel).filter((x): x is string => Boolean(x))),
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
      lines.push("", "### Actual Error / RouterOS Output", "```text", issue.actualError, "```");
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

function KindBadge({ kind }: { kind: FeedbackKind }): ReactNode {
  return (
    <span className="monitor-risk" data-risk={KIND_RISK[kind] ?? "read"}>
      {KIND_LABELS[kind].toUpperCase()}
    </span>
  );
}

function OccurrencePill({ count, reopened }: { count: number; reopened: number }): ReactNode {
  const hot = count >= 5;
  const warm = count >= 2;
  return (
    <span
      className="monitor-chip font-mono font-semibold tabular-nums"
      title={
        reopened > 0
          ? `Reported ${count} times (reopened ${reopened}× after resolution)`
          : `Reported ${count} time${count === 1 ? "" : "s"} (deduplicated)`
      }
    >
      ×{count}
      {hot ? " · hot" : warm ? " · repeat" : ""}
      {reopened > 0 ? ` · ↺${reopened}` : ""}
    </span>
  );
}

interface ParsedSearch {
  plainQuery: string;
  tokens: { key: string; value: string; raw: string }[];
}

function parseSmartQuery(raw: string): ParsedSearch {
  const tokens: { key: string; value: string; raw: string }[] = [];
  const plainParts: string[] = [];
  const regex = /\b(kind|impact|status|tool|op|device|ros|tag|is|has):([^\s]+)|([^\s]+)/gi;
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

function matchesSmartTokens(
  item: FeedbackIssue,
  tokens: { key: string; value: string }[],
  deviceFilter: string,
  rosFilter: string,
  quickPresets: Set<string>,
): boolean {
  if (deviceFilter !== "all" && (item.lastDevice ?? "") !== deviceFilter) return false;
  if (rosFilter !== "all" && (item.lastRouterosVersion ?? "") !== rosFilter) return false;

  if (quickPresets.has("blockers") && item.impact !== "blocker") return false;
  if (quickPresets.has("hot") && item.occurrences < 3) return false;
  if (quickPresets.has("missing_tool") && item.kind !== "missing_tool") return false;
  if (quickPresets.has("reopened") && item.reopenedCount === 0) return false;
  if (
    quickPresets.has("has_fix") &&
    !item.resolutionNote &&
    !item.workaround &&
    !item.replacementTool
  )
    return false;
  if (quickPresets.has("memory_synced") && !item.memoryFactId) return false;
  if (quickPresets.has("github_linked") && !item.githubIssueUrl) return false;

  for (const { key, value } of tokens) {
    if (key === "kind" && !item.kind.toLowerCase().includes(value)) return false;
    if (key === "impact" && !item.impact.toLowerCase().includes(value)) return false;
    if (key === "status" && !item.status.toLowerCase().includes(value)) return false;
    if (
      (key === "tool" || key === "op") &&
      !(item.operation ?? "").toLowerCase().includes(value) &&
      !(item.replacementTool ?? "").toLowerCase().includes(value)
    )
      return false;
    if (key === "device" && !(item.lastDevice ?? "").toLowerCase().includes(value)) return false;
    if (key === "ros" && !(item.lastRouterosVersion ?? "").toLowerCase().includes(value))
      return false;
    if (key === "tag" && !item.tags.some((t) => t.toLowerCase().includes(value))) return false;
    if (key === "is" || key === "has") {
      if (value === "hot" && item.occurrences < 3) return false;
      if (value === "blocker" && item.impact !== "blocker") return false;
      if (value === "reopened" && item.reopenedCount === 0) return false;
      if (value === "memory" && !item.memoryFactId) return false;
      if (value === "github" && !item.githubIssueUrl) return false;
      if (value === "workaround" && !item.workaround) return false;
      if (value === "fix" && !item.resolutionNote && !item.replacementTool && !item.fixedInVersion)
        return false;
    }
  }
  return true;
}

function NewFeedbackDialog({
  open,
  onClose,
  onSaved,
  initialStatus = "open",
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (res: SubmitFeedbackResult, targetStatus: FeedbackStatus) => void;
  initialStatus?: FeedbackStatus;
}): ReactNode {
  const [targetStatus, setTargetStatus] = useState<FeedbackStatus>(initialStatus);
  const [kind, setKind] = useState<FeedbackKind>("missing_tool");
  const [impact, setImpact] = useState<FeedbackImpact>("degraded");
  const [operation, setOperation] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [expected, setExpected] = useState("");
  const [actualError, setActualError] = useState("");
  const [workaround, setWorkaround] = useState("");
  const [suggestedFix, setSuggestedFix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) setTargetStatus(initialStatus);
  }, [open, initialStatus]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await postJson<SubmitFeedbackResult & { error?: string }>("/api/feedback", {
        kind,
        impact,
        operation: operation.trim() || undefined,
        title: title.trim(),
        detail: detail.trim(),
        expected: expected.trim() || undefined,
        actual_error: actualError.trim() || undefined,
        workaround: workaround.trim() || undefined,
        suggested_fix: suggestedFix.trim() || undefined,
      });
      if (res.error) throw new Error(res.error);
      onSaved(res, targetStatus);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit feedback");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && title.trim().length >= 3 && detail.trim().length >= 3;

  return (
    <MonitorDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy && !next) onClose();
      }}
      eyebrow={`Tool feedback & telemetry · ${STATUS_LABELS[targetStatus]} column`}
      title="File tool feedback"
      description="Reports are automatically deduplicated by tool name, normalized error skeleton, and semantic similarity."
      width={680}
      dismissible={false}
      closeDisabled={busy}
      footer={
        <>
          <span className="flex-1 text-xs text-muted-foreground">
            Deduplication merges repeat reports into the existing issue automatically.
          </span>
          <MonitorButton variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </MonitorButton>
          <MonitorButton
            variant="primary"
            type="submit"
            form="feedback-new-form"
            disabled={!canSubmit}
            icon={<Check aria-hidden="true" />}
          >
            {busy ? "Submitting…" : "Submit feedback"}
          </MonitorButton>
        </>
      }
    >
      <form id="feedback-new-form" className="monitor-dialog-body fb-modal-form" onSubmit={submit}>
        {error && (
          <MonitorNote tone="bad" role="alert">
            {error}
          </MonitorNote>
        )}

        {/* Section 1: Classification & Workflow Target */}
        <div className="fb-modal-section">
          <div className="fb-modal-section-title">
            <span>1. Classification & Target Column</span>
            <StatusBadge tone={statusTone(targetStatus)} quiet>
              {STATUS_LABELS[targetStatus]}
            </StatusBadge>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Category" help={KIND_DESCRIPTIONS[kind]}>
              <Select
                label="Category"
                value={kind}
                onChange={(v) => setKind(v as FeedbackKind)}
                options={feedbackKinds.map((k) => ({
                  value: k,
                  label: KIND_LABELS[k],
                  description: KIND_DESCRIPTIONS[k],
                }))}
              />
            </Field>
            <Field
              label="Operation or tool name"
              optional="optional"
              help="MCP tool name or RouterOS CLI path"
            >
              <TextInput
                mono
                value={operation}
                onChange={setOperation}
                placeholder="e.g. create_wireguard_peer or /ip/dns/cache"
              />
            </Field>
          </div>

          <Field label="Impact severity">
            <div className="fb-impact-grid" role="radiogroup" aria-label="Impact severity">
              {feedbackImpacts.map((imp) => (
                <button
                  key={imp}
                  type="button"
                  role="radio"
                  aria-checked={impact === imp}
                  className="monitor-choice"
                  onClick={() => setImpact(imp)}
                >
                  <span className="flex items-center gap-1.5">
                    <StatusDot tone={impactTone(imp)} />
                    <b className="font-semibold">{IMPACT_LABELS[imp]}</b>
                  </span>
                  <small>{IMPACT_HINTS[imp]}</small>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Initial board column">
            <Segmented
              label="Initial board column"
              value={targetStatus}
              onChange={(v) => setTargetStatus(v)}
              options={feedbackStatuses.map((s) => ({
                value: s,
                label: STATUS_LABELS[s],
              }))}
            />
          </Field>
        </div>

        {/* Section 2: Core Issue Summary & Details */}
        <div className="fb-modal-section">
          <div className="fb-modal-section-title">
            <span>2. Problem Summary & Details</span>
            <span>Required</span>
          </div>

          <Field
            label="Title"
            help="Concise one-line summary of the bug, missing capability, or schema issue"
          >
            <TextInput
              value={title}
              onChange={setTitle}
              placeholder="e.g. Missing dedicated tool to flush DNS cache without raw CLI"
              required
            />
          </Field>

          <Field
            label="What happened?"
            help="Describe what was attempted, what failed or was missing, and how it affected the task (never include secrets)"
          >
            <TextArea
              rows={3}
              value={detail}
              onChange={setDetail}
              placeholder="Detailed context of the tool call or missing RouterOS parameter…"
              required
            />
          </Field>
        </div>

        {/* Section 3: Diagnostics, Workaround & Fix Guidance */}
        <div className="fb-modal-section">
          <div className="fb-modal-section-title">
            <span>3. Diagnostics, Workaround & Guidance</span>
            <span>Optional · Shared with AI</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Actual error output" optional="optional">
              <TextInput
                mono
                value={actualError}
                onChange={setActualError}
                placeholder="RouterOS or Zod validation error…"
              />
            </Field>
            <Field label="Expected behavior" optional="optional">
              <TextInput
                value={expected}
                onChange={setExpected}
                placeholder="What the tool should return or execute…"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Workaround for future AI sessions"
              optional="optional"
              help="Returned automatically when an agent hits this issue"
            >
              <TextInput
                value={workaround}
                onChange={setWorkaround}
                placeholder="e.g. Use invoke_tool with flush_dns_cache"
              />
            </Field>
            <Field
              label="Suggested engineering fix"
              optional="optional"
              help="Included in Copy AI Prompt & GitHub Issue"
            >
              <TextInput
                value={suggestedFix}
                onChange={setSuggestedFix}
                placeholder="Concrete schema or command-builder change…"
              />
            </Field>
          </div>
        </div>
      </form>
    </MonitorDialog>
  );
}

export function FeedbackView(): ReactNode {
  const [page, setPage] = useState<FeedbackListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [swimlaneBy, setSwimlaneBy] = useState<SwimlaneBy>("none");

  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [impactFilter, setImpactFilter] = useState<string>("all");
  const [operationFilter, setOperationFilter] = useState<string>("");
  const [deviceFilter, setDeviceFilter] = useState<string>("all");
  const [rosFilter, setRosFilter] = useState<string>("all");
  const [quickPresets, setQuickPresets] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortBy>("occurrences");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);

  // Optimistic status map for instant Jira Drag & Drop transitions
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<number, FeedbackStatus>>({});
  const [draggingIds, setDraggingIds] = useState<number[]>([]);
  const [dropTargetStatus, setDropTargetStatus] = useState<FeedbackStatus | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastClickedIdRef = useRef<number | null>(null);
  const shiftHeldRef = useRef(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [drawerTab, setDrawerTab] = useState<string>("overview");
  const [detailData, setDetailData] = useState<{
    issue: FeedbackIssue;
    occurrences: FeedbackOccurrence[];
    similar: { issue: FeedbackIssue; similarity: number }[];
  } | null>(null);

  const [resolutionDraft, setResolutionDraft] = useState("");
  const [workaroundDraft, setWorkaroundDraft] = useState("");
  const [fixedVersionDraft, setFixedVersionDraft] = useState("");
  const [replacementToolDraft, setReplacementToolDraft] = useState("");
  const [syncToMemory, setSyncToMemory] = useState(true);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createInitialStatus, setCreateInitialStatus] = useState<FeedbackStatus>("open");

  const parsedSearch = useMemo(() => parseSmartQuery(query), [query]);
  const pageSize = viewMode === "board" ? BOARD_PAGE_SIZE : LIST_PAGE_SIZE;
  const effectiveStatusParam = viewMode === "board" ? "all" : statusTab;

  const refresh = () => {
    setLoading(true);
    setError("");
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      const params = new URLSearchParams({
        status: effectiveStatusParam,
        sort,
        limit: String(pageSize),
        offset: String(viewMode === "board" ? 0 : offset),
      });
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (impactFilter !== "all") params.set("impact", impactFilter);
      if (operationFilter) params.set("operation", operationFilter);
      if (parsedSearch.plainQuery) params.set("query", parsedSearch.plainQuery);

      try {
        const res = await api<FeedbackListResult>(
          `/api/feedback?${params.toString()}`,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setPage(res);
          setOptimisticStatuses({});
          setError("");
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load tool feedback");
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => abort.abort();
  }, [
    effectiveStatusParam,
    kindFilter,
    impactFilter,
    operationFilter,
    parsedSearch.plainQuery,
    sort,
    offset,
    pageSize,
    viewMode,
    version,
  ]);

  useEffect(() => {
    if (activeId === null) return;
    const abort = new AbortController();
    void api<{
      issue: FeedbackIssue;
      occurrences: FeedbackOccurrence[];
      similar: { issue: FeedbackIssue; similarity: number }[];
    }>(`/api/feedback/${activeId}`, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted) {
          setDetailData(res);
          setResolutionDraft(res.issue.resolutionNote ?? "");
          setWorkaroundDraft(res.issue.workaround ?? "");
          setFixedVersionDraft(res.issue.fixedInVersion ?? "");
          setReplacementToolDraft(res.issue.replacementTool ?? "");
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setDetailData(null);
      });
    return () => abort.abort();
  }, [activeId, version]);

  const summary = page?.summary;
  const rawItems = useMemo(
    () =>
      (page?.items ?? []).map((item) =>
        optimisticStatuses[item.id] ? { ...item, status: optimisticStatuses[item.id]! } : item,
      ),
    [page?.items, optimisticStatuses],
  );

  const availableDevices = useMemo(
    () =>
      [...new Set(rawItems.map((i) => i.lastDevice).filter((x): x is string => Boolean(x)))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [rawItems],
  );

  const availableRosVersions = useMemo(
    () =>
      [
        ...new Set(
          rawItems.map((i) => i.lastRouterosVersion).filter((x): x is string => Boolean(x)),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [rawItems],
  );

  const items = useMemo(
    () =>
      rawItems.filter((item) =>
        matchesSmartTokens(item, parsedSearch.tokens, deviceFilter, rosFilter, quickPresets),
      ),
    [rawItems, parsedSearch.tokens, deviceFilter, rosFilter, quickPresets],
  );

  const activeIndex = activeId !== null ? items.findIndex((i) => i.id === activeId) : -1;
  const currentDetail = activeId !== null && detailData?.issue.id === activeId ? detailData : null;
  const activeIssueBase =
    currentDetail?.issue ?? (activeIndex >= 0 ? items[activeIndex] : null) ?? null;
  const activeIssue =
    activeIssueBase && optimisticStatuses[activeIssueBase.id]
      ? { ...activeIssueBase, status: optimisticStatuses[activeIssueBase.id]! }
      : activeIssueBase;

  const hasAnyFilter =
    Boolean(query.trim()) ||
    kindFilter !== "all" ||
    impactFilter !== "all" ||
    Boolean(operationFilter) ||
    deviceFilter !== "all" ||
    rosFilter !== "all" ||
    quickPresets.size > 0 ||
    (viewMode === "list" && statusTab !== "all");

  const clearAllFilters = () => {
    setQuery("");
    setKindFilter("all");
    setImpactFilter("all");
    setOperationFilter("");
    setDeviceFilter("all");
    setRosFilter("all");
    setQuickPresets(new Set());
    if (viewMode === "list") setStatusTab("all");
    setOffset(0);
  };

  const togglePreset = (key: string) => {
    setQuickPresets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setOffset(0);
  };

  const removeQueryToken = (rawToken: string) => {
    setQuery((prev) =>
      prev
        .replace(rawToken, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
  };

  const updateIssue = async (
    id: number,
    patch: Record<string, unknown>,
    successMsg = "Feedback updated",
  ) => {
    if (typeof patch.status === "string") {
      setOptimisticStatuses((prev) => ({ ...prev, [id]: patch.status as FeedbackStatus }));
    }
    setBusy(true);
    try {
      const res = await patchFeedback(id, patch);
      if (res.error) throw new Error(res.error);
      toast.success(res.memorySynced ? `${successMsg} · Synced to MCP Memory` : successMsg);
      refresh();
    } catch (err) {
      setOptimisticStatuses((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast.error(err instanceof Error ? err.message : "Could not update feedback");
    } finally {
      setBusy(false);
    }
  };

  const moveIssuesToStatus = async (ids: number[], targetStatus: FeedbackStatus) => {
    const moving = ids.filter((id) => {
      const found = rawItems.find((i) => i.id === id);
      return found && found.status !== targetStatus;
    });
    if (moving.length === 0) return;

    // Optimistic update for instant Jira board responsiveness
    setOptimisticStatuses((prev) => {
      const next = { ...prev };
      for (const id of moving) next[id] = targetStatus;
      return next;
    });

    setBusy(true);
    try {
      if (moving.length === 1) {
        const id = moving[0]!;
        const res = await patchFeedback(id, {
          status: targetStatus,
          sync_to_memory: targetStatus === "resolved",
        });
        if (res.error) throw new Error(res.error);
        toast.success(
          `Moved #${id} → ${STATUS_LABELS[targetStatus]}${
            res.memorySynced ? " · Synced to MCP Memory" : ""
          }`,
        );
      } else {
        const res = await postJson<{
          ok?: boolean;
          updatedCount?: number;
          memorySyncedCount?: number;
          error?: string;
        }>("/api/feedback/batch", {
          ids: moving,
          action: "update",
          patch: { status: targetStatus, sync_to_memory: targetStatus === "resolved" },
        });
        if (res.error) throw new Error(res.error);
        toast.success(
          `Moved ${moving.length} issues → ${STATUS_LABELS[targetStatus]}${
            res.memorySyncedCount ? ` · ${res.memorySyncedCount} synced to MCP Memory` : ""
          }`,
        );
      }
      refresh();
    } catch (err) {
      setOptimisticStatuses((prev) => {
        const next = { ...prev };
        for (const id of moving) delete next[id];
        return next;
      });
      toast.error(err instanceof Error ? err.message : "Could not move feedback card");
    } finally {
      setBusy(false);
    }
  };

  const handleCardDragStart = (e: DragEvent<HTMLElement>, item: FeedbackIssue) => {
    const batch = selectedIds.has(item.id) && selectedIds.size > 1 ? [...selectedIds] : [item.id];
    setDraggingIds(batch);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-mikrotik-feedback-ids", JSON.stringify(batch));
    e.dataTransfer.setData("text/plain", batch.map((id) => `#${id}`).join(", "));
  };

  const handleCardDragEnd = () => {
    setDraggingIds([]);
    setDropTargetStatus(null);
  };

  const handleLaneDragOver = (e: DragEvent<HTMLElement>, status: FeedbackStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTargetStatus !== status) {
      setDropTargetStatus(status);
    }
  };

  const handleLaneDrop = (e: DragEvent<HTMLElement>, status: FeedbackStatus) => {
    e.preventDefault();
    setDropTargetStatus(null);
    let ids = draggingIds;
    if (ids.length === 0) {
      try {
        const raw = e.dataTransfer.getData("application/x-mikrotik-feedback-ids");
        if (raw) ids = JSON.parse(raw) as number[];
      } catch {
        /* ignore malformed transfer payload */
      }
    }
    setDraggingIds([]);
    if (ids.length > 0) {
      void moveIssuesToStatus(ids, status);
    }
  };

  const syncIssueMemory = async (id: number) => {
    setBusy(true);
    try {
      const res = await postJson<{ ok?: boolean; memoryFactId?: number; error?: string }>(
        `/api/feedback/${id}/sync-memory`,
        {},
      );
      if (res.error) throw new Error(res.error);
      toast.success(`Synced #${id} to MCP Memory (fact #${res.memoryFactId ?? "?"})`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sync to MCP Memory");
    } finally {
      setBusy(false);
    }
  };

  const submitGithubIssue = async (id: number) => {
    setBusy(true);
    try {
      const res = await postJson<{
        ok?: boolean;
        mode?: "api" | "web_url";
        url?: string;
        number?: number | null;
        fallbackUrl?: string;
        error?: string;
      }>(`/api/feedback/${id}/github-issue`, {});
      if (res.error) {
        if (res.fallbackUrl) {
          window.open(res.fallbackUrl, "_blank", "noopener,noreferrer");
          toast.success("Opened pre-filled GitHub Issue in browser");
          return;
        }
        throw new Error(res.error);
      }
      if (res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      }
      if (res.mode === "api") {
        toast.success(`Created GitHub Issue ${res.number ? `#${res.number}` : ""}`);
        refresh();
      } else {
        toast.success("Opened pre-filled GitHub Issue in browser");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open GitHub issue");
    } finally {
      setBusy(false);
    }
  };

  const deleteIssues = async (ids: number[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await deleteJson<{ removed?: number; error?: string }>("/api/feedback", { ids });
      if (res.error) throw new Error(res.error);
      toast.success(
        `Deleted ${res.removed ?? ids.length} feedback item${ids.length === 1 ? "" : "s"}`,
      );
      setSelectedIds(new Set());
      if (activeId !== null && ids.includes(activeId)) setActiveId(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete feedback");
    } finally {
      setBusy(false);
    }
  };

  const mergeInto = async (targetId: number, sourceId: number) => {
    setBusy(true);
    try {
      const res = await postJson<{ ok?: boolean; issue?: FeedbackIssue; error?: string }>(
        `/api/feedback/${targetId}/merge`,
        { sourceId },
      );
      if (res.error) throw new Error(res.error);
      toast.success(`Merged #${sourceId} into #${targetId} (×${res.issue?.occurrences ?? "?"})`);
      setActiveId(targetId);
      setMergeTargetId("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (id: number) => {
    const useShiftRange = shiftHeldRef.current && lastClickedIdRef.current !== null;
    shiftHeldRef.current = false;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (useShiftRange && lastClickedIdRef.current !== null) {
        const a = items.findIndex((i) => i.id === lastClickedIdRef.current);
        const b = items.findIndex((i) => i.id === id);
        if (a >= 0 && b >= 0) {
          const [start, end] = a <= b ? [a, b] : [b, a];
          for (let idx = start; idx <= end; idx++) {
            const row = items[idx];
            if (row) next.add(row.id);
          }
          lastClickedIdRef.current = id;
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastClickedIdRef.current = id;
      return next;
    });
  };

  const shownIds = items.map((i) => i.id);
  const shownSelectedCount = shownIds.filter((id) => selectedIds.has(id)).length;
  const allShownSelected = items.length > 0 && shownSelectedCount === items.length;
  const someShownSelected = shownSelectedCount > 0 && !allShownSelected;

  const toggleSelectAllShown = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allShownSelected) {
        for (const id of shownIds) next.delete(id);
      } else {
        for (const id of shownIds) next.add(id);
      }
      return next;
    });
  };

  const toggleSelectColumn = (columnItems: FeedbackIssue[]) => {
    const colIds = columnItems.map((i) => i.id);
    const allColSelected = colIds.length > 0 && colIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allColSelected) {
        for (const id of colIds) next.delete(id);
      } else {
        for (const id of colIds) next.add(id);
      }
      return next;
    });
  };

  const selectedItems = rawItems.filter((i) => selectedIds.has(i.id));

  const copySelectedPrompts = async (ids?: number[]) => {
    const targetIds = ids ?? [...selectedIds];
    const targetItems = rawItems.filter((i) => targetIds.includes(i.id));
    if (targetItems.length === 0) return;
    const text = buildBatchAiFixPrompt(targetItems);
    try {
      await navigator.clipboard?.writeText(text);
      toast.success(
        targetItems.length === 1
          ? `Copied AI Engineering Prompt for #${targetItems[0]!.id}`
          : `Copied combined AI Engineering Prompt for ${targetItems.length} issues`,
      );
    } catch {
      toast.error("Clipboard access failed");
    }
  };

  const batchUpdateStatus = async (status: FeedbackStatus, label: string) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    await moveIssuesToStatus(ids, status);
    setSelectedIds(new Set());
    void label;
  };

  const batchSyncMemory = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await postJson<{
        ok?: boolean;
        memorySyncedCount?: number;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "sync_memory",
      });
      if (res.error) throw new Error(res.error);
      toast.success(
        `Synced ${res.memorySyncedCount ?? 0} of ${ids.length} selected issue${
          ids.length === 1 ? "" : "s"
        } to MCP Memory`,
      );
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch MCP Memory sync failed");
    } finally {
      setBusy(false);
    }
  };

  const batchSubmitGithubIssue = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (ids.length === 1) {
      await submitGithubIssue(ids[0]!);
      return;
    }
    setBusy(true);
    try {
      const res = await postJson<{
        ok?: boolean;
        mode?: "api" | "web_url";
        url?: string;
        number?: number | null;
        count?: number;
        fallbackUrl?: string;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "github_issue",
      });
      if (res.error) {
        if (res.fallbackUrl) {
          window.open(res.fallbackUrl, "_blank", "noopener,noreferrer");
          toast.success(`Opened combined GitHub Issue for ${ids.length} items in browser`);
          return;
        }
        throw new Error(res.error);
      }
      if (res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      }
      if (res.mode === "api") {
        toast.success(
          `Created combined GitHub Issue ${res.number ? `#${res.number}` : ""} for ${
            res.count ?? ids.length
          } items`,
        );
        refresh();
      } else {
        toast.success(`Opened combined GitHub Issue for ${ids.length} items in browser`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit batch GitHub issue");
    } finally {
      setBusy(false);
    }
  };

  const batchMergeSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    setBusy(true);
    try {
      const res = await postJson<{
        ok?: boolean;
        targetId?: number;
        mergedCount?: number;
        issue?: FeedbackIssue;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "merge",
        target_id: ids[0],
      });
      if (res.error) throw new Error(res.error);
      toast.success(
        `Merged ${res.mergedCount ?? ids.length - 1} issue${
          (res.mergedCount ?? 1) === 1 ? "" : "s"
        } into #${res.targetId ?? ids[0]} (×${res.issue?.occurrences ?? "?"})`,
      );
      setSelectedIds(new Set());
      if (res.targetId) setActiveId(res.targetId);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch merge failed");
    } finally {
      setBusy(false);
    }
  };

  const openIssuesCount = (summary?.openIssues ?? 0) + (summary?.inProgressIssues ?? 0);

  const swimlaneGroups = useMemo(() => {
    if (swimlaneBy === "none") {
      return [{ id: "all", label: "All Feedback Issues", items }];
    }
    if (swimlaneBy === "impact") {
      return feedbackImpacts
        .map((imp) => ({
          id: imp,
          label: `${IMPACT_LABELS[imp]} Impact`,
          items: items.filter((i) => i.impact === imp),
        }))
        .filter((g) => g.items.length > 0);
    }
    if (swimlaneBy === "kind") {
      return feedbackKinds
        .map((k) => ({
          id: k,
          label: KIND_LABELS[k],
          items: items.filter((i) => i.kind === k),
        }))
        .filter((g) => g.items.length > 0);
    }
    // device swimlanes
    const byDevice = new Map<string, FeedbackIssue[]>();
    for (const item of items) {
      const dev = item.lastDevice ?? "Unspecified device";
      const list = byDevice.get(dev) ?? [];
      list.push(item);
      byDevice.set(dev, list);
    }
    return [...byDevice.entries()].map(([dev, list]) => ({
      id: dev,
      label: `Router: ${dev}`,
      items: list,
    }));
  }, [items, swimlaneBy]);

  const renderIssueContextMenu = (item: FeedbackIssue, children: ReactElement) => {
    const isSelected = selectedIds.has(item.id);
    return (
      <RowMenu
        key={item.id}
        title={`#${item.id} · ${item.title}`}
        sub={`${KIND_LABELS[item.kind]} · ×${item.occurrences} sightings`}
        onOpen={() => setActiveId(item.id)}
        cells={{
          operation: item.operation
            ? {
                value: item.operation,
                kind: "tool",
                filter: () => {
                  setOperationFilter(item.operation!);
                  setOffset(0);
                },
                clearFilter: operationFilter
                  ? () => {
                      setOperationFilter("");
                      setOffset(0);
                    }
                  : undefined,
              }
            : { value: "" },
          kind: {
            value: KIND_LABELS[item.kind],
            filter: () => {
              setKindFilter(item.kind);
              setOffset(0);
            },
            clearFilter:
              kindFilter !== "all"
                ? () => {
                    setKindFilter("all");
                    setOffset(0);
                  }
                : undefined,
          },
          impact: {
            value: IMPACT_LABELS[item.impact],
            filter: () => {
              setImpactFilter(item.impact);
              setOffset(0);
            },
            clearFilter:
              impactFilter !== "all"
                ? () => {
                    setImpactFilter("all");
                    setOffset(0);
                  }
                : undefined,
          },
        }}
        copies={[
          { label: "AI Fix Prompt", value: () => buildAiFixPrompt(item) },
          { label: "Feedback ID", value: String(item.id) },
          { label: "Title", value: item.title },
          ...(item.operation ? [{ label: "Operation", value: item.operation }] : []),
        ]}
        row={item}
        select={{
          selected: isSelected,
          toggle: () => toggleSelect(item.id),
          similar: item.operation
            ? {
                label: `Select all for ${item.operation}`,
                run: () =>
                  setSelectedIds(
                    (prev) =>
                      new Set([
                        ...prev,
                        ...items.filter((x) => x.operation === item.operation).map((x) => x.id),
                      ]),
                  ),
              }
            : {
                label: `Select all ${KIND_LABELS[item.kind]}`,
                run: () =>
                  setSelectedIds(
                    (prev) =>
                      new Set([
                        ...prev,
                        ...items.filter((x) => x.kind === item.kind).map((x) => x.id),
                      ]),
                  ),
              },
        }}
        selection={{
          count: selectedIds.size,
          summary: "Batch prompt, GitHub issue, resolve, memory sync, merge or delete",
          actions: [
            {
              label: `Copy AI Prompt (${selectedIds.size})`,
              icon: <Copy aria-hidden="true" />,
              onSelect: () => void copySelectedPrompts(),
            },
            {
              label: `Submit GitHub Issue (${selectedIds.size})`,
              icon: <ExternalLink aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchSubmitGithubIssue(),
            },
            {
              label: `Move ${selectedIds.size} → Resolved & Sync Memory`,
              icon: <Check aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchUpdateStatus("resolved", "Resolved selected issues"),
            },
            {
              label: `Move ${selectedIds.size} → In Progress`,
              icon: <Wrench aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchUpdateStatus("in_progress", "Marked in progress"),
            },
            {
              label: `Move ${selectedIds.size} → Open`,
              icon: <RotateCcw aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchUpdateStatus("open", "Reopened selected issues"),
            },
            {
              label: `Move ${selectedIds.size} → Won’t Fix`,
              icon: <XCircle aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchUpdateStatus("wont_fix", "Marked won't fix"),
            },
            {
              label: `Sync to MCP Memory (${selectedIds.size})`,
              icon: <Sparkles aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void batchSyncMemory(),
            },
            ...(selectedIds.size >= 2
              ? [
                  {
                    label: `Merge ${selectedIds.size} into #${[...selectedIds][0]}`,
                    icon: <GitMerge aria-hidden="true" />,
                    disabled: busy,
                    onSelect: () => void batchMergeSelected(),
                  },
                ]
              : []),
            {
              label: `Delete ${selectedIds.size} issues`,
              icon: <Trash2 aria-hidden="true" />,
              danger: true,
              disabled: busy,
              onSelect: () => void deleteIssues([...selectedIds]),
            },
          ],
          clear: () => setSelectedIds(new Set()),
        }}
        actions={[
          {
            label: "Submit GitHub Issue",
            icon: <ExternalLink aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void submitGithubIssue(item.id),
          },
          ...(item.status !== "resolved"
            ? [
                {
                  label: "Move → Resolved & sync Memory",
                  icon: <Check aria-hidden="true" />,
                  disabled: busy,
                  onSelect: () => void moveIssuesToStatus([item.id], "resolved"),
                },
              ]
            : []),
          ...(item.status !== "in_progress"
            ? [
                {
                  label: "Move → In progress",
                  icon: <Wrench aria-hidden="true" />,
                  disabled: busy,
                  onSelect: () => void moveIssuesToStatus([item.id], "in_progress"),
                },
              ]
            : []),
          ...(item.status !== "open"
            ? [
                {
                  label: "Move → Open",
                  icon: <RotateCcw aria-hidden="true" />,
                  disabled: busy,
                  onSelect: () => void moveIssuesToStatus([item.id], "open"),
                },
              ]
            : []),
          ...(item.status !== "wont_fix"
            ? [
                {
                  label: "Move → Won’t fix",
                  icon: <XCircle aria-hidden="true" />,
                  disabled: busy,
                  onSelect: () => void moveIssuesToStatus([item.id], "wont_fix"),
                },
              ]
            : []),
          {
            label: "Sync to MCP Memory",
            icon: <Sparkles aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void syncIssueMemory(item.id),
          },
          {
            label: "Delete issue",
            icon: <Trash2 aria-hidden="true" />,
            danger: true,
            disabled: busy,
            onSelect: () => void deleteIssues([item.id]),
          },
        ]}
      >
        {children}
      </RowMenu>
    );
  };

  const renderKanbanCard = (item: FeedbackIssue) => {
    const isSelected = selectedIds.has(item.id);
    const isOpenDrawer = activeId === item.id;
    const isDragging = draggingIds.includes(item.id);

    return renderIssueContextMenu(
      item,
      <article
        draggable
        onDragStart={(e) => handleCardDragStart(e, item)}
        onDragEnd={handleCardDragEnd}
        className="fb-card"
        data-impact={item.impact}
        data-selected={isOpenDrawer || isSelected || undefined}
        data-dragging={isDragging || undefined}
      >
        <header className="flex items-center gap-1.5">
          <span
            className="monitor-check"
            onPointerDown={(ev) => {
              shiftHeldRef.current = ev.shiftKey;
            }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => toggleSelect(item.id)}
              aria-label={`Select feedback #${item.id} (Shift-click selects a range)`}
            />
          </span>
          <span
            className="inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold text-muted-foreground"
            title="Drag card to another board column to change status"
          >
            <GripVertical className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />#{item.id}
          </span>
          <span data-col="kind">
            <KindBadge kind={item.kind} />
          </span>
          <span className="flex-1" />
          <OccurrencePill count={item.occurrences} reopened={item.reopenedCount} />
          <RowMore />
        </header>

        <button type="button" className="text-left" onClick={() => setActiveId(item.id)}>
          <strong className="line-clamp-2 block text-[13px] font-semibold leading-snug text-foreground">
            {item.title}
          </strong>
          <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
            {item.detail}
          </span>
        </button>

        <div className="flex flex-wrap items-center gap-1.5">
          <span data-col="impact">
            <StatusBadge tone={impactTone(item.impact)} quiet>
              {IMPACT_LABELS[item.impact]}
            </StatusBadge>
          </span>
          {item.operation && (
            <button
              type="button"
              data-col="operation"
              className="monitor-chip max-w-[180px] truncate font-mono text-[11px]"
              title={`Filter by ${item.operation}`}
              onClick={(ev) => {
                ev.stopPropagation();
                setOperationFilter(operationFilter === item.operation ? "" : item.operation!);
                setOffset(0);
              }}
            >
              {item.operation}
            </button>
          )}
          {item.fixedInVersion && (
            <span className="monitor-chip font-mono text-[11px]" title="Fixed in version">
              ✓ {item.fixedInVersion}
            </span>
          )}
          {item.replacementTool && (
            <span className="monitor-chip font-mono text-[11px]" title="Replacement tool">
              → {item.replacementTool}
            </span>
          )}
          {item.memoryFactId && (
            <span
              className="monitor-chip text-[11px]"
              title={`Synced to MCP Memory (fact #${item.memoryFactId})`}
            >
              Memory #{item.memoryFactId}
            </span>
          )}
        </div>

        {(item.actualError || item.resolutionNote || item.workaround) && (
          <div className="rounded-lg bg-[var(--overlay-03)] px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {item.resolutionNote ? (
              <div className="line-clamp-2">
                <strong className="font-medium text-foreground">Fix: </strong>
                {item.resolutionNote}
              </div>
            ) : item.workaround ? (
              <div className="line-clamp-2">
                <strong className="font-medium text-foreground">Workaround: </strong>
                {item.workaround}
              </div>
            ) : (
              <div className="truncate font-mono">{item.actualError}</div>
            )}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--line)] pt-2 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 truncate">
            {item.lastDevice ? (
              <button
                type="button"
                className="font-mono hover:text-foreground"
                title={`Filter by device ${item.lastDevice}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setDeviceFilter(deviceFilter === item.lastDevice ? "all" : item.lastDevice!);
                }}
              >
                {item.lastDevice}
              </button>
            ) : (
              <span>{formatAgo(item.lastSeenAt)}</span>
            )}
            {item.lastRouterosVersion && (
              <>
                <span>·</span>
                <span className="font-mono">v{item.lastRouterosVersion}</span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
            <CopyButton
              text={buildAiFixPrompt(item)}
              label="Prompt"
              title="Copy structured Prompt-Engineering prompt (Role, Context, Telemetry & Constraints)"
            />
            <MonitorButton
              size="sm"
              variant="glass"
              disabled={busy}
              icon={<ExternalLink aria-hidden="true" />}
              onClick={() => void submitGithubIssue(item.id)}
            >
              {item.githubIssueUrl ? "Issue" : "GitHub"}
            </MonitorButton>
          </div>
        </footer>
      </article>,
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="LLM tool telemetry & Jira workflow board"
        verdict={
          summary ? (
            openIssuesCount === 0 ? (
              <>
                All reported tool feedback is <span className="s">resolved</span>.
              </>
            ) : (
              <>
                {openIssuesCount} active tool {openIssuesCount === 1 ? "issue" : "issues"} across{" "}
                <span className="s">{summary.totalOccurrences}</span> sightings.
                {summary.blockersOpen > 0 && (
                  <>
                    {" "}
                    <span className="w">
                      {summary.blockersOpen} {summary.blockersOpen === 1 ? "blocker" : "blockers"}.
                    </span>
                  </>
                )}
              </>
            )
          ) : (
            "Deduplicated tool feedback from AI sessions."
          )
        }
        lead="Drag cards across Jira workflow columns to transition status (Open → In Progress → Resolved → Won’t Fix). Moving a card to Resolved automatically syncs the fix or replacement tool into MCP Memory so future AI sessions learn it via memory_recall."
        actions={
          <>
            <MonitorButton
              variant="primary"
              icon={<Plus aria-hidden="true" />}
              onClick={() => {
                setCreateInitialStatus("open");
                setCreating(true);
              }}
            >
              File feedback
            </MonitorButton>
            <Segmented
              label="View mode"
              value={viewMode}
              onChange={(v) => setViewMode(v)}
              options={[
                {
                  value: "board",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
                      Jira Board
                    </span>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <List className="h-3.5 w-3.5" aria-hidden="true" />
                      List Queue
                    </span>
                  ),
                },
              ]}
            />
            <MonitorButton
              variant="ghost"
              disabled={loading}
              onClick={refresh}
              icon={<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />}
            >
              Refresh
            </MonitorButton>
          </>
        }
        aside={
          summary ? (
            <div className="glass flex min-w-[290px] items-center gap-4 p-4">
              <Donut
                size={116}
                stroke={12}
                center={summary.totalIssues}
                sub="issues"
                label="Feedback status"
                noun="issues"
                parts={[
                  { value: summary.openIssues, tone: "warn", label: "Open" },
                  { value: summary.inProgressIssues, tone: "brand", label: "In progress" },
                  { value: summary.resolvedIssues, tone: "good", label: "Resolved" },
                  { value: summary.wontFixIssues, tone: "muted", label: "Won’t fix" },
                ]}
              />
              <div className="flex flex-1 flex-col gap-2 text-xs">
                {(
                  [
                    ["warn", "Open", summary.openIssues],
                    ["brand", "In progress", summary.inProgressIssues],
                    ["good", "Resolved", summary.resolvedIssues],
                    ["default", "Won’t fix", summary.wontFixIssues],
                  ] as const
                ).map(([tone, label, n]) => (
                  <span key={label} className="flex items-center gap-2">
                    <StatusDot tone={tone} />
                    <span className="flex-1 text-muted-foreground">{label}</span>
                    <span className="tabular-nums">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : undefined
        }
      />

      <MetricStrip label="Tool feedback metrics">
        <Metric
          label="Open & In Progress"
          value={openIssuesCount}
          tone={openIssuesCount > 0 ? "warn" : "good"}
          hint={`${summary?.openIssues ?? 0} open · ${summary?.inProgressIssues ?? 0} in progress`}
        />
        <Metric
          label="Active Blockers"
          value={summary?.blockersOpen ?? 0}
          tone={(summary?.blockersOpen ?? 0) > 0 ? "bad" : "good"}
          hint="Tasks where the LLM was blocked"
        />
        <Metric
          label="Total Sightings"
          value={summary?.totalOccurrences ?? 0}
          tone="brand"
          hint={`${summary?.repeatOccurrencesSaved ?? 0} duplicate tickets prevented`}
        />
        <Metric
          label="Resolved & Guided"
          value={summary?.resolvedIssues ?? 0}
          tone="good"
          hint="Auto-synced to MCP Memory on resolve"
        />
      </MetricStrip>

      {error && (
        <MonitorNote tone="bad" role="alert">
          <span className="flex flex-wrap items-center gap-2">
            {error}
            <MonitorButton size="sm" onClick={refresh}>
              Retry
            </MonitorButton>
          </span>
        </MonitorNote>
      )}

      {/* Professional Search, Smart Tokens, Quick Filter Chips & Swimlane Controls */}
      <div className="glass flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <MonitorSearch
            className="min-w-[260px] flex-1"
            label="Search & JQL-style filter"
            placeholder="Search text or use tokens: kind:bug impact:blocker tool:wireguard device:home-ax3 is:hot is:memory…"
            value={query}
            onChange={(v) => {
              setQuery(v.slice(0, 500));
              setOffset(0);
            }}
          />
          <MonitorSelect
            label="Category"
            value={kindFilter}
            onChange={(v) => {
              setKindFilter(v);
              setOffset(0);
            }}
            options={[
              { value: "all", label: "All categories" },
              ...feedbackKinds.map((k) => ({ value: k, label: KIND_LABELS[k] })),
            ]}
          />
          <MonitorSelect
            label="Impact"
            value={impactFilter}
            onChange={(v) => {
              setImpactFilter(v);
              setOffset(0);
            }}
            options={[
              { value: "all", label: "All impacts" },
              ...feedbackImpacts.map((i) => ({ value: i, label: IMPACT_LABELS[i] })),
            ]}
          />
          {availableDevices.length > 0 && (
            <MonitorSelect
              label="Router"
              value={deviceFilter}
              onChange={(v) => {
                setDeviceFilter(v);
                setOffset(0);
              }}
              options={[
                { value: "all", label: "All routers" },
                ...availableDevices.map((d) => ({ value: d, label: d })),
              ]}
            />
          )}
          {availableRosVersions.length > 0 && (
            <MonitorSelect
              label="RouterOS"
              value={rosFilter}
              onChange={(v) => {
                setRosFilter(v);
                setOffset(0);
              }}
              options={[
                { value: "all", label: "All RouterOS" },
                ...availableRosVersions.map((v) => ({ value: v, label: `v${v}` })),
              ]}
            />
          )}
          {viewMode === "board" && (
            <MonitorSelect
              label="Swimlanes"
              value={swimlaneBy}
              onChange={(v) => setSwimlaneBy(v as SwimlaneBy)}
              options={[
                { value: "none", label: "Swimlanes: None" },
                { value: "impact", label: "Group by Impact" },
                { value: "kind", label: "Group by Category" },
                { value: "device", label: "Group by Router" },
              ]}
            />
          )}
          <Segmented
            label="Sort feedback"
            value={sort}
            onChange={(v) => {
              setSort(v);
              setOffset(0);
            }}
            options={[
              { value: "occurrences", label: "Most frequent" },
              { value: "impact", label: "Impact" },
              { value: "recent", label: "Latest" },
            ]}
          />
        </div>

        {/* Quick Jira-style Filter Pills + Active Smart Token Badges */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Filter className="h-3 w-3" aria-hidden="true" />
              Quick filters:
            </span>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("blockers") || undefined}
              onClick={() => togglePreset("blockers")}
            >
              <StatusDot tone="bad" />
              Blockers
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("hot") || undefined}
              onClick={() => togglePreset("hot")}
            >
              <Flame className="h-3.5 w-3.5 text-[var(--warning)]" aria-hidden="true" />
              Hot (×3+)
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("missing_tool") || undefined}
              onClick={() => togglePreset("missing_tool")}
            >
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              Missing Tools
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("reopened") || undefined}
              onClick={() => togglePreset("reopened")}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reopened (↺)
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("has_fix") || undefined}
              onClick={() => togglePreset("has_fix")}
            >
              <Check className="h-3.5 w-3.5 text-[var(--sig)]" aria-hidden="true" />
              Has Fix / Workaround
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("memory_synced") || undefined}
              onClick={() => togglePreset("memory_synced")}
            >
              <Sparkles className="h-3.5 w-3.5 text-[var(--sig)]" aria-hidden="true" />
              Synced in Memory
            </button>
            <button
              type="button"
              className="fb-filter-pill"
              data-active={quickPresets.has("github_linked") || undefined}
              onClick={() => togglePreset("github_linked")}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Linked to GitHub
            </button>

            {operationFilter && (
              <button
                type="button"
                className="fb-filter-pill"
                data-active="true"
                onClick={() => setOperationFilter("")}
              >
                <span className="font-mono">tool:{operationFilter}</span>
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}

            {parsedSearch.tokens.map((tok) => (
              <button
                key={tok.raw}
                type="button"
                className="fb-filter-pill font-mono"
                data-active="true"
                title="Click to remove search token"
                onClick={() => removeQueryToken(tok.raw)}
              >
                <span>
                  {tok.key}:{tok.value}
                </span>
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ))}

            {hasAnyFilter && (
              <MonitorButton size="sm" variant="ghost" onClick={clearAllFilters}>
                Reset all filters
              </MonitorButton>
            )}
          </div>

          {/* Hotspot quick-filter chips */}
          {summary && summary.topOperations.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Hotspots:</span>
              {summary.topOperations.slice(0, 4).map((op) => {
                if (op.operation === "(general)") return null;
                const active = operationFilter === op.operation;
                return (
                  <button
                    key={op.operation}
                    type="button"
                    className="fb-filter-pill font-mono"
                    data-active={active || undefined}
                    onClick={() => {
                      setOperationFilter(active ? "" : op.operation);
                      setOffset(0);
                    }}
                  >
                    <StatusDot tone={impactTone(op.highestImpact)} />
                    <span>{op.operation}</span>
                    <span className="text-muted-foreground">×{op.occurrences}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Multi-select & Batch Action Bar */}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2.5">
              <Checkbox
                aria-label="Select all shown feedback issues"
                checked={someShownSelected ? "indeterminate" : allShownSelected}
                onCheckedChange={toggleSelectAllShown}
              />
              <span className="font-medium">
                {selectedIds.size > 0
                  ? `${selectedIds.size} selected (drag any selected card to move all together)`
                  : `Select all (${items.length} shown)`}
              </span>
              {items.some((i) => i.status !== "resolved") && (
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelectedIds(
                      new Set(items.filter((i) => i.status !== "resolved").map((i) => i.id)),
                    )
                  }
                >
                  Select unresolved
                </MonitorButton>
              )}
              {items.some((i) => i.impact === "blocker") && (
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelectedIds(
                      new Set(items.filter((i) => i.impact === "blocker").map((i) => i.id)),
                    )
                  }
                >
                  Select blockers
                </MonitorButton>
              )}
              {selectedIds.size > 0 && (
                <MonitorButton size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                  Clear selection
                </MonitorButton>
              )}
            </div>

            {selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <CopyButton
                  text={buildBatchAiFixPrompt(selectedItems)}
                  label={
                    selectedIds.size === 1
                      ? "Copy AI Prompt"
                      : `Copy AI Prompt (${selectedIds.size})`
                  }
                  title="Copy combined Prompt-Engineering prompt for all selected feedback items"
                />
                <MonitorButton
                  size="sm"
                  variant="glass"
                  disabled={busy}
                  icon={<ExternalLink aria-hidden="true" />}
                  onClick={() => void batchSubmitGithubIssue()}
                >
                  {selectedIds.size === 1
                    ? "Submit GitHub Issue"
                    : `Submit GitHub Issue (${selectedIds.size})`}
                </MonitorButton>
                <MonitorButton
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  icon={<Check aria-hidden="true" />}
                  onClick={() => void batchUpdateStatus("resolved", "Resolved selected issues")}
                >
                  Move → Resolved & Sync Memory
                </MonitorButton>
                <MonitorButton
                  size="sm"
                  variant="glass"
                  disabled={busy}
                  icon={<Wrench aria-hidden="true" />}
                  onClick={() => void batchUpdateStatus("in_progress", "Marked in progress")}
                >
                  Move → In Progress
                </MonitorButton>
                <MonitorButton
                  size="sm"
                  variant="glass"
                  disabled={busy}
                  icon={<Sparkles aria-hidden="true" />}
                  onClick={() => void batchSyncMemory()}
                >
                  Sync Memory
                </MonitorButton>
                {selectedIds.size >= 2 && (
                  <MonitorButton
                    size="sm"
                    variant="glass"
                    disabled={busy}
                    icon={<GitMerge aria-hidden="true" />}
                    onClick={() => void batchMergeSelected()}
                  >
                    Merge ({selectedIds.size})
                  </MonitorButton>
                )}
                <MonitorButton
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void deleteIssues([...selectedIds])}
                >
                  Delete ({selectedIds.size})
                </MonitorButton>
              </div>
            )}
          </div>
        )}
      </div>

      {/* VIEW 1: JIRA KANBAN BOARD WITH DRAG & DROP */}
      {viewMode === "board" ? (
        <div className="flex flex-col gap-4">
          {loading && !page ? (
            <LoadingState label="Loading Jira feedback board" layout="cards" />
          ) : (
            swimlaneGroups.map((group) => (
              <div
                key={group.id}
                className={swimlaneBy !== "none" ? "fb-swimlane" : "flex flex-col gap-2"}
              >
                {swimlaneBy !== "none" && (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <strong className="text-sm font-semibold">{group.label}</strong>
                      <span className="monitor-chip font-mono text-xs">
                        {group.items.length} {group.items.length === 1 ? "issue" : "issues"}
                      </span>
                    </div>
                  </div>
                )}

                <ScrollArea className="fb-board-scroll">
                  <div className="fb-board" role="region" aria-label="Feedback Kanban board">
                    {feedbackStatuses.map((status) => {
                      const colItems = group.items.filter((i) => i.status === status);
                      const colSightings = colItems.reduce((sum, i) => sum + i.occurrences, 0);
                      const colAllSelected =
                        colItems.length > 0 && colItems.every((i) => selectedIds.has(i.id));
                      const colSomeSelected =
                        colItems.some((i) => selectedIds.has(i.id)) && !colAllSelected;
                      const isDropActive = dropTargetStatus === status;

                      return (
                        <section
                          key={status}
                          className="fb-lane"
                          data-status={status}
                          data-drop-active={isDropActive || undefined}
                          aria-label={`${STATUS_LABELS[status]} column (${colItems.length} issues)`}
                          onDragOver={(e) => handleLaneDragOver(e, status)}
                          onDragLeave={() => {
                            if (dropTargetStatus === status) setDropTargetStatus(null);
                          }}
                          onDrop={(e) => handleLaneDrop(e, status)}
                        >
                          <header className="fb-lane-head">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <Checkbox
                                  checked={colSomeSelected ? "indeterminate" : colAllSelected}
                                  onCheckedChange={() => toggleSelectColumn(colItems)}
                                  aria-label={`Select all in ${STATUS_LABELS[status]}`}
                                />
                                <StatusDot tone={statusTone(status)} />
                                <strong className="truncate text-sm font-semibold">
                                  {STATUS_LABELS[status]}
                                </strong>
                                <span className="monitor-chip font-mono text-xs font-semibold tabular-nums">
                                  {colItems.length}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span
                                  className="monitor-chip font-mono text-[11px] text-muted-foreground"
                                  title="Total deduplicated sightings in this column"
                                >
                                  ×{colSightings}
                                </span>
                                <button
                                  type="button"
                                  className="monitor-icon-btn h-7 w-7"
                                  title={`File feedback directly in ${STATUS_LABELS[status]}`}
                                  onClick={() => {
                                    setCreateInitialStatus(status);
                                    setCreating(true);
                                  }}
                                >
                                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                            <p className="text-[11px] leading-snug text-muted-foreground">
                              {LANE_SUBTITLES[status]}
                            </p>
                          </header>

                          <ScrollArea className="fb-lane-scroll">
                            <div className="fb-lane-body">
                              {isDropActive && (
                                <div className="fb-drop-hint">
                                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                                  <span>
                                    Drop to move{" "}
                                    {draggingIds.length > 1
                                      ? `${draggingIds.length} issues`
                                      : draggingIds[0]
                                        ? `#${draggingIds[0]}`
                                        : "card"}{" "}
                                    → <strong>{STATUS_LABELS[status]}</strong>
                                    {status === "resolved" ? " & sync MCP Memory" : ""}
                                  </span>
                                </div>
                              )}

                              {colItems.length === 0 && !isDropActive ? (
                                <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-muted-foreground">
                                  <span>No {STATUS_LABELS[status].toLowerCase()} issues</span>
                                  <span className="mt-1 text-[11px] opacity-75">
                                    Drag a feedback card here to set status to{" "}
                                    {STATUS_LABELS[status]}
                                  </span>
                                </div>
                              ) : (
                                colItems.map((item) => renderKanbanCard(item))
                              )}
                            </div>
                          </ScrollArea>
                        </section>
                      );
                    })}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </div>
            ))
          )}
        </div>
      ) : (
        /* VIEW 2: LIST QUEUE VIEW WITH SIDEBAR ANALYTICS */
        <>
          <MonitorTabs
            label="Feedback status filter"
            value={statusTab}
            onChange={(v) => {
              setStatusTab(v);
              setOffset(0);
            }}
            tabs={[
              { value: "all", label: "All issues", count: summary?.totalIssues },
              { value: "open", label: "Open", count: summary?.openIssues },
              { value: "in_progress", label: "In progress", count: summary?.inProgressIssues },
              { value: "resolved", label: "Resolved", count: summary?.resolvedIssues },
              { value: "wont_fix", label: "Won’t fix", count: summary?.wontFixIssues },
            ]}
          />

          <div className="grid min-w-0 grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <MonitorPanel
              title="Deduplicated feedback queue"
              description="Ranked by repeat occurrences so the highest-friction tool gaps surface at the top."
              flush
            >
              {loading && !page && (
                <div className="px-[18px] pb-3.5 pt-3">
                  <LoadingState label="Loading feedback queue" layout="cards" />
                </div>
              )}

              <div className="flex flex-col gap-2.5 px-[18px] py-3.5" aria-busy={loading}>
                {!loading && items.length === 0 ? (
                  <MonitorEmpty
                    icon={<MessageSquarePlus aria-hidden="true" />}
                    title="No matching feedback reports"
                    action={
                      hasAnyFilter && (
                        <MonitorButton size="sm" onClick={clearAllFilters}>
                          Clear filters
                        </MonitorButton>
                      )
                    }
                  >
                    {hasAnyFilter
                      ? "No feedback issues matched your current search tokens or quick filters."
                      : "When AI agents call submit_feedback on a missing capability, bug, or confusing parameter, deduplicated issues appear here."}
                  </MonitorEmpty>
                ) : (
                  items.map((item) => {
                    const isSelected = selectedIds.has(item.id);
                    const isOpenDrawer = activeId === item.id;
                    return renderIssueContextMenu(
                      item,
                      <article
                        className="memory-fact"
                        data-selected={isOpenDrawer || isSelected || undefined}
                      >
                        <header className="flex flex-wrap items-center gap-2">
                          <span
                            className="monitor-check"
                            onPointerDown={(ev) => {
                              shiftHeldRef.current = ev.shiftKey;
                            }}
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(item.id)}
                              aria-label={`Select feedback #${item.id} (Shift-click selects a range)`}
                            />
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            #{item.id}
                          </span>
                          <span data-col="kind">
                            <KindBadge kind={item.kind} />
                          </span>
                          <span data-col="impact">
                            <StatusBadge tone={impactTone(item.impact)}>
                              {IMPACT_LABELS[item.impact]}
                            </StatusBadge>
                          </span>
                          <StatusBadge tone={statusTone(item.status)} quiet>
                            {STATUS_LABELS[item.status]}
                          </StatusBadge>
                          {item.operation && (
                            <button
                              type="button"
                              data-col="operation"
                              className="monitor-chip font-mono text-xs"
                              title={`Filter by ${item.operation}`}
                              onClick={() => {
                                setOperationFilter(
                                  operationFilter === item.operation ? "" : item.operation!,
                                );
                                setOffset(0);
                              }}
                            >
                              {item.operation}
                            </button>
                          )}
                          <span className="flex-1" />
                          <OccurrencePill count={item.occurrences} reopened={item.reopenedCount} />
                          <RowMore />
                        </header>

                        <button
                          type="button"
                          className="memory-fact-content"
                          onClick={() => setActiveId(item.id)}
                        >
                          <strong className="block font-semibold">{item.title}</strong>
                          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </button>

                        {(item.actualError ||
                          item.workaround ||
                          item.resolutionNote ||
                          item.fixedInVersion ||
                          item.replacementTool) && (
                          <div className="flex flex-col gap-1 text-xs">
                            {item.actualError && (
                              <div className="truncate font-mono text-muted-foreground">
                                Error: {item.actualError}
                              </div>
                            )}
                            {(item.fixedInVersion || item.replacementTool || item.memoryFactId) && (
                              <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                                {item.fixedInVersion && (
                                  <span className="monitor-chip font-mono text-[11px]">
                                    Fixed in {item.fixedInVersion}
                                  </span>
                                )}
                                {item.replacementTool && (
                                  <span className="monitor-chip font-mono text-[11px]">
                                    Tool: {item.replacementTool}
                                  </span>
                                )}
                                {item.memoryFactId && (
                                  <span className="monitor-chip text-[11px]">
                                    Memory #{item.memoryFactId}
                                  </span>
                                )}
                              </div>
                            )}
                            {(item.resolutionNote || item.workaround) && (
                              <div className="truncate text-muted-foreground">
                                <strong className="font-medium text-foreground">
                                  {item.resolutionNote ? "Resolution: " : "Workaround: "}
                                </strong>
                                {item.resolutionNote ?? item.workaround}
                              </div>
                            )}
                          </div>
                        )}

                        <footer className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>First seen {formatAgo(item.firstSeenAt)}</span>
                          <span>·</span>
                          <span>Last seen {formatAgo(item.lastSeenAt)}</span>
                          {item.lastDevice && (
                            <>
                              <span>·</span>
                              <span className="font-mono">{item.lastDevice}</span>
                            </>
                          )}
                          {item.lastRouterosVersion && (
                            <>
                              <span>·</span>
                              <span className="font-mono">v{item.lastRouterosVersion}</span>
                            </>
                          )}
                          <span className="ml-auto flex flex-wrap items-center gap-1.5">
                            <CopyButton
                              text={buildAiFixPrompt(item)}
                              label="Copy AI Prompt"
                              title="Copy professional Prompt-Engineering prompt (Role, Context, Telemetry & Constraints)"
                            />
                            <MonitorButton
                              size="sm"
                              variant="glass"
                              disabled={busy}
                              icon={<ExternalLink aria-hidden="true" />}
                              onClick={() => void submitGithubIssue(item.id)}
                            >
                              {item.githubIssueUrl ? "GitHub Issue" : "Submit GitHub Issue"}
                            </MonitorButton>
                          </span>
                        </footer>
                      </article>,
                    );
                  })
                )}
              </div>

              <div className="monitor-foot" aria-live="polite">
                <StatusDot tone="good" pulse={!loading} />
                <span>{loading ? "Refreshing feedback…" : "Local only"}</span>
                <span className="flex-1" />
                {page && (
                  <span className="tabular-nums">
                    {page.total
                      ? `${offset + 1}–${Math.min(offset + LIST_PAGE_SIZE, page.total)} of ${page.total}`
                      : "0 of 0"}
                  </span>
                )}
                {page && page.total > LIST_PAGE_SIZE && (
                  <>
                    <MonitorButton
                      variant="ghost"
                      size="sm"
                      disabled={offset === 0 || loading}
                      onClick={() => setOffset((v) => Math.max(0, v - LIST_PAGE_SIZE))}
                      icon={<ChevronLeft aria-hidden="true" />}
                    >
                      Previous
                    </MonitorButton>
                    <MonitorButton
                      variant="ghost"
                      size="sm"
                      disabled={offset + LIST_PAGE_SIZE >= page.total || loading}
                      onClick={() => setOffset((v) => v + LIST_PAGE_SIZE)}
                      icon={<ChevronRight aria-hidden="true" />}
                    >
                      Next
                    </MonitorButton>
                  </>
                )}
              </div>
            </MonitorPanel>

            <div className="flex flex-col gap-3.5">
              <MonitorPanel
                title="Hotspot tools & paths"
                description="Operations generating the most repeat feedback sightings."
              >
                {summary && summary.topOperations.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {summary.topOperations.map((op) => {
                      const active = operationFilter === op.operation;
                      return (
                        <button
                          key={op.operation}
                          type="button"
                          className="memory-subject justify-between"
                          data-selected={active || undefined}
                          onClick={() => {
                            setOperationFilter(
                              active || op.operation === "(general)" ? "" : op.operation,
                            );
                            setOffset(0);
                          }}
                        >
                          <span className="min-w-0 truncate font-mono text-xs">{op.operation}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                            <StatusDot tone={impactTone(op.highestImpact)} />
                            <span>×{op.occurrences}</span>
                            <span className="text-muted-foreground">({op.issues})</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No tool hotspots recorded yet. Operations will rank here as feedback arrives.
                  </p>
                )}
              </MonitorPanel>

              <MonitorPanel
                title="Breakdown by kind"
                description="Distribution of reported issues."
              >
                {summary && summary.totalIssues > 0 ? (
                  <HBars
                    rows={feedbackKinds
                      .map((k) => ({
                        label: KIND_LABELS[k],
                        value: summary.byKind[k] ?? 0,
                      }))
                      .filter((r) => r.value > 0)}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">No issues recorded yet.</p>
                )}
              </MonitorPanel>
            </div>
          </div>
        </>
      )}

      <SelectionBar
        count={selectedIds.size}
        noun={selectedIds.size === 1 ? "issue" : "issues"}
        onClear={() => setSelectedIds(new Set())}
        actions={[
          {
            label: "Copy AI Prompt",
            icon: <Copy aria-hidden="true" />,
            onSelect: () => void copySelectedPrompts(),
          },
          {
            label: "Submit GitHub Issue",
            icon: <ExternalLink aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchSubmitGithubIssue(),
          },
          {
            label: "Resolve & Sync Memory",
            icon: <Check aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchUpdateStatus("resolved", "Resolved selected issues"),
          },
          {
            label: "In Progress",
            icon: <Wrench aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchUpdateStatus("in_progress", "Marked in progress"),
          },
          {
            label: "Won’t Fix",
            icon: <XCircle aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchUpdateStatus("wont_fix", "Marked won't fix"),
          },
          {
            label: "Reopen",
            icon: <RotateCcw aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchUpdateStatus("open", "Reopened selected issues"),
          },
          {
            label: "Sync Memory",
            icon: <Sparkles aria-hidden="true" />,
            disabled: busy,
            onSelect: () => void batchSyncMemory(),
          },
          ...(selectedIds.size >= 2
            ? [
                {
                  label: "Merge",
                  icon: <GitMerge aria-hidden="true" />,
                  disabled: busy,
                  onSelect: () => void batchMergeSelected(),
                },
              ]
            : []),
          {
            label: "Delete",
            icon: <Trash2 aria-hidden="true" />,
            danger: true,
            disabled: busy,
            onSelect: () => void deleteIssues([...selectedIds]),
          },
        ]}
      />

      <RowDrawer
        open={activeIssue !== null}
        onClose={() => setActiveId(null)}
        label={activeIssue ? `Feedback details: #${activeIssue.id}` : "Feedback details"}
        status={
          activeIssue
            ? {
                tone:
                  activeIssue.status === "resolved"
                    ? "ok"
                    : activeIssue.impact === "blocker"
                      ? "bad"
                      : activeIssue.status === "in_progress"
                        ? "acc"
                        : "warn",
                label: `${STATUS_LABELS[activeIssue.status]} · ×${activeIssue.occurrences} sightings`,
              }
            : undefined
        }
        title={activeIssue ? `#${activeIssue.id} · ${activeIssue.title}` : ""}
        meta={
          activeIssue
            ? `${KIND_LABELS[activeIssue.kind]} · ${IMPACT_LABELS[activeIssue.impact]} impact${
                activeIssue.operation ? ` · ${activeIssue.operation}` : ""
              }`
            : undefined
        }
        nav={
          activeIndex >= 0
            ? {
                index: activeIndex,
                total: items.length,
                onPrev: activeIndex > 0 ? () => setActiveId(items[activeIndex - 1]!.id) : undefined,
                onNext:
                  activeIndex < items.length - 1
                    ? () => setActiveId(items[activeIndex + 1]!.id)
                    : undefined,
              }
            : undefined
        }
        rowKey={activeIssue?.id}
        storageKey="tool-feedback"
        tab={drawerTab}
        onTab={setDrawerTab}
        actions={
          activeIssue && (
            <>
              <CopyButton
                text={buildAiFixPrompt(activeIssue, currentDetail?.occurrences ?? [])}
                label="Copy AI Prompt"
                title="Copy structured Prompt-Engineering prompt (Role, Context, Telemetry & Constraints)"
              />
              <MonitorButton
                size="sm"
                variant="glass"
                disabled={busy}
                icon={<ExternalLink aria-hidden="true" />}
                onClick={() => void submitGithubIssue(activeIssue.id)}
              >
                {activeIssue.githubIssueUrl ? "GitHub Issue" : "Submit GitHub Issue"}
              </MonitorButton>
            </>
          )
        }
        primary={
          activeIssue && (
            <>
              {activeIssue.status !== "resolved" ? (
                <MonitorButton
                  variant="primary"
                  disabled={busy}
                  icon={<Check aria-hidden="true" />}
                  onClick={() =>
                    void updateIssue(
                      activeIssue.id,
                      {
                        status: "resolved",
                        resolution_note: resolutionDraft.trim() || null,
                        workaround: workaroundDraft.trim() || null,
                        fixed_in_version: fixedVersionDraft.trim() || null,
                        replacement_tool: replacementToolDraft.trim() || null,
                        sync_to_memory: syncToMemory,
                      },
                      `Resolved #${activeIssue.id}`,
                    )
                  }
                >
                  Save & Resolve
                </MonitorButton>
              ) : (
                <MonitorButton
                  variant="glass"
                  disabled={busy}
                  icon={<RotateCcw aria-hidden="true" />}
                  onClick={() =>
                    void updateIssue(
                      activeIssue.id,
                      { status: "open" },
                      `Reopened #${activeIssue.id}`,
                    )
                  }
                >
                  Reopen
                </MonitorButton>
              )}
            </>
          )
        }
        tabs={
          activeIssue
            ? [
                {
                  id: "overview",
                  label: "Overview & Resolution",
                  content: (
                    <div className="flex flex-col gap-4">
                      <DetailBlock label="Problem description">
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">
                          {activeIssue.detail}
                        </p>
                      </DetailBlock>

                      {activeIssue.actualError && (
                        <DetailBlock
                          label="Actual error"
                          aside={<CopyButton text={activeIssue.actualError} icon />}
                        >
                          <pre className="overflow-x-auto rounded-lg border p-2.5 font-mono text-xs">
                            {activeIssue.actualError}
                          </pre>
                        </DetailBlock>
                      )}

                      {activeIssue.expected && (
                        <DetailBlock label="Expected behavior">
                          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                            {activeIssue.expected}
                          </p>
                        </DetailBlock>
                      )}

                      {activeIssue.suggestedFix && (
                        <DetailBlock label="LLM suggested fix">
                          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                            {activeIssue.suggestedFix}
                          </p>
                        </DetailBlock>
                      )}

                      <DetailList
                        items={[
                          {
                            label: "Operation",
                            value: activeIssue.operation ?? "(general)",
                            mono: true,
                          },
                          {
                            label: "Occurrences",
                            value: `×${activeIssue.occurrences}${
                              activeIssue.reopenedCount > 0
                                ? ` (reopened ${activeIssue.reopenedCount}×)`
                                : ""
                            }`,
                            mono: true,
                          },
                          {
                            label: "First seen",
                            value: formatDate(activeIssue.firstSeenAt),
                            mono: true,
                          },
                          {
                            label: "Last seen",
                            value: formatDate(activeIssue.lastSeenAt),
                            mono: true,
                          },
                          {
                            label: "Last device",
                            value: activeIssue.lastDevice ?? "—",
                            mono: true,
                          },
                          {
                            label: "RouterOS",
                            value: activeIssue.lastRouterosVersion ?? "—",
                            mono: true,
                          },
                          {
                            label: "Agent model",
                            value: activeIssue.lastAgentModel ?? "—",
                            mono: true,
                          },
                          {
                            label: "MCP Memory Fact",
                            value: activeIssue.memoryFactId
                              ? `Synced (#${activeIssue.memoryFactId} in mcp-tool-feedback)`
                              : "Not synced yet",
                            mono: true,
                          },
                          ...(activeIssue.githubIssueUrl
                            ? [
                                {
                                  label: "GitHub Issue",
                                  value: activeIssue.githubIssueUrl,
                                  mono: true,
                                },
                              ]
                            : []),
                          {
                            label: "Fingerprint",
                            value: activeIssue.fingerprint,
                            mono: true,
                          },
                        ]}
                      />

                      <DetailBlock
                        label="Operator triage, fix registration & MCP Memory sync"
                        aside={
                          <span className="text-[11px] text-muted-foreground">
                            Returned on find_feedback / submit_feedback & synced to memory_recall
                          </span>
                        }
                      >
                        <div className="flex flex-col gap-3">
                          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            <Field label="Status">
                              <Select
                                label="Status"
                                value={activeIssue.status}
                                onChange={(v) =>
                                  void updateIssue(
                                    activeIssue.id,
                                    {
                                      status: v as FeedbackStatus,
                                      sync_to_memory: syncToMemory,
                                    },
                                    `Status set to ${STATUS_LABELS[v as FeedbackStatus]}`,
                                  )
                                }
                                options={feedbackStatuses.map((s) => ({
                                  value: s,
                                  label: STATUS_LABELS[s],
                                }))}
                              />
                            </Field>
                            <Field label="Impact">
                              <Select
                                label="Impact"
                                value={activeIssue.impact}
                                onChange={(v) =>
                                  void updateIssue(
                                    activeIssue.id,
                                    { impact: v as FeedbackImpact },
                                    `Impact set to ${IMPACT_LABELS[v as FeedbackImpact]}`,
                                  )
                                }
                                options={feedbackImpacts.map((i) => ({
                                  value: i,
                                  label: IMPACT_LABELS[i],
                                }))}
                              />
                            </Field>
                          </div>

                          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            <Field
                              label="Fixed / added in version"
                              help="Version or commit where the bug was fixed or feature added"
                            >
                              <TextInput
                                value={fixedVersionDraft}
                                onChange={setFixedVersionDraft}
                                placeholder="e.g. v6.22.0"
                              />
                            </Field>
                            <Field
                              label="Implemented / replacement tool"
                              help="New or updated MCP tool name the LLM should call now"
                            >
                              <TextInput
                                value={replacementToolDraft}
                                onChange={setReplacementToolDraft}
                                placeholder="e.g. flush_dns_cache"
                              />
                            </Field>
                          </div>

                          <Field
                            label="Known workaround for AI sessions"
                            help="Tells the LLM how to accomplish the task with existing tools"
                          >
                            <TextArea
                              rows={2}
                              value={workaroundDraft}
                              onChange={setWorkaroundDraft}
                              placeholder="e.g. Call invoke_tool with list_dns_cache or pass allow_address_list…"
                            />
                          </Field>

                          <Field
                            label="Operator resolution note"
                            help="Explains what was fixed/added, how the LLM should use it, or why it won't be fixed"
                          >
                            <TextArea
                              rows={2}
                              value={resolutionDraft}
                              onChange={setResolutionDraft}
                              placeholder="e.g. Fixed in v6.22.0 — added dedicated flush_dns_cache tool; use it instead of raw CLI."
                            />
                          </Field>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                              <Checkbox
                                checked={syncToMemory}
                                onCheckedChange={(c) => setSyncToMemory(Boolean(c))}
                              />
                              <span>
                                Sync resolution & tool guidance to MCP Memory (
                                <code className="font-mono">mcp-tool-feedback</code>)
                              </span>
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <MonitorButton
                                size="sm"
                                variant="glass"
                                disabled={busy}
                                icon={<Sparkles aria-hidden="true" />}
                                onClick={() => void syncIssueMemory(activeIssue.id)}
                              >
                                Sync to Memory now
                              </MonitorButton>
                              <MonitorButton
                                size="sm"
                                disabled={busy}
                                icon={<Check aria-hidden="true" />}
                                onClick={() =>
                                  void updateIssue(
                                    activeIssue.id,
                                    {
                                      workaround: workaroundDraft.trim() || null,
                                      resolution_note: resolutionDraft.trim() || null,
                                      fixed_in_version: fixedVersionDraft.trim() || null,
                                      replacement_tool: replacementToolDraft.trim() || null,
                                      sync_to_memory: syncToMemory,
                                    },
                                    "Saved resolution & guidance",
                                  )
                                }
                              >
                                Save guidance
                              </MonitorButton>
                            </div>
                          </div>
                        </div>
                      </DetailBlock>
                    </div>
                  ),
                },
                {
                  id: "occurrences",
                  label: "Sightings",
                  count: currentDetail?.occurrences.length ?? activeIssue.occurrences,
                  content: (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-muted-foreground">
                        Each time an AI session submits a matching report, its context is appended
                        here instead of creating a duplicate issue.
                      </p>
                      {currentDetail?.occurrences.length ? (
                        <ul className="memory-timeline">
                          {currentDetail.occurrences.map((occ) => (
                            <li key={occ.id}>
                              <header>
                                <span className="font-mono">{formatDate(occ.ts)}</span>
                                <span>
                                  {occ.source.toUpperCase()}
                                  {occ.device ? ` · ${occ.device}` : ""}
                                  {occ.routerosVersion ? ` · v${occ.routerosVersion}` : ""}
                                  {occ.agentModel ? ` · ${occ.agentModel}` : ""}
                                </span>
                              </header>
                              {occ.detail && <p className="text-xs">{occ.detail}</p>}
                              {occ.actualError && (
                                <pre className="overflow-x-auto rounded border p-1.5 font-mono text-[11px] text-muted-foreground">
                                  {occ.actualError}
                                </pre>
                              )}
                              {occ.workaround && <small>Workaround used: {occ.workaround}</small>}
                              {occ.callId && (
                                <small className="font-mono">Call ID: {occ.callId}</small>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <MonitorEmpty
                          compact
                          icon={<History aria-hidden="true" />}
                          title="No occurrence rows"
                        />
                      )}
                    </div>
                  ),
                },
                {
                  id: "dedup",
                  label: "Merge & Dedup",
                  count: currentDetail?.similar.length || undefined,
                  content: (
                    <div className="flex flex-col gap-4">
                      <DetailBlock label="Manual merge into another issue">
                        <p className="mb-2.5 text-xs text-muted-foreground">
                          Combine this issue’s occurrences and timeline into another feedback ID.
                          Issue #{activeIssue.id} will be removed after merging.
                        </p>
                        <div className="flex items-end gap-2">
                          <Field label="Target issue ID (#)">
                            <TextInput
                              value={mergeTargetId}
                              onChange={(v) => setMergeTargetId(v.replace(/\D+/g, ""))}
                              placeholder="e.g. 12"
                            />
                          </Field>
                          <MonitorButton
                            disabled={
                              busy ||
                              !mergeTargetId ||
                              Number(mergeTargetId) === activeIssue.id ||
                              Number(mergeTargetId) <= 0
                            }
                            icon={<GitMerge aria-hidden="true" />}
                            onClick={() => void mergeInto(Number(mergeTargetId), activeIssue.id)}
                          >
                            Merge #{activeIssue.id} → #{mergeTargetId || "?"}
                          </MonitorButton>
                        </div>
                      </DetailBlock>

                      <DetailBlock label="Similar issues detected by fuzzy engine">
                        {currentDetail?.similar.length ? (
                          <div className="flex flex-col gap-2">
                            {currentDetail.similar.map(({ issue: sim, similarity }) => (
                              <div
                                key={sim.id}
                                className="flex items-center justify-between gap-2 rounded-lg border p-2.5 text-xs"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono text-muted-foreground">
                                      #{sim.id}
                                    </span>
                                    <span className="monitor-chip font-mono">
                                      {Math.round(similarity * 100)}% match
                                    </span>
                                    <span className="monitor-chip font-mono">
                                      ×{sim.occurrences}
                                    </span>
                                  </div>
                                  <p className="mt-1 truncate font-medium">{sim.title}</p>
                                </div>
                                <MonitorButton
                                  size="sm"
                                  disabled={busy}
                                  icon={<GitMerge aria-hidden="true" />}
                                  onClick={() => void mergeInto(activeIssue.id, sim.id)}
                                >
                                  Merge into #{activeIssue.id}
                                </MonitorButton>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No other open issues scored above the similarity threshold.
                          </p>
                        )}
                      </DetailBlock>

                      <DetailBlock label="Danger zone">
                        <div className="flex flex-wrap items-center gap-2">
                          {activeIssue.status !== "wont_fix" && (
                            <MonitorButton
                              size="sm"
                              disabled={busy}
                              icon={<XCircle aria-hidden="true" />}
                              onClick={() =>
                                void updateIssue(
                                  activeIssue.id,
                                  { status: "wont_fix" },
                                  `Marked #${activeIssue.id} won’t fix`,
                                )
                              }
                            >
                              Mark won’t fix
                            </MonitorButton>
                          )}
                          <MonitorButton
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            icon={<Trash2 aria-hidden="true" />}
                            onClick={() => void deleteIssues([activeIssue.id])}
                          >
                            Delete issue #{activeIssue.id}
                          </MonitorButton>
                        </div>
                      </DetailBlock>
                    </div>
                  ),
                },
              ]
            : undefined
        }
      />

      {creating && (
        <NewFeedbackDialog
          open={creating}
          initialStatus={createInitialStatus}
          onClose={() => setCreating(false)}
          onSaved={(res, targetStatus) => {
            if (res.deduplicated) {
              toast.success(
                `Deduplicated into #${res.issue.id} (now ×${res.issue.occurrences} occurrences)`,
              );
            } else {
              toast.success(`Created feedback #${res.issue.id}`);
            }
            if (targetStatus !== "open" && res.issue.status !== targetStatus) {
              void moveIssuesToStatus([res.issue.id], targetStatus);
            } else {
              refresh();
            }
            setActiveId(res.issue.id);
          }}
        />
      )}
    </div>
  );
}
