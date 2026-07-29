/** stdio transport — the default; used by Claude Desktop and most MCP clients. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "../core/runtime";
import { checkForUpdate } from "../core/update-check";
import { logger } from "../logger";
import { createServer } from "../server";
import { setMcpAlertSender } from "../alerts/channels";
import { VERSION } from "../version";

export async function runStdio(): Promise<void> {
  const { server, toolCount, promptCount, uiViewCount, readOnly } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    `MCP server ready on stdio — ${toolCount} tools, ${promptCount} prompts, ${uiViewCount} app views${readOnly ? " [READ-ONLY]" : ""}`,
  );

  // Wire the `mcp` alert channel to this client. Only stdio does this today —
  // the HTTP transport has no unprompted push path wired, so an alert routed to
  // `mcp` there degrades to a delivery failure with a clear reason rather than
  // vanishing. Documented in docs/alerting.md.
  setMcpAlertSender((n) => {
    void server.server
      .sendLoggingMessage({
        level: n.severity === "critical" || n.severity === "high" ? "error" : "info",
        data:
          `[alert:${n.kind}] ${n.title}${n.device ? ` · ${n.device}` : ""} ` +
          `(severity ${n.severity}, rule ${n.ruleId})${n.body ? ` — ${n.body}` : ""}`,
      })
      .catch(() => {});
  });

  // Non-blocking update whisper: check for a newer version in the background
  // and, if found, notify the connected LLM via a logging message. This runs
  // well after the handshake so it never delays initialization. The LLM can
  // absorb the update as ambient context and mention it when relevant.
  if (!getConfig().disableUpdateCheck) {
    void whisperUpdate(server).catch(() => {});
  }
}

async function whisperUpdate(server: McpServer): Promise<void> {
  const result = await checkForUpdate();
  if (!result.release?.isNewer) return;
  const r = result.release;
  try {
    void server.server
      .sendLoggingMessage({
        level: "info",
        data:
          `[MikroTik MCP] Update available: v${r.version} (running v${VERSION}). ` +
          `${r.name ? `"${r.name}" \u2014 ` : ""}` +
          `Call check_server_pulse for release notes, or upgrade: bun i -g @usex/mikrotik-mcp@latest`,
      })
      .catch(() => {});
  } catch {
    // Logging is best-effort; never propagate.
  }
}
