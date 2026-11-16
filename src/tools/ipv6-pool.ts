/** IPv6 address/prefix pools — `/ipv6 pool`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

export const ipv6PoolTools: ToolModule = [
  defineTool({
    name: "create_ipv6_pool",
    title: "Create IPv6 Prefix Pool",
    annotations: WRITE,
    description:
      "Creates an IPv6 prefix pool (`/ipv6 pool`) — defines a large address block " +
      "from which smaller per-client prefix delegations are carved, typically used with " +
      "DHCPv6 prefix delegation (PD). " +
      "For IPv4 address pools use `create_ip_pool`. " +
      "`prefix` is the overall block (e.g. `2001:db8::/48`); " +
      "`prefix_length` is the size of each carved delegation (e.g. 64) and must be " +
      "longer than the pool prefix length. " +
      "Returns the created pool's full detail including name and prefix configuration.",
    inputSchema: {
      name: z.string(),
      prefix: z.string().describe("Overall block, e.g. '2001:db8::/48'"),
      prefix_length: z
        .number()
        .int()
        .min(1)
        .max(128)
        .describe("Size of each carved delegation, e.g. 64"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPv6 pool: name=${a.name}, prefix=${a.prefix}`);
      const cmd = new Cmd("/ipv6 pool add")
        .set("name", a.name)
        .set("prefix", a.prefix)
        .set("prefix-length", a.prefix_length)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPv6 pool: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 pool print detail where name="${a.name}"`,
        ctx,
      );
      return `IPv6 pool created successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_ipv6_pools",
    title: "List IPv6 Prefix Pools",
    annotations: READ,
    description:
      "Lists IPv6 prefix pools (`/ipv6 pool print`) — returns all defined pools, " +
      "optionally filtered by name or prefix substring. " +
      "For full detail on a single pool use `get_ipv6_pool`. " +
      "To see which prefixes have already been delegated from a pool use `list_ipv6_pool_used`. " +
      "For IPv4 address pools use `list_ip_pools`. " +
      "Returns pool names, prefixes, prefix-lengths, and comments.",
    inputSchema: {
      name_filter: z.string().optional(),
      prefix_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 pools");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.prefix_filter) filters.push(`prefix~"${a.prefix_filter}"`);

      const result = await executeMikrotikCommand(`/ipv6 pool print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No IPv6 pools found matching the criteria."
        : `IPV6 POOLS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_pool",
    title: "Get IPv6 Pool Details",
    annotations: READ,
    description:
      "Fetches full detail of a single IPv6 prefix pool (`/ipv6 pool print detail`) " +
      "identified by name — use when you need all fields for one pool rather than a summary list. " +
      "For scanning all pools use `list_ipv6_pools`. " +
      "To check active delegations handed out from a pool use `list_ipv6_pool_used`. " +
      "Returns the pool's prefix, prefix-length, comment, and all configuration fields.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 pool details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ipv6 pool print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 pool '${a.name}' not found.`
        : `IPV6 POOL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_ipv6_pool_used",
    title: "List IPv6 Pool Delegated Prefixes",
    annotations: READ,
    description:
      "Lists actively delegated prefixes from IPv6 pools (`/ipv6 pool used print`) — " +
      "shows which sub-prefixes have been handed out (e.g. via DHCPv6 prefix delegation) " +
      "and to which clients. This is the runtime usage view, not the pool definitions. " +
      "For the pool configuration itself use `list_ipv6_pools` or `get_ipv6_pool`. " +
      "Optionally filter by pool name substring (`pool_filter`). " +
      "Returns delegated prefix entries with pool name, prefix, and binding information.",
    inputSchema: {
      pool_filter: z.string().optional().describe("Partial pool-name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 pool usage");
      const filters: string[] = [];
      if (a.pool_filter) filters.push(`pool~"${a.pool_filter}"`);

      const result = await executeMikrotikCommand(
        `/ipv6 pool used print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 pool usage found matching the criteria."
        : `IPV6 POOL USAGE:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_pool",
    title: "Update IPv6 Prefix Pool",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing IPv6 prefix pool (`/ipv6 pool set`) — modifies the pool's " +
      "name, prefix block, delegation size, or comment. " +
      "Use `list_ipv6_pools` to find the current pool `name` before updating. " +
      'Pass comment="" to clear the comment. ' +
      "Returns the updated pool's full detail after the change.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      new_name: z.string().optional(),
      prefix: z.string().optional(),
      prefix_length: z.number().int().min(1).max(128).optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IPv6 pool: name=${a.name}`);
      const base = `/ipv6 pool set [find name="${a.name}"]`;
      const cmd = new Cmd(base);
      if (a.new_name) cmd.set("name", a.new_name);
      if (a.prefix) cmd.set("prefix", a.prefix);
      if (a.prefix_length !== undefined) cmd.set("prefix-length", a.prefix_length);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update IPv6 pool: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 pool print detail where name="${a.new_name || a.name}"`,
        ctx,
      );
      return `IPv6 pool updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_pool",
    title: "Remove IPv6 Prefix Pool",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes an IPv6 prefix pool (`/ipv6 pool remove`) by name. " +
      "Performs a count-only existence check first and returns an error if the pool is not found. " +
      "Active delegations visible via `list_ipv6_pool_used` may be disrupted. " +
      "Use `list_ipv6_pools` to confirm the exact pool name before removing. " +
      "Returns a success confirmation or an error message if the pool does not exist.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 pool: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ipv6 pool print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `IPv6 pool '${a.name}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 pool remove [find name="${a.name}"]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 pool: ${result}`;
      return `IPv6 pool '${a.name}' removed successfully.`;
    },
  }),
];
