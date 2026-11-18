/** DHCPv6 client — `/ipv6 dhcp-client`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

const Request = z.enum(["address", "prefix", "address,prefix"]);
const AddDefaultRoute = z.enum(["yes", "no", "special-classless"]);

export const ipv6DhcpClientTools: ToolModule = [
  defineTool({
    name: "add_ipv6_dhcp_client",
    title: "Add IPv6 DHCP Client",
    annotations: WRITE,
    description:
      "Adds an IPv6 DHCP client (`/ipv6 dhcp-client`) on a named interface so the router can request an IPv6 address and/or delegated prefix from an upstream DHCPv6 server (e.g. an ISP). " +
      "Use when the router is the DHCP *client*, not the server — for serving IPv6 addresses to downstream hosts use the DHCPv6 server tools. " +
      "Returns the new client's full detail print including its `.id` (use that `.id` in get_ipv6_dhcp_client, release_ipv6_dhcp_client, renew_ipv6_dhcp_client, or remove_ipv6_dhcp_client).\n\n" +
      "Notes:\n" +
      "    request: what to ask the server for — 'address', 'prefix', or 'address,prefix' (both).\n" +
      "    pool_name: when requesting a prefix, the delegated prefix is exposed\n" +
      "        as this IPv6 pool (used by '/ipv6 address from-pool').\n" +
      "    pool_prefix_length: per-interface prefix length carved from the pool,\n" +
      "        e.g. 64.\n" +
      "    prefix_hint: hint the desired delegated prefix, e.g. '::/56'.",
    inputSchema: {
      interface: z.string(),
      request: Request.default("prefix"),
      pool_name: z
        .string()
        .optional()
        .describe("Name of the IPv6 pool to expose the delegated prefix as"),
      pool_prefix_length: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .describe("Prefix length carved from the delegated pool, e.g. 64"),
      prefix_hint: z
        .string()
        .optional()
        .describe("Hint the desired delegated prefix, e.g. '::/56'"),
      add_default_route: AddDefaultRoute.optional(),
      default_route_distance: z.number().int().optional(),
      use_peer_dns: z.boolean().optional(),
      rapid_commit: z.boolean().optional(),
      dhcp_options: z.string().optional().describe("Comma-separated custom DHCP option names"),
      use_interface_duid: z
        .boolean()
        .optional()
        .describe("Use the interface MAC address to generate the DUID instead of the system DUID"),
      custom_duid: z
        .string()
        .optional()
        .describe("Override the DUID with a custom hex value, e.g. '0x00010001...'"),
      script: z
        .string()
        .optional()
        .describe("RouterOS script run on lease bind/release/renew events"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding DHCPv6 client: interface=${a.interface}`);
      const cmd = new Cmd("/ipv6 dhcp-client add")
        .set("interface", a.interface)
        .set("request", a.request)
        .opt("pool-name", a.pool_name)
        .opt("pool-prefix-length", a.pool_prefix_length)
        .opt("prefix-hint", a.prefix_hint)
        .opt("add-default-route", a.add_default_route)
        .opt("default-route-distance", a.default_route_distance)
        .bool("use-peer-dns", a.use_peer_dns)
        .bool("rapid-commit", a.rapid_commit)
        .opt("dhcp-options", a.dhcp_options)
        .bool("use-interface-duid", a.use_interface_duid)
        .opt("custom-duid", a.custom_duid)
        .opt("script", a.script)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add DHCPv6 client: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 dhcp-client print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return details.trim()
        ? `DHCPv6 client added successfully:\n\n${details}`
        : "DHCPv6 client addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_dhcp_clients",
    title: "List IPv6 DHCP Clients",
    annotations: READ,
    description:
      "Lists all IPv6 DHCP clients (`/ipv6 dhcp-client`) configured on the router — each entry is an interface on which the router requests an IPv6 address or delegated prefix from an upstream DHCPv6 server. " +
      "Supports filtering by interface name, status (e.g. 'bound', 'searching', 'stopped'), disabled state, or invalid state. " +
      "Returns all matching client entries with current status and lease/prefix info.",
    inputSchema: {
      interface_filter: z.string().optional(),
      status_filter: z
        .string()
        .optional()
        .describe("Match status, e.g. 'bound', 'searching', 'stopped'"),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing DHCPv6 clients");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.status_filter) filters.push(`status=${quoted(a.status_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCPv6 clients found matching the criteria."
        : `DHCPV6 CLIENTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_dhcp_client",
    title: "Get IPv6 DHCP Client Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPv6 DHCP client (`/ipv6 dhcp-client print detail`) by its `.id` (e.g. '*1') or interface name — the `.id` is available from list_ipv6_dhcp_clients. " +
      "Returns the complete detail print including status, lease times, assigned address, and delegated prefix.",
    inputSchema: {
      client_id: z.string().describe("RouterOS .id (e.g. '*1') or the interface name"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting DHCPv6 client details: client_id=${a.client_id}`);
      let result = await executeMikrotikCommand(
        `/ipv6 dhcp-client print detail where .id=${quoted(a.client_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ipv6 dhcp-client print detail where interface=${quoted(a.client_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `DHCPv6 client '${a.client_id}' not found.`
        : `DHCPV6 CLIENT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "release_ipv6_dhcp_client",
    title: "Release IPv6 DHCP Client Lease",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Releases the current IPv6 DHCP address/prefix lease for a client (`/ipv6 dhcp-client release`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. " +
      "Causes the client to stop using the assigned address or delegated prefix and notify the server. " +
      "To immediately re-acquire a lease use renew_ipv6_dhcp_client instead.",
    inputSchema: { client_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Releasing DHCPv6 client: client_id=${a.client_id}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-client release [find interface=${quoted(a.client_id)} or .id=${quoted(a.client_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to release DHCPv6 client: ${result}`;
      return `DHCPv6 client '${a.client_id}' released.`;
    },
  }),

  defineTool({
    name: "renew_ipv6_dhcp_client",
    title: "Renew IPv6 DHCP Client Lease",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Renews the IPv6 DHCP address/prefix lease for a client (`/ipv6 dhcp-client renew`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. " +
      "Sends a DHCPv6 RENEW message to refresh the assignment without releasing it first. " +
      "To give up the lease first use release_ipv6_dhcp_client.",
    inputSchema: { client_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Renewing DHCPv6 client: client_id=${a.client_id}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-client renew [find interface=${quoted(a.client_id)} or .id=${quoted(a.client_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to renew DHCPv6 client: ${result}`;
      return `DHCPv6 client '${a.client_id}' renew requested.`;
    },
  }),

  defineTool({
    name: "remove_ipv6_dhcp_client",
    title: "Remove IPv6 DHCP Client",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 DHCP client entry (`/ipv6 dhcp-client remove`) identified by `.id` or interface name — the `.id` is available from list_ipv6_dhcp_clients. " +
      "After removal the router will no longer request IPv6 address or prefix on that interface. " +
      "Confirms existence before attempting removal and returns an error if the client is not found.",
    inputSchema: { client_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCPv6 client: client_id=${a.client_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ipv6 dhcp-client print count-only where .id=${quoted(a.client_id)}`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ipv6 dhcp-client print count-only where interface=${quoted(a.client_id)}`,
          ctx,
        );
        if (count.trim() === "0") return `DHCPv6 client '${a.client_id}' not found.`;
      }
      const selector = byId ? `.id=${quoted(a.client_id)}` : `interface=${quoted(a.client_id)}`;
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-client remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCPv6 client: ${result}`;
      return `DHCPv6 client '${a.client_id}' removed successfully.`;
    },
  }),
];
