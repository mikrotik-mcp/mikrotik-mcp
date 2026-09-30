import {
  getMcpSettingsService,
  McpSettingsPatchSchema,
  McpSettingsPendingSchema,
  McpSettingsUpdateSchema,
} from "../core/mcp-settings";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";

const render = (value: unknown): string => JSON.stringify(value, null, 2);

export const mcpSettingsTools: ToolModule = [
  defineTool({
    name: "get_mcp_settings",
    title: "Read MCP Server Settings",
    noDevice: true,
    annotations: READ,
    description:
      "Read the MCP host's editable settings, opaque revision and pending change. Covers tool presentation, SSH pooling, dashboard recording, Memory enablement and startup update checks. Contains no credentials; never contacts a router. These are configured values, not proof a startup-only component has restarted. Read before preview_mcp_settings or update_mcp_settings.",
    handler: () => render(getMcpSettingsService().read()),
  }),
  defineTool({
    name: "get_mcp_settings_schema",
    title: "Describe Editable MCP Settings",
    noDevice: true,
    annotations: READ,
    description:
      "Get the exact JSON Schema for the partial changes accepted by preview_mcp_settings and update_mcp_settings. Unknown/protected fields are rejected, omitted fields stay unchanged. Credentials, listeners, file paths, device inventory and permission ceilings are operator-managed. No device or file changes.",
    handler: () => render(getMcpSettingsService().schema()),
  }),
  defineTool({
    name: "preview_mcp_settings",
    title: "Validate and Preview MCP Settings",
    noDevice: true,
    annotations: READ,
    description:
      "Validate a partial MCP settings change against live configuration and return changed paths, a secret-free diff, revision and restart requirements. No file writes or router contact. Show the preview and obtain user approval before applying; never guess setting names.",
    inputSchema: {
      changes: McpSettingsPatchSchema.describe(
        "Only the fields to change; omitted values are preserved.",
      ),
    },
    handler: (args) => render(getMcpSettingsService().preview(args.changes)),
  }),
  defineTool({
    name: "update_mcp_settings",
    title: "Safely Update MCP Settings",
    noDevice: true,
    annotations: WRITE,
    description:
      "Apply explicitly user-approved MCP host settings, not RouterOS configuration. First get_mcp_settings_schema and preview_mcp_settings; supply that revision and confirm=true. Backs up the config locally, saves atomically and arms a 30–600s in-process rollback (default 60s). Conflicts with another pending dashboard/tool edit are rejected. Verify configured values with get_mcp_settings, then confirm_mcp_settings before the deadline or rollback_mcp_settings. Never restart while pending: the rollback timer does not survive process exit. Restart-required settings are only fully activated after confirmation and a separate operator-controlled restart. Does not widen access scopes or change router addresses/credentials.",
    inputSchema: McpSettingsUpdateSchema.shape,
    handler: (args) => render(getMcpSettingsService().update(args)),
  }),
  defineTool({
    name: "confirm_mcp_settings",
    title: "Keep a Pending MCP Settings Change",
    noDevice: true,
    annotations: WRITE,
    description:
      "Keep the exact pending change created by update_mcp_settings after reading back its values. Cancels its rollback timer. Requires the current revision and pending_id; cannot confirm dashboard-owned, expired or superseded changes. Does not restart the MCP server or contact routers.",
    inputSchema: McpSettingsPendingSchema.shape,
    handler: (args) => render(getMcpSettingsService().finish(args, "confirm")),
  }),
  defineTool({
    name: "rollback_mcp_settings",
    title: "Revert a Pending MCP Settings Change",
    noDevice: true,
    annotations: WRITE,
    description:
      "Restore the host-side config backup for a still-pending update_mcp_settings change. Requires its pending_id and current revision. Refuses dashboard-owned transactions or changes that would overwrite newer configuration. Restores configured values only; no router changes, server restart or deletion of knowledge data.",
    inputSchema: McpSettingsPendingSchema.shape,
    handler: (args) => render(getMcpSettingsService().finish(args, "rollback")),
  }),
];
