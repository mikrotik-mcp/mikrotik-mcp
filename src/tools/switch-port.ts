/** Switch chip ports — `/interface ethernet switch port`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const VlanMode = z.enum(["disabled", "optional", "enabled", "secure"]);
const VlanHeader = z.enum(["leave-as-is", "always-strip", "add-if-missing"]);

export const switchPortTools: ToolModule = [
  defineTool({
    name: "list_switch_ports",
    title: "List Switch Chip Ports",
    annotations: READ,
    description:
      "List all switch chip ports (`/interface ethernet switch port print`) — the hardware-level " +
      "per-port VLAN configuration entries on RouterOS switch chips. " +
      "Use this to discover port names and their current vlan-mode, vlan-header, and " +
      "default-vlan-id (PVID) settings before updating them. " +
      "For a single port's full detail use get_switch_port; to change settings use update_switch_port. " +
      "Optional filters narrow results by partial port name or owning switch (e.g. 'switch1'). " +
      "Returns all matching port rows including VLAN mode, tag-header treatment, and PVID.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial port-name match"),
      switch_filter: z.string().optional().describe("Filter by owning switch, e.g. 'switch1'"),
    },
    async handler(a, ctx) {
      ctx.info("Listing switch ports");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.switch_filter) filters.push(`switch="${a.switch_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface ethernet switch port print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No switch ports found matching the criteria."
        : `SWITCH PORTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_switch_port",
    title: "Get Switch Chip Port Details",
    annotations: READ,
    description:
      "Retrieve detailed settings for a single switch chip port (`/interface ethernet switch port print detail`) " +
      "by port name (e.g. 'ether1') or RouterOS '.id' from list_switch_ports. " +
      "Use this when you need the full attribute set of one port before updating it; " +
      "for all ports use list_switch_ports; to change settings use update_switch_port. " +
      "Returns a detailed view of vlan-mode, vlan-header, default-vlan-id, and force-vlan-id for the matched port.",
    inputSchema: {
      port_id: z.string().describe("Port name (e.g. 'ether1') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting switch port details: port_id=${a.port_id}`);
      let result = await executeMikrotikCommand(
        `/interface ethernet switch port print detail where .id="${a.port_id}"`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/interface ethernet switch port print detail where name="${a.port_id}"`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `Switch port '${a.port_id}' not found.`
        : `SWITCH PORT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_switch_port",
    title: "Update Switch Chip Port VLAN Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Set hardware VLAN settings on a switch chip port (`/interface ethernet switch port set`) — " +
      "controls how the port handles 802.1Q VLAN tags at the chip level (PVID, enforcement mode, tag treatment). " +
      "To inspect current settings first use get_switch_port or list_switch_ports. " +
      "port_id accepts a port name (e.g. 'ether1') or the '.id' returned by list_switch_ports. " +
      "Returns the updated port's full detail on success.\n\n" +
      "Notes:\n" +
      "    vlan_mode: 'disabled' (ignore VLAN table), 'optional', 'enabled', or\n" +
      "        'secure' (strict VLAN table enforcement).\n" +
      "    vlan_header: how the egress VLAN tag is handled — 'leave-as-is',\n" +
      "        'always-strip', or 'add-if-missing'.\n" +
      "    default_vlan_id: PVID for untagged ingress ('auto', 'none', or a number).",
    inputSchema: {
      unset: unsetProperties,
      port_id: z.string().describe("Port name (e.g. 'ether1') or RouterOS '.id'"),
      default_vlan_id: z.string().optional().describe("PVID: 'auto', 'none', or a VLAN id number"),
      vlan_mode: VlanMode.optional(),
      vlan_header: VlanHeader.optional(),
      force_vlan_id: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating switch port: port_id=${a.port_id}`);
      const selector = a.port_id.startsWith("*") ? `.id="${a.port_id}"` : `name="${a.port_id}"`;
      const base = `/interface ethernet switch port set [find ${selector}]`;
      const cmd = new Cmd(base)
        .opt("default-vlan-id", a.default_vlan_id)
        .opt("vlan-mode", a.vlan_mode)
        .opt("vlan-header", a.vlan_header)
        .bool("force-vlan-id", a.force_vlan_id);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update switch port: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface ethernet switch port print detail where ${selector}`,
        ctx,
      );
      return `Switch port updated successfully:\n\n${details}`;
    },
  }),
];
