/** Bounded, secret-free MCP configuration edits. Never changes router targets or access ceilings. */
import { z } from "zod";
import {
  DashboardConfigSchema,
  getConfigSource,
  McpServerSettingsSchema,
  MemoryConfigSchema,
  MikrotikConfigSchema,
  SSHConfigSchema,
} from "../config";
import { getConfigAdmin } from "../observability/config-admin";
import type { ConfigAdmin } from "../observability/config-admin";
import { diffLines } from "./diff";
import { getConfig } from "./runtime";

// Remove defaults BEFORE making fields optional: an omitted patch field must
// preserve the current value, not silently install its schema default.
export const McpSettingsPatchSchema = z
  .object({
    mcp: z
      .object({
        toolPageSize: McpServerSettingsSchema.shape.toolPageSize.removeDefault().optional(),
        appViews: McpServerSettingsSchema.shape.appViews.removeDefault().optional(),
        capabilityGating: McpServerSettingsSchema.shape.capabilityGating.removeDefault().optional(),
      })
      .strict()
      .optional(),
    ssh: z
      .object({
        keepAlive: SSHConfigSchema.shape.keepAlive.removeDefault().optional(),
        keepAliveInterval: SSHConfigSchema.shape.keepAliveInterval.removeDefault().optional(),
        idleTimeout: SSHConfigSchema.shape.idleTimeout.removeDefault().optional(),
      })
      .strict()
      .optional(),
    dashboard: z
      .object({
        maxEvents: DashboardConfigSchema.shape.maxEvents.removeDefault().optional(),
        captureBody: DashboardConfigSchema.shape.captureBody.removeDefault().optional(),
        redactInput: z.literal(true).optional().describe("May enable redaction, never disable it."),
        maxBodyBytes: DashboardConfigSchema.shape.maxBodyBytes.removeDefault().optional(),
        feedLimit: DashboardConfigSchema.shape.feedLimit.removeDefault().optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        enabled: MemoryConfigSchema.shape.enabled.removeDefault().optional(),
      })
      .strict()
      .optional(),
    disableUpdateCheck: MikrotikConfigSchema.shape.disableUpdateCheck.removeDefault().optional(),
  })
  .strict();

export const McpSettingsUpdateSchema = z
  .object({
    changes: McpSettingsPatchSchema,
    revision: z
      .string()
      .length(64)
      .describe("Current revision from get_mcp_settings or preview_mcp_settings."),
    confirm: z.literal(true).describe("Only set after the user authorizes these exact changes."),
    rollback_seconds: z.number().int().min(30).max(600).default(60),
  })
  .strict();

export const McpSettingsPendingSchema = z
  .object({
    pending_id: z.string().min(1),
    revision: z
      .string()
      .length(64)
      .describe("Revision returned by update_mcp_settings or get_mcp_settings."),
  })
  .strict();

const BOUNDARY =
  "Only the listed fields are editable. Devices, credentials, file paths, listeners, access, readOnly, tools and service probe allowlists remain operator-managed. No router is contacted.";

function settings(cfg: ReturnType<typeof getConfig>) {
  return {
    mcp: {
      toolPageSize: cfg.mcp.toolPageSize,
      appViews: cfg.mcp.appViews,
      capabilityGating: cfg.mcp.capabilityGating,
    },
    ssh: {
      keepAlive: cfg.ssh.keepAlive,
      keepAliveInterval: cfg.ssh.keepAliveInterval,
      idleTimeout: cfg.ssh.idleTimeout,
    },
    dashboard: {
      maxEvents: cfg.dashboard.maxEvents,
      captureBody: cfg.dashboard.captureBody,
      redactInput: cfg.dashboard.redactInput,
      maxBodyBytes: cfg.dashboard.maxBodyBytes,
      feedLimit: cfg.dashboard.feedLimit,
    },
    memory: { enabled: cfg.memory.enabled },
    disableUpdateCheck: cfg.disableUpdateCheck,
  };
}

/** Uses the same injected state machine as the dashboard; tests need no server, SSH or real files. */
export function createMcpSettingsService(deps: {
  admin: ConfigAdmin;
  getConfig: typeof getConfig;
  source: typeof getConfigSource;
}) {
  let owned: { id: string; expiresAt: number | null } | null = null;
  const read = () => {
    const id = deps.admin.pendingId();
    const source = deps.source();
    return {
      revision: deps.admin.revision(),
      settings: settings(deps.getConfig()),
      pending: id
        ? { id, owned: id === owned?.id, expiresAt: id === owned?.id ? owned.expiresAt : null }
        : null,
      persistence: {
        path: source.path,
        fromFile: source.fromFile,
        note: source.fromFile
          ? "Saved to the source config file; CLI/environment overrides may still take precedence on restart."
          : "Saved to the default config file. Start with --config pointing to the returned path to reuse it; environment/CLI overrides may still take precedence.",
      },
      boundary: BOUNDARY,
    };
  };

  const prepare = (raw: unknown) => {
    const parsed = McpSettingsPatchSchema.safeParse(raw);
    // Never echo an invalid value (it might be a credential sent to a forbidden field).
    if (!parsed.success)
      throw new Error(
        "Invalid or protected MCP setting. Use get_mcp_settings_schema for allowed fields and values.",
      );
    const changes = parsed.data;
    const current = deps.getConfig();
    const next = MikrotikConfigSchema.parse({
      ...current,
      ...changes,
      mcp: { ...current.mcp, ...changes.mcp },
      ssh: { ...current.ssh, ...changes.ssh },
      dashboard: { ...current.dashboard, ...changes.dashboard },
      memory: { ...current.memory, ...changes.memory },
    });
    if (changes.dashboard?.captureBody === true && !next.dashboard.redactInput)
      throw new Error("Enabling body capture also requires dashboard.redactInput=true.");
    const before = settings(current);
    const after = settings(next);
    const changedPaths: string[] = [];
    for (const key of ["mcp", "ssh", "dashboard", "memory"] as const) {
      for (const [field, value] of Object.entries(after[key])) {
        if (value !== (before[key] as Record<string, unknown>)[field])
          changedPaths.push(`${key}.${field}`);
      }
    }
    if (before.disableUpdateCheck !== after.disableUpdateCheck)
      changedPaths.push("disableUpdateCheck");
    const restartRequired = changedPaths.some(
      (path) =>
        path.startsWith("mcp.") || path.startsWith("dashboard.") || path === "disableUpdateCheck",
    );
    const diff = diffLines(JSON.stringify(before, null, 2), JSON.stringify(after, null, 2), {
      fromLabel: "current MCP settings",
      toLabel: "proposed MCP settings",
    });
    return {
      next,
      preview: {
        revision: deps.admin.revision(),
        changedPaths,
        before,
        after,
        summary: diff.summary,
        unified: diff.unified,
        restartRequired,
        activation: [
          "Memory enable/disable is checked on the next memory operation; disabling does not delete stored knowledge.",
          "SSH pool changes affect subsequent calls/new connections and newly armed idle timers; existing connections are not forcibly closed.",
          "MCP presentation, dashboard recorder and startup update-check settings require a server restart for full activation. Confirm the change before restarting; an in-process rollback timer cannot survive process exit.",
        ],
      },
    };
  };

  const checkWrite = (revision: string) => {
    if (deps.getConfig().readOnly)
      throw new Error("MCP settings writes are disabled in read-only mode.");
    if (revision !== deps.admin.revision())
      throw new Error("MCP settings changed. Read and preview again before writing.");
  };

  return {
    read,
    schema: () => ({
      schema: z.toJSONSchema(McpSettingsPatchSchema, { target: "draft-2020-12" }),
      boundary: BOUNDARY,
    }),
    preview: (changes: unknown) => prepare(changes).preview,
    update: (raw: unknown) => {
      const input = McpSettingsUpdateSchema.safeParse(raw);
      if (!input.success)
        throw new Error(
          "Invalid settings update. A current revision, allowed changes, confirm=true and 30–600 second rollback window are required.",
        );
      checkWrite(input.data.revision);
      if (deps.admin.pendingId())
        throw new Error(
          "Another configuration change is pending. Confirm or roll back its owning workflow first.",
        );
      const { next, preview } = prepare(input.data.changes);
      if (!preview.changedPaths.length) return { applied: false, ...preview, ...read() };
      const applied = deps.admin.applyConfig(next, input.data.rollback_seconds * 1000);
      owned = { id: applied.pendingId, expiresAt: applied.expiresAt };
      return { applied: true, ...preview, ...applied, ...read() };
    },
    finish: (raw: unknown, action: "confirm" | "rollback") => {
      const result = McpSettingsPendingSchema.safeParse(raw);
      if (!result.success) throw new Error("A pending_id and current revision are required.");
      const input = result.data;
      checkWrite(input.revision);
      if (!owned || owned.id !== input.pending_id || deps.admin.pendingId() !== owned.id)
        throw new Error(
          "This transaction is not pending in MCP settings. It may have expired or belong to the dashboard.",
        );
      const ok =
        action === "confirm" ? deps.admin.keepConfig(owned.id) : deps.admin.rollback(owned.id);
      if (!ok) throw new Error("Configuration changed before confirmation; read settings again.");
      owned = null;
      return { action, ok, ...read() };
    },
  };
}

let service: ReturnType<typeof createMcpSettingsService> | undefined;

export function getMcpSettingsService() {
  return (service ??= createMcpSettingsService({
    admin: getConfigAdmin(),
    getConfig,
    source: getConfigSource,
  }));
}
