/** RIP — `/routing rip` (instance, interface-template, static-neighbor, neighbor) — RouterOS v7. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
  quoted,
  quoteValue,
} from "../core/routeros";

const UNSUPPORTED =
  "RIP is not available on this device (requires RouterOS v7 with the routing package).";

export const routingRipTools: ToolModule = [
  // ── Instances ─────────────────────────────────────────────────────────────
  defineTool({
    name: "list_rip_instances",
    title: "List RIP Instances",
    annotations: READ,
    description:
      "List RIP process instances (`/routing rip instance`) — each instance is one RIPv2 process with its own " +
      "router-id, redistribution policy, and import/export filter chains. Use before creating or updating an instance " +
      "with add_rip_instance or update_rip_instance. For OSPF use the OSPF tools; for BGP use list_bgp_connections; " +
      "for static routes use list_routes. Returns all instance details including router-id, VRF, redistribution " +
      "config, and enabled/disabled state. Requires RouterOS v7 with the routing package.",
    async handler(_a, ctx) {
      ctx.info("Listing RIP instances");
      const result = await executeMikrotikCommand("/routing rip instance print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No RIP instances found." : `RIP INSTANCES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_rip_instance",
    title: "Add RIP Instance",
    annotations: WRITE,
    description:
      "Create a RIP process instance (`/routing rip instance add`) — the top-level RIPv2 process object that " +
      "governs route redistribution and filter chains. Required before attaching interfaces with " +
      'add_rip_interface_template. `redistribute` is a comma-separated list (e.g. "connected,static,ospf,bgp"); ' +
      "`originate_default` accepts never, if-installed, or always; `router_id` accepts an IPv4 address, 'main', " +
      "or a /routing id name; filter chains reference /routing filter. For OSPF use the OSPF tools; for BGP use " +
      "add_bgp_connection. Returns the created instance's detail including its name. Requires RouterOS v7 with " +
      "the routing package.",
    inputSchema: {
      name: z.string().describe("Unique instance name"),
      router_id: z.string().optional().describe("IPv4 address, 'main', or a /routing id name"),
      vrf: z.string().optional(),
      routing_table: z.string().optional().describe("Routing table to install routes into"),
      redistribute: z.string().optional().describe('Comma list, e.g. "connected,static"'),
      in_filter_chain: z.string().optional(),
      out_filter_chain: z.string().optional(),
      originate_default: z.string().optional().describe("never, if-installed, or always"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding RIP instance: ${a.name}`);
      const cmd = new Cmd("/routing rip instance add")
        .set("name", a.name)
        .opt("router-id", a.router_id)
        .opt("vrf", a.vrf)
        .opt("routing-table", a.routing_table)
        .opt("redistribute", a.redistribute)
        .opt("in-filter-chain", a.in_filter_chain)
        .opt("out-filter-chain", a.out_filter_chain)
        .opt("originate-default", a.originate_default)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add RIP instance: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing rip instance print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `RIP instance '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "update_rip_instance",
    title: "Update RIP Instance",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify an existing RIP process instance (`/routing rip instance set`) identified by its name. Use to " +
      "change redistribution policy, filter chains, router-id, or enabled/disabled state without recreating the " +
      "instance. Obtain the name from list_rip_instances. For creating a new instance use add_rip_instance; for " +
      "removing one use remove_rip_instance. Returns the updated instance's detail. Requires RouterOS v7 with " +
      "the routing package.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Existing RIP instance name"),
      router_id: z.string().optional(),
      routing_table: z.string().optional().describe("Routing table to install routes into"),
      redistribute: z.string().optional(),
      in_filter_chain: z.string().optional(),
      out_filter_chain: z.string().optional(),
      originate_default: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating RIP instance: ${a.name}`);
      const base = `/routing rip instance set [find name=${quoted(a.name)}]`;
      const cmd = new Cmd(base)
        .opt("router-id", a.router_id)
        .opt("routing-table", a.routing_table)
        .opt("redistribute", a.redistribute)
        .opt("in-filter-chain", a.in_filter_chain)
        .opt("out-filter-chain", a.out_filter_chain)
        .opt("originate-default", a.originate_default);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update RIP instance: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing rip instance print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `RIP instance '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_rip_instance",
    title: "Remove RIP Instance",
    annotations: DESTRUCTIVE,
    description:
      "Delete a RIP process instance (`/routing rip instance remove`) by its name, removing the process and all " +
      "associated routing state. Obtain the name from list_rip_instances. Remove associated interface templates " +
      "first with remove_rip_interface_template to avoid orphaned entries. To disable without deleting use " +
      "update_rip_instance with disabled=true. Requires RouterOS v7 with the routing package.",
    inputSchema: { name: z.string().describe("RIP instance name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing RIP instance: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing rip instance remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove RIP instance: ${result}`;
      return `RIP instance '${a.name}' removed successfully.`;
    },
  }),

  // ── Interface templates ───────────────────────────────────────────────────
  defineTool({
    name: "list_rip_interface_templates",
    title: "List RIP Interface Templates",
    annotations: READ,
    description:
      "List RIP interface templates (`/routing rip interface-template`) — records that bind one or more interfaces " +
      "to a RIP instance and set per-link options such as passive mode and authentication key-chain. Use to inspect " +
      "which interfaces participate in RIP before adding or removing templates with add_rip_interface_template or " +
      "remove_rip_interface_template. For static unicast neighbors use list_rip_static_neighbors; for discovered " +
      "active peers use list_rip_neighbors. Returns all templates with their instance, interface(s), passive, " +
      "key-chain, and enabled/disabled state. Requires RouterOS v7 with the routing package.",
    async handler(_a, ctx) {
      ctx.info("Listing RIP interface templates");
      const result = await executeMikrotikCommand(
        "/routing rip interface-template print detail",
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No RIP interface templates found."
        : `RIP INTERFACE TEMPLATES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_rip_interface_template",
    title: "Add RIP Interface Template",
    annotations: WRITE,
    description:
      "Bind interfaces to a RIP instance (`/routing rip interface-template add`) so they participate in RIP " +
      "route advertisement. The `instance` must already exist — create it first with add_rip_instance. " +
      "`passive=true` suppresses outbound RIP updates while still receiving; `key_chain` names a /routing " +
      "key-chain for MD5 authentication. For static unicast neighbors on non-broadcast links use " +
      "add_rip_static_neighbor instead. Returns the new template's .id. Requires RouterOS v7 with the " +
      "routing package.",
    inputSchema: {
      instance: z.string().describe("RIP instance name"),
      interfaces: z.string().describe("Interface or interface-list name"),
      passive: z.boolean().optional(),
      split_horizon: z.boolean().optional().describe("Enable split-horizon loop prevention"),
      poison_reverse: z.boolean().optional().describe("Advertise back with infinite metric"),
      key_chain: z.string().optional().describe("Key-chain name for authentication"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding RIP interface template for instance ${a.instance}`);
      const cmd = new Cmd("/routing rip interface-template add")
        .set("instance", a.instance)
        .set("interfaces", a.interfaces)
        .opt("key-chain", a.key_chain)
        .opt("comment", a.comment);
      if (a.passive !== undefined) cmd.bool("passive", a.passive);
      if (a.split_horizon !== undefined) cmd.bool("split-horizon", a.split_horizon);
      if (a.poison_reverse !== undefined) cmd.bool("poison-reverse", a.poison_reverse);
      cmd.flag("disabled", a.disabled);

      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add RIP interface template: ${result}`;
      const t = result.trim();
      return t
        ? `RIP interface template added (id ${t}).`
        : "RIP interface template added successfully.";
    },
  }),

  defineTool({
    name: "remove_rip_interface_template",
    title: "Remove RIP Interface Template",
    annotations: DESTRUCTIVE,
    description:
      "Remove a RIP interface template (`/routing rip interface-template remove`) by its `.id`, detaching the " +
      "bound interfaces from the RIP instance. Obtain the `.id` from list_rip_interface_templates. To re-configure " +
      "instead of removing, delete and recreate with add_rip_interface_template. Requires RouterOS v7 with the " +
      "routing package.",
    inputSchema: { template_id: z.string().describe('Template id, e.g. "*1"') },
    async handler(a, ctx) {
      ctx.info(`Removing RIP interface template ${a.template_id}`);
      const result = await executeMikrotikCommand(
        `/routing rip interface-template remove ${quoteValue(a.template_id)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove RIP interface template: ${result}`;
      return `RIP interface template '${a.template_id}' removed successfully.`;
    },
  }),

  // ── Static neighbors ──────────────────────────────────────────────────────
  defineTool({
    name: "list_rip_static_neighbors",
    title: "List RIP Static Neighbors",
    annotations: READ,
    description:
      "List manually configured RIP static neighbors (`/routing rip static-neighbor`) — IPv4 unicast targets for " +
      "RIP updates on non-broadcast or point-to-point links where multicast does not reach. Use before adding or " +
      "removing entries with add_rip_static_neighbor or remove_rip_static_neighbor. For dynamically discovered " +
      "active peers see list_rip_neighbors; for interface participation config see list_rip_interface_templates. " +
      "Returns address, instance, and enabled/disabled state. Requires RouterOS v7 with the routing package.",
    async handler(_a, ctx) {
      ctx.info("Listing RIP static neighbors");
      const result = await executeMikrotikCommand("/routing rip static-neighbor print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No RIP static neighbors found."
        : `RIP STATIC NEIGHBORS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_rip_static_neighbor",
    title: "Add RIP Static Neighbor",
    annotations: WRITE,
    description:
      "Add a static RIP neighbor entry (`/routing rip static-neighbor add`) to unicast RIP updates to a specific " +
      "IPv4 address on non-broadcast or point-to-point links. Optionally scope to a specific RIP instance by name " +
      "(obtain from list_rip_instances). For multicast-reachable peers, binding an interface with " +
      "add_rip_interface_template is sufficient. Returns a confirmation message on success. Requires RouterOS v7 " +
      "with the routing package.",
    inputSchema: {
      address: z.string().describe("Neighbor IP address"),
      instance: z.string().optional().describe("RIP instance name"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding RIP static neighbor ${a.address}`);
      const cmd = new Cmd("/routing rip static-neighbor add")
        .set("address", a.address)
        .opt("instance", a.instance)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add RIP static neighbor: ${result}`;
      return `RIP static neighbor '${a.address}' added successfully.`;
    },
  }),

  defineTool({
    name: "remove_rip_static_neighbor",
    title: "Remove RIP Static Neighbor",
    annotations: DESTRUCTIVE,
    description:
      "Delete a static RIP neighbor entry (`/routing rip static-neighbor remove`) by its `.id`, stopping unicast " +
      "RIP updates to that IPv4 peer. Obtain the `.id` from list_rip_static_neighbors. The link itself is " +
      "unaffected. Requires RouterOS v7 with the routing package.",
    inputSchema: {
      neighbor_id: z.string().describe('Static-neighbor id, e.g. "*1"'),
    },
    async handler(a, ctx) {
      ctx.info(`Removing RIP static neighbor ${a.neighbor_id}`);
      const result = await executeMikrotikCommand(
        `/routing rip static-neighbor remove ${quoteValue(a.neighbor_id)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove RIP static neighbor: ${result}`;
      return `RIP static neighbor '${a.neighbor_id}' removed successfully.`;
    },
  }),

  // ── Operational neighbors (read-only) ─────────────────────────────────────
  defineTool({
    name: "list_rip_neighbors",
    title: "List Active RIP Neighbors",
    annotations: READ,
    description:
      "List dynamically discovered RIP peers (`/routing rip neighbor`) — read-only operational state showing " +
      "which IPv4 peers this router is currently exchanging routes with, including last-update timestamps. For " +
      "manually configured unicast targets see list_rip_static_neighbors; for interface participation config see " +
      "list_rip_interface_templates. For BGP peers use list_bgp_sessions; for static routes use list_routes. " +
      "Returns peer addresses, uptime, and last-update timing. Requires RouterOS v7 with the routing package.",
    async handler(_a, ctx) {
      ctx.info("Listing RIP neighbors");
      const result = await executeMikrotikCommand("/routing rip neighbor print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No RIP neighbors found." : `RIP NEIGHBORS:\n\n${result}`;
    },
  }),
];
