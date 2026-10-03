/**
 * Bridges — `/interface bridge`.
 *
 * Bridge CRUD plus the three child tables RouterOS hangs off a bridge: ports
 * (`/interface bridge port`), the learned MAC table (`/interface bridge host`),
 * and the VLAN table (`/interface bridge vlan`). Follows the canonical
 * tool-module pattern from `vlan.ts`.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const ProtocolMode = z.enum(["none", "rstp", "stp", "mstp"]);
const ArpMode = z.enum(["disabled", "enabled", "proxy-arp", "reply-only", "local-proxy-arp"]);
const EtherType = z.enum(["0x8100", "0x88a8", "0x9100"]);
const FrameTypes = z.enum([
  "admit-all",
  "admit-only-untagged-and-priority-tagged",
  "admit-only-vlan-tagged",
]);
const PortLearn = z.enum(["auto", "yes", "no"]);
const PortEdge = z.enum(["auto", "no", "yes", "no-discover", "yes-discover"]);
const PortPointToPoint = z.enum(["auto", "yes", "no"]);
const MulticastRouter = z.enum(["disabled", "permanent", "temporary-query"]);

export const bridgeTools: ToolModule = [
  defineTool({
    name: "create_bridge",
    title: "Create Bridge Interface",
    annotations: WRITE,
    description:
      "Creates a bridge interface (`/interface bridge`) — combines multiple interfaces into a Layer-2 switch domain. " +
      "For VLAN migration read get_vlan_segmentation_guide first. Stage a new bridge with filtering off; enable it LAST after VLAN membership and protected management access are ready. Set `protocol_mode` for STP/RSTP/MSTP spanning-tree. " +
      "For adding a member interface to an existing bridge use `add_bridge_port`; " +
      "for standalone 802.1Q VLAN sub-interfaces use `create_vlan_interface`. " +
      "Returns the created bridge's full detail including its `.id`.",
    inputSchema: {
      name: interfaceName("Name for the new bridge, e.g. 'bridge1'"),
      comment: z.string().optional(),
      vlan_filtering: z
        .boolean()
        .default(false)
        .describe("Enable 802.1Q VLAN filtering on the bridge"),
      protocol_mode: ProtocolMode.optional().describe("Spanning-tree protocol mode"),
      disabled: z.boolean().default(false),
      mtu: z.number().int().optional(),
      ageing_time: z.string().optional().describe("Host table entry timeout, e.g. '5m'"),
      arp: ArpMode.optional().describe("ARP resolution mode"),
      arp_timeout: z.string().optional().describe("ARP entry timeout, e.g. '30s' or 'auto'"),
      auto_mac: z
        .boolean()
        .optional()
        .describe("Automatically pick the bridge MAC from a member port"),
      admin_mac: z
        .string()
        .optional()
        .describe("Static bridge MAC address (requires auto_mac=false)"),
      priority: z.string().optional().describe("STP/RSTP bridge priority, e.g. '0x8000'"),
      ether_type: EtherType.optional().describe(
        "Service VLAN (S-tag) EtherType when VLAN filtering",
      ),
      pvid: z
        .number()
        .int()
        .min(1)
        .max(4094)
        .optional()
        .describe("Bridge-level default port VLAN ID"),
      frame_types: FrameTypes.optional().describe("Default accepted frame types for ports"),
      ingress_filtering: z
        .boolean()
        .optional()
        .describe("Default ingress VLAN filtering for ports"),
      dhcp_snooping: z.boolean().optional().describe("Enable DHCP snooping"),
      igmp_snooping: z.boolean().optional().describe("Enable IGMP/MLD snooping"),
      fast_forward: z.boolean().optional().describe("Enable Fast Forward optimization"),
      mvrp: z.boolean().optional().describe("Enable Multiple VLAN Registration Protocol"),
      forward_delay: z.string().optional().describe("STP forward delay timer, e.g. '15s'"),
      max_message_age: z.string().optional().describe("STP maximum message age, e.g. '20s'"),
      transmit_hold_count: z.number().int().optional().describe("STP transmit hold count"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating bridge: name=${a.name}, vlan_filtering=${a.vlan_filtering}`);
      const cmd = new Cmd("/interface bridge add")
        .set("name", a.name)
        .opt("comment", a.comment)
        .flag("vlan-filtering", a.vlan_filtering)
        .opt("protocol-mode", a.protocol_mode)
        .opt("mtu", a.mtu)
        .opt("ageing-time", a.ageing_time)
        .opt("arp", a.arp)
        .opt("arp-timeout", a.arp_timeout)
        .bool("auto-mac", a.auto_mac)
        .opt("admin-mac", a.admin_mac)
        .opt("priority", a.priority)
        .opt("ether-type", a.ether_type)
        .opt("pvid", a.pvid)
        .opt("frame-types", a.frame_types)
        .bool("ingress-filtering", a.ingress_filtering)
        .bool("dhcp-snooping", a.dhcp_snooping)
        .bool("igmp-snooping", a.igmp_snooping)
        .bool("fast-forward", a.fast_forward)
        .bool("mvrp", a.mvrp)
        .opt("forward-delay", a.forward_delay)
        .opt("max-message-age", a.max_message_age)
        .opt("transmit-hold-count", a.transmit_hold_count)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create bridge: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface bridge print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `Bridge created successfully:\n\n${details}`
        : "Bridge creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_bridges",
    title: "List Bridge Interfaces",
    annotations: READ,
    description:
      "Lists bridge interfaces (`/interface bridge`). " +
      "Use to enumerate all bridge domains or confirm whether a named bridge exists. " +
      "For member ports enslaved to a bridge use `list_bridge_ports`; " +
      "for the VLAN membership table use `list_bridge_vlans`; " +
      "for learned MAC addresses use `list_bridge_hosts`. " +
      "Optional `name_filter` does a partial name match. Returns bridge name, MTU, VLAN-filtering flag, and STP state.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing bridges");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface bridge print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No bridges found matching the criteria." : `BRIDGES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_bridge",
    title: "Get Bridge Interface Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single bridge interface (`/interface bridge print detail`). " +
      "Use to inspect STP/MSTP state, VLAN-filtering flag, MTU, MAC address, and operational status for one bridge. " +
      "For all bridges use `list_bridges`; for the member ports of this bridge use `list_bridge_ports`. " +
      "Requires the exact bridge `name`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting bridge details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface bridge print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result) ? `Bridge '${a.name}' not found.` : `BRIDGE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_bridge",
    title: "Update Bridge Interface Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies settings on an existing bridge interface (`/interface bridge set`). " +
      "Use to rename a bridge (`new_name`), toggle VLAN filtering, change STP/RSTP/MSTP protocol mode, adjust MTU, or enable/disable the bridge. " +
      "VLAN filtering can interrupt management: read get_vlan_segmentation_guide, verify CPU membership, PVID/admission and recovery access before enabling it LAST. Do not disable existing filtering to simplify migration. " +
      "For adding or removing member interfaces use `add_bridge_port` / `remove_bridge_port`; " +
      "for VLAN table entries use `add_bridge_vlan`. " +
      "Identified by the current bridge `name`; supply only the fields you want to change.",
    inputSchema: {
      name: z.string().describe("Current name of the bridge to update"),
      new_name: interfaceName().optional().describe("Rename the bridge to this (no spaces)."),
      comment: z.string().optional(),
      vlan_filtering: z.boolean().optional(),
      protocol_mode: ProtocolMode.optional(),
      disabled: z.boolean().optional(),
      mtu: z.number().int().optional(),
      ageing_time: z.string().optional().describe("Host table entry timeout, e.g. '5m'"),
      arp: ArpMode.optional().describe("ARP resolution mode"),
      arp_timeout: z.string().optional().describe("ARP entry timeout, e.g. '30s' or 'auto'"),
      auto_mac: z
        .boolean()
        .optional()
        .describe("Automatically pick the bridge MAC from a member port"),
      admin_mac: z
        .string()
        .optional()
        .describe("Static bridge MAC address (requires auto_mac=false)"),
      priority: z.string().optional().describe("STP/RSTP bridge priority, e.g. '0x8000'"),
      ether_type: EtherType.optional().describe(
        "Service VLAN (S-tag) EtherType when VLAN filtering",
      ),
      pvid: z
        .number()
        .int()
        .min(1)
        .max(4094)
        .optional()
        .describe("Bridge-level default port VLAN ID"),
      frame_types: FrameTypes.optional().describe("Default accepted frame types for ports"),
      ingress_filtering: z
        .boolean()
        .optional()
        .describe("Default ingress VLAN filtering for ports"),
      dhcp_snooping: z.boolean().optional().describe("Enable DHCP snooping"),
      igmp_snooping: z.boolean().optional().describe("Enable IGMP/MLD snooping"),
      fast_forward: z.boolean().optional().describe("Enable Fast Forward optimization"),
      mvrp: z.boolean().optional().describe("Enable Multiple VLAN Registration Protocol"),
      forward_delay: z.string().optional().describe("STP forward delay timer, e.g. '15s'"),
      max_message_age: z.string().optional().describe("STP maximum message age, e.g. '20s'"),
      transmit_hold_count: z.number().int().optional().describe("STP transmit hold count"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating bridge: name=${a.name}`);
      const cmd = new Cmd(`/interface bridge set [find name="${a.name}"]`)
        .opt("name", a.new_name)
        .opt("comment", a.comment)
        .bool("vlan-filtering", a.vlan_filtering)
        .opt("protocol-mode", a.protocol_mode)
        .bool("disabled", a.disabled)
        .opt("mtu", a.mtu)
        .opt("ageing-time", a.ageing_time)
        .opt("arp", a.arp)
        .opt("arp-timeout", a.arp_timeout)
        .bool("auto-mac", a.auto_mac)
        .opt("admin-mac", a.admin_mac)
        .opt("priority", a.priority)
        .opt("ether-type", a.ether_type)
        .opt("pvid", a.pvid)
        .opt("frame-types", a.frame_types)
        .bool("ingress-filtering", a.ingress_filtering)
        .bool("dhcp-snooping", a.dhcp_snooping)
        .bool("igmp-snooping", a.igmp_snooping)
        .bool("fast-forward", a.fast_forward)
        .bool("mvrp", a.mvrp)
        .opt("forward-delay", a.forward_delay)
        .opt("max-message-age", a.max_message_age)
        .opt("transmit-hold-count", a.transmit_hold_count)
        .build();

      // No updates were supplied -> the command would just be the `set [find ...]` stem.
      if (!cmd.includes("=", cmd.indexOf("]"))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update bridge: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/interface bridge print detail where name="${target}"`,
        ctx,
      );
      return `Bridge updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_bridge",
    title: "Remove Bridge Interface",
    annotations: DESTRUCTIVE,
    description:
      "Deletes a bridge interface (`/interface bridge remove`). " +
      "Verifies existence first and returns an error if the bridge is not found. " +
      "Removing the bridge also releases all enslaved member ports. " +
      "To detach a single member without deleting the bridge use `remove_bridge_port`. " +
      "Identified by bridge `name`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing bridge: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface bridge print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `Bridge '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface bridge remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove bridge: ${result}`;
      return `Bridge '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "add_bridge_port",
    title: "Add Bridge Port (Enslave Interface)",
    annotations: WRITE,
    description:
      "Enslaves an interface as a member port of a bridge (`/interface bridge port add`). " +
      "Use to add an Ethernet, VLAN sub-interface, or other interface type to an existing bridge domain. " +
      "Set `pvid` (1-4094) to assign the port's native/untagged VLAN; set `hw=true` to enable hardware offload. " +
      "To create the bridge itself first use `create_bridge`; " +
      "to add a VLAN entry to the bridge VLAN table use `add_bridge_vlan`; " +
      "for standalone VLAN sub-interfaces use `create_vlan_interface`. " +
      "Returns the new port entry's detail.",
    inputSchema: {
      bridge: z.string().describe("Bridge to add the port to"),
      interface: z.string().describe("Interface to enslave to the bridge"),
      pvid: z
        .number()
        .int()
        .min(1)
        .max(4094)
        .optional()
        .describe("Port VLAN ID for untagged ingress"),
      comment: z.string().optional(),
      hw: z.boolean().optional().describe("Use hardware offload for this port"),
      disabled: z.boolean().optional().describe("Disable this bridge port"),
      frame_types: FrameTypes.optional().describe("Accepted frame types on ingress"),
      ingress_filtering: z
        .boolean()
        .optional()
        .describe("Drop ingress frames tagged with a VLAN the port isn't a member of"),
      tag_stacking: z.boolean().optional().describe("Force an extra VLAN tag (Q-in-Q) on ingress"),
      priority: z.string().optional().describe("STP port priority, e.g. '0x80'"),
      path_cost: z.number().int().optional().describe("STP path cost for this port"),
      internal_path_cost: z.number().int().optional().describe("MSTP internal path cost"),
      horizon: z
        .number()
        .int()
        .optional()
        .describe("Split-horizon group number for forwarding isolation"),
      learn: PortLearn.optional().describe("MAC address learning mode"),
      edge: PortEdge.optional().describe("STP edge-port setting"),
      point_to_point: PortPointToPoint.optional().describe("STP point-to-point link setting"),
      auto_isolate: z
        .boolean()
        .optional()
        .describe("Keep port in discarding until a BPDU is received"),
      bpdu_guard: z.boolean().optional().describe("Disable the port if it receives a BPDU"),
      restricted_role: z.boolean().optional().describe("Exclude port from becoming the root port"),
      restricted_tcn: z
        .boolean()
        .optional()
        .describe("Block topology change notifications from this port"),
      trusted: z
        .boolean()
        .optional()
        .describe("Trust DHCP server replies on this port (DHCP snooping)"),
      multicast_router: MulticastRouter.optional().describe("IGMP-snooping multicast router state"),
      fast_leave: z.boolean().optional().describe("IGMP-snooping fast leave"),
      unknown_unicast_flood: z
        .boolean()
        .optional()
        .describe("Flood unknown-unicast frames to this port"),
      unknown_multicast_flood: z
        .boolean()
        .optional()
        .describe("Flood unknown-multicast frames to this port"),
      broadcast_flood: z.boolean().optional().describe("Flood broadcast frames to this port"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding bridge port: bridge=${a.bridge}, interface=${a.interface}`);
      const cmd = new Cmd("/interface bridge port add")
        .set("bridge", a.bridge)
        .set("interface", a.interface)
        .opt("pvid", a.pvid)
        .opt("comment", a.comment)
        .bool("hw", a.hw)
        .bool("disabled", a.disabled)
        .opt("frame-types", a.frame_types)
        .bool("ingress-filtering", a.ingress_filtering)
        .bool("tag-stacking", a.tag_stacking)
        .opt("priority", a.priority)
        .opt("path-cost", a.path_cost)
        .opt("internal-path-cost", a.internal_path_cost)
        .opt("horizon", a.horizon)
        .opt("learn", a.learn)
        .opt("edge", a.edge)
        .opt("point-to-point", a.point_to_point)
        .bool("auto-isolate", a.auto_isolate)
        .bool("bpdu-guard", a.bpdu_guard)
        .bool("restricted-role", a.restricted_role)
        .bool("restricted-tcn", a.restricted_tcn)
        .bool("trusted", a.trusted)
        .opt("multicast-router", a.multicast_router)
        .bool("fast-leave", a.fast_leave)
        .bool("unknown-unicast-flood", a.unknown_unicast_flood)
        .bool("unknown-multicast-flood", a.unknown_multicast_flood)
        .bool("broadcast-flood", a.broadcast_flood)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add bridge port: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface bridge port print detail where interface="${a.interface}"`,
        ctx,
      );
      return details.trim()
        ? `Bridge port added successfully:\n\n${details}`
        : "Bridge port addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_bridge_ports",
    title: "List Bridge Port Memberships",
    annotations: READ,
    description:
      "Lists bridge port memberships (`/interface bridge port print`). " +
      "Use to see which interfaces are enslaved to a bridge, their PVID, horizon, and hardware-offload status. " +
      "For the bridge interfaces themselves use `list_bridges`; " +
      "for MAC addresses learned on the bridge use `list_bridge_hosts`; " +
      "for VLAN table entries use `list_bridge_vlans`. " +
      "Filter by exact `bridge_filter` (bridge name) or `interface_filter` (member interface name).",
    inputSchema: {
      bridge_filter: z.string().optional().describe("Exact bridge name"),
      interface_filter: z.string().optional().describe("Exact interface name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing bridge ports");
      const filters: string[] = [];
      if (a.bridge_filter) filters.push(`bridge="${a.bridge_filter}"`);
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface bridge port print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No bridge ports found matching the criteria."
        : `BRIDGE PORTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_bridge_port",
    title: "Remove Bridge Port (Release Interface)",
    annotations: DESTRUCTIVE,
    description:
      "Detaches a member interface from its bridge (`/interface bridge port remove`). " +
      "Verifies the port exists first and returns an error if not found. " +
      "Releases the interface back to standalone mode without deleting the bridge itself. " +
      "To delete the entire bridge (and release all ports) use `remove_bridge`. " +
      "Identified by the member `interface` name.",
    inputSchema: {
      interface: z.string().describe("Interface to remove from the bridge"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing bridge port: interface=${a.interface}`);
      const count = await executeMikrotikCommand(
        `/interface bridge port print count-only where interface="${a.interface}"`,
        ctx,
      );
      if (count.trim() === "0") return `Bridge port for interface '${a.interface}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface bridge port remove [find interface="${a.interface}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove bridge port: ${result}`;
      return `Bridge port for interface '${a.interface}' removed successfully.`;
    },
  }),

  defineTool({
    name: "list_bridge_hosts",
    title: "List Bridge MAC Address (Host) Table",
    annotations: READ,
    description:
      "Lists the learned MAC forwarding table of a bridge (`/interface bridge host print`). " +
      "Use to see which MAC addresses are known on each bridge port — useful for Layer-2 troubleshooting and verifying device reachability. " +
      "This is the bridge forwarding database, not the ARP table (ARP maps IP-to-MAC; use ARP tools for that). " +
      "Not the same as `list_bridge_ports` (which lists enslaved interfaces, not learned MACs). " +
      "Filter by exact `bridge_filter`; returns MAC address, port, age, and dynamic/static flag.",
    inputSchema: {
      bridge_filter: z.string().optional().describe("Exact bridge name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing bridge hosts");
      const filters: string[] = [];
      if (a.bridge_filter) filters.push(`bridge="${a.bridge_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface bridge host print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No bridge hosts found matching the criteria."
        : `BRIDGE HOSTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_bridge_vlan",
    title: "Add Bridge VLAN Table Entry",
    annotations: WRITE,
    description:
      "Adds a VLAN membership entry to a bridge's 802.1Q VLAN table (`/interface bridge vlan add`). " +
      "Use to define which ports carry a specific VLAN as tagged (trunk) or untagged (access). " +
      "Entries can be staged BEFORE enabling filtering; filtering enforces membership and should be enabled LAST after management is protected. " +
      "For routed VLANs verify tagged bridge/CPU membership. Use one VLAN ID per entry containing access ports and align their PVID/admission; read get_vlan_segmentation_guide first. " +
      "`vlan_ids` accepts a single ID (e.g. '100') or comma-separated list (e.g. '100,200'); " +
      "`tagged` and `untagged` accept comma-separated interface names. " +
      "For standalone 802.1Q VLAN sub-interfaces use `create_vlan_interface`; " +
      "for listing existing VLAN table entries use `list_bridge_vlans`; " +
      "for setting per-port native VLAN use the `pvid` parameter in `add_bridge_port`.",
    inputSchema: {
      bridge: z.string().describe("Bridge to add the VLAN entry to"),
      vlan_ids: z.string().describe("VLAN ID(s), e.g. '100' or '100,200'"),
      tagged: z.string().optional().describe("Comma-separated tagged interfaces"),
      untagged: z.string().optional().describe("Comma-separated untagged interfaces"),
      comment: z.string().optional(),
      disabled: z.boolean().optional().describe("Disable this VLAN table entry"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding bridge VLAN: bridge=${a.bridge}, vlan_ids=${a.vlan_ids}`);
      const cmd = new Cmd("/interface bridge vlan add")
        .set("bridge", a.bridge)
        .set("vlan-ids", a.vlan_ids)
        .opt("tagged", a.tagged)
        .opt("untagged", a.untagged)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add bridge VLAN: ${result}`;
      return `Bridge VLAN '${a.vlan_ids}' added to '${a.bridge}' successfully.`;
    },
  }),

  defineTool({
    name: "list_bridge_vlans",
    title: "List Bridge VLAN Table Entries",
    annotations: READ,
    description:
      "Lists VLAN membership entries from the bridge VLAN table (`/interface bridge vlan print`). " +
      "Use to inspect which ports are tagged or untagged for each VLAN on a bridge where `vlan-filtering` is active. " +
      "For standalone 802.1Q VLAN sub-interfaces (not bridge VLAN table) use `create_vlan_interface` and related VLAN tools; " +
      "for bridge port PVID (native VLAN) settings use `list_bridge_ports`. " +
      "Filter by exact `bridge_filter`; returns VLAN IDs with their tagged and untagged port lists.",
    inputSchema: {
      bridge_filter: z.string().optional().describe("Exact bridge name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing bridge VLANs");
      const filters: string[] = [];
      if (a.bridge_filter) filters.push(`bridge="${a.bridge_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface bridge vlan print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No bridge VLANs found matching the criteria."
        : `BRIDGE VLANS:\n\n${result}`;
    },
  }),
];
