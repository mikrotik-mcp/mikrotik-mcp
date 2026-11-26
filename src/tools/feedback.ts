/**
 * LLM Tool Feedback & Telemetry Loop — `submit_feedback`, `find_feedback`, and `update_feedback`.
 *
 * Gives AI agents a structured, zero-router-I/O channel to report missing tools,
 * missing parameters, broken commands, confusing schemas, or unexpected outputs
 * as soon as they happen, and to resolve or annotate existing issues once fixed.
 * Multi-stage deduplication merges repeat reports into a single issue with an
 * incrementing `occurrences` counter and returns any known workaround or
 * operator/agent resolution note immediately.
 */
import { z } from "zod";
import { READ, WRITE, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getFeedbackStore } from "../feedback/accessor";
import { syncFeedbackToMemory } from "../feedback/memory-sync";
import {
  FindFeedbackSchema,
  SubmitFeedbackSchema,
  UpdateFeedbackSchema,
  normalizeUpdateFeedbackInput,
} from "../feedback/types";

export { closeFeedbackStore, resetFeedbackStore } from "../feedback/accessor";

/** Feedback tools write the MCP host's local `feedback.db` only, never a router. */
const feedbackTool: typeof defineTool = (def) =>
  defineTool({ ...def, noDevice: true, hostOnly: true });

export const feedbackTools: ToolModule = [
  feedbackTool({
    name: "submit_feedback",
    title: "Submit Tool Feedback or Bug Report",
    annotations: WRITE,
    description:
      "Report a tool bug, missing capability (`missing_tool`), missing filter/parameter (`missing_param`), confusing schema, unexpected output, or documentation gap to the MCP host's local feedback database (`~/.mikrotik-mcp/feedback.db`). Call this proactively without asking the user whenever `find_tools` has no dedicated tool and you must fall back to `run_routeros_command`, when a tool fails due to a command-builder or schema defect, or when parameters are ambiguous. Format important tool names, RouterOS paths, and key terms in **bold** (`**...**`) or inline code so exported GitHub issues and dashboard cards are easy to scan. Built-in multi-stage deduplication automatically matches existing reports (stripping volatile IPs/MACs/IDs), increments `occurrences` instead of creating duplicates, and returns any known `workaround` or `resolutionNote`. Never include plaintext passwords, private keys, or tokens. Does not contact a router.",
    inputSchema: SubmitFeedbackSchema.shape,
    async handler(args) {
      const store = await getFeedbackStore();
      const result = store.submit(args, "llm");
      return JSON.stringify(result, null, 2);
    },
  }),

  feedbackTool({
    name: "find_feedback",
    title: "Search Tool Feedback, Fixes, and Known Workarounds",
    annotations: READ,
    description:
      "Search existing LLM tool feedback reports, resolved fixes (`status='resolved'`), newly added replacement tools (`replacementTool`), known bugs, and resolution notes / workarounds stored on this MCP host. Use this to check whether a previously reported bug or missing tool was fixed (`fixedInVersion` / `replacementTool`) or already has a documented workaround. Does not contact a router.",
    inputSchema: FindFeedbackSchema.shape,
    async handler(args) {
      const store = await getFeedbackStore();
      const result = store.list(args);
      return JSON.stringify(result, null, 2);
    },
  }),

  feedbackTool({
    name: "update_feedback",
    title: "Update or Resolve a Tool Feedback Issue",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update an existing tool-feedback issue in the MCP host's local feedback database (`~/.mikrotik-mcp/feedback.db`) by `id` (or `issue_id`). Coding agents and operators use this after implementing a missing tool, fixing a schema/command-builder bug, or discovering a reliable workaround: set `status='resolved'` (or `'in_progress'` / `'wont_fix'`), record `resolution_note`, `replacement_tool`, `fixed_in_version`, and `workaround`, and format important tool names, file paths, and key terms in **bold** (`**...**`). Resolved guidance is automatically synced into MCP Knowledge Memory (`mcp-tool-feedback` shared policy entity) so future AI sessions immediately learn the fix via `memory_recall`. Does not contact a router.",
    inputSchema: UpdateFeedbackSchema.shape,
    async handler(args) {
      const normalized = normalizeUpdateFeedbackInput(args);
      if (normalized.id === undefined) {
        throw new z.ZodError([
          {
            code: "custom",
            path: ["id"],
            message: "Required (supply `id` or `issue_id` of the feedback issue to update)",
          },
        ]);
      }
      const store = await getFeedbackStore();
      let issue = store.update(normalized.id, normalized);
      const shouldSyncMemory =
        normalized.sync_to_memory ??
        (issue.status === "resolved" ||
          normalized.resolution_note !== undefined ||
          normalized.workaround !== undefined ||
          normalized.replacement_tool !== undefined ||
          normalized.fixed_in_version !== undefined);
      let memoryFactId = issue.memoryFactId;
      if (shouldSyncMemory) {
        try {
          const syncedId = await syncFeedbackToMemory(issue);
          if (syncedId !== null && syncedId !== issue.memoryFactId) {
            issue = store.update(normalized.id, {}, syncedId);
            memoryFactId = syncedId;
          }
        } catch {
          /* best-effort memory sync when memory is disabled or locked */
        }
      }
      return JSON.stringify(
        {
          ok: true,
          issue,
          memorySynced: Boolean(memoryFactId),
          summary: store.summary(),
        },
        null,
        2,
      );
    },
  }),
];
