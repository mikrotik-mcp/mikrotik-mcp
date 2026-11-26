/**
 * Tool Feedback command — mirrors the dashboard's Jira-style Tool Feedback board:
 * deduplicated LLM tool bug reports, missing tools, schema friction, MCP Memory
 * synchronization (`mcp-tool-feedback` shared policy entity), AI Prompt-Engineering
 * generator, GitHub Issue submission, single & multi-select batch operations,
 * JQL-style token filtering (`kind:`, `impact:`, `tool:`, `device:`, `ros:`,
 * `tag:`, `is:hot`, `has:memory`), and analytics breakdown.
 */
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Detail,
  Form,
  Icon,
  Keyboard,
  List,
  Toast,
  open,
  showToast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useCallback, useMemo, useState } from "react";
import { api, deleteJson, patchJson, postJson, withToken } from "./lib/api";
import { confirmDestructive, showFailureToast } from "./lib/confirm";
import {
  IMPACT_HINTS,
  IMPACT_LABELS,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  LANE_SUBTITLES,
  STATUS_LABELS,
  buildAiFixPrompt,
  buildBatchAiFixPrompt,
  buildIssueDetailMarkdown,
  formatAgo,
  formatDate,
  matchesSmartFeedbackQuery,
} from "./lib/feedback-model";
import { num } from "./lib/format";
import { useApi, usePolling } from "./lib/hooks";
import {
  FEEDBACK_IMPACTS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
} from "./lib/types";
import type {
  FeedbackConfigPayload,
  FeedbackImpact,
  FeedbackIssue,
  FeedbackKind,
  FeedbackListResult,
  FeedbackOccurrence,
  FeedbackStatus,
  FeedbackSummary,
  SubmitFeedbackResult,
} from "./lib/types";

const IMPACT_COLOR: Record<FeedbackImpact, Color> = {
  blocker: Color.Red,
  degraded: Color.Orange,
  friction: Color.Yellow,
  suggestion: Color.Blue,
};

const STATUS_COLOR: Record<FeedbackStatus, Color> = {
  open: Color.Orange,
  in_progress: Color.Blue,
  resolved: Color.Green,
  wont_fix: Color.SecondaryText,
};

const STATUS_ICON: Record<FeedbackStatus, Icon> = {
  open: Icon.ExclamationMark,
  in_progress: Icon.Clock,
  resolved: Icon.CheckCircle,
  wont_fix: Icon.XMarkCircle,
};

const KIND_COLOR: Record<FeedbackKind, Color> = {
  bug: Color.Red,
  missing_tool: Color.Orange,
  missing_param: Color.Orange,
  confusing_schema: Color.Magenta,
  unexpected_output: Color.Yellow,
  performance: Color.Purple,
  docs_gap: Color.Blue,
  feature_request: Color.Green,
};

/* ----------------------------------------------------- File Feedback Form */

function FileFeedbackForm({
  initialStatus = "open",
  onSaved,
}: {
  initialStatus?: FeedbackStatus;
  onSaved: () => void;
}) {
  const { pop } = useNavigation();
  const [kind, setKind] = useState<FeedbackKind>("missing_tool");
  const [impact, setImpact] = useState<FeedbackImpact>("degraded");
  const [targetStatus, setTargetStatus] =
    useState<FeedbackStatus>(initialStatus);

  return (
    <Form
      navigationTitle="File Tool Feedback"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit Feedback"
            icon={Icon.CheckCircle}
            onSubmit={async (v: {
              kind: string;
              impact: string;
              targetStatus: string;
              operation: string;
              title: string;
              detail: string;
              actual_error: string;
              expected: string;
              workaround: string;
              suggested_fix: string;
              device: string;
              routeros_version: string;
              tags: string;
              force_new: boolean;
            }) => {
              const title = (v.title ?? "").trim();
              const detail = (v.detail ?? "").trim();
              if (title.length < 3 || detail.length < 3) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Title and problem description are required",
                  message: "Please enter at least 3 characters for both fields.",
                });
                return;
              }
              const toast = await showToast({
                style: Toast.Style.Animated,
                title: "Submitting tool feedback…",
              });
              try {
                const tags = (v.tags ?? "")
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
                const res = await postJson<SubmitFeedbackResult>(
                  "/api/feedback",
                  {
                    kind: v.kind || kind,
                    impact: v.impact || impact,
                    operation: v.operation?.trim() || undefined,
                    title,
                    detail,
                    actual_error: v.actual_error?.trim() || undefined,
                    expected: v.expected?.trim() || undefined,
                    workaround: v.workaround?.trim() || undefined,
                    suggested_fix: v.suggested_fix?.trim() || undefined,
                    device: v.device?.trim() || undefined,
                    routeros_version: v.routeros_version?.trim() || undefined,
                    tags: tags.length ? tags : undefined,
                    force_new: Boolean(v.force_new),
                  },
                );
                if (res.error) throw new Error(res.error);
                const desiredStatus = (v.targetStatus ||
                  targetStatus) as FeedbackStatus;
                if (desiredStatus !== "open" && res.issue?.id) {
                  await patchJson(`/api/feedback/${res.issue.id}`, {
                    status: desiredStatus,
                  });
                }
                toast.style = Toast.Style.Success;
                toast.title = res.deduplicated
                  ? `Merged into #${res.issue.id} (×${res.issue.occurrences})`
                  : `Created feedback #${res.issue.id}`;
                toast.message = res.advice;
                onSaved();
                pop();
              } catch (e) {
                toast.hide();
                await showFailureToast(e, {
                  title: "Could not submit feedback",
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="1. Classification & Target Column"
        text="Reports are automatically deduplicated by tool name, normalized error skeleton, and semantic similarity."
      />
      <Form.Dropdown
        id="kind"
        title="Category"
        value={kind}
        onChange={(v) => setKind(v as FeedbackKind)}
        info={KIND_DESCRIPTIONS[kind]}
      >
        {FEEDBACK_KINDS.map((k) => (
          <Form.Dropdown.Item
            key={k}
            value={k}
            title={`${KIND_LABELS[k]} — ${KIND_DESCRIPTIONS[k]}`}
          />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="impact"
        title="Impact Severity"
        value={impact}
        onChange={(v) => setImpact(v as FeedbackImpact)}
        info={IMPACT_HINTS[impact]}
      >
        {FEEDBACK_IMPACTS.map((i) => (
          <Form.Dropdown.Item
            key={i}
            value={i}
            title={`${IMPACT_LABELS[i]} — ${IMPACT_HINTS[i]}`}
          />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="targetStatus"
        title="Initial Board Column"
        value={targetStatus}
        onChange={(v) => setTargetStatus(v as FeedbackStatus)}
      >
        {FEEDBACK_STATUSES.map((s) => (
          <Form.Dropdown.Item key={s} value={s} title={STATUS_LABELS[s]} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="operation"
        title="Operation or Tool Name"
        placeholder="e.g. create_wireguard_peer or /ip/dns/cache"
        info="Exact MCP tool name or RouterOS CLI path"
      />

      <Form.Separator />
      <Form.Description
        title="2. Problem Summary & Details"
        text="Never include plaintext passwords, private keys, or tokens."
      />
      <Form.TextField
        id="title"
        title="Title *"
        placeholder="e.g. Missing dedicated tool to flush DNS cache without raw CLI"
      />
      <Form.TextArea
        id="detail"
        title="What Happened? *"
        placeholder="Describe what was attempted, what failed or was missing, and how it affected the workflow…"
      />

      <Form.Separator />
      <Form.Description
        title="3. Diagnostics, Workaround & Fix Guidance"
        text="Optional · Shared automatically with future AI sessions and included in AI prompts / GitHub issues."
      />
      <Form.TextField
        id="actual_error"
        title="Actual Error Output"
        placeholder="RouterOS parser message or Zod validation error…"
      />
      <Form.TextField
        id="expected"
        title="Expected Behavior"
        placeholder="What the tool should return or execute…"
      />
      <Form.TextField
        id="workaround"
        title="Workaround for AI Sessions"
        placeholder="e.g. Use invoke_tool with flush_dns_cache or filter client-side"
      />
      <Form.TextField
        id="suggested_fix"
        title="Suggested Engineering Fix"
        placeholder="Concrete schema or command-builder change…"
      />
      <Form.TextField
        id="device"
        title="Device Name"
        placeholder="e.g. home-ax3"
      />
      <Form.TextField
        id="routeros_version"
        title="RouterOS Version"
        placeholder="e.g. 7.16.2"
      />
      <Form.TextField
        id="tags"
        title="Subsystem Tags"
        placeholder="wireguard, ipv6, dns (comma-separated)"
      />
      <Form.Checkbox
        id="force_new"
        label="Bypass fuzzy deduplication and force a new issue"
        defaultValue={false}
      />
    </Form>
  );
}

/* ------------------------------------------- Edit & Resolve Feedback Form */

function EditFeedbackForm({
  issue,
  onSaved,
}: {
  issue: FeedbackIssue;
  onSaved: () => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={`Edit #${issue.id} · ${issue.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save & Sync MCP Memory"
            icon={Icon.CheckCircle}
            onSubmit={async (v: {
              status: string;
              impact: string;
              kind: string;
              title: string;
              detail: string;
              workaround: string;
              suggested_fix: string;
              resolution_note: string;
              replacement_tool: string;
              fixed_in_version: string;
              github_issue_url: string;
              tags: string;
              sync_to_memory: boolean;
            }) => {
              const toast = await showToast({
                style: Toast.Style.Animated,
                title: `Saving #${issue.id}…`,
              });
              try {
                const tags = (v.tags ?? "")
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
                const res = await patchJson<{
                  ok?: boolean;
                  memorySynced?: boolean;
                  error?: string;
                }>(`/api/feedback/${issue.id}`, {
                  status: v.status as FeedbackStatus,
                  impact: v.impact as FeedbackImpact,
                  kind: v.kind as FeedbackKind,
                  title: v.title.trim() || issue.title,
                  detail: v.detail.trim() || issue.detail,
                  workaround: v.workaround.trim() || null,
                  suggested_fix: v.suggested_fix.trim() || null,
                  resolution_note: v.resolution_note.trim() || null,
                  replacement_tool: v.replacement_tool.trim() || null,
                  fixed_in_version: v.fixed_in_version.trim() || null,
                  github_issue_url: v.github_issue_url.trim() || null,
                  tags,
                  sync_to_memory: Boolean(v.sync_to_memory),
                });
                if (res.error) throw new Error(res.error);
                toast.style = Toast.Style.Success;
                toast.title = res.memorySynced
                  ? `Updated #${issue.id} & synced MCP Memory`
                  : `Updated #${issue.id}`;
                onSaved();
                pop();
              } catch (e) {
                toast.hide();
                await showFailureToast(e, {
                  title: `Could not update #${issue.id}`,
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title={`Feedback #${issue.id}`}
        text={`Operation: ${issue.operation ?? "(general)"} · Sightings: ×${issue.occurrences}`}
      />
      <Form.Dropdown
        id="status"
        title="Board Column (Status)"
        defaultValue={issue.status}
      >
        {FEEDBACK_STATUSES.map((s) => (
          <Form.Dropdown.Item key={s} value={s} title={STATUS_LABELS[s]} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="impact"
        title="Impact Severity"
        defaultValue={issue.impact}
      >
        {FEEDBACK_IMPACTS.map((i) => (
          <Form.Dropdown.Item key={i} value={i} title={IMPACT_LABELS[i]} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="kind" title="Category" defaultValue={issue.kind}>
        {FEEDBACK_KINDS.map((k) => (
          <Form.Dropdown.Item key={k} value={k} title={KIND_LABELS[k]} />
        ))}
      </Form.Dropdown>
      <Form.TextField id="title" title="Title" defaultValue={issue.title} />
      <Form.TextArea id="detail" title="Detail" defaultValue={issue.detail} />

      <Form.Separator />
      <Form.Description
        title="Resolution & MCP Memory Guidance"
        text="When synced, every future LLM session calling memory_recall learns this fix or workaround under the shared mcp-tool-feedback policy entity."
      />
      <Form.TextField
        id="replacement_tool"
        title="Replacement / Implemented Tool"
        defaultValue={issue.replacementTool ?? ""}
        placeholder="e.g. flush_dns_cache"
      />
      <Form.TextField
        id="fixed_in_version"
        title="Fixed in Server Version"
        defaultValue={issue.fixedInVersion ?? ""}
        placeholder="e.g. v0.31.0"
      />
      <Form.TextArea
        id="resolution_note"
        title="Resolution Note"
        defaultValue={issue.resolutionNote ?? ""}
        placeholder="How the bug was resolved or how the AI should call the tool now…"
      />
      <Form.TextArea
        id="workaround"
        title="Workaround"
        defaultValue={issue.workaround ?? ""}
        placeholder="Temporary or permanent workaround for AI sessions…"
      />
      <Form.TextArea
        id="suggested_fix"
        title="Suggested Engineering Fix"
        defaultValue={issue.suggestedFix ?? ""}
      />
      <Form.TextField
        id="github_issue_url"
        title="GitHub Issue URL"
        defaultValue={issue.githubIssueUrl ?? ""}
        placeholder="https://github.com/owner/repo/issues/123"
      />
      <Form.TextField
        id="tags"
        title="Tags"
        defaultValue={issue.tags.join(", ")}
        placeholder="wireguard, ipv6"
      />
      <Form.Checkbox
        id="sync_to_memory"
        label="Sync resolution / workaround to MCP Knowledge Memory (mcp-tool-feedback)"
        defaultValue={true}
      />
    </Form>
  );
}

/* ---------------------------------------------------- GitHub Issue Form */

function GithubIssueForm({
  ids,
  titleHint,
  onDone,
}: {
  ids: number[];
  titleHint: string;
  onDone: () => void;
}) {
  const { pop } = useNavigation();
  const isBatch = ids.length > 1;
  return (
    <Form
      navigationTitle={
        isBatch
          ? `Create Combined GitHub Issue (${ids.length} items)`
          : `Create GitHub Issue · #${ids[0]}`
      }
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit GitHub Issue"
            icon={Icon.Globe}
            onSubmit={async (v: { repo: string; token: string }) => {
              const repo = v.repo.trim() || "mikrotik-mcp/mikrotik-mcp";
              const token = v.token.trim() || undefined;
              const toast = await showToast({
                style: Toast.Style.Animated,
                title: isBatch
                  ? `Creating combined GitHub issue for ${ids.length} items…`
                  : `Creating GitHub issue for #${ids[0]}…`,
              });
              try {
                const res = isBatch
                  ? await postJson<{
                      ok?: boolean;
                      mode?: "api" | "web_url";
                      url?: string;
                      number?: number | null;
                      fallbackUrl?: string;
                      error?: string;
                    }>("/api/feedback/batch", {
                      ids,
                      action: "github_issue",
                      github: { repo, token },
                    })
                  : await postJson<{
                      ok?: boolean;
                      mode?: "api" | "web_url";
                      url?: string;
                      number?: number | null;
                      fallbackUrl?: string;
                      error?: string;
                    }>(`/api/feedback/${ids[0]}/github-issue`, {
                      repo,
                      token,
                    });

                const targetUrl = res.url ?? res.fallbackUrl;
                if (res.error && !targetUrl) throw new Error(res.error);
                if (targetUrl) {
                  await open(targetUrl);
                }
                toast.style = Toast.Style.Success;
                toast.title =
                  res.mode === "api"
                    ? `Created GitHub Issue ${res.number ? `#${res.number}` : ""}`
                    : "Opened pre-filled GitHub Issue in browser";
                onDone();
                pop();
              } catch (e) {
                toast.hide();
                await showFailureToast(e, {
                  title: "Could not create GitHub issue",
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title={isBatch ? `${ids.length} Selected Feedback Items` : titleHint}
        text="If a GitHub Personal Access Token (or server GITHUB_TOKEN) is provided, the issue is created directly via the GitHub REST API and linked back to the feedback item(s). Otherwise, a pre-filled github.com/issues/new URL opens in your browser."
      />
      <Form.TextField
        id="repo"
        title="GitHub Repository"
        defaultValue="mikrotik-mcp/mikrotik-mcp"
        placeholder="owner/repo"
      />
      <Form.PasswordField
        id="token"
        title="GitHub Token (Optional)"
        placeholder="ghp_… (leave blank to use server GITHUB_TOKEN or browser pre-fill)"
      />
    </Form>
  );
}

/* ----------------------------------------------- Merge Duplicate Form */

function MergeFeedbackForm({
  source,
  allItems,
  onDone,
}: {
  source: FeedbackIssue;
  allItems: FeedbackIssue[];
  onDone: () => void;
}) {
  const { pop } = useNavigation();
  const candidates = allItems.filter((i) => i.id !== source.id);
  return (
    <Form
      navigationTitle={`Merge #${source.id} Into Another Issue`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Merge Issue"
            icon={Icon.ArrowRight}
            onSubmit={async (v: { targetId: string }) => {
              const targetId = Number(v.targetId);
              if (!targetId) return;
              const toast = await showToast({
                style: Toast.Style.Animated,
                title: `Merging #${source.id} into #${targetId}…`,
              });
              try {
                const res = await postJson<{
                  ok?: boolean;
                  issue?: FeedbackIssue;
                  error?: string;
                }>(`/api/feedback/${targetId}/merge`, {
                  sourceId: source.id,
                });
                if (res.error) throw new Error(res.error);
                toast.style = Toast.Style.Success;
                toast.title = `Merged #${source.id} into #${targetId}`;
                onDone();
                pop();
              } catch (e) {
                toast.hide();
                await showFailureToast(e, {
                  title: "Could not merge feedback issues",
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title={`Source Issue · #${source.id}`}
        text={`${source.title} (×${source.occurrences} sightings). All occurrences, tags, and workarounds will be folded into the target issue.`}
      />
      <Form.Dropdown id="targetId" title="Target Issue">
        {candidates.map((c) => (
          <Form.Dropdown.Item
            key={c.id}
            value={String(c.id)}
            title={`#${c.id} [${STATUS_LABELS[c.status]} · ×${c.occurrences}] ${c.operation ? `${c.operation}: ` : ""}${c.title}`}
          />
        ))}
      </Form.Dropdown>
    </Form>
  );
}

/* ------------------------------------------- Full Detail & Prompt Preview */

function FeedbackDetailView({
  issueId,
  initialIssue,
  allItems,
  onChanged,
}: {
  issueId: number;
  initialIssue: FeedbackIssue;
  allItems: FeedbackIssue[];
  onChanged: () => void;
}) {
  const { data, isLoading, revalidate } = usePromise(
    (id: number) =>
      api<{ issue: FeedbackIssue; occurrences: FeedbackOccurrence[] }>(
        `/api/feedback/${id}`,
      ),
    [issueId],
  );
  const issue = data?.issue ?? initialIssue;
  const occurrences = data?.occurrences ?? [];
  const aiPrompt = useMemo(
    () => buildAiFixPrompt(issue, occurrences),
    [issue, occurrences],
  );
  const md = useMemo(
    () => buildIssueDetailMarkdown(issue, occurrences),
    [issue, occurrences],
  );

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={`Feedback #${issue.id} · ${issue.operation ?? KIND_LABELS[issue.kind]}`}
      markdown={md}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="Board Column">
            <Detail.Metadata.TagList.Item
              text={STATUS_LABELS[issue.status]}
              color={STATUS_COLOR[issue.status]}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.TagList title="Impact & Kind">
            <Detail.Metadata.TagList.Item
              text={IMPACT_LABELS[issue.impact]}
              color={IMPACT_COLOR[issue.impact]}
            />
            <Detail.Metadata.TagList.Item
              text={KIND_LABELS[issue.kind]}
              color={KIND_COLOR[issue.kind]}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="Operation / Tool"
            text={issue.operation ?? "(general)"}
          />
          <Detail.Metadata.Label
            title="Sightings"
            text={`×${num(issue.occurrences)}${issue.reopenedCount > 0 ? ` (reopened ${issue.reopenedCount}×)` : ""}`}
          />
          <Detail.Metadata.Label
            title="MCP Memory Sync"
            text={
              issue.memoryFactId
                ? `Synced (Fact #${issue.memoryFactId})`
                : "Not synced"
            }
            icon={{
              source: issue.memoryFactId ? Icon.CheckCircle : Icon.Circle,
              tintColor: issue.memoryFactId
                ? Color.Green
                : Color.SecondaryText,
            }}
          />
          {issue.githubIssueUrl && (
            <Detail.Metadata.Link
              title="GitHub Issue"
              target={issue.githubIssueUrl}
              text={issue.githubIssueUrl.replace(/^https?:\/\/github\.com\//, "")}
            />
          )}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Last Device"
            text={issue.lastDevice ?? "—"}
          />
          <Detail.Metadata.Label
            title="RouterOS"
            text={
              issue.lastRouterosVersion
                ? `v${issue.lastRouterosVersion}`
                : "—"
            }
          />
          <Detail.Metadata.Label
            title="Agent Model"
            text={issue.lastAgentModel ?? "—"}
          />
          <Detail.Metadata.Label
            title="First Seen"
            text={formatDate(issue.firstSeenAt)}
          />
          <Detail.Metadata.Label
            title="Last Seen"
            text={formatDate(issue.lastSeenAt)}
          />
          {issue.tags.length > 0 && (
            <Detail.Metadata.TagList title="Tags">
              {issue.tags.map((t) => (
                <Detail.Metadata.TagList.Item
                  key={t}
                  text={t}
                  color={Color.Blue}
                />
              ))}
            </Detail.Metadata.TagList>
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Engineering & AI Prompt">
            <Action.CopyToClipboard
              title="Copy AI Prompt for Fix"
              icon={Icon.Stars}
              content={aiPrompt}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
            <Action.Push
              title="Preview AI Fix Prompt"
              icon={Icon.CodeBlock}
              target={
                <Detail
                  navigationTitle={`AI Fix Prompt · #${issue.id}`}
                  markdown={`\`\`\`markdown\n${aiPrompt}\n\`\`\``}
                  actions={
                    <ActionPanel>
                      <Action.CopyToClipboard
                        title="Copy AI Prompt"
                        content={aiPrompt}
                      />
                      <Action.Paste
                        title="Paste AI Prompt into Active App"
                        content={aiPrompt}
                      />
                    </ActionPanel>
                  }
                />
              }
            />
            <Action.Push
              title="Edit / Resolve & Sync Memory"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              target={
                <EditFeedbackForm
                  issue={issue}
                  onSaved={() => {
                    revalidate();
                    onChanged();
                  }}
                />
              }
            />
            <Action.Push
              title="Create GitHub Issue…"
              icon={Icon.Globe}
              shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
              target={
                <GithubIssueForm
                  ids={[issue.id]}
                  titleHint={`#${issue.id} · ${issue.title}`}
                  onDone={() => {
                    revalidate();
                    onChanged();
                  }}
                />
              }
            />
            {allItems.length > 1 && (
              <Action.Push
                title="Merge Into Another Issue…"
                icon={Icon.ArrowRight}
                target={
                  <MergeFeedbackForm
                    source={issue}
                    allItems={allItems}
                    onDone={() => {
                      revalidate();
                      onChanged();
                    }}
                  />
                }
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Open & Refresh">
            {issue.githubIssueUrl && (
              <Action.OpenInBrowser
                title="Open Linked GitHub Issue"
                url={issue.githubIssueUrl}
              />
            )}
            <Action.OpenInBrowser
              title="Open Kanban Board in Dashboard"
              url={withToken("/#feedback")}
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              onAction={() => {
                revalidate();
                onChanged();
              }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

/* ------------------------------------------------- Analytics Summary View */

function FeedbackAnalyticsView({
  summary,
  config,
}: {
  summary: FeedbackSummary | undefined;
  config: FeedbackConfigPayload | undefined;
}) {
  if (!summary) {
    return <Detail isLoading navigationTitle="Feedback Analytics" />;
  }

  const kindRows = FEEDBACK_KINDS.map(
    (k) => `| ${KIND_LABELS[k]} (\`${k}\`) | ${num(summary.byKind[k] ?? 0)} |`,
  ).join("\n");

  const impactRows = FEEDBACK_IMPACTS.map(
    (i) =>
      `| **${IMPACT_LABELS[i]}** (\`${i}\`) | ${num(summary.byImpact[i] ?? 0)} |`,
  ).join("\n");

  const topOps = summary.topOperations.length
    ? [
        "| Operation / Tool | Unique Issues | Sightings | Open | Highest Impact |",
        "| :--- | ---: | ---: | ---: | :--- |",
        ...summary.topOperations.map(
          (o) =>
            `| \`${o.operation}\` | ${num(o.issues)} | ×${num(o.occurrences)} | ${num(o.openIssues)} | **${IMPACT_LABELS[o.highestImpact]}** |`,
        ),
      ].join("\n")
    : "_No tool-specific operations recorded yet._";

  const md = [
    "# LLM Tool Feedback & Telemetry Analytics",
    "",
    "| Metric | Count |",
    "| :--- | ---: |",
    `| **Open Issues** | ${num(summary.openIssues)} |`,
    `| **In Progress** | ${num(summary.inProgressIssues)} |`,
    `| **Resolved (Knowledge Base)** | ${num(summary.resolvedIssues)} |`,
    `| **Won’t Fix** | ${num(summary.wontFixIssues)} |`,
    `| **Open Blockers** | ${num(summary.blockersOpen)} |`,
    `| **Total Unique Issues** | ${num(summary.totalIssues)} |`,
    `| **Total Sightings** | ×${num(summary.totalOccurrences)} |`,
    `| **Duplicates Absorbed** | ${num(summary.repeatOccurrencesSaved)} |`,
    "",
    "## Most Reported Operations & Tools",
    "",
    topOps,
    "",
    "## By Category",
    "",
    "| Category | Issues |",
    "| :--- | ---: |",
    kindRows,
    "",
    "## By Impact Severity",
    "",
    "| Impact | Issues |",
    "| :--- | ---: |",
    impactRows,
    config
      ? `\n---\n_Database: \`${config.dbPath}\` (${config.enabled ? "enabled" : "disabled"})_`
      : "",
  ].join("\n");

  return (
    <Detail
      navigationTitle="Tool Feedback Analytics"
      markdown={md}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open Kanban Board in Dashboard"
            url={withToken("/#feedback")}
          />
        </ActionPanel>
      }
    />
  );
}

/* ----------------------------------------------------------- Main Command */

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [dropdownFilter, setDropdownFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const listQ = useApi<FeedbackListResult>(
    "/api/feedback?status=all&sort=occurrences&limit=100",
  );
  const configQ = useApi<FeedbackConfigPayload>("/api/feedback/config");

  const revalidateAll = useCallback(() => {
    listQ.revalidate();
    configQ.revalidate();
  }, [listQ.revalidate, configQ.revalidate]);

  usePolling(revalidateAll, 10_000);

  const allItems = listQ.data?.items ?? [];
  const summary = listQ.data?.summary ?? configQ.data?.summary ?? undefined;

  const filteredItems = useMemo(
    () =>
      allItems.filter((item) =>
        matchesSmartFeedbackQuery(item, searchText, dropdownFilter),
      ),
    [allItems, searchText, dropdownFilter],
  );

  const selectedItems = useMemo(
    () => allItems.filter((i) => selectedIds.has(i.id)),
    [allItems, selectedIds],
  );

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedIds(new Set(filteredItems.map((i) => i.id)));
  }, [filteredItems]);

  const selectColumn = useCallback(
    (status: FeedbackStatus) => {
      const ids = filteredItems
        .filter((i) => i.status === status)
        .map((i) => i.id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const allIn = ids.length > 0 && ids.every((id) => next.has(id));
        if (allIn) {
          for (const id of ids) next.delete(id);
        } else {
          for (const id of ids) next.add(id);
        }
        return next;
      });
    },
    [filteredItems],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  async function moveIssueStatus(issue: FeedbackIssue, status: FeedbackStatus) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Moving #${issue.id} → ${STATUS_LABELS[status]}…`,
    });
    try {
      const res = await patchJson<{
        ok?: boolean;
        memorySynced?: boolean;
        error?: string;
      }>(`/api/feedback/${issue.id}`, {
        status,
        sync_to_memory: status === "resolved" ? true : undefined,
      });
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = res.memorySynced
        ? `#${issue.id} → ${STATUS_LABELS[status]} (MCP Memory synced)`
        : `#${issue.id} → ${STATUS_LABELS[status]}`;
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, {
        title: `Could not move #${issue.id}`,
      });
    }
  }

  async function syncSingleMemory(issue: FeedbackIssue) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Syncing #${issue.id} to MCP Memory…`,
    });
    try {
      const res = await postJson<{
        ok?: boolean;
        memoryFactId?: number;
        error?: string;
      }>(`/api/feedback/${issue.id}/sync-memory`, {});
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = `Synced #${issue.id} to mcp-tool-feedback (Fact #${res.memoryFactId})`;
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, {
        title: "Could not sync to MCP Memory",
      });
    }
  }

  async function deleteSingleIssue(issue: FeedbackIssue) {
    const ok = await confirmDestructive({
      title: `Delete feedback #${issue.id}?`,
      message: `Removes “${issue.title}” and all ×${issue.occurrences} recorded sightings.`,
      actionTitle: "Delete",
    });
    if (!ok) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Deleting #${issue.id}…`,
    });
    try {
      const res = await deleteJson<{ removed?: number; error?: string }>(
        `/api/feedback/${issue.id}`,
        {},
      );
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = `Deleted #${issue.id}`;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(issue.id);
        return next;
      });
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: `Could not delete #${issue.id}` });
    }
  }

  async function runBatchStatus(status: FeedbackStatus) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Moving ${ids.length} items → ${STATUS_LABELS[status]}…`,
    });
    try {
      const res = await postJson<{
        ok?: boolean;
        updatedCount?: number;
        memorySyncedCount?: number;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "update",
        patch: {
          status,
          sync_to_memory: status === "resolved" ? true : undefined,
        },
      });
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = `Moved ${res.updatedCount ?? ids.length} items → ${STATUS_LABELS[status]}`;
      if (res.memorySyncedCount) {
        toast.message = `Synced ${res.memorySyncedCount} items to MCP Memory`;
      }
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: "Batch status update failed" });
    }
  }

  async function runBatchSyncMemory() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Syncing ${ids.length} items to MCP Memory…`,
    });
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
      toast.style = Toast.Style.Success;
      toast.title = `Synced ${res.memorySyncedCount ?? 0} of ${ids.length} items to MCP Memory`;
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: "Batch MCP Memory sync failed" });
    }
  }

  async function runBatchMerge() {
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    const targetId = ids[0]!;
    const ok = await confirmDestructive({
      title: `Merge ${ids.length} selected issues into #${targetId}?`,
      message: `Issues ${ids
        .slice(1)
        .map((id) => `#${id}`)
        .join(", ")} will be folded into #${targetId}.`,
      actionTitle: "Merge Issues",
      icon: Icon.ArrowRight,
    });
    if (!ok) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Merging ${ids.length} issues into #${targetId}…`,
    });
    try {
      const res = await postJson<{
        ok?: boolean;
        mergedCount?: number;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "merge",
        target_id: targetId,
      });
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = `Merged ${res.mergedCount ?? ids.length - 1} issues into #${targetId}`;
      setSelectedIds(new Set([targetId]));
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: "Batch merge failed" });
    }
  }

  async function runBatchDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const ok = await confirmDestructive({
      title: `Delete ${ids.length} selected feedback issues?`,
      message: `Permanently deletes ${ids.map((id) => `#${id}`).join(", ")} and all their sightings.`,
      actionTitle: `Delete ${ids.length} Issues`,
    });
    if (!ok) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Deleting ${ids.length} issues…`,
    });
    try {
      const res = await postJson<{
        ok?: boolean;
        removed?: number;
        error?: string;
      }>("/api/feedback/batch", {
        ids,
        action: "delete",
      });
      if (res.error) throw new Error(res.error);
      toast.style = Toast.Style.Success;
      toast.title = `Deleted ${res.removed ?? ids.length} feedback issues`;
      clearSelection();
      revalidateAll();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: "Batch delete failed" });
    }
  }

  return (
    <List
      isLoading={listQ.isLoading}
      isShowingDetail
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search or use tokens: kind:bug impact:blocker tool:wireguard is:hot has:memory…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter Kanban Board"
          value={dropdownFilter}
          onChange={setDropdownFilter}
        >
          <List.Dropdown.Section title="Kanban View">
            <List.Dropdown.Item
              value="all"
              title={`All Board Columns (${allItems.length})`}
              icon={Icon.AppWindowGrid2x2}
            />
            <List.Dropdown.Item
              value="preset:unresolved"
              title="Active / Unresolved Only (Open + In Progress)"
              icon={Icon.ExclamationMark}
            />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Quick Presets">
            <List.Dropdown.Item
              value="impact:blocker"
              title="Blockers Only"
              icon={{ source: Icon.Warning, tintColor: Color.Red }}
            />
            <List.Dropdown.Item
              value="preset:hot"
              title="Hot Repeat (×3+ Sightings)"
              icon={{ source: Icon.Bolt, tintColor: Color.Orange }}
            />
            <List.Dropdown.Item
              value="kind:missing_tool"
              title="Missing Dedicated Tools"
              icon={{ source: Icon.Hammer, tintColor: Color.Orange }}
            />
            <List.Dropdown.Item
              value="preset:reopened"
              title="Reopened After Resolution (↺)"
              icon={{
                source: Icon.ArrowCounterClockwise,
                tintColor: Color.Yellow,
              }}
            />
            <List.Dropdown.Item
              value="preset:has_fix"
              title="Has Fix / Workaround"
              icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
            />
            <List.Dropdown.Item
              value="preset:memory_synced"
              title="MCP Memory Synced"
              icon={{ source: Icon.Stars, tintColor: Color.Green }}
            />
            <List.Dropdown.Item
              value="preset:github_linked"
              title="GitHub Issue Linked"
              icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Board Columns (Status)">
            {FEEDBACK_STATUSES.map((s) => (
              <List.Dropdown.Item
                key={s}
                value={`status:${s}`}
                title={STATUS_LABELS[s]}
                icon={{ source: STATUS_ICON[s], tintColor: STATUS_COLOR[s] }}
              />
            ))}
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Categories (Kind)">
            {FEEDBACK_KINDS.map((k) => (
              <List.Dropdown.Item
                key={k}
                value={`kind:${k}`}
                title={KIND_LABELS[k]}
              />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="File Tool Feedback"
            icon={Icon.Plus}
            shortcut={Keyboard.Shortcut.Common.New}
            target={<FileFeedbackForm onSaved={revalidateAll} />}
          />
          <Action.Push
            title="View Feedback Analytics"
            icon={Icon.BarChart}
            target={
              <FeedbackAnalyticsView summary={summary} config={configQ.data} />
            }
          />
          <Action.OpenInBrowser
            title="Open Kanban Board in Dashboard"
            url={withToken("/#feedback")}
          />
          <Action
            title="Refresh Board"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={revalidateAll}
          />
        </ActionPanel>
      }
    >
      {FEEDBACK_STATUSES.map((status) => {
        const colItems = filteredItems.filter((i) => i.status === status);
        if (colItems.length === 0) return null;
        const colSightings = colItems.reduce(
          (sum, i) => sum + i.occurrences,
          0,
        );
        const colSelectedCount = colItems.filter((i) =>
          selectedIds.has(i.id),
        ).length;

        return (
          <List.Section
            key={status}
            title={`${STATUS_LABELS[status]}${colSelectedCount > 0 ? ` · ${colSelectedCount} selected` : ""}`}
            subtitle={`${colItems.length} issue${colItems.length === 1 ? "" : "s"} · ×${num(colSightings)} sightings — ${LANE_SUBTITLES[status]}`}
          >
            {colItems.map((item) => {
              const isSelected = selectedIds.has(item.id);
              const singlePrompt = buildAiFixPrompt(item);
              const batchPrompt =
                selectedItems.length > 0
                  ? buildBatchAiFixPrompt(selectedItems)
                  : singlePrompt;

              const accessories: List.Item.Accessory[] = [];
              if (isSelected) {
                accessories.push({
                  tag: { value: "SELECTED", color: Color.Green },
                  tooltip: "Included in batch actions",
                });
              }
              accessories.push({
                tag: {
                  value: IMPACT_LABELS[item.impact],
                  color: IMPACT_COLOR[item.impact],
                },
                tooltip: IMPACT_HINTS[item.impact],
              });
              accessories.push({
                tag: {
                  value: `×${item.occurrences}${item.reopenedCount > 0 ? ` · ↺${item.reopenedCount}` : ""}`,
                  color:
                    item.occurrences >= 5
                      ? Color.Red
                      : item.occurrences >= 2
                        ? Color.Orange
                        : Color.SecondaryText,
                },
                tooltip: `Deduplicated sightings: ${item.occurrences}`,
              });
              if (item.memoryFactId) {
                accessories.push({
                  icon: { source: Icon.Stars, tintColor: Color.Green },
                  tooltip: `Synced to MCP Memory (Fact #${item.memoryFactId})`,
                });
              }
              if (item.githubIssueUrl) {
                accessories.push({
                  icon: { source: Icon.Globe, tintColor: Color.Blue },
                  tooltip: `Linked GitHub Issue: ${item.githubIssueUrl}`,
                });
              }
              accessories.push({
                text: formatAgo(item.lastSeenAt),
                tooltip: `Last seen ${formatDate(item.lastSeenAt)}`,
              });

              return (
                <List.Item
                  key={item.id}
                  icon={{
                    source: isSelected
                      ? Icon.CheckCircle
                      : STATUS_ICON[item.status],
                    tintColor: isSelected
                      ? Color.Green
                      : IMPACT_COLOR[item.impact],
                  }}
                  title={`#${item.id} ${item.title}`}
                  subtitle={item.operation ?? KIND_LABELS[item.kind]}
                  accessories={accessories}
                  detail={
                    <List.Item.Detail
                      markdown={buildIssueDetailMarkdown(item)}
                      metadata={
                        <List.Item.Detail.Metadata>
                          <List.Item.Detail.Metadata.TagList title="Kanban Column & Impact">
                            <List.Item.Detail.Metadata.TagList.Item
                              text={STATUS_LABELS[item.status]}
                              color={STATUS_COLOR[item.status]}
                            />
                            <List.Item.Detail.Metadata.TagList.Item
                              text={IMPACT_LABELS[item.impact]}
                              color={IMPACT_COLOR[item.impact]}
                            />
                            <List.Item.Detail.Metadata.TagList.Item
                              text={KIND_LABELS[item.kind]}
                              color={KIND_COLOR[item.kind]}
                            />
                          </List.Item.Detail.Metadata.TagList>
                          <List.Item.Detail.Metadata.Label
                            title="Operation / Tool"
                            text={item.operation ?? "(general)"}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Deduplicated Sightings"
                            text={`×${num(item.occurrences)}${item.reopenedCount > 0 ? ` (reopened ${item.reopenedCount}×)` : ""}`}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="MCP Memory Sync"
                            text={
                              item.memoryFactId
                                ? `Synced (Fact #${item.memoryFactId})`
                                : "Not synced"
                            }
                            icon={{
                              source: item.memoryFactId
                                ? Icon.CheckCircle
                                : Icon.Circle,
                              tintColor: item.memoryFactId
                                ? Color.Green
                                : Color.SecondaryText,
                            }}
                          />
                          {item.githubIssueUrl && (
                            <List.Item.Detail.Metadata.Link
                              title="GitHub Issue"
                              target={item.githubIssueUrl}
                              text={item.githubIssueUrl.replace(
                                /^https?:\/\/github\.com\//,
                                "",
                              )}
                            />
                          )}
                          <List.Item.Detail.Metadata.Separator />
                          <List.Item.Detail.Metadata.Label
                            title="Device / RouterOS"
                            text={`${item.lastDevice ?? "—"} · ${item.lastRouterosVersion ? `v${item.lastRouterosVersion}` : "—"}`}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Agent Model"
                            text={item.lastAgentModel ?? "—"}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Last Seen"
                            text={formatDate(item.lastSeenAt)}
                          />
                        </List.Item.Detail.Metadata>
                      }
                    />
                  }
                  actions={
                    <ActionPanel>
                      <ActionPanel.Section
                        title={`Issue #${item.id} · ${STATUS_LABELS[item.status]}`}
                      >
                        <Action.Push
                          title="Inspect Full Issue & Sightings"
                          icon={Icon.Eye}
                          target={
                            <FeedbackDetailView
                              issueId={item.id}
                              initialIssue={item}
                              allItems={allItems}
                              onChanged={revalidateAll}
                            />
                          }
                        />
                        <Action.CopyToClipboard
                          title="Copy AI Prompt for Fix"
                          icon={Icon.Stars}
                          content={singlePrompt}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                        />
                        <Action.Push
                          title="Edit / Resolve & Sync Memory"
                          icon={Icon.Pencil}
                          shortcut={{ modifiers: ["cmd"], key: "e" }}
                          target={
                            <EditFeedbackForm
                              issue={item}
                              onSaved={revalidateAll}
                            />
                          }
                        />
                        <ActionPanel.Submenu
                          title="Move to Board Column…"
                          icon={Icon.ArrowRight}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                        >
                          {FEEDBACK_STATUSES.filter(
                            (s) => s !== item.status,
                          ).map((s) => (
                            <Action
                              key={s}
                              title={`Move to ${STATUS_LABELS[s]}${s === "resolved" ? " & Sync MCP Memory" : ""}`}
                              icon={{
                                source: STATUS_ICON[s],
                                tintColor: STATUS_COLOR[s],
                              }}
                              onAction={() => void moveIssueStatus(item, s)}
                            />
                          ))}
                        </ActionPanel.Submenu>
                        <Action
                          title="Sync to MCP Knowledge Memory"
                          icon={Icon.Stars}
                          onAction={() => void syncSingleMemory(item)}
                        />
                        <Action.Push
                          title="Create GitHub Issue…"
                          icon={Icon.Globe}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
                          target={
                            <GithubIssueForm
                              ids={[item.id]}
                              titleHint={`#${item.id} · ${item.title}`}
                              onDone={revalidateAll}
                            />
                          }
                        />
                        {allItems.length > 1 && (
                          <Action.Push
                            title="Merge Into Another Issue…"
                            icon={Icon.ArrowRight}
                            target={
                              <MergeFeedbackForm
                                source={item}
                                allItems={allItems}
                                onDone={revalidateAll}
                              />
                            }
                          />
                        )}
                      </ActionPanel.Section>

                      <ActionPanel.Section
                        title={
                          selectedIds.size > 0
                            ? `Multi-Select & Batch (${selectedIds.size} Selected)`
                            : "Multi-Select & Batch"
                        }
                      >
                        <Action
                          title={
                            isSelected
                              ? `Deselect #${item.id}`
                              : `Select #${item.id} for Batch Action`
                          }
                          icon={isSelected ? Icon.Circle : Icon.CheckCircle}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                          onAction={() => toggleSelect(item.id)}
                        />
                        <Action
                          title={`Toggle Select All in ${STATUS_LABELS[item.status]} (${colItems.length})`}
                          icon={Icon.CheckList}
                          onAction={() => selectColumn(item.status)}
                        />
                        <Action
                          title={`Select All Matching Filter (${filteredItems.length})`}
                          icon={Icon.CheckList}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
                          onAction={selectAllFiltered}
                        />
                        {selectedIds.size > 0 && (
                          <>
                            <Action
                              title={`Copy Combined AI Prompt (${selectedIds.size} Items)`}
                              icon={Icon.Stars}
                              onAction={async () => {
                                await Clipboard.copy(batchPrompt);
                                await showToast({
                                  style: Toast.Style.Success,
                                  title: `Copied AI Fix Prompt for ${selectedIds.size} items`,
                                });
                              }}
                            />
                            <Action.Push
                              title={`Create Combined GitHub Issue (${selectedIds.size} Items)…`}
                              icon={Icon.Globe}
                              target={
                                <GithubIssueForm
                                  ids={[...selectedIds]}
                                  titleHint={`${selectedIds.size} selected issues`}
                                  onDone={revalidateAll}
                                />
                              }
                            />
                            <ActionPanel.Submenu
                              title={`Batch Move ${selectedIds.size} Items to Column…`}
                              icon={Icon.ArrowRight}
                            >
                              {FEEDBACK_STATUSES.map((s) => (
                                <Action
                                  key={s}
                                  title={`Move ${selectedIds.size} Items → ${STATUS_LABELS[s]}`}
                                  icon={{
                                    source: STATUS_ICON[s],
                                    tintColor: STATUS_COLOR[s],
                                  }}
                                  onAction={() => void runBatchStatus(s)}
                                />
                              ))}
                            </ActionPanel.Submenu>
                            <Action
                              title={`Batch Sync ${selectedIds.size} Items to MCP Memory`}
                              icon={Icon.Stars}
                              onAction={() => void runBatchSyncMemory()}
                            />
                            {selectedIds.size >= 2 && (
                              <Action
                                title={`Merge ${selectedIds.size} Selected Issues Into #${[...selectedIds][0]}`}
                                icon={Icon.ArrowRight}
                                onAction={() => void runBatchMerge()}
                              />
                            )}
                            <Action
                              title={`Clear Selection (${selectedIds.size})`}
                              icon={Icon.XMarkCircle}
                              onAction={clearSelection}
                            />
                            <Action
                              title={`Batch Delete ${selectedIds.size} Selected Issues`}
                              icon={Icon.Trash}
                              style={Action.Style.Destructive}
                              onAction={() => void runBatchDelete()}
                            />
                          </>
                        )}
                      </ActionPanel.Section>

                      <ActionPanel.Section title="Board & Workspace">
                        <Action.Push
                          title="File New Tool Feedback"
                          icon={Icon.Plus}
                          shortcut={Keyboard.Shortcut.Common.New}
                          target={
                            <FileFeedbackForm
                              initialStatus={item.status}
                              onSaved={revalidateAll}
                            />
                          }
                        />
                        <Action.Push
                          title="View Feedback Analytics"
                          icon={Icon.BarChart}
                          target={
                            <FeedbackAnalyticsView
                              summary={summary}
                              config={configQ.data}
                            />
                          }
                        />
                        {item.githubIssueUrl && (
                          <Action.OpenInBrowser
                            title="Open Linked GitHub Issue"
                            url={item.githubIssueUrl}
                          />
                        )}
                        <Action.OpenInBrowser
                          title="Open Kanban Board in Dashboard"
                          url={withToken("/#feedback")}
                        />
                        <Action
                          title="Refresh Board"
                          icon={Icon.ArrowClockwise}
                          shortcut={Keyboard.Shortcut.Common.Refresh}
                          onAction={revalidateAll}
                        />
                        <Action
                          title={`Delete #${item.id}`}
                          icon={Icon.Trash}
                          style={Action.Style.Destructive}
                          shortcut={Keyboard.Shortcut.Common.Remove}
                          onAction={() => void deleteSingleIssue(item)}
                        />
                      </ActionPanel.Section>
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}

      <List.EmptyView
        icon={
          listQ.error
            ? Icon.ExclamationMark
            : allItems.length === 0
              ? Icon.CheckCircle
              : Icon.MagnifyingGlass
        }
        title={
          listQ.error
            ? "Could not load tool feedback"
            : listQ.isLoading
              ? "Loading Jira feedback board…"
              : allItems.length === 0
                ? "No tool feedback recorded yet"
                : "No feedback issues match the current filter"
        }
        description={
          listQ.error
            ? "Check the dashboard URL and bearer token in Raycast extension preferences."
            : allItems.length === 0
              ? "AI assistants call submit_feedback when a tool errors or a dedicated capability is missing, or press ⌘N to file one."
              : "Try clearing your search query or switching the filter dropdown."
        }
        actions={
          <ActionPanel>
            <Action.Push
              title="File Tool Feedback"
              icon={Icon.Plus}
              shortcut={Keyboard.Shortcut.Common.New}
              target={<FileFeedbackForm onSaved={revalidateAll} />}
            />
            {summary && (
              <Action.Push
                title="View Feedback Analytics"
                icon={Icon.BarChart}
                target={
                  <FeedbackAnalyticsView
                    summary={summary}
                    config={configQ.data}
                  />
                }
              />
            )}
            <Action.OpenInBrowser
              title="Open Kanban Board in Dashboard"
              url={withToken("/#feedback")}
            />
            <Action
              title="Refresh Board"
              icon={Icon.ArrowClockwise}
              onAction={revalidateAll}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
