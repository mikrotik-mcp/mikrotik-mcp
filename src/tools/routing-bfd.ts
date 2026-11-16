/** Bidirectional Forwarding Detection — `/routing bfd` (RouterOS v7). */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  yesno,
  whereClause,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
} from "../core/routeros";

const UNSUPPORTED =
  "BFD is not available on this device (requires RouterOS v7 with the routing package).";

export const routingBfdTools: ToolModule = [
  // ── Configuration ─────────────────────────────────────────────────────────
  defineTool({
    name: "list_bfd_configurations",
    title: "List BFD Configurations",
    annotations: READ,
    description:
      "Lists all BFD timer-profile entries (`/routing bfd configuration`) — each entry binds min-rx/min-tx " +
      "intervals and a detection multiplier to one or more interfaces in a VRF, controlling how fast BFD detects " +
      "a link failure so routing protocols (OSPF/BGP) can tear down sessions far faster than their own hold timers. " +
      "Requires RouterOS v7 with the routing package. To see live BFD neighbor state use `list_bfd_sessions`. " +
      "Returns all configuration entries with full detail.",
    async handler(_a, ctx) {
      ctx.info("Listing BFD configurations");
      const result = await executeMikrotikCommand("/routing bfd configuration print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BFD configurations found." : `BFD CONFIGURATIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_bfd_configuration",
    title: "Add BFD Configuration",
    annotations: WRITE,
    description:
      "Creates a BFD timer-profile entry (`/routing bfd configuration add`) that binds sub-second " +
      "failure-detection parameters to an interface or interface-list in a VRF. `interfaces` names the " +
      "interface or interface-list where BFD runs; `min_rx`/`min_tx` set the desired minimum receive/transmit " +
      'intervals (e.g. "200ms"); `multiplier` sets how many missed packets declare a session down ' +
      "(detection time ≈ interval × multiplier). To view existing configurations use `list_bfd_configurations`; " +
      "to see live session state use `list_bfd_sessions`. Returns the new entry's `.id`.",
    inputSchema: {
      interfaces: z.string().describe("Interface or interface-list name BFD runs on"),
      vrf: z.string().optional().describe("VRF (default 'main')"),
      min_rx: z.string().optional().describe('Desired min RX interval, e.g. "200ms"'),
      min_tx: z.string().optional().describe('Desired min TX interval, e.g. "200ms"'),
      multiplier: z.number().int().optional().describe("Detection multiplier, e.g. 5"),
      forbid_bfd: z.boolean().optional().describe("Forbid BFD on the matched interfaces"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding BFD configuration for ${a.interfaces}`);
      const cmd = new Cmd("/routing bfd configuration add")
        .set("interfaces", a.interfaces)
        .opt("vrf", a.vrf)
        .opt("min-rx", a.min_rx)
        .opt("min-tx", a.min_tx)
        .opt("multiplier", a.multiplier)
        .bool("forbid-bfd", a.forbid_bfd)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add BFD configuration: ${result}`;
      const t = result.trim();
      return t ? `BFD configuration added (id ${t}).` : "BFD configuration added successfully.";
    },
  }),

  defineTool({
    name: "update_bfd_configuration",
    title: "Update BFD Configuration",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing BFD timer-profile entry (`/routing bfd configuration set`) by its `.id` " +
      "(obtain from `list_bfd_configurations`). Adjusts `interfaces`, `vrf`, `min_rx`/`min_tx` intervals " +
      '(e.g. "200ms"), `multiplier`, `comment`, or `disabled` state. To toggle enabled state only use ' +
      "`set_bfd_configuration_enabled`. Returns the updated entry's full detail.",
    inputSchema: {
      unset: unsetProperties,
      config_id: z.string().describe('Configuration id, e.g. "*1"'),
      interfaces: z.string().optional(),
      vrf: z.string().optional(),
      min_rx: z.string().optional(),
      min_tx: z.string().optional(),
      multiplier: z.number().int().optional(),
      forbid_bfd: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating BFD configuration ${a.config_id}`);
      const base = `/routing bfd configuration set ${a.config_id}`;
      const cmd = new Cmd(base)
        .opt("interfaces", a.interfaces)
        .opt("vrf", a.vrf)
        .opt("min-rx", a.min_rx)
        .opt("min-tx", a.min_tx)
        .opt("multiplier", a.multiplier)
        .bool("forbid-bfd", a.forbid_bfd);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update BFD configuration: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing bfd configuration print detail where .id=${a.config_id}`,
        ctx,
      );
      return `BFD configuration updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_bfd_configuration",
    title: "Remove BFD Configuration",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a BFD timer-profile entry (`/routing bfd configuration remove`) by its `.id` " +
      "(obtain from `list_bfd_configurations`). Any BFD sessions driven by this configuration will stop. " +
      "To suspend BFD without deleting the configuration use `set_bfd_configuration_enabled`.",
    inputSchema: {
      config_id: z.string().describe('Configuration id, e.g. "*1"'),
    },
    async handler(a, ctx) {
      ctx.info(`Removing BFD configuration ${a.config_id}`);
      const result = await executeMikrotikCommand(
        `/routing bfd configuration remove ${a.config_id}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove BFD configuration: ${result}`;
      return `BFD configuration '${a.config_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_bfd_configuration_enabled",
    title: "Enable or Disable BFD Configuration",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables or disables a BFD configuration entry (`/routing bfd configuration set ... disabled=yes/no`) " +
      "by its `.id` (obtain from `list_bfd_configurations`). Use this to suspend BFD on specific interfaces " +
      "without removing the configuration. To change timer parameters use `update_bfd_configuration`; " +
      "to delete the entry permanently use `remove_bfd_configuration`.",
    inputSchema: {
      config_id: z.string().describe('Configuration id, e.g. "*1"'),
      enabled: z.boolean(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting BFD configuration ${a.config_id} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing bfd configuration set ${a.config_id} disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update BFD configuration: ${result}`;
      return `BFD configuration '${a.config_id}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),

  // ── Sessions (read-only) ──────────────────────────────────────────────────
  defineTool({
    name: "list_bfd_sessions",
    title: "List BFD Sessions",
    annotations: READ,
    description:
      "Lists live BFD neighbor sessions (`/routing bfd session print detail`) — shows each peer's state " +
      "(up/down), local/remote discriminators, and negotiated rx/tx intervals. Read-only runtime state; " +
      "use it to verify BFD is actually up before relying on fast failover for OSPF/BGP. Filter to only " +
      "up sessions with `up_only=true`. To manage the timer-profile entries that drive these sessions use " +
      "`list_bfd_configurations`.",
    inputSchema: {
      up_only: z.boolean().default(false).describe("Show only sessions currently up"),
    },
    async handler(a, ctx) {
      ctx.info("Listing BFD sessions");
      const filters: string[] = [];
      if (a.up_only) filters.push("status=up");
      const result = await executeMikrotikCommand(
        `/routing bfd session print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BFD sessions found." : `BFD SESSIONS:\n\n${result}`;
    },
  }),
];
