/** Resolved routing next-hops — `/routing nexthop` (RouterOS v7, read-only). */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, isEmpty, commandUnsupported, quoted } from "../core/routeros";

const UNSUPPORTED =
  "Routing next-hops are not available on this device (requires RouterOS v7 with the routing package).";

export const routingNexthopTools: ToolModule = [
  defineTool({
    name: "list_routing_nexthops",
    title: "List Routing Next-Hops",
    annotations: READ,
    description:
      "List resolved routing next-hops (`/routing nexthop`) — the recursive next-hop resolution table that shows " +
      "how each gateway maps to a concrete egress interface and immediate next-hop address, " +
      "and whether it is currently active. Use this to debug recursive or BGP next-hop resolution failures where " +
      "a route exists but traffic is not forwarded as expected. " +
      "For the IPv4 route table use list_routes; for IPv6 routes use list_ipv6_routes; " +
      "for routing policy rules use list_routing_rules; for next-hop counts only use get_routing_nexthop_stats. " +
      "Requires RouterOS v7 with the routing package. " +
      "Returns full detail for each next-hop entry. " +
      "Filter with gateway_filter (substring match on gateway address) and active_only=true to restrict to active entries.",
    inputSchema: {
      gateway_filter: z
        .string()
        .optional()
        .describe("Substring match on the resolved gateway address"),
      active_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing next-hops");
      const filters: string[] = [];
      if (a.gateway_filter) filters.push(`gateway~${quoted(a.gateway_filter)}`);
      if (a.active_only) filters.push("active=yes");
      const result = await executeMikrotikCommand(
        `/routing nexthop print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No routing next-hops found." : `ROUTING NEXT-HOPS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_routing_nexthop_stats",
    title: "Get Routing Next-Hop Statistics",
    annotations: READ,
    description:
      "Summarise the routing next-hop table (`/routing nexthop`) — returns total and active next-hop counts. " +
      "Use this for a quick health check on next-hop resolution capacity without fetching full entry detail. " +
      "For the full per-entry list with gateway and interface detail use list_routing_nexthops; " +
      "for the IPv4 route table use list_routes; for IPv6 routes use list_ipv6_routes. " +
      "Requires RouterOS v7 with the routing package. " +
      "Returns two counts: total next-hops and active next-hops.",
    async handler(_a, ctx) {
      ctx.info("Getting routing next-hop statistics");
      const total = await executeMikrotikCommand("/routing nexthop print count-only", ctx);
      if (commandUnsupported(total)) return UNSUPPORTED;
      const active = await executeMikrotikCommand(
        "/routing nexthop print count-only where active=yes",
        ctx,
      );
      return `ROUTING NEXT-HOP STATISTICS:\n\nTotal next-hops: ${total.trim()}\nActive next-hops: ${active.trim()}`;
    },
  }),
];
