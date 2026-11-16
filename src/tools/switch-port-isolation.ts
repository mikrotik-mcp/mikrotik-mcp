/** Switch port isolation — `/interface ethernet switch port-isolation`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

/** Build the RouterOS `[find ...]` selector for a port (by name) or `.id`. */
function selectorFor(id: string): string {
  return id.startsWith("*") ? `.id="${id}"` : `port="${id}"`;
}

export const switchPortIsolationTools: ToolModule = [
  defineTool({
    name: "add_switch_port_isolation",
    title: "Add Switch Port Isolation Entry",
    annotations: WRITE,
    description:
      "Add a port-isolation entry (`/interface ethernet switch port-isolation add`) — " +
      "restricts which switch-chip ports a given source port may forward traffic to, " +
      "implementing hardware-level private-VLAN-style isolation without IP rules.\n\n" +
      "Use this when you need to prevent a switch port from communicating with all " +
      "other ports except a specific allowed set (e.g. uplink only). This is a " +
      "switch-chip hardware rule; for Layer-3 traffic filtering use the firewall tools " +
      "(create_filter_rule, create_nat_rule). For VLAN segmentation use create_vlan_interface.\n\n" +
      "Returns the created entry's details including its `.id` (use list_switch_port_isolation " +
      "to obtain `.id` values of existing entries).\n\n" +
      "Args:\n" +
      "    port: source port to isolate, e.g. 'ether1'.\n" +
      "    forwarding_override_ports: comma-separated list of the ONLY ports this port " +
      "        may forward to — all others are blocked in hardware.",
    inputSchema: {
      port: z.string().describe("Source port to isolate, e.g. 'ether1'"),
      forwarding_override_ports: z.string().describe("Comma-separated allowed destination ports"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding switch port-isolation: port=${a.port}`);
      const cmd = new Cmd("/interface ethernet switch port-isolation add")
        .set("port", a.port)
        .set("forwarding-override-ports", a.forwarding_override_ports)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add switch port-isolation: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation print detail where port="${a.port}"`,
        ctx,
      );
      return details.trim()
        ? `Switch port-isolation added successfully:\n\n${details}`
        : "Switch port-isolation addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_switch_port_isolation",
    title: "List Switch Port Isolation Entries",
    annotations: READ,
    description:
      "List all switch port-isolation entries (`/interface ethernet switch port-isolation print`) — " +
      "shows every source port that has a forwarding-override configured on the switch chip, " +
      "including its allowed destination ports and `.id`.\n\n" +
      "Use this to audit current port isolation policy or to retrieve `.id` values " +
      "needed by get_switch_port_isolation, update_switch_port_isolation, or " +
      "remove_switch_port_isolation. For a single entry's full detail use get_switch_port_isolation.\n\n" +
      "Returns a table of all matching entries; optionally filter by partial port name via port_filter.",
    inputSchema: {
      port_filter: z.string().optional().describe("Partial source-port match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing switch port-isolation entries");
      const filters: string[] = [];
      if (a.port_filter) filters.push(`port~"${a.port_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No switch port-isolation entries found matching the criteria."
        : `SWITCH PORT-ISOLATION:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_switch_port_isolation",
    title: "Get Switch Port Isolation Entry",
    annotations: READ,
    description:
      "Retrieve detail for a single switch port-isolation entry " +
      "(`/interface ethernet switch port-isolation print detail`) by source port name or RouterOS `.id`.\n\n" +
      "Use this to inspect the forwarding-override-ports of one specific port in full detail. " +
      "For all entries use list_switch_port_isolation. The `.id` argument (e.g. '*1') " +
      "comes from list_switch_port_isolation; a plain port name (e.g. 'ether1') is also accepted.\n\n" +
      "Returns the full detail block for the matched entry, or a not-found message.",
    inputSchema: {
      isolation_id: z.string().describe("Source port name (e.g. 'ether1') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting switch port-isolation: isolation_id=${a.isolation_id}`);
      const result = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation print detail where ${selectorFor(a.isolation_id)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Switch port-isolation '${a.isolation_id}' not found.`
        : `SWITCH PORT-ISOLATION DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_switch_port_isolation",
    title: "Update Switch Port Isolation Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify an existing switch port-isolation entry (`/interface ethernet switch port-isolation set`) " +
      "— change the allowed forwarding-override-ports or comment without removing and recreating the entry.\n\n" +
      "isolation_id accepts either the source port name (e.g. 'ether1') or the RouterOS `.id` " +
      "(e.g. '*1') from list_switch_port_isolation. Only supplied fields are changed; " +
      'pass comment="" to clear the comment. To change which port is being isolated ' +
      "(the port field itself), use remove_switch_port_isolation then add_switch_port_isolation.\n\n" +
      "Returns the entry's updated detail block.",
    inputSchema: {
      unset: unsetProperties,
      isolation_id: z.string().describe("Source port name or RouterOS '.id'"),
      forwarding_override_ports: z
        .string()
        .optional()
        .describe("Comma-separated allowed destination ports"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating switch port-isolation: isolation_id=${a.isolation_id}`);
      const selector = selectorFor(a.isolation_id);
      const base = `/interface ethernet switch port-isolation set [find ${selector}]`;
      const cmd = new Cmd(base).opt("forwarding-override-ports", a.forwarding_override_ports);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update switch port-isolation: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation print detail where ${selector}`,
        ctx,
      );
      return `Switch port-isolation updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_switch_port_isolation",
    title: "Remove Switch Port Isolation Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a switch port-isolation entry (`/interface ethernet switch port-isolation remove`) " +
      "— restores the port's default forwarding behaviour (no forwarding restriction on the switch chip).\n\n" +
      "isolation_id accepts either the source port name (e.g. 'ether1') or the RouterOS `.id` " +
      "(e.g. '*1') from list_switch_port_isolation. Performs a count-only existence check before " +
      "removal and returns a not-found message if the entry does not exist. To add a new isolation rule " +
      "afterwards use add_switch_port_isolation; to only modify allowed ports use update_switch_port_isolation.",
    inputSchema: {
      isolation_id: z.string().describe("Source port name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing switch port-isolation: isolation_id=${a.isolation_id}`);
      const selector = selectorFor(a.isolation_id);
      const count = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `Switch port-isolation '${a.isolation_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ethernet switch port-isolation remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove switch port-isolation: ${result}`;
      return `Switch port-isolation '${a.isolation_id}' removed successfully.`;
    },
  }),
];
