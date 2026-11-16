/** IP address pools — `/ip pool`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

interface UpdatePoolArgs {
  name: string;
  unset?: string[];
  new_name?: string;
  ranges?: string;
  next_pool?: string;
  comment?: string;
}

/** Shared `update_ip_pool` body, reused by `expand_ip_pool`. */
async function updatePool(
  a: UpdatePoolArgs,
  ctx: Parameters<typeof executeMikrotikCommand>[1],
): Promise<string> {
  ctx.info(`Updating IP pool: name=${a.name}`);
  const base = `/ip pool set [find name="${a.name}"]`;
  const cmd = new Cmd(base);
  if (a.new_name) cmd.set("name", a.new_name);
  if (a.ranges) cmd.set("ranges", a.ranges);
  if (a.next_pool !== undefined) {
    cmd.raw(a.next_pool === "" ? "!next-pool" : `next-pool=${quoteValue(a.next_pool)}`);
  }
  if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);

  const built = cmd.unset(a.unset).build();
  if (built === base) return "No updates specified.";

  const result = await executeMikrotikCommand(built, ctx);
  if (looksLikeError(result)) return `Failed to update IP pool: ${result}`;

  const detailsName = a.new_name || a.name;
  const details = await executeMikrotikCommand(
    `/ip pool print detail where name="${detailsName}"`,
    ctx,
  );
  return `IP pool updated successfully:\n\n${details}`;
}

export const ipPoolTools: ToolModule = [
  defineTool({
    name: "create_ip_pool",
    title: "Create IP Pool",
    annotations: WRITE,
    description:
      "Creates a named IPv4 address pool (`/ip pool`) — a set of IP ranges that DHCP servers" +
      " (via `address-pool`) and PPP/tunnel interfaces draw leases from. For full DHCP server" +
      " provisioning use `create_dhcp_server`. Ranges use hyphen notation" +
      " e.g. `192.168.1.1-192.168.1.100`; multiple ranges are comma-separated." +
      " Optionally chains to another pool via `next_pool` when this pool is exhausted." +
      " Returns the created pool's detail.",
    inputSchema: {
      name: z.string(),
      ranges: z
        .string()
        .describe(
          'Hyphen-separated range(s) e.g. "192.168.1.1-192.168.1.100". Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120"',
        ),
      next_pool: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IP pool: name=${a.name}, ranges=${a.ranges}`);
      const cmd = new Cmd("/ip pool add")
        .set("name", a.name)
        .set("ranges", a.ranges)
        .opt("next-pool", a.next_pool)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      const t = result.trim();
      if (t) {
        if (t.includes("*") || /^\d+$/.test(t)) {
          const details = await executeMikrotikCommand(
            `/ip pool print detail where name="${a.name}"`,
            ctx,
          );
          return details.trim()
            ? `IP pool created successfully:\n\n${details}`
            : `IP pool created with ID: ${result}`;
        }
        return `Failed to create IP pool: ${result}`;
      }
      const details = await executeMikrotikCommand(
        `/ip pool print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `IP pool created successfully:\n\n${details}`
        : "IP pool creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ip_pools",
    title: "List IP Pools",
    annotations: READ,
    description:
      "Lists all configured IPv4 address pools (`/ip pool print`) — the named range sets" +
      " used by DHCP and PPP/tunnel services as address sources. Supports substring filtering" +
      " by name or ranges. Set `include_used=true` to append a used-address count per pool" +
      " (issues a `/ip pool used print count-only` sub-query for each pool); for the full" +
      " per-lease allocation detail (with MAC and lease owner) use `list_ip_pool_used`." +
      " Returns all matching pool entries.",
    inputSchema: {
      name_filter: z.string().optional(),
      ranges_filter: z.string().optional(),
      include_used: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Listing IP pools with filters: name=${a.name_filter}, ranges=${a.ranges_filter}`);
      let cmd = "/ip pool print";
      if (a.include_used) cmd += " detail";

      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.ranges_filter) filters.push(`ranges~"${a.ranges_filter}"`);
      cmd += whereClause(filters);

      const result = await executeMikrotikCommand(cmd, ctx);
      if (isEmpty(result)) return "No IP pools found matching the criteria.";

      if (a.include_used) {
        const resultLines = result.trim().split("\n");
        const outputLines: string[] = [];
        for (const line of resultLines) {
          outputLines.push(line);
          if (line.includes("name=")) {
            const nameStart = line.indexOf('name="') + 6;
            const nameEnd = line.indexOf('"', nameStart);
            if (nameStart > 5 && nameEnd > nameStart) {
              const poolName = line.slice(nameStart, nameEnd);
              const usedCount = await executeMikrotikCommand(
                `/ip pool used print count-only where pool="${poolName}"`,
                ctx,
              );
              if (/^\d+$/.test(usedCount.trim()))
                outputLines.push(`      used-addresses=${usedCount.trim()}`);
            }
          }
        }
        return `IP POOLS:\n\n${outputLines.join("\n")}`;
      }

      return `IP POOLS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ip_pool",
    title: "Get IP Pool Details",
    annotations: READ,
    description:
      "Fetches full detail for a single named IPv4 pool (`/ip pool print detail`) including" +
      " its ranges, next-pool chain, comment, and currently used-address count" +
      " (`/ip pool used print count-only`). Takes the pool `name` (not an `.id`)." +
      " For a summary listing of all pools use `list_ip_pools`; for the individual" +
      " allocated addresses with MAC and lease-owner info use `list_ip_pool_used`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IP pool details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip pool print detail where name="${a.name}"`,
        ctx,
      );
      if (isEmpty(result)) return `IP pool '${a.name}' not found.`;

      const usedCount = await executeMikrotikCommand(
        `/ip pool used print count-only where pool="${a.name}"`,
        ctx,
      );
      if (/^\d+$/.test(usedCount.trim())) {
        return `IP POOL DETAILS:\n\n${result}\n      used-addresses=${usedCount.trim()}`;
      }
      return `IP POOL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ip_pool",
    title: "Update IP Pool",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing IPv4 pool (`/ip pool set`) — rename it, replace its full ranges" +
      " string, update the next-pool chain reference, or set a comment. Omit a field to leave" +
      ' it unchanged; pass `""` (empty string) for `next_pool` to clear the chained-pool' +
      " reference. Ranges use hyphen notation e.g. `192.168.1.1-192.168.1.100`, multiple" +
      " ranges comma-separated: `10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120`. To append ranges" +
      " without knowing the current set use `expand_ip_pool`. Returns the updated pool detail.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      new_name: z.string().optional(),
      ranges: z
        .string()
        .optional()
        .describe(
          'Hyphen-separated range(s) e.g. "192.168.1.1-192.168.1.100". Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120"',
        ),
      next_pool: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      return updatePool(a, ctx);
    },
  }),

  defineTool({
    name: "remove_ip_pool",
    title: "Remove IP Pool",
    annotations: DESTRUCTIVE,
    description:
      "Deletes a named IPv4 pool (`/ip pool remove`). Before removing, pre-checks that no" +
      " addresses are currently allocated from it (`/ip pool used print count-only`) and that" +
      " no DHCP server references it (`/ip dhcp-server print count-only`); returns an error" +
      " describing the blocker instead of deleting. To inspect active allocations first call" +
      " `list_ip_pool_used`; to see which DHCP servers reference the pool use `list_dhcp_servers`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IP pool: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ip pool print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `IP pool '${a.name}' not found.`;

      const usedCount = await executeMikrotikCommand(
        `/ip pool used print count-only where pool="${a.name}"`,
        ctx,
      );
      if (usedCount.trim() !== "0") {
        return `Cannot remove IP pool '${a.name}': ${usedCount.trim()} addresses are currently in use.`;
      }

      const dhcpCount = await executeMikrotikCommand(
        `/ip dhcp-server print count-only where address-pool="${a.name}"`,
        ctx,
      );
      if (dhcpCount.trim() !== "0") {
        return `Cannot remove IP pool '${a.name}': It is used by ${dhcpCount.trim()} DHCP server(s).`;
      }

      const result = await executeMikrotikCommand(`/ip pool remove [find name="${a.name}"]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IP pool: ${result}`;
      return `IP pool '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "list_ip_pool_used",
    title: "List IP Pool Allocated Addresses",
    annotations: READ,
    description:
      "Lists currently allocated (in-use) addresses from IPv4 pools (`/ip pool used print`)," +
      " showing pool name, IP address, MAC address, and lease owner (`info` field). Filterable" +
      " by pool name (exact), address substring, MAC address substring, or info substring." +
      " Use to diagnose address exhaustion or find which client holds a specific IP." +
      " For pool configuration (ranges, next-pool) use `list_ip_pools` or `get_ip_pool`.",
    inputSchema: {
      pool_name: z.string().optional(),
      address_filter: z.string().optional(),
      mac_filter: z.string().optional(),
      info_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Listing used IP pool addresses: pool=${a.pool_name}, address=${a.address_filter}`);
      const filters: string[] = [];
      if (a.pool_name) filters.push(`pool="${a.pool_name}"`);
      if (a.address_filter) filters.push(`address~"${a.address_filter}"`);
      if (a.mac_filter) filters.push(`mac-address~"${a.mac_filter}"`);
      if (a.info_filter) filters.push(`info~"${a.info_filter}"`);

      const result = await executeMikrotikCommand(
        `/ip pool used print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No used addresses found matching the criteria."
        : `USED IP POOL ADDRESSES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "expand_ip_pool",
    title: "Expand IP Pool Ranges",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Appends additional IPv4 ranges to an existing pool (`/ip pool set`) without requiring" +
      " the caller to know the current ranges — reads them first via `/ip pool print detail`," +
      " then writes the merged range list. Convenience wrapper over `update_ip_pool` for range" +
      " expansion; use `update_ip_pool` when you want to replace the full range set. Ranges use" +
      " hyphen notation e.g. `192.168.1.101-192.168.1.150`; multiple ranges comma-separated:" +
      " `10.0.0.51-10.0.0.60,10.0.0.70-10.0.0.80`. Returns the updated pool detail.",
    inputSchema: {
      name: z.string(),
      additional_ranges: z
        .string()
        .describe(
          'Hyphen-separated range(s) e.g. "192.168.1.101-192.168.1.150". Multiple ranges comma-separated: "10.0.0.51-10.0.0.60,10.0.0.70-10.0.0.80"',
        ),
    },
    async handler(a, ctx) {
      ctx.info(`Expanding IP pool: name=${a.name}, additional_ranges=${a.additional_ranges}`);
      const current = await executeMikrotikCommand(
        `/ip pool print detail where name="${a.name}"`,
        ctx,
      );
      if (!current || current.includes("no such item")) return `IP pool '${a.name}' not found.`;

      const match = current.match(/ranges=(\S+)/);
      if (!match) return "Unable to determine current ranges.";

      const newRanges = `${match[1]},${a.additional_ranges}`;
      return updatePool({ name: a.name, ranges: newRanges }, ctx);
    },
  }),
];
