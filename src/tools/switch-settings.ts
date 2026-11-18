/** Switch chip settings — `/interface ethernet switch`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const switchSettingsTools: ToolModule = [
  defineTool({
    name: "list_switches",
    title: "List Hardware Switch Chips",
    annotations: READ,
    description:
      "Lists hardware switch chips (`/interface ethernet switch`). " +
      "Use to discover switch chip names and types present on the device before targeting a chip with get_switch or update_switch. " +
      "Accepts optional `name_filter` and `type_filter` for partial-match filtering. " +
      "Returns chip name, type, and mirror/flow-control configuration for each matching entry; returns an empty message if none match.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial switch-name match"),
      type_filter: z.string().optional().describe("Partial switch-type match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing switches");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.type_filter) filters.push(`type~${quoted(a.type_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface ethernet switch print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No switches found matching the criteria."
        : `SWITCHES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_switch",
    title: "Get Hardware Switch Chip Details",
    annotations: READ,
    description:
      "Fetches full detail for a single hardware switch chip (`/interface ethernet switch print detail`). " +
      "Use to inspect the current cpu-flow-control flag and mirror-source, mirror-target, and mirror-egress settings before modifying them with update_switch. " +
      "`switch_id` accepts the chip name (e.g. 'switch1') or the RouterOS `.id` returned by list_switches — tries `.id` lookup first, then falls back to name lookup. " +
      "Returns detailed chip settings or a not-found message.",
    inputSchema: {
      switch_id: z.string().describe("Switch name (e.g. 'switch1') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting switch details: switch_id=${a.switch_id}`);
      let result = await executeMikrotikCommand(
        `/interface ethernet switch print detail where .id=${quoted(a.switch_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/interface ethernet switch print detail where name=${quoted(a.switch_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `Switch '${a.switch_id}' not found.`
        : `SWITCH DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_switch",
    title: "Update Hardware Switch Chip Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies settings on a hardware switch chip (`/interface ethernet switch set`) — " +
      "use to configure port mirroring (SPAN) or CPU flow control on the chip itself. " +
      "`switch_id` accepts the chip name (e.g. 'switch1') or the RouterOS `.id` returned by list_switches.\n\n" +
      "cpu_flow_control: pauses CPU-bound traffic when the CPU port is congested.\n" +
      "mirror_source / mirror_target: span a port's traffic to a monitor port or 'cpu' (chip-dependent availability).\n" +
      "mirror_egress: egress mirror source port on newer chips.\n" +
      "Pass mirror_source / mirror_target / mirror_egress='none' to disable mirroring.\n\n" +
      "Returns updated switch details on success.",
    inputSchema: {
      unset: unsetProperties,
      switch_id: z.string().describe("Switch name (e.g. 'switch1') or RouterOS '.id'"),
      name: z.string().optional().describe("Rename the switch"),
      cpu_flow_control: z.boolean().optional(),
      mirror_source: z.string().optional().describe("Source port to mirror, or 'none'"),
      mirror_target: z.string().optional().describe("Monitor port, 'cpu', or 'none'"),
      mirror_egress: z
        .string()
        .optional()
        .describe("Egress mirror source port (newer chips), or 'none'"),
      mirror_egress_target: z
        .string()
        .optional()
        .describe("Egress mirror target port (88E6393X/88E6191X/88E6190 chips), or 'none'"),
      switch_all_ports: z
        .boolean()
        .optional()
        .describe("Switch all ports together (RB450G/RB435G/RB850Gx2 only)"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating switch: switch_id=${a.switch_id}`);
      const selector = a.switch_id.startsWith("*")
        ? `.id=${quoted(a.switch_id)}`
        : `name=${quoted(a.switch_id)}`;
      const base = `/interface ethernet switch set [find ${selector}]`;
      const cmd = new Cmd(base)
        .opt("name", a.name)
        .bool("cpu-flow-control", a.cpu_flow_control)
        .opt("mirror-source", a.mirror_source)
        .opt("mirror-target", a.mirror_target)
        .opt("mirror-egress", a.mirror_egress)
        .opt("mirror-egress-target", a.mirror_egress_target)
        .bool("switch-all-ports", a.switch_all_ports);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update switch: ${result}`;

      const detailSelector = a.name ? `name=${quoted(a.name)}` : selector;
      const details = await executeMikrotikCommand(
        `/interface ethernet switch print detail where ${detailSelector}`,
        ctx,
      );
      return `Switch updated successfully:\n\n${details}`;
    },
  }),
];
