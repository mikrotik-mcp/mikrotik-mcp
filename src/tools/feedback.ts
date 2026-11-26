/**
 * LLM Tool Feedback & Telemetry Loop — `submit_feedback` and `find_feedback`.
 *
 * Gives AI agents a structured, zero-router-I/O channel to report missing tools,
 * missing parameters, broken commands, confusing schemas, or unexpected outputs
 * as soon as they happen. Multi-stage deduplication merges repeat reports into
 * a single issue with an incrementing `occurrences` counter and returns any
 * known workaround or operator resolution note immediately.
 */
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getFeedbackStore } from "../feedback/accessor";
import { FindFeedbackSchema, SubmitFeedbackSchema } from "../feedback/types";

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
      "Report a tool bug, missing capability (`missing_tool`), missing filter/parameter (`missing_param`), confusing schema, unexpected output, or documentation gap to the MCP host's local feedback database (`~/.mikrotik-mcp/feedback.db`). Call this proactively without asking the user whenever `find_tools` has no dedicated tool and you must fall back to `run_routeros_command`, when a tool fails due to a command-builder or schema defect, or when parameters are ambiguous. Built-in multi-stage deduplication automatically matches existing reports (stripping volatile IPs/MACs/IDs), increments `occurrences` instead of creating duplicates, and returns any known `workaround` or operator `resolutionNote`. Never include plaintext passwords, private keys, or tokens. Does not contact a router.",
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
      "Search existing LLM tool feedback reports, resolved fixes (`status='resolved'`), newly added replacement tools (`replacementTool`), known bugs, and operator resolution notes / workarounds stored on this MCP host. Use this to check whether a previously reported bug or missing tool was fixed (`fixedInVersion` / `replacementTool`) or already has a documented workaround. Does not contact a router.",
    inputSchema: FindFeedbackSchema.shape,
    async handler(args) {
      const store = await getFeedbackStore();
      const result = store.list(args);
      return JSON.stringify(result, null, 2);
    },
  }),
];
