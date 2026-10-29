/** DHCPv6 server, bindings and options — `/ipv6 dhcp-server`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

export const ipv6DhcpServerTools: ToolModule = [
  // ── Server ────────────────────────────────────────────────────────────────
  defineTool({
    name: "create_ipv6_dhcp_server",
    title: "Create IPv6 DHCP Server",
    annotations: WRITE,
    description:
      "Creates an IPv6 DHCPv6 server instance (`/ipv6 dhcp-server`) bound to a network interface, " +
      "delegating prefixes or addresses from a named IPv6 pool. " +
      "Use this to provision stateful DHCPv6 service on an interface. " +
      "For IPv4 DHCP use create_dhcp_server; for pinning a prefix to a known client by DUID use add_ipv6_dhcp_binding. " +
      "Returns the created server's full detail including its `.id`.\n\n" +
      "Argument notes:\n" +
      "    address_pool: IPv6 pool name the server delegates prefixes/addresses from.\n" +
      "    lease_time: RouterOS duration string e.g. '1d', '12h', '30m'.\n" +
      "    rapid_commit: enable 2-message (Solicit/Reply) exchange.\n" +
      "    preference: server preference (0-255) used in multi-server deployments.\n" +
      "    dhcp_option: list of custom DHCPv6 option names defined via add_ipv6_dhcp_option.",
    inputSchema: {
      name: z.string(),
      interface: z.string(),
      address_pool: z.string().describe("IPv6 pool name the server delegates from"),
      lease_time: z.string().default("3d").describe("Lease duration e.g. '1d', '12h', '30m'"),
      binding_script: z.string().optional(),
      rapid_commit: z.boolean().optional(),
      add_dns_entries: z
        .boolean()
        .optional()
        .describe("RouterOS 7.25+ create AAAA DNS entries for client FQDNs"),
      add_dns_entries_suffix: z
        .string()
        .optional()
        .describe("Suffix for dynamically created DHCPv6 DNS entries"),
      preference: z.number().int().min(0).max(255).optional(),
      route_distance: z.number().int().optional(),
      use_radius: z.boolean().optional().describe("Authenticate clients via RADIUS"),
      allow_dual_stack_queue: z
        .boolean()
        .optional()
        .describe("Share a simple queue with the client's IPv4 DHCP lease"),
      parent_queue: z
        .string()
        .optional()
        .describe("Parent queue for dynamically created simple queues"),
      dhcp_option: z.array(z.string()).optional().describe("Custom DHCPv6 option names"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating DHCPv6 server: name=${a.name}, interface=${a.interface}`);
      const cmd = new Cmd("/ipv6 dhcp-server add")
        .set("name", a.name)
        .set("interface", a.interface)
        .set("address-pool", a.address_pool)
        .set("lease-time", a.lease_time)
        .opt("binding-script", a.binding_script)
        .bool("rapid-commit", a.rapid_commit)
        .bool("add-dns-entries", a.add_dns_entries)
        .opt("add-dns-entries-suffix", a.add_dns_entries_suffix)
        .opt("preference", a.preference)
        .opt("route-distance", a.route_distance)
        .bool("use-radius", a.use_radius)
        .bool("allow-dual-stack-queue", a.allow_dual_stack_queue)
        .opt("parent-queue", a.parent_queue)
        .opt("dhcp-option", a.dhcp_option?.length ? a.dhcp_option.join(",") : undefined)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create DHCPv6 server: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 dhcp-server print detail where name="${a.name}"`,
        ctx,
      );
      return `DHCPv6 server created successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_ipv6_dhcp_servers",
    title: "List IPv6 DHCP Servers",
    annotations: READ,
    description:
      "Lists all IPv6 DHCPv6 server instances (`/ipv6 dhcp-server`) configured on the device. " +
      "Use to discover which interfaces have DHCPv6 service, their associated pools, and enabled/invalid status. " +
      "For full detail on a single server use get_ipv6_dhcp_server; for client prefix assignments use list_ipv6_dhcp_bindings. " +
      "Returns all matching server entries; filterable by name, interface, disabled-only, or invalid-only.",
    inputSchema: {
      name_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing DHCPv6 servers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCPv6 servers found matching the criteria."
        : `DHCPV6 SERVERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_dhcp_server",
    title: "Get IPv6 DHCP Server Details",
    annotations: READ,
    description:
      "Retrieves full configuration detail for a single named IPv6 DHCPv6 server (`/ipv6 dhcp-server print detail`). " +
      "Use when you need the complete configuration of one server rather than a summary listing. " +
      "For all servers use list_ipv6_dhcp_servers; for client prefix assignments on this server use list_ipv6_dhcp_bindings. " +
      "Returns the server's detailed configuration or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting DHCPv6 server details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `DHCPv6 server '${a.name}' not found.`
        : `DHCPV6 SERVER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_dhcp_server",
    title: "Remove IPv6 DHCP Server",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named IPv6 DHCPv6 server instance (`/ipv6 dhcp-server remove`) after confirming it exists. " +
      "Removing the server stops DHCPv6 service on the bound interface but does not automatically remove its bindings or option definitions. " +
      "For removing static/dynamic prefix assignments use remove_ipv6_dhcp_binding; for removing option definitions use remove_ipv6_dhcp_option. " +
      "Returns a success or not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCPv6 server: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ipv6 dhcp-server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `DHCPv6 server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCPv6 server: ${result}`;
      return `DHCPv6 server '${a.name}' removed successfully.`;
    },
  }),

  // ── Bindings (static prefix delegation) ─────────────────────────────────────
  defineTool({
    name: "add_ipv6_dhcp_binding",
    title: "Add IPv6 DHCP Server Binding",
    annotations: WRITE,
    description:
      "Creates a static IPv6 DHCPv6 server binding (`/ipv6 dhcp-server binding add`) that pins a delegated prefix " +
      "or specific IPv6 address to a client identified by its DUID. " +
      "Use to ensure a known client always receives the same prefix/address assignment. " +
      "The binding references a server created by create_ipv6_dhcp_server; for viewing all bindings use list_ipv6_dhcp_bindings. " +
      "Returns the created binding's detail or a completion notice.\n\n" +
      "Argument notes:\n" +
      "    duid: client DHCP Unique Identifier (required) — the binding matches on this.\n" +
      "    prefix: delegated prefix e.g. '2001:db8:1::/64'.\n" +
      "    address: specific IPv6 address to assign (alternative or complement to prefix).\n" +
      "    iaid: Identity Association ID.\n" +
      "    server: target DHCPv6 server name, or 'all' to match any server.\n" +
      "    life_time: RouterOS duration string e.g. '1d', '12h'.",
    inputSchema: {
      address: z.string().optional().describe("Assigned IPv6 address, if any"),
      prefix: z.string().optional().describe("Delegated prefix, e.g. '2001:db8:1::/64'"),
      duid: z.string().describe("Client DUID the binding matches"),
      iaid: z.string().optional().describe("Identity Association ID"),
      server: z.string().optional().describe("DHCPv6 server name, or 'all'"),
      life_time: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding DHCPv6 binding: duid=${a.duid}`);
      const cmd = new Cmd("/ipv6 dhcp-server binding add")
        .opt("address", a.address)
        .opt("prefix", a.prefix)
        .set("duid", a.duid)
        .opt("iaid", a.iaid)
        .opt("server", a.server)
        .opt("life-time", a.life_time)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add DHCPv6 binding: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 dhcp-server binding print detail where duid="${a.duid}"`,
        ctx,
      );
      return details.trim()
        ? `DHCPv6 binding added successfully:\n\n${details}`
        : "DHCPv6 binding addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_dhcp_bindings",
    title: "List IPv6 DHCP Server Bindings",
    annotations: READ,
    description:
      "Lists IPv6 DHCPv6 server bindings (`/ipv6 dhcp-server binding`) — both static (manually created via add_ipv6_dhcp_binding) " +
      "and dynamic (auto-leased) client prefix/address assignments. " +
      "Use to audit which clients have received delegated prefixes and inspect DUID-to-prefix mappings. " +
      "For server configuration detail use get_ipv6_dhcp_server; to delete a binding use remove_ipv6_dhcp_binding. " +
      "Returns all matching bindings; filterable by server name, DUID substring, or dynamic-only.",
    inputSchema: {
      server_filter: z.string().optional(),
      duid_filter: z.string().optional(),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing DHCPv6 bindings");
      const filters: string[] = [];
      if (a.server_filter) filters.push(`server="${a.server_filter}"`);
      if (a.duid_filter) filters.push(`duid~"${a.duid_filter}"`);
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server binding print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCPv6 bindings found matching the criteria."
        : `DHCPV6 BINDINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_dhcp_binding",
    title: "Remove IPv6 DHCP Server Binding",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 DHCPv6 server binding (`/ipv6 dhcp-server binding remove`) identified by its RouterOS `.id` or by its client DUID. " +
      "Use to revoke a static prefix assignment or clear a stale dynamic lease. " +
      "The `.id` comes from list_ipv6_dhcp_bindings; supply either `.id` (e.g. '*1') or a DUID string — the tool tries `.id` first then falls back to DUID. " +
      "To remove the server itself use remove_ipv6_dhcp_server. " +
      "Returns a success or not-found message.",
    inputSchema: {
      binding_id: z.string().describe("RouterOS .id (e.g. '*1') or the DUID"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing DHCPv6 binding: binding_id=${a.binding_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ipv6 dhcp-server binding print count-only where .id="${a.binding_id}"`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ipv6 dhcp-server binding print count-only where duid="${a.binding_id}"`,
          ctx,
        );
        if (count.trim() === "0") return `DHCPv6 binding '${a.binding_id}' not found.`;
      }
      const selector = byId ? `.id="${a.binding_id}"` : `duid="${a.binding_id}"`;
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server binding remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCPv6 binding: ${result}`;
      return `DHCPv6 binding '${a.binding_id}' removed successfully.`;
    },
  }),

  // ── Options ─────────────────────────────────────────────────────────────────
  defineTool({
    name: "add_ipv6_dhcp_option",
    title: "Add IPv6 DHCP Server Option",
    annotations: WRITE,
    description:
      "Defines a named custom IPv6 DHCPv6 option (`/ipv6 dhcp-server option add`) by numeric option code and value. " +
      "Use to configure vendor-specific or non-standard DHCPv6 options that can then be referenced by name in create_ipv6_dhcp_server via the `dhcp_option` field. " +
      "For viewing existing options use list_ipv6_dhcp_options; to delete one use remove_ipv6_dhcp_option. " +
      "Returns the created option's detail or a completion notice.\n\n" +
      "Argument notes:\n" +
      "    code: numeric DHCPv6 option code (e.g. 23 for DNS recursive name server).\n" +
      "    value: option value; use '0x...' prefix for raw hex encoding.",
    inputSchema: {
      name: z.string(),
      code: z.number().int().describe("Numeric DHCPv6 option code"),
      value: z.string().describe("Option value (use '0x...' for raw hex)"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding DHCPv6 option: name=${a.name}, code=${a.code}`);
      const cmd = new Cmd("/ipv6 dhcp-server option add")
        .set("name", a.name)
        .set("code", a.code)
        .set("value", a.value)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add DHCPv6 option: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 dhcp-server option print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `DHCPv6 option added successfully:\n\n${details}`
        : "DHCPv6 option addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_dhcp_options",
    title: "List IPv6 DHCP Server Options",
    annotations: READ,
    description:
      "Lists all named custom IPv6 DHCPv6 option definitions (`/ipv6 dhcp-server option`) on the device. " +
      "Use to audit available option codes and values before referencing them in DHCPv6 server configurations via the `dhcp_option` field of create_ipv6_dhcp_server. " +
      "To add a new option use add_ipv6_dhcp_option; to delete one use remove_ipv6_dhcp_option. " +
      "Returns all matching option definitions; filterable by name substring.",
    inputSchema: { name_filter: z.string().optional() },
    async handler(a, ctx) {
      ctx.info("Listing DHCPv6 options");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server option print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCPv6 options found matching the criteria."
        : `DHCPV6 OPTIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_dhcp_option",
    title: "Remove IPv6 DHCP Server Option",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named custom IPv6 DHCPv6 option definition (`/ipv6 dhcp-server option remove`) after confirming it exists. " +
      "Note: removing an option that is still referenced by an active server's `dhcp_option` list will affect that server's advertised options. " +
      "For listing existing options use list_ipv6_dhcp_options; to add options use add_ipv6_dhcp_option. " +
      "Returns a success or not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCPv6 option: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ipv6 dhcp-server option print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `DHCPv6 option '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-server option remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCPv6 option: ${result}`;
      return `DHCPv6 option '${a.name}' removed successfully.`;
    },
  }),
];
