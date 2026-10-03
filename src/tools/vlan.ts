/**
 * VLAN interfaces — `/interface vlan`.
 *
 * This module is the canonical example of the tool-module pattern every other
 * scope follows: a flat array of `defineTool(...)` declarations, each with a Zod
 * input schema, a risk preset, and a handler that builds a RouterOS command via
 * `Cmd` and runs it through `executeMikrotikCommand`.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const ArpMode = z.enum(["enabled", "disabled", "proxy-arp", "reply-only"]);
const LoopProtect = z.enum(["default", "on", "off"]);

export const vlanTools: ToolModule = [
  defineTool({
    name: "create_vlan_interface",
    title: "Create VLAN Interface",
    annotations: WRITE,
    description:
      "Creates an 802.1Q VLAN sub-interface (`/interface vlan`) on a specified parent physical or bridge interface." +
      " This creates only a VLAN sub-interface, NOT bridge port membership, PVID, firewall isolation or SSID mapping. For a bridge member use the bridge as routed parent; read get_vlan_segmentation_guide before migration. Set `use_service_tag=true` for 802.1ad QinQ double-tagging." +
      " For listing existing VLAN interfaces use `list_vlan_interfaces`; for editing an existing VLAN use `update_vlan_interface`." +
      " Returns the created interface's full detail including its name, which is the identifier accepted by `get_vlan_interface`, `update_vlan_interface`, and `remove_vlan_interface`." +
      " ARP mode accepts: enabled (default), disabled, proxy-arp, reply-only.",
    inputSchema: {
      name: interfaceName("Name for the new VLAN interface, e.g. 'vlan100'"),
      vlan_id: z.number().int().min(1).max(4094).describe("802.1Q VLAN ID (1-4094)"),
      interface: z.string().describe("Parent interface, e.g. 'ether1' or 'bridge'"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      mtu: z.number().int().optional(),
      use_service_tag: z.boolean().default(false).describe("Use 802.1ad service tag (QinQ)"),
      arp: ArpMode.default("enabled"),
      arp_timeout: z.string().optional(),
      loop_protect: LoopProtect.optional().describe("Loop protection: default, on, off"),
      loop_protect_disable_time: z
        .string()
        .optional()
        .describe("Time to disable interface on loop detection, e.g. '5m' (0 = forever)"),
      loop_protect_send_interval: z
        .string()
        .optional()
        .describe("Interval between loop-protect probe packets, e.g. '5s'"),
    },
    async handler(a, ctx) {
      ctx.info(
        `Creating VLAN interface: name=${a.name}, vlan_id=${a.vlan_id}, interface=${a.interface}`,
      );
      const cmd = new Cmd("/interface vlan add")
        .set("name", a.name)
        .set("vlan-id", a.vlan_id)
        .set("interface", a.interface)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .opt("mtu", a.mtu)
        .flag("use-service-tag", a.use_service_tag)
        .raw(a.arp !== "enabled" ? `arp=${a.arp}` : null)
        .opt("arp-timeout", a.arp_timeout)
        .opt("loop-protect", a.loop_protect)
        .opt("loop-protect-disable-time", a.loop_protect_disable_time)
        .opt("loop-protect-send-interval", a.loop_protect_send_interval)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create VLAN interface: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface vlan print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `VLAN interface created successfully:\n\n${details}`
        : "VLAN interface creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_vlan_interfaces",
    title: "List VLAN Interfaces",
    annotations: READ,
    description:
      "Lists all 802.1Q VLAN sub-interfaces (`/interface vlan print`) with optional filters by name substring, VLAN ID, parent interface, or disabled state." +
      " Use to discover existing VLANs and obtain interface names for `get_vlan_interface`, `update_vlan_interface`, or `remove_vlan_interface`." +
      " For a single interface's full property detail use `get_vlan_interface`." +
      " Returns a table of matching VLAN interfaces, or a not-found message when no entries match the filters.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
      vlan_id_filter: z.number().int().optional(),
      interface_filter: z.string().optional().describe("Exact parent interface name"),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing VLAN interfaces");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.vlan_id_filter !== undefined) filters.push(`vlan-id=${a.vlan_id_filter}`);
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/interface vlan print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No VLAN interfaces found matching the criteria."
        : `VLAN INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_vlan_interface",
    title: "Get VLAN Interface Details",
    annotations: READ,
    description:
      'Returns full detail for a single named VLAN interface (`/interface vlan print detail where name="..."`), including VLAN ID, parent interface, ARP mode, MTU, and running state.' +
      " Use when you already know the exact interface name and need all properties." +
      " For searching across all VLANs or filtering by parent interface or VLAN ID use `list_vlan_interfaces`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting VLAN interface details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface vlan print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `VLAN interface '${a.name}' not found.`
        : `VLAN INTERFACE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_vlan_interface",
    title: "Update VLAN Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      'Modifies properties of an existing VLAN sub-interface (`/interface vlan set [find name="..."]`).' +
      " Accepts any subset of the create parameters; omit fields to leave them unchanged." +
      " Supply the current `name` from `list_vlan_interfaces` or `get_vlan_interface`; use `new_name` to rename the interface." +
      " For creating a new VLAN interface use `create_vlan_interface`; to permanently delete use `remove_vlan_interface`." +
      " Returns the updated interface's full detail after applying the change." +
      " ARP mode accepts: enabled, disabled, proxy-arp, reply-only.",
    inputSchema: {
      name: z.string().describe("Current name of the VLAN interface to update"),
      new_name: interfaceName().optional().describe("Rename the interface to this (no spaces)."),
      vlan_id: z.number().int().min(1).max(4094).optional(),
      interface: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      mtu: z.number().int().optional(),
      use_service_tag: z.boolean().optional(),
      arp: ArpMode.optional(),
      arp_timeout: z.string().optional(),
      loop_protect: LoopProtect.optional().describe("Loop protection: default, on, off"),
      loop_protect_disable_time: z
        .string()
        .optional()
        .describe("Time to disable interface on loop detection, e.g. '5m' (0 = forever)"),
      loop_protect_send_interval: z
        .string()
        .optional()
        .describe("Interval between loop-protect probe packets, e.g. '5s'"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating VLAN interface: name=${a.name}`);
      const cmd = new Cmd(`/interface vlan set [find name="${a.name}"]`)
        .opt("name", a.new_name)
        .opt("vlan-id", a.vlan_id)
        .opt("interface", a.interface)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .opt("mtu", a.mtu)
        .bool("use-service-tag", a.use_service_tag)
        .opt("arp", a.arp)
        .opt("arp-timeout", a.arp_timeout)
        .opt("loop-protect", a.loop_protect)
        .opt("loop-protect-disable-time", a.loop_protect_disable_time)
        .opt("loop-protect-send-interval", a.loop_protect_send_interval)
        .build();

      // No updates were supplied -> the command would just be the `set [find ...]` stem.
      if (!cmd.includes("=", cmd.indexOf("]"))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update VLAN interface: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/interface vlan print detail where name="${target}"`,
        ctx,
      );
      return `VLAN interface updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_vlan_interface",
    title: "Remove VLAN Interface",
    annotations: DESTRUCTIVE,
    description:
      'Permanently deletes a VLAN sub-interface (`/interface vlan remove [find name="..."]`) after confirming it exists via a count-only check.' +
      " Supply the interface `name` from `list_vlan_interfaces` or `get_vlan_interface`." +
      " Removing a VLAN interface also removes IP addresses assigned to it; firewall rules and other configuration that reference it by name are not automatically deleted and will remain as orphaned, ineffective entries." +
      " To disable a VLAN temporarily without deleting it use `update_vlan_interface` with `disabled=true`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing VLAN interface: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface vlan print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `VLAN interface '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface vlan remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove VLAN interface: ${result}`;
      return `VLAN interface '${a.name}' removed successfully.`;
    },
  }),
];
