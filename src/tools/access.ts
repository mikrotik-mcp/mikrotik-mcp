/**
 * Access-scope introspection and self-narrowing.
 *
 * Both tools are `noDevice` — they never touch a router. `narrow_access_scope`
 * is a WRITE against the server's own session state, and it is deliberately
 * one-way: it can only ever remove permissions (see `narrowScope` in
 * `src/core/access.ts`). There is intentionally no widening tool; the ceiling
 * is the operator's configuration and nothing reachable by the model can raise
 * it.
 */
import { z } from "zod";
import { RISK_ORDER, getAccessPolicy, narrowSession, recentDenials } from "../core/access";
import type { AccessScope } from "../core/access";
import { READ, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";

function renderScope(scope: AccessScope): string[] {
  const lines: string[] = [];
  lines.push(`  max risk    : ${scope.maxRisk ?? "(no ceiling)"}`);
  lines.push(
    `  devices     : ${scope.devices && scope.devices.length > 0 ? scope.devices.join(", ") : "(all configured)"}`,
  );
  if (scope.denyDevices && scope.denyDevices.length > 0) {
    lines.push(`  denied devs : ${scope.denyDevices.join(", ")}`);
  }
  lines.push(
    `  tools       : ${scope.tools && scope.tools.length > 0 ? scope.tools.join(", ") : "(all)"}`,
  );
  if (scope.denyTools && scope.denyTools.length > 0) {
    lines.push(`  denied tools: ${scope.denyTools.join(", ")}`);
  }
  lines.push(
    `  expires     : ${scope.expiresAt ? new Date(scope.expiresAt).toISOString() : "(never)"}`,
  );
  if (scope.label) lines.push(`  label       : ${scope.label}`);
  return lines;
}

export const accessTools: ToolModule = [
  defineTool({
    name: "get_access_scope",
    title: "Show the Active Access Scope",
    annotations: READ,
    noDevice: true,
    description:
      "Reports the access scope currently enforced on this session: the maximum risk tier that " +
      "may be invoked, which devices may be targeted, which tool-name globs are allowed or " +
      "denied, and when the scope expires. Also lists recent DENIED calls with the rule that " +
      "blocked each one. Call this after an 'Access denied' result to see exactly what the " +
      "boundary is instead of guessing, and before attempting a batch of writes to confirm they " +
      "are permitted. Contacts no device.",
    inputSchema: {
      denials: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("How many recent denials to include (default 10, 0 to omit)."),
    },
    handler(a) {
      const policy = getAccessPolicy();
      if (!policy.enabled) {
        return (
          "ACCESS SCOPE: not enforced.\n\n" +
          "Every tool may be called on every configured device. To enforce a scope, set " +
          "`access.enabled` (with `access.maxRisk` / `access.devices` / `access.denyTools`) in " +
          "the server configuration, or call narrow_access_scope to restrict this session."
        );
      }
      const lines = ["ACCESS SCOPE: ENFORCED", "", ...renderScope(policy.scope)];

      const want = a.denials ?? 10;
      if (want > 0) {
        const list = recentDenials(want);
        lines.push("", `RECENT DENIALS (${list.length}):`);
        if (list.length === 0) {
          lines.push("  none — no call has been blocked by this scope.");
        } else {
          for (const d of list) {
            lines.push(
              `  ${new Date(d.ts).toISOString()}  ${d.tool} (${d.risk})` +
                `${d.device ? ` on ${d.device}` : ""} — blocked by '${d.rule}' rule`,
            );
          }
        }
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "narrow_access_scope",
    title: "Narrow This Session's Access Scope",
    annotations: WRITE_IDEMPOTENT,
    noDevice: true,
    description:
      "Voluntarily restricts what THIS session may do for the rest of its life — lower the risk " +
      "ceiling, limit which devices may be targeted, restrict tool names, or set an expiry. " +
      "Useful before handing control to an unattended loop, or to self-limit to read-only while " +
      "investigating a production issue. This operation is STRICTLY ONE-WAY: every field can " +
      "only make the scope narrower, and there is no tool that widens it again — only the " +
      "operator's server configuration sets the ceiling, and restarting the session is the only " +
      "way back. Values that would widen the scope are silently clamped to the current one. " +
      "Contacts no device.",
    inputSchema: {
      max_risk: z
        .enum(RISK_ORDER)
        .optional()
        .describe(
          "Highest risk tier to allow from now on. Ignored if it is higher than the current " +
            "ceiling. READ is the most restrictive.",
        ),
      devices: z
        .array(z.string())
        .optional()
        .describe("Restrict to these device keys (intersected with any current restriction)."),
      deny_devices: z
        .array(z.string())
        .optional()
        .describe("Device keys to forbid outright (added to any existing denials)."),
      tools: z
        .array(z.string())
        .optional()
        .describe("Tool-name globs to permit, e.g. ['list_*','get_*','diagnose']."),
      deny_tools: z
        .array(z.string())
        .optional()
        .describe("Tool-name globs to forbid (added to any existing denials)."),
      expires_in_minutes: z
        .number()
        .int()
        .positive()
        .max(10_080)
        .optional()
        .describe("Expire the scope after this many minutes (max 7 days)."),
      label: z.string().optional().describe("A note recorded with the scope, shown in denials."),
    },
    handler(a) {
      const requested: AccessScope = {
        maxRisk: a.max_risk,
        devices: a.devices,
        denyDevices: a.deny_devices,
        tools: a.tools,
        denyTools: a.deny_tools,
        expiresAt:
          a.expires_in_minutes === undefined
            ? undefined
            : Date.now() + a.expires_in_minutes * 60_000,
        label: a.label,
      };
      const effective = narrowSession(requested);
      return [
        "Access scope narrowed. Now in force for this session:",
        "",
        ...renderScope(effective),
        "",
        "This cannot be undone from inside the session — widening requires the operator's " +
          "server configuration and a restart.",
      ].join("\n");
    },
  }),
];
