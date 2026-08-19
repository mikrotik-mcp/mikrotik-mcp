/** IP routing table — `/ip route`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  yesno,
  whereClause,
  routeTypeArg,
  quoteValue,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
} from "../core/routeros";
import { notFoundMessage, ruleResolver } from "./_resolve-rule-id";

/**
 * `/ip route` ids move. Every add/remove renumbers the row positions, and a
 * `.id` can be reassigned over time, so a `route_id` is resolved to a concrete
 * `.id` immediately before it is used — never interpolated straight into a
 * command. Without this, `set <N>` edits row N while the verification read
 * (`where .id=<N>`) matches nothing, so the tool edits one route and reports
 * another.
 */
const resolveRouteId = ruleResolver("/ip route");

const routeNotFound = (id: string): string => notFoundMessage("Route", id, "list_routes");

/**
 * RouterOS v7 dropped v6's `type=` property on `/ip route`: `blackhole` is a
 * bare keyword and `unreachable`/`prohibit` no longer exist (see routeTypeArg).
 */
const RouteType = z.enum(["unicast", "blackhole"]);

interface AddRouteArgs {
  dst_address: string;
  gateway: string;
  distance?: number;
  scope?: number;
  target_scope?: number;
  routing_table?: string;
  routing_mark?: string;
  comment?: string;
  disabled?: boolean;
  vrf_interface?: string;
  pref_src?: string;
  check_gateway?: string;
  suppress_hw_offload?: boolean;
  type?: "unicast" | "blackhole";
}

/** Shared `add_route` body, reused by `add_default_route`. */
async function addRoute(
  a: AddRouteArgs,
  ctx: Parameters<typeof executeMikrotikCommand>[1],
): Promise<string> {
  ctx.info(`Adding route: dst=${a.dst_address}, gateway=${a.gateway}`);
  const cmd = new Cmd("/ip route add")
    .set("dst-address", a.dst_address)
    .set("gateway", a.gateway)
    .opt("distance", a.distance)
    .opt("scope", a.scope)
    .opt("target-scope", a.target_scope)
    // RouterOS v7 renamed the route's `routing-mark` property to `routing-table`
    // (v6's name is accepted here as a deprecated alias for back-compat).
    .opt("routing-table", a.routing_table ?? a.routing_mark)
    .opt("comment", a.comment)
    .flag("disabled", a.disabled)
    .opt("vrf-interface", a.vrf_interface)
    .opt("pref-src", a.pref_src)
    .opt("check-gateway", a.check_gateway)
    .bool("suppress-hw-offload", a.suppress_hw_offload)
    .raw(routeTypeArg(a.type))
    .build();

  const result = await executeMikrotikCommand(cmd, ctx);
  const t = result.trim();
  if (t) {
    if (t.includes("*") || /^\d+$/.test(t)) {
      const details = await executeMikrotikCommand(`/ip route print detail where .id=${t}`, ctx);
      return details.trim()
        ? `Route added successfully:\n\n${details}`
        : `Route added with ID: ${result}`;
    }
    return `Failed to add route: ${result}`;
  }
  const details = await executeMikrotikCommand(
    `/ip route print detail where dst-address="${a.dst_address}" and gateway="${a.gateway}"`,
    ctx,
  );
  return details.trim()
    ? `Route added successfully:\n\n${details}`
    : "Route addition completed but unable to verify.";
}

/** Shared enable/disable body for a single route. */
async function setRouteDisabled(
  routeId: string,
  disabled: boolean,
  ctx: Parameters<typeof executeMikrotikCommand>[1],
): Promise<string> {
  ctx.info(`Updating route: route_id=${routeId}`);
  const id = await resolveRouteId(routeId, ctx);
  if (!id) return routeNotFound(routeId);
  const result = await executeMikrotikCommand(
    `/ip route set ${id} disabled=${yesno(disabled)}`,
    ctx,
  );
  if (looksLikeError(result)) return `Failed to update route: ${result}`;
  const details = await executeMikrotikCommand(`/ip route print detail where .id=${id}`, ctx);
  return `Route updated successfully:\n\n${details}`;
}

export const routeTools: ToolModule = [
  defineTool({
    name: "add_route",
    title: "Add IPv4 Static Route",
    annotations: WRITE,
    description:
      "Adds an IPv4 static route (`/ip route add`) to the routing table — use this to define any " +
      "non-default unicast next-hop (host, subnet, or summarized prefix). " +
      "For the 0.0.0.0/0 default gateway use add_default_route; for null/drop routes use " +
      "add_blackhole_route; for IPv6 use add_ipv6_route. " +
      "`distance` sets priority (1–255, lower wins); `routing_table` assigns the route to a " +
      'policy-routing table (must already exist — see add_routing_table); `check_gateway` ("ping" ' +
      'or "arp") enables active gateway monitoring. ' +
      "Returns the created route's detail including its `.id`.",
    inputSchema: {
      dst_address: z.string().describe('CIDR e.g. "0.0.0.0/0", "192.168.1.0/24"'),
      gateway: z.string(),
      distance: z.number().int().optional().describe("1-255 (lower = higher priority)"),
      scope: z.number().int().optional(),
      target_scope: z.number().int().optional(),
      routing_table: z
        .string()
        .optional()
        .describe('Policy-routing table name, e.g. "main" or a custom table (RouterOS v7)'),
      routing_mark: z
        .string()
        .optional()
        .describe("Deprecated alias for routing_table (RouterOS v6 name)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      vrf_interface: z.string().optional(),
      pref_src: z.string().optional(),
      check_gateway: z.string().optional().describe('"ping" or "arp"'),
      suppress_hw_offload: z
        .boolean()
        .optional()
        .describe("Exclude route from hardware (HW) offloading"),
      type: RouteType.optional().describe(
        '"unicast" (default) or "blackhole" (drop silently). RouterOS v7 has no ' +
          '"unreachable"/"prohibit" route types.',
      ),
    },
    async handler(a, ctx) {
      return addRoute(a, ctx);
    },
  }),

  defineTool({
    name: "list_routes",
    title: "List IPv4 Routes",
    annotations: READ,
    description:
      "Lists IPv4 routes from `/ip route` with optional filters — the primary tool for inspecting " +
      "what routes the router knows. `dst_filter` and `gateway_filter` do substring matching; " +
      "`routing_table_filter` and `distance_filter` do exact matching; " +
      "`active_only`/`disabled_only`/`dynamic_only`/`static_only` are boolean flags. " +
      "For a table-scoped view of active routes use get_routing_table; for counts and summary stats " +
      "use get_route_statistics; for IPv6 use list_ipv6_routes. " +
      "Returns all matching route entries.",
    inputSchema: {
      dst_filter: z.string().optional(),
      gateway_filter: z.string().optional(),
      routing_table_filter: z
        .string()
        .optional()
        .describe("Exact policy-routing table name (RouterOS v7)"),
      routing_mark_filter: z
        .string()
        .optional()
        .describe("Deprecated alias for routing_table_filter"),
      distance_filter: z.number().int().optional(),
      active_only: z.boolean().default(false),
      disabled_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
      static_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Listing routes with filters: dst=${a.dst_filter}, gateway=${a.gateway_filter}`);
      const filters: string[] = [];
      if (a.dst_filter) filters.push(`dst-address~"${a.dst_filter}"`);
      if (a.gateway_filter) filters.push(`gateway~"${a.gateway_filter}"`);
      const tableFilter = a.routing_table_filter ?? a.routing_mark_filter;
      if (tableFilter) filters.push(`routing-table="${tableFilter}"`);
      if (a.distance_filter !== undefined) filters.push(`distance=${a.distance_filter}`);
      if (a.active_only) filters.push("active=yes");
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");
      if (a.static_only) filters.push("static=yes");

      const result = await executeMikrotikCommand(`/ip route print${whereClause(filters)}`, ctx);
      return isEmpty(result) ? "No routes found matching the criteria." : `ROUTES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_route",
    title: "Get IPv4 Route Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single IPv4 route (`/ip route print detail where .id=…`) — " +
      "use this after list_routes to inspect one entry's flags, nexthop, distance, scope, and " +
      "all attributes. `route_id` is the `*N` or `N` `.id` value from list_routes. " +
      "For listing multiple routes use list_routes; for a table-scoped view use get_routing_table. " +
      "Returns the complete detail block for that route, or a not-found message.",
    inputSchema: {
      route_id: z.string().describe('"*N" or "N" from list output e.g. "*3"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting route details: route_id=${a.route_id}`);
      const id = await resolveRouteId(a.route_id, ctx);
      if (!id) return routeNotFound(a.route_id);
      const result = await executeMikrotikCommand(`/ip route print detail where .id=${id}`, ctx);
      return isEmpty(result) ? routeNotFound(a.route_id) : `ROUTE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_route",
    title: "Update IPv4 Route",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing IPv4 static route (`/ip route set`) — change its gateway, dst-address, " +
      "distance, scope, routing-table, VRF interface, preferred-source, or gateway check method. " +
      "`route_id` is the `*N` `.id` from list_routes. " +
      'Pass an empty string ("") for `routing_table`, `vrf_interface`, or `pref_src` to clear those fields. ' +
      "For toggling active state without editing attributes use enable_route / disable_route. " +
      "Returns the updated route detail.",
    inputSchema: {
      route_id: z.string().describe('"*N" or "N" from list output e.g. "*3"'),
      dst_address: z.string().optional().describe('CIDR e.g. "192.168.1.0/24"'),
      gateway: z.string().optional(),
      distance: z.number().int().optional().describe("1-255"),
      scope: z.number().int().optional(),
      target_scope: z.number().int().optional(),
      routing_table: z
        .string()
        .optional()
        .describe('Policy-routing table name (RouterOS v7); "" clears it'),
      routing_mark: z
        .string()
        .optional()
        .describe("Deprecated alias for routing_table (RouterOS v6 name)"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      vrf_interface: z.string().optional(),
      pref_src: z.string().optional(),
      check_gateway: z.string().optional().describe('"ping" or "arp"'),
      suppress_hw_offload: z
        .boolean()
        .optional()
        .describe("Exclude route from hardware (HW) offloading"),
      type: RouteType.optional().describe(
        '"blackhole" makes the route drop traffic; "unicast" turns a blackhole route back into a ' +
          "normal next-hop route.",
      ),
    },
    async handler(a, ctx) {
      ctx.info(`Updating route: route_id=${a.route_id}`);
      const id = await resolveRouteId(a.route_id, ctx);
      if (!id) return routeNotFound(a.route_id);
      const base = `/ip route set ${id}`;
      const cmd = new Cmd(base);
      if (a.dst_address) cmd.set("dst-address", a.dst_address);
      if (a.gateway) cmd.set("gateway", a.gateway);
      if (a.distance !== undefined) cmd.set("distance", a.distance);
      if (a.scope !== undefined) cmd.set("scope", a.scope);
      if (a.target_scope !== undefined) cmd.set("target-scope", a.target_scope);
      // v7 property is `routing-table`; `routing_mark` is the v6-named alias.
      const table = a.routing_table ?? a.routing_mark;
      if (table !== undefined) {
        cmd.raw(table === "" ? "!routing-table" : `routing-table=${quoteValue(table)}`);
      }
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);
      if (a.vrf_interface !== undefined) {
        cmd.raw(
          a.vrf_interface === ""
            ? "!vrf-interface"
            : `vrf-interface=${quoteValue(a.vrf_interface)}`,
        );
      }
      if (a.pref_src !== undefined) {
        cmd.raw(a.pref_src === "" ? "!pref-src" : `pref-src=${quoteValue(a.pref_src)}`);
      }
      if (a.check_gateway !== undefined) cmd.raw(`check-gateway=${quoteValue(a.check_gateway)}`);
      if (a.suppress_hw_offload !== undefined)
        cmd.bool("suppress-hw-offload", a.suppress_hw_offload);
      if (a.type !== undefined) cmd.raw(routeTypeArg(a.type, true));

      const built = cmd.build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update route: ${result}`;

      const details = await executeMikrotikCommand(`/ip route print detail where .id=${id}`, ctx);
      // Name the resolved .id: when the caller passed a row position, this is
      // the only way they can tell WHICH route actually changed.
      return `Route ${id} updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_route",
    title: "Remove IPv4 Route",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv4 route (`/ip route remove`) — verifies the entry exists first " +
      "(count-only check) then removes it. `route_id` is the `*N` `.id` from list_routes. " +
      "To temporarily take a route out of service without deleting it use disable_route instead. " +
      "Confirms deletion or reports not-found.",
    inputSchema: {
      route_id: z.string().describe('"*N" or "N" from list output e.g. "*3"'),
    },
    async handler(a, ctx) {
      ctx.info(`Removing route: route_id=${a.route_id}`);
      const id = await resolveRouteId(a.route_id, ctx);
      if (!id) return routeNotFound(a.route_id);

      // Show what is about to be deleted, resolved to its .id — a row position
      // that drifted between the caller's list and this call would otherwise
      // delete a neighbouring route with no trace of which one it was.
      const doomed = await executeMikrotikCommand(`/ip route print detail where .id=${id}`, ctx);
      const result = await executeMikrotikCommand(`/ip route remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove route: ${result}`;
      return `Route ${id} removed successfully. Removed entry was:\n\n${doomed}`;
    },
  }),

  defineTool({
    name: "enable_route",
    title: "Enable IPv4 Route",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Activates a disabled IPv4 route (`/ip route set disabled=no`) — makes it eligible for " +
      "route selection without altering any other attributes. " +
      "`route_id` is the `*N` `.id` from list_routes. " +
      "To deactivate a route use disable_route; to remove it permanently use remove_route. " +
      "Returns the updated route detail.",
    inputSchema: {
      route_id: z.string().describe('"*N" or "N" from list output e.g. "*3"'),
    },
    async handler(a, ctx) {
      return setRouteDisabled(a.route_id, false, ctx);
    },
  }),

  defineTool({
    name: "disable_route",
    title: "Disable IPv4 Route",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates an IPv4 route (`/ip route set disabled=yes`) — removes it from route selection " +
      "without deleting it so it can be re-enabled later. " +
      "`route_id` is the `*N` `.id` from list_routes. " +
      "To re-activate use enable_route; to permanently delete use remove_route. " +
      "Returns the updated route detail.",
    inputSchema: {
      route_id: z.string().describe('"*N" or "N" from list output e.g. "*3"'),
    },
    async handler(a, ctx) {
      return setRouteDisabled(a.route_id, true, ctx);
    },
  }),

  defineTool({
    name: "get_routing_table",
    title: "Get IPv4 Routing Table by Name",
    annotations: READ,
    description:
      "Reads IPv4 route entries scoped by routing table (`/ip route print`) — for any `table_name` " +
      'other than "main" adds `where routing-table=<name>`; for the implicit default "main" table ' +
      "the routing-table filter is omitted (routes without an explicit table belong to main). " +
      'Designed for policy-routing setups with multiple tables (e.g. "main", "ISP1", "ISP2"). ' +
      'Filters by `table_name` (default "main"), optional `protocol_filter`, and `active_only` ' +
      "(default true, showing only routes currently used for forwarding). " +
      "For an unfiltered list across all tables use list_routes; for total/active/static counts " +
      "use get_route_statistics. Returns matching route entries from the specified table.",
    inputSchema: {
      table_name: z.string().default("main"),
      protocol_filter: z.string().optional(),
      active_only: z.boolean().default(true),
    },
    async handler(a, ctx) {
      ctx.info(`Getting routing table: table=${a.table_name}`);
      const filters: string[] = [];
      if (a.table_name && a.table_name !== "main") filters.push(`routing-table="${a.table_name}"`);
      if (a.protocol_filter) filters.push(`protocol="${a.protocol_filter}"`);
      if (a.active_only) filters.push("active=yes");

      const result = await executeMikrotikCommand(`/ip route print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? `No routes found in table '${a.table_name}'.`
        : `ROUTING TABLE (${a.table_name}):\n\n${result}`;
    },
  }),

  defineTool({
    name: "check_route_path",
    title: "Check IPv4 Route Path",
    annotations: READ,
    description:
      "Resolves which nexthop RouterOS would use for a given IPv4 destination " +
      '— answers "which gateway will this packet take?" without sending any traffic. ' +
      "Version-aware: uses `/ip route check` on v6, falls back to " +
      "`/ip route print where <dest> in dst-address active=yes` on v7+ where the check " +
      "command was removed. Optionally scoped by `routing_table` (v7) / `routing_mark` (v6) " +
      "for policy-routing table lookups. " +
      "For listing all known routes use list_routes; for a named-table view use get_routing_table. " +
      "Returns the resolved nexthop and interface detail.",
    inputSchema: {
      destination: z.string(),
      routing_table: z
        .string()
        .optional()
        .describe('Policy-routing table name (v7) or routing-mark (v6), e.g. "VPN"'),
    },
    async handler(a, ctx) {
      ctx.info(`Checking route path to: ${a.destination}`);
      const table = a.routing_table;

      // v6: `/ip route check <dest>` — simple, no src-address parameter.
      const v6Cmd = new Cmd(`/ip route check ${a.destination}`).opt("routing-mark", table).build();
      const v6Result = await executeMikrotikCommand(v6Cmd, ctx);
      if (!commandUnsupported(v6Result) && !looksLikeError(v6Result) && !isEmpty(v6Result)) {
        return `ROUTE PATH TO ${a.destination}:\n\n${v6Result}`;
      }

      // v7+: `/ip route check` was removed — query active routes instead.
      // `<dest> in dst-address` finds routes whose prefix COVERS the target
      // (e.g. 0.0.0.0/0 covers 8.8.8.8).  The old `dst-address in <dest>`
      // was backwards — it checked if the route prefix was a SUBSET of the
      // target, so only an exact /32 match ever returned.
      // Routes in the default "main" table carry no explicit `routing-table`
      // property, so filtering by `routing-table=main` returns nothing —
      // omit the filter for "main" (same logic as get_routing_table).
      const where = [`${a.destination} in dst-address`, "active=yes"];
      if (table && table !== "main") where.push(`routing-table=${quoteValue(table)}`);
      const v7Cmd = `/ip route print detail where ${where.join(" ")}`;
      const v7Result = await executeMikrotikCommand(v7Cmd, ctx);
      if (looksLikeError(v7Result)) return `Failed to check route to ${a.destination}: ${v7Result}`;
      if (isEmpty(v7Result)) {
        return `No active route to ${a.destination}${table ? ` in table '${table}'` : ""}.`;
      }
      return `ROUTE PATH TO ${a.destination}:\n\n${v7Result}`;
    },
  }),

  defineTool({
    name: "get_route_cache",
    title: "Get IPv4 Route Cache / Forwarding Table",
    annotations: READ,
    description:
      "Shows the IPv4 route cache or active forwarding table — version-aware: on RouterOS v6 reads " +
      "the real per-flow route cache (`/ip route cache print`); on v7+ (where the cache was removed) " +
      "returns active `/ip route` entries with active=yes (the FIB equivalent). " +
      "Use this to inspect what the dataplane is actually forwarding. " +
      "For all routes including inactive/disabled entries use list_routes. " +
      "Returns cache entries (v6) or active forwarding-table entries (v7+).",
    async handler(_a, ctx) {
      ctx.info("Getting route cache");
      // v6: a real per-flow route cache exists.
      const cache = await executeMikrotikCommand("/ip route cache print", ctx);
      if (!commandUnsupported(cache)) {
        if (looksLikeError(cache)) return `Failed to get route cache: ${cache}`;
        return isEmpty(cache) ? "Route cache is empty." : `ROUTE CACHE:\n\n${cache}`;
      }
      // v7+: the cache was removed — the forwarding table is the active routes (FIB).
      const fib = await executeMikrotikCommand("/ip route print where active=yes", ctx);
      if (looksLikeError(fib)) return `Failed to read forwarding table: ${fib}`;
      return isEmpty(fib)
        ? "No active routes in the forwarding table."
        : `ACTIVE FORWARDING TABLE (RouterOS v7+ has no separate route cache; showing active /ip route entries):\n\n${fib}`;
    },
  }),

  defineTool({
    name: "flush_route_cache",
    title: "Flush IPv4 Route Cache",
    annotations: DESTRUCTIVE,
    description:
      "Clears the IPv4 per-flow route cache (`/ip route cache flush`) — forces the dataplane to " +
      "re-resolve nexthops from the routing table, useful after manual route changes that have not " +
      "yet propagated to the cache. " +
      "Version-aware: on RouterOS v7+ there is no separate cache (the FIB is rebuilt directly from " +
      "`/ip route`), so this is a no-op and reports accordingly. " +
      "To view the current cache before flushing use get_route_cache.",
    async handler(_a, ctx) {
      ctx.info("Flushing route cache");
      const result = await executeMikrotikCommand("/ip route cache flush", ctx);
      if (commandUnsupported(result)) {
        return "No route cache to flush — RouterOS v7+ has no separate route cache (the forwarding table is rebuilt from /ip route directly), so this is a no-op.";
      }
      if (looksLikeError(result)) return `Failed to flush route cache: ${result}`;
      return result.trim() ? `Flush result: ${result}` : "Route cache flushed successfully.";
    },
  }),

  defineTool({
    name: "add_default_route",
    title: "Add IPv4 Default Route",
    annotations: WRITE,
    description:
      "Adds an IPv4 default route (`/ip route add dst-address=0.0.0.0/0`) with gateway health " +
      "monitoring — a convenience wrapper around add_route fixed to the 0.0.0.0/0 prefix. " +
      '`check_gateway` defaults to "ping" (active gateway probing); set `distance` to control ' +
      "failover priority when multiple default routes exist. " +
      "For any other prefix use add_route; for null/drop routes use add_blackhole_route; " +
      "for IPv6 use add_ipv6_route. Returns the created route detail including its `.id`.",
    inputSchema: {
      gateway: z.string(),
      distance: z.number().int().default(1),
      comment: z.string().optional(),
      check_gateway: z.string().default("ping"),
    },
    async handler(a, ctx) {
      return addRoute(
        {
          dst_address: "0.0.0.0/0",
          gateway: a.gateway,
          distance: a.distance,
          comment: a.comment || "Default route",
          check_gateway: a.check_gateway,
        },
        ctx,
      );
    },
  }),

  defineTool({
    name: "add_blackhole_route",
    title: "Add IPv4 Blackhole Route",
    annotations: WRITE,
    description:
      "Adds an IPv4 null/blackhole route (`/ip route add … blackhole`) — traffic to `dst_address` " +
      "is silently dropped at the routing layer without generating an ICMP unreachable. " +
      "Used for traffic engineering, bogon suppression, or null-routing abusive prefixes. " +
      "For a normal next-hop route use add_route; for a default gateway use add_default_route. " +
      "Returns the created route's `.id` on success.",
    inputSchema: {
      dst_address: z.string().describe('CIDR e.g. "10.0.0.0/8"'),
      distance: z.number().int().default(1).describe("1-255"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding blackhole route: dst=${a.dst_address}`);
      const cmd = new Cmd("/ip route add")
        .set("dst-address", a.dst_address)
        .raw("blackhole")
        .set("distance", a.distance)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      const t = result.trim();
      if (t) {
        if (t.includes("*") || /^\d+$/.test(t))
          return `Blackhole route added successfully. ID: ${result}`;
        return `Failed to add blackhole route: ${result}`;
      }
      return "Blackhole route added successfully.";
    },
  }),

  defineTool({
    name: "get_route_statistics",
    title: "Get IPv4 Route Statistics",
    annotations: READ,
    description:
      "Returns a count summary of the IPv4 routing table (`/ip route print count-only`) broken down " +
      "by total, active, dynamic, static, and disabled entries — a fast health-check without " +
      "returning the full route list. " +
      "For the actual route entries use list_routes; for a named-table view use get_routing_table. " +
      "Returns a formatted ROUTE STATISTICS block with five counters.",
    async handler(_a, ctx) {
      ctx.info("Getting route statistics");
      const total = await executeMikrotikCommand("/ip route print count-only", ctx);
      const active = await executeMikrotikCommand(
        "/ip route print count-only where active=yes",
        ctx,
      );
      const dynamic = await executeMikrotikCommand(
        "/ip route print count-only where dynamic=yes",
        ctx,
      );
      const staticCount = await executeMikrotikCommand(
        "/ip route print count-only where static=yes",
        ctx,
      );
      const disabled = await executeMikrotikCommand(
        "/ip route print count-only where disabled=yes",
        ctx,
      );

      const stats = [
        `Total routes: ${total.trim()}`,
        `Active routes: ${active.trim()}`,
        `Dynamic routes: ${dynamic.trim()}`,
        `Static routes: ${staticCount.trim()}`,
        `Disabled routes: ${disabled.trim()}`,
      ];

      return `ROUTE STATISTICS:\n\n${stats.join("\n")}`;
    },
  }),
];
