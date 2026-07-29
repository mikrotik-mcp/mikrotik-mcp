/** IPv6 routing table — `/ipv6 route`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, routeTypeArg, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";

/** Same v7 reality as `/ip route`: bare `blackhole`, no unreachable/prohibit. */
const RouteType = z.enum(["unicast", "blackhole"]);

interface AddIpv6RouteArgs {
  dst_address: string;
  gateway?: string;
  type?: "unicast" | "blackhole";
  distance?: number;
  scope?: number;
  target_scope?: number;
  routing_table?: string;
  pref_src?: string;
  check_gateway?: string;
  vrf_interface?: string;
  route_tag?: number;
  suppress_hw_offload?: boolean;
  comment?: string;
  disabled?: boolean;
}

/** Shared `add_ipv6_route` body, reused by `add_ipv6_default_route`. */
async function addIpv6Route(a: AddIpv6RouteArgs, ctx: ToolContext): Promise<string> {
  ctx.info(`Adding IPv6 route: dst=${a.dst_address}, gateway=${a.gateway}`);
  const cmd = new Cmd("/ipv6 route add")
    .set("dst-address", a.dst_address)
    .opt("gateway", a.gateway)
    .raw(routeTypeArg(a.type))
    .opt("distance", a.distance)
    .opt("scope", a.scope)
    .opt("target-scope", a.target_scope)
    .opt("routing-table", a.routing_table)
    .opt("pref-src", a.pref_src)
    .opt("check-gateway", a.check_gateway)
    .opt("vrf-interface", a.vrf_interface)
    .opt("route-tag", a.route_tag)
    .bool("suppress-hw-offload", a.suppress_hw_offload)
    .opt("comment", a.comment)
    .flag("disabled", a.disabled)
    .build();

  const result = await executeMikrotikCommand(cmd, ctx);
  const t = result.trim();
  if (t) {
    if (t.includes("*") || /^\d+$/.test(t)) {
      const details = await executeMikrotikCommand(`/ipv6 route print detail where .id=${t}`, ctx);
      return details.trim()
        ? `IPv6 route added successfully:\n\n${details}`
        : `IPv6 route added with ID: ${result}`;
    }
    return `Failed to add IPv6 route: ${result}`;
  }
  const details = await executeMikrotikCommand(
    `/ipv6 route print detail where dst-address="${a.dst_address}"`,
    ctx,
  );
  return details.trim()
    ? `IPv6 route added successfully:\n\n${details}`
    : "IPv6 route addition completed but unable to verify.";
}

/** Shared enable/disable body for a single IPv6 route. */
async function setIpv6RouteDisabled(
  routeId: string,
  disabled: boolean,
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating IPv6 route: route_id=${routeId}`);
  const result = await executeMikrotikCommand(
    `/ipv6 route set ${routeId} disabled=${yesno(disabled)}`,
    ctx,
  );
  if (looksLikeError(result)) return `Failed to update IPv6 route: ${result}`;
  return `IPv6 route '${routeId}' ${disabled ? "disabled" : "enabled"}.`;
}

export const ipv6RouteTools: ToolModule = [
  defineTool({
    name: "add_ipv6_route",
    title: "Add IPv6 Static Route",
    annotations: WRITE,
    description:
      "Adds an IPv6 static route (`/ipv6 route add`) to the routing table — " +
      "use to configure next-hop forwarding, black-hole drops, or VRF-targeted routes for IPv6 prefixes. " +
      "For the IPv4 equivalent use add_route. " +
      "To set the gateway-of-last-resort (::/0) use add_ipv6_default_route instead. " +
      "Returns the created route's full detail including its `.id`.\n\n" +
      "Notes:\n" +
      "    dst_address: destination prefix, e.g. '2001:db8:1::/64'.\n" +
      "    type: 'unicast' (default) routes via gateway; 'blackhole' discards\n" +
      "        traffic (no gateway needed). RouterOS v7 has no 'unreachable'/'prohibit'.\n" +
      "    routing_table: target a named routing table/FIB.",
    inputSchema: {
      dst_address: z.string().describe("Destination prefix, e.g. '2001:db8:1::/64'"),
      gateway: z
        .string()
        .optional()
        .describe("Next-hop IPv6 address or interface (required for unicast)"),
      type: RouteType.optional(),
      distance: z.number().int().min(1).max(255).optional(),
      scope: z.number().int().min(0).max(255).optional(),
      target_scope: z.number().int().min(0).max(255).optional(),
      routing_table: z.string().optional(),
      pref_src: z.string().optional(),
      check_gateway: z.string().optional().describe("'ping', 'arp', 'bfd' or 'none'"),
      vrf_interface: z.string().optional(),
      route_tag: z.number().int().optional().describe("Route tag for matching in routing filters"),
      suppress_hw_offload: z
        .boolean()
        .optional()
        .describe("Disable hardware offloading for this route"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      return addIpv6Route(a, ctx);
    },
  }),

  defineTool({
    name: "add_ipv6_default_route",
    title: "Add IPv6 Default Route",
    annotations: WRITE,
    description:
      "Adds an IPv6 default route (::/0) (`/ipv6 route add`) via the specified gateway — " +
      "shortcut for setting the gateway-of-last-resort for all IPv6 traffic with no more-specific match. " +
      "For a non-default prefix use add_ipv6_route. " +
      "For the IPv4 default route use add_default_route. " +
      "Returns the created route's full detail including its `.id`.",
    inputSchema: {
      gateway: z.string().describe("Next-hop IPv6 address or interface"),
      distance: z.number().int().min(1).max(255).optional(),
      check_gateway: z.string().optional(),
      routing_table: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      return addIpv6Route({ ...a, dst_address: "::/0" }, ctx);
    },
  }),

  defineTool({
    name: "list_ipv6_routes",
    title: "List IPv6 Routes",
    annotations: READ,
    description:
      "Lists IPv6 routes (`/ipv6 route print`) from the routing table — " +
      "use to inspect static and dynamic IPv6 routes and obtain `.id` values for get/remove/enable/disable operations. " +
      "For IPv4 routes use list_routes. For policy routing rules use list_routing_rules. " +
      "Accepts optional filters: dst_filter (substring match on destination prefix), gateway_filter, " +
      "routing_table_filter, active_only, disabled_only, dynamic_only. " +
      "Returns a formatted route table or a not-found message.",
    inputSchema: {
      dst_filter: z.string().optional(),
      gateway_filter: z.string().optional(),
      routing_table_filter: z.string().optional(),
      active_only: z.boolean().default(false),
      disabled_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 routes");
      const filters: string[] = [];
      if (a.dst_filter) filters.push(`dst-address~"${a.dst_filter}"`);
      if (a.gateway_filter) filters.push(`gateway~"${a.gateway_filter}"`);
      if (a.routing_table_filter) filters.push(`routing-table="${a.routing_table_filter}"`);
      if (a.active_only) filters.push("active=yes");
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(`/ipv6 route print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No IPv6 routes found matching the criteria."
        : `IPV6 ROUTES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_route",
    title: "Get IPv6 Route Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPv6 route (`/ipv6 route print detail`) by RouterOS `.id` or destination prefix — " +
      "use when you need all attributes of one specific route rather than the full table. " +
      "For the complete route table use list_ipv6_routes. For the IPv4 equivalent use get_route. " +
      "Accepts a `.id` (e.g. '*1', obtained from list_ipv6_routes) or a destination prefix string; " +
      "tries `.id` first then falls back to a dst-address match. Returns the route's detail block.",
    inputSchema: {
      route_id: z.string().describe("RouterOS .id (e.g. '*1') or the destination prefix"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 route details: route_id=${a.route_id}`);
      let result = await executeMikrotikCommand(
        `/ipv6 route print detail where .id="${a.route_id}"`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ipv6 route print detail where dst-address="${a.route_id}"`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `IPv6 route '${a.route_id}' not found.`
        : `IPV6 ROUTE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_route",
    title: "Remove IPv6 Static Route",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes an IPv6 static route (`/ipv6 route remove`) by its RouterOS `.id`. " +
      "For the IPv4 equivalent use remove_route. " +
      "Obtain the `.id` (e.g. '*5') from list_ipv6_routes; use it instead of a destination prefix " +
      "to avoid ambiguity when multiple routes share the same dst-address. " +
      "Verifies the route exists before removal and returns an error if not found. " +
      "Dynamic routes injected by routing protocols cannot be removed this way.",
    inputSchema: {
      route_id: z.string().describe("RouterOS .id, e.g. '*5'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 route: route_id=${a.route_id}`);
      const count = await executeMikrotikCommand(
        `/ipv6 route print count-only where .id="${a.route_id}"`,
        ctx,
      );
      if (count.trim() === "0") return `IPv6 route '${a.route_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 route remove [find .id="${a.route_id}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPv6 route: ${result}`;
      return `IPv6 route '${a.route_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_route",
    title: "Enable IPv6 Route",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled IPv6 route (`/ipv6 route set disabled=no`) by its RouterOS `.id` — " +
      "makes the route active and eligible for forwarding decisions again without recreating it. " +
      "To suppress it without deleting it use disable_ipv6_route. " +
      "Obtain the `.id` from list_ipv6_routes. Returns a confirmation string.",
    inputSchema: { route_id: z.string() },
    async handler(a, ctx) {
      return setIpv6RouteDisabled(a.route_id, false, ctx);
    },
  }),

  defineTool({
    name: "disable_ipv6_route",
    title: "Disable IPv6 Route",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv6 route (`/ipv6 route set disabled=yes`) by its RouterOS `.id` — " +
      "suppresses the route from the forwarding table without deleting it, preserving its config for later re-activation. " +
      "To re-activate it use enable_ipv6_route. To permanently delete it use remove_ipv6_route. " +
      "Obtain the `.id` from list_ipv6_routes. Returns a confirmation string.",
    inputSchema: { route_id: z.string() },
    async handler(a, ctx) {
      return setIpv6RouteDisabled(a.route_id, true, ctx);
    },
  }),
];
