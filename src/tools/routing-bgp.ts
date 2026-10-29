/** BGP — `/routing bgp` (connections, templates, sessions, advertisements) — RouterOS v7. */
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
  quoteValue,
  Cmd,
} from "../core/routeros";

const UNSUPPORTED =
  "BGP is not available on this device (requires RouterOS v7 with the routing package).";

export const routingBgpTools: ToolModule = [
  defineTool({
    name: "list_bgp_instances",
    title: "List BGP Instances",
    annotations: READ,
    description:
      "Read BGP instances and their best-path selection settings, including RouterOS 7.25+ always-compare-med. Use before changing an instance.",
    async handler(_a, ctx) {
      const result = await executeMikrotikCommand("/routing bgp instance print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BGP instances found." : `BGP INSTANCES:\n\n${result}`;
    },
  }),
  defineTool({
    name: "update_bgp_instance_med_comparison",
    title: "Set BGP Instance MED Comparison",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Set RouterOS 7.25+ always-compare-med on one named BGP instance. This changes best-path selection and can reroute traffic; inspect list_bgp_instances and obtain operator approval first.",
    inputSchema: {
      name: z.string().min(1).describe("Exact BGP instance name"),
      always_compare_med: z.boolean(),
      confirm_routing_change: z
        .literal(true)
        .describe("Operator approved the best-path behavior change"),
    },
    async handler(a, ctx) {
      const selector = new Cmd("/routing bgp instance print count-only where")
        .set("name", a.name)
        .build();
      const count = await executeMikrotikCommand(selector, ctx);
      if (commandUnsupported(count)) return UNSUPPORTED;
      if (looksLikeError(count)) return `Failed to inspect BGP instance: ${count}`;
      if (isEmpty(count) || count.trim() === "0") return `BGP instance '${a.name}' not found.`;
      const cmd = new Cmd(`/routing bgp instance set [find name=${quoteValue(a.name)}]`)
        .bool("always-compare-med", a.always_compare_med)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update BGP instance: ${result}`;
      const details = await executeMikrotikCommand(
        new Cmd("/routing bgp instance print detail where").set("name", a.name).build(),
        ctx,
      );
      if (looksLikeError(details) || isEmpty(details))
        return `BGP instance update was sent, but read-back failed: ${details || "no details returned"}`;
      return `BGP instance '${a.name}' MED comparison updated:\n\n${details}`;
    },
  }),
  // ── Connections ───────────────────────────────────────────────────────────
  defineTool({
    name: "list_bgp_connections",
    title: "List BGP Connections",
    annotations: READ,
    description:
      "Lists configured BGP peer connections (`/routing bgp connection`) — the static configuration of each peer " +
      "or listener, including local/remote AS, addresses, and role. For runtime peering state (established/idle, " +
      "uptime, prefix counts) use `list_bgp_sessions`. For shared configuration objects inherited by connections " +
      "use `list_bgp_templates`. Optionally filters by connection name substring. Returns all matching connection " +
      "entries. Requires RouterOS v7 with the routing package.",
    inputSchema: {
      name_filter: z.string().optional().describe("Substring match on connection name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing BGP connections");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      const result = await executeMikrotikCommand(
        `/routing bgp connection print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BGP connections found." : `BGP CONNECTIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_bgp_connection",
    title: "Get BGP Connection Details",
    annotations: READ,
    description:
      "Fetches full configuration detail for a single BGP connection by name " +
      '(`/routing bgp connection print detail where name="<name>"`). Use this to inspect one peer\'s full ' +
      "settings; to browse all connections use `list_bgp_connections`. For runtime session status (established, " +
      "uptime, prefix counts) use `list_bgp_sessions`. Returns the complete connection record or a not-found message.",
    inputSchema: { name: z.string().describe("BGP connection name") },
    async handler(a, ctx) {
      ctx.info(`Getting BGP connection: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing bgp connection print detail where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? `BGP connection '${a.name}' not found.`
        : `BGP CONNECTION:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_bgp_connection",
    title: "Add BGP Connection",
    annotations: WRITE,
    description:
      "Creates a BGP peer connection (`/routing bgp connection add`) — the per-peer configuration that " +
      "initiates or accepts a BGP session. At minimum supply `name`, `remote_address`, and `as`/`local_role` for " +
      "the local side. `local_role` values: `ebgp`, `ibgp`, `ebgp-customer`, `ebgp-provider`, `ibgp-rr`, " +
      '`ibgp-rr-client`. For `address_families` pass a comma-separated list, e.g. `"ip"` or `"ip,ipv6,l2vpn"`. ' +
      'For `hold_time`/`keepalive_time` use RouterOS duration strings, e.g. `"3m"` or `"180s"`. ' +
      "`input_filter`/`output_filter` reference `/routing filter` chain names. Common settings (AS, filters, timers) " +
      "can be factored into a template referenced via `templates`; to create templates use `add_bgp_template`. " +
      "To modify an existing connection use `update_bgp_connection`. Returns the created connection's full detail. " +
      "Requires RouterOS v7 with the routing package.",
    inputSchema: {
      name: z.string().describe("Unique connection name"),
      remote_address: z.string().describe("Peer IP address (remote.address)"),
      remote_as: z.number().int().optional().describe("Peer AS number (remote.as)"),
      remote_port: z.number().int().optional().describe("Peer TCP port (remote.port)"),
      as: z.number().int().optional().describe("Local AS number"),
      local_role: z
        .string()
        .optional()
        .describe(
          "local.role: ebgp, ibgp, ebgp-customer, ebgp-provider, ibgp-rr, ibgp-rr-client, …",
        ),
      local_address: z.string().optional().describe("Local source address (local.address)"),
      local_port: z.number().int().optional().describe("Local TCP port (local.port)"),
      router_id: z.string().optional().describe("Override router-id for this connection"),
      cluster_id: z.string().optional().describe("Route-reflector cluster ID (cluster-id)"),
      templates: z.string().optional().describe("Template name(s) to inherit settings from"),
      address_families: z.string().optional().describe('Comma list, e.g. "ip" or "ip,ipv6,l2vpn"'),
      hold_time: z.string().optional().describe('e.g. "3m" or "180s"'),
      keepalive_time: z.string().optional(),
      multihop: z.boolean().optional().describe("Allow non-directly-connected peers"),
      nexthop_choice: z.string().optional().describe("default, force-self, or propagate"),
      use_bfd: z.boolean().optional().describe("Use BFD for fast failure detection (use-bfd)"),
      tcp_md5_key: z.string().optional().describe("TCP MD5 authentication key (tcp-md5-key)"),
      connect: z.boolean().optional().describe("Actively initiate the TCP session (connect)"),
      listen: z.boolean().optional().describe("Accept incoming TCP session (listen)"),
      input_filter: z
        .string()
        .optional()
        .describe("Routing filter chain for inbound routes (input.filter)"),
      input_accept_nlri: z
        .string()
        .optional()
        .describe("Address list of accepted NLRI prefixes (input.accept-nlri)"),
      input_allow_as: z
        .number()
        .int()
        .optional()
        .describe("Number of times own AS may appear in AS-path (input.allow-as)"),
      input_ignore_as_path_len: z
        .boolean()
        .optional()
        .describe("Ignore AS-path length in best-path selection (input.ignore-as-path-len)"),
      output_filter: z
        .string()
        .optional()
        .describe("Routing filter chain for outbound routes (output.filter)"),
      output_network: z
        .string()
        .optional()
        .describe("Address list of networks to originate/advertise (output.network)"),
      output_default_originate: z
        .string()
        .optional()
        .describe(
          "Advertise a default route: never, if-installed, or always (output.default-originate)",
        ),
      output_redistribute: z
        .string()
        .optional()
        .describe(
          "Comma list of route sources to redistribute, e.g. connected,static (output.redistribute)",
        ),
      output_as_override: z
        .boolean()
        .optional()
        .describe("Replace peer AS in AS-path with local AS (output.as-override)"),
      output_keep_sent_attributes: z
        .boolean()
        .optional()
        .describe("Retain sent path attributes for inspection (output.keep-sent-attributes)"),
      output_no_client_to_client_reflection: z
        .boolean()
        .optional()
        .describe(
          "Disable route-reflector client-to-client reflection (output.no-client-to-client-reflection)",
        ),
      routing_table: z.string().optional().describe("RIB to install learned routes into"),
      vrf: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding BGP connection: ${a.name}`);
      const cmd = new Cmd("/routing bgp connection add")
        .set("name", a.name)
        .set("remote.address", a.remote_address)
        .opt("remote.as", a.remote_as)
        .opt("remote.port", a.remote_port)
        .opt("as", a.as)
        .opt("local.role", a.local_role)
        .opt("local.address", a.local_address)
        .opt("local.port", a.local_port)
        .opt("router-id", a.router_id)
        .opt("cluster-id", a.cluster_id)
        .opt("templates", a.templates)
        .opt("address-families", a.address_families)
        .opt("hold-time", a.hold_time)
        .opt("keepalive-time", a.keepalive_time)
        .bool("multihop", a.multihop)
        .opt("nexthop-choice", a.nexthop_choice)
        .bool("use-bfd", a.use_bfd)
        .opt("tcp-md5-key", a.tcp_md5_key)
        .bool("connect", a.connect)
        .bool("listen", a.listen)
        .opt("input.filter", a.input_filter)
        .opt("input.accept-nlri", a.input_accept_nlri)
        .opt("input.allow-as", a.input_allow_as)
        .bool("input.ignore-as-path-len", a.input_ignore_as_path_len)
        .opt("output.filter", a.output_filter)
        .opt("output.network", a.output_network)
        .opt("output.default-originate", a.output_default_originate)
        .opt("output.redistribute", a.output_redistribute)
        .bool("output.as-override", a.output_as_override)
        .bool("output.keep-sent-attributes", a.output_keep_sent_attributes)
        .bool("output.no-client-to-client-reflection", a.output_no_client_to_client_reflection)
        .opt("routing-table", a.routing_table)
        .opt("vrf", a.vrf)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add BGP connection: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing bgp connection print detail where name="${a.name}"`,
        ctx,
      );
      return `BGP connection '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "update_bgp_connection",
    title: "Update BGP Connection",
    annotations: WRITE_IDEMPOTENT,
    description:
      'Modifies settings of an existing BGP connection by name (`/routing bgp connection set [find name="<name>"]`). ' +
      "Only supplied fields are changed; omitted fields are left unchanged. To enable or disable a connection " +
      "without touching other settings use `set_bgp_connection_enabled`. To delete a connection use " +
      "`remove_bgp_connection`. Returns the full updated connection detail on success.",
    inputSchema: {
      name: z.string().describe("Existing BGP connection name"),
      remote_address: z.string().optional(),
      remote_as: z.number().int().optional(),
      remote_port: z.number().int().optional(),
      as: z.number().int().optional(),
      local_role: z.string().optional(),
      local_address: z.string().optional(),
      local_port: z.number().int().optional(),
      router_id: z.string().optional(),
      cluster_id: z.string().optional(),
      address_families: z.string().optional(),
      hold_time: z.string().optional(),
      keepalive_time: z.string().optional(),
      multihop: z.boolean().optional(),
      nexthop_choice: z.string().optional(),
      use_bfd: z.boolean().optional(),
      tcp_md5_key: z.string().optional(),
      connect: z.boolean().optional(),
      listen: z.boolean().optional(),
      input_filter: z.string().optional(),
      input_accept_nlri: z.string().optional(),
      input_allow_as: z.number().int().optional(),
      input_ignore_as_path_len: z.boolean().optional(),
      output_filter: z.string().optional(),
      output_network: z.string().optional(),
      output_default_originate: z.string().optional(),
      output_redistribute: z.string().optional(),
      output_as_override: z.boolean().optional(),
      output_keep_sent_attributes: z.boolean().optional(),
      output_no_client_to_client_reflection: z.boolean().optional(),
      routing_table: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating BGP connection: ${a.name}`);
      const base = `/routing bgp connection set [find name="${a.name}"]`;
      const cmd = new Cmd(base)
        .opt("remote.address", a.remote_address)
        .opt("remote.as", a.remote_as)
        .opt("remote.port", a.remote_port)
        .opt("as", a.as)
        .opt("local.role", a.local_role)
        .opt("local.address", a.local_address)
        .opt("local.port", a.local_port)
        .opt("router-id", a.router_id)
        .opt("cluster-id", a.cluster_id)
        .opt("address-families", a.address_families)
        .opt("hold-time", a.hold_time)
        .opt("keepalive-time", a.keepalive_time)
        .opt("nexthop-choice", a.nexthop_choice)
        .opt("tcp-md5-key", a.tcp_md5_key)
        .opt("input.filter", a.input_filter)
        .opt("input.accept-nlri", a.input_accept_nlri)
        .opt("input.allow-as", a.input_allow_as)
        .opt("output.filter", a.output_filter)
        .opt("output.network", a.output_network)
        .opt("output.default-originate", a.output_default_originate)
        .opt("output.redistribute", a.output_redistribute)
        .opt("routing-table", a.routing_table);
      if (a.multihop !== undefined) cmd.bool("multihop", a.multihop);
      if (a.use_bfd !== undefined) cmd.bool("use-bfd", a.use_bfd);
      if (a.connect !== undefined) cmd.bool("connect", a.connect);
      if (a.listen !== undefined) cmd.bool("listen", a.listen);
      if (a.input_ignore_as_path_len !== undefined)
        cmd.bool("input.ignore-as-path-len", a.input_ignore_as_path_len);
      if (a.output_as_override !== undefined) cmd.bool("output.as-override", a.output_as_override);
      if (a.output_keep_sent_attributes !== undefined)
        cmd.bool("output.keep-sent-attributes", a.output_keep_sent_attributes);
      if (a.output_no_client_to_client_reflection !== undefined)
        cmd.bool("output.no-client-to-client-reflection", a.output_no_client_to_client_reflection);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update BGP connection: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing bgp connection print detail where name="${a.name}"`,
        ctx,
      );
      return `BGP connection '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_bgp_connection",
    title: "Remove BGP Connection",
    annotations: DESTRUCTIVE,
    description:
      'Permanently deletes a BGP peer connection by name (`/routing bgp connection remove [find name="<name>"]`), ' +
      "tearing down the peering and removing all its configuration. To only suspend a connection without deleting it " +
      "use `set_bgp_connection_enabled`. To remove a shared settings object use `remove_bgp_template`. " +
      "The `name` is the connection name visible in `list_bgp_connections`.",
    inputSchema: { name: z.string().describe("BGP connection name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing BGP connection: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing bgp connection remove [find name="${a.name}"]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove BGP connection: ${result}`;
      return `BGP connection '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_bgp_connection_enabled",
    title: "Enable or Disable BGP Connection",
    annotations: WRITE_IDEMPOTENT,
    description:
      'Enables or disables a BGP connection by name (`/routing bgp connection set [find name="<name>"] ' +
      "disabled=yes/no`). Pass `enabled=true` to bring a peer up, `enabled=false` to suspend it without deleting " +
      "its configuration. To change other connection settings use `update_bgp_connection`. To permanently delete " +
      "the connection use `remove_bgp_connection`.",
    inputSchema: {
      name: z.string().describe("BGP connection name"),
      enabled: z.boolean(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting BGP connection ${a.name} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing bgp connection set [find name="${a.name}"] disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update BGP connection: ${result}`;
      return `BGP connection '${a.name}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),

  // ── Templates ─────────────────────────────────────────────────────────────
  defineTool({
    name: "list_bgp_templates",
    title: "List BGP Templates",
    annotations: READ,
    description:
      "Lists BGP template objects (`/routing bgp template print detail`). Templates hold shared peer settings — " +
      "AS number, address-families, route filters, timers — that individual connections inherit via their `templates` " +
      "field, avoiding repetition across many peers. For per-peer connection configuration use `list_bgp_connections`. " +
      "For runtime session state use `list_bgp_sessions`. Returns all defined templates. Requires RouterOS v7 " +
      "with the routing package.",
    async handler(_a, ctx) {
      ctx.info("Listing BGP templates");
      const result = await executeMikrotikCommand("/routing bgp template print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BGP templates found." : `BGP TEMPLATES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_bgp_template",
    title: "Add BGP Template",
    annotations: WRITE,
    description:
      "Creates a BGP template (`/routing bgp template add`) to hold shared peer settings (AS, address-families, " +
      "route filters, routing table) that multiple connections can inherit via their `templates` field, avoiding " +
      'repetition across many peers. For `address_families` pass a comma-separated list, e.g. `"ip,ipv6"`. ' +
      "`input_filter`/`output_filter` reference `/routing filter` chain names. To create a peer that references " +
      "this template use `add_bgp_connection`. To remove a template use `remove_bgp_template`. Returns success " +
      "confirmation; verify with `list_bgp_templates`. Requires RouterOS v7 with the routing package.",
    inputSchema: {
      name: z.string().describe("Template name"),
      as: z.number().int().optional().describe("Local AS number"),
      router_id: z.string().optional(),
      cluster_id: z.string().optional().describe("Route-reflector cluster ID (cluster-id)"),
      address_families: z.string().optional().describe('e.g. "ip,ipv6"'),
      hold_time: z.string().optional().describe('e.g. "3m" or "180s"'),
      keepalive_time: z.string().optional(),
      multihop: z.boolean().optional().describe("Allow non-directly-connected peers"),
      nexthop_choice: z.string().optional().describe("default, force-self, or propagate"),
      use_bfd: z.boolean().optional().describe("Use BFD for fast failure detection (use-bfd)"),
      input_filter: z.string().optional(),
      output_filter: z.string().optional(),
      output_network: z
        .string()
        .optional()
        .describe("Address list of networks to originate/advertise (output.network)"),
      output_default_originate: z
        .string()
        .optional()
        .describe(
          "Advertise a default route: never, if-installed, or always (output.default-originate)",
        ),
      output_redistribute: z
        .string()
        .optional()
        .describe(
          "Comma list of route sources to redistribute, e.g. connected,static (output.redistribute)",
        ),
      routing_table: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding BGP template: ${a.name}`);
      const cmd = new Cmd("/routing bgp template add")
        .set("name", a.name)
        .opt("as", a.as)
        .opt("router-id", a.router_id)
        .opt("cluster-id", a.cluster_id)
        .opt("address-families", a.address_families)
        .opt("hold-time", a.hold_time)
        .opt("keepalive-time", a.keepalive_time)
        .bool("multihop", a.multihop)
        .opt("nexthop-choice", a.nexthop_choice)
        .bool("use-bfd", a.use_bfd)
        .opt("input.filter", a.input_filter)
        .opt("output.filter", a.output_filter)
        .opt("output.network", a.output_network)
        .opt("output.default-originate", a.output_default_originate)
        .opt("output.redistribute", a.output_redistribute)
        .opt("routing-table", a.routing_table)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add BGP template: ${result}`;
      return `BGP template '${a.name}' added successfully.`;
    },
  }),

  defineTool({
    name: "remove_bgp_template",
    title: "Remove BGP Template",
    annotations: DESTRUCTIVE,
    description:
      'Permanently deletes a BGP template by name (`/routing bgp template remove [find name="<name>"]`). ' +
      "Connections that referenced this template lose the inherited settings — review with `list_bgp_connections` " +
      "before removing. To remove a peer connection instead use `remove_bgp_connection`. The `name` is the template " +
      "name visible in `list_bgp_templates`.",
    inputSchema: { name: z.string().describe("BGP template name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing BGP template: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing bgp template remove [find name="${a.name}"]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove BGP template: ${result}`;
      return `BGP template '${a.name}' removed successfully.`;
    },
  }),

  // ── Sessions & advertisements (read-only) ─────────────────────────────────
  defineTool({
    name: "list_bgp_sessions",
    title: "List BGP Sessions",
    annotations: READ,
    description:
      "Lists runtime BGP session state (`/routing bgp session print detail`) — negotiated peering status " +
      "(established/idle/active/…), remote AS, uptime, and received/advertised prefix counts. This is the live " +
      "operational view, not configuration; to view or change peer configuration use `list_bgp_connections`. " +
      "Pass `established_only=true` to filter to established (fully up) sessions only. For prefixes being sent to a peer use " +
      "`list_bgp_advertisements`. Returns all matching session entries. Requires RouterOS v7 with the routing package.",
    inputSchema: {
      established_only: z.boolean().default(false).describe("Show only established sessions"),
    },
    async handler(a, ctx) {
      ctx.info("Listing BGP sessions");
      const filters: string[] = [];
      if (a.established_only) filters.push("established=yes");
      const result = await executeMikrotikCommand(
        `/routing bgp session print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BGP sessions found." : `BGP SESSIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_bgp_advertisements",
    title: "List BGP Advertisements",
    annotations: READ,
    description:
      "Lists prefixes currently being advertised to BGP peers (`/routing bgp advertisements print`) after output " +
      "filters are applied — use this to verify exactly what routes this router is sending to a given peer. " +
      "Read-only operational data; to see session status (prefix counts, uptime) use `list_bgp_sessions`. " +
      "Filter by peer name substring with `peer_filter`. Returns advertisement entries per peer, or a not-found message. " +
      "Requires RouterOS v7 with the routing package.",
    inputSchema: {
      peer_filter: z.string().optional().describe("Substring match on the peer name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing BGP advertisements");
      const filters: string[] = [];
      if (a.peer_filter) filters.push(`peer~"${a.peer_filter}"`);
      const result = await executeMikrotikCommand(
        `/routing bgp advertisements print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No BGP advertisements found." : `BGP ADVERTISEMENTS:\n\n${result}`;
    },
  }),
];
