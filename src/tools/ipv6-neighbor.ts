/**
 * IPv6 neighbor cache — `/ipv6 neighbor`.
 *
 * The IPv6 equivalent of the ARP table: addresses discovered via Neighbor
 * Discovery. Entries are dynamic (populated by ND) so this scope is read-only
 * apart from flushing stale/incorrect entries.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, quoted } from "../core/routeros";

export const ipv6NeighborTools: ToolModule = [
  defineTool({
    name: "list_ipv6_neighbors",
    title: "List IPv6 Neighbor Cache Entries",
    annotations: READ,
    description:
      "List IPv6 neighbor cache entries (`/ipv6 neighbor`) — the IPv6 equivalent of the ARP table, " +
      "populated automatically by Neighbor Discovery (ND). Use this to inspect which IPv6 addresses " +
      "are reachable on each interface and what MAC they map to. " +
      "This tool covers only IPv6 neighbor cache (ND) entries; for IPv6 routing entries use list_ipv6_routes. " +
      "Returns each entry's address, mac-address, interface, status, and router flag. " +
      "Optional filters: interface_filter (exact interface name), address_filter (regex match on IPv6 address), " +
      "mac_filter (regex match on MAC), status_filter (e.g. 'reachable', 'stale', 'delay', 'probe'), " +
      "router_only=true to show only entries flagged as routers.",
    inputSchema: {
      interface_filter: z.string().optional(),
      address_filter: z.string().optional(),
      mac_filter: z.string().optional(),
      status_filter: z
        .string()
        .optional()
        .describe("Match status, e.g. 'reachable', 'stale', 'delay', 'probe'"),
      router_only: z.boolean().default(false).describe("Only entries flagged as routers"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 neighbors");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.mac_filter) filters.push(`mac-address~${quoted(a.mac_filter)}`);
      if (a.status_filter) filters.push(`status=${quoted(a.status_filter)}`);
      if (a.router_only) filters.push("router=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 neighbor print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 neighbors found matching the criteria."
        : `IPV6 NEIGHBORS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_neighbor",
    title: "Get IPv6 Neighbor Cache Entry Detail",
    annotations: READ,
    description:
      "Retrieve full detail for a single IPv6 neighbor cache entry (`/ipv6 neighbor print detail`) " +
      "by its RouterOS `.id` or by IPv6 address — resolves whichever form matches first. " +
      "Use this when you already know which entry you need and want its complete fields " +
      "(address, mac-address, interface, status, router flag). " +
      "To browse all entries or search by interface/status use list_ipv6_neighbors. " +
      "The neighbor_id argument accepts either a RouterOS .id (e.g. '*1', obtained from list_ipv6_neighbors) " +
      "or a full IPv6 address string.",
    inputSchema: {
      neighbor_id: z.string().describe("RouterOS .id (e.g. '*1') or the IPv6 address"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 neighbor: neighbor_id=${a.neighbor_id}`);
      let result = await executeMikrotikCommand(
        `/ipv6 neighbor print detail where .id=${quoted(a.neighbor_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ipv6 neighbor print detail where address=${quoted(a.neighbor_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `IPv6 neighbor '${a.neighbor_id}' not found.`
        : `IPV6 NEIGHBOR DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_neighbor",
    title: "Flush IPv6 Neighbor Cache Entry",
    annotations: DESTRUCTIVE,
    description:
      "Flush (remove) a single IPv6 neighbor cache entry (`/ipv6 neighbor remove`) by its RouterOS `.id` " +
      "or by IPv6 address — the device performs a count-only existence check before removing. " +
      "Use this to clear a stale or incorrect ND-learned address-to-MAC binding so the router " +
      "re-probes and re-learns the correct mapping. The entry will be re-added automatically " +
      "by Neighbor Discovery once traffic resumes. " +
      "To look up the `.id` or address of the entry to flush, use list_ipv6_neighbors or get_ipv6_neighbor first. " +
      "This operates only on the dynamic ND cache — it does not affect IPv6 routes (use remove_ipv6_route) " +
      "or IPv6 addresses assigned to interfaces (use the IPv6 address tools).",
    inputSchema: {
      neighbor_id: z.string().describe("RouterOS .id (e.g. '*1') or the IPv6 address"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 neighbor: neighbor_id=${a.neighbor_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ipv6 neighbor print count-only where .id=${quoted(a.neighbor_id)}`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ipv6 neighbor print count-only where address=${quoted(a.neighbor_id)}`,
          ctx,
        );
        if (count.trim() === "0") return `IPv6 neighbor '${a.neighbor_id}' not found.`;
      }
      const selector = byId ? `.id=${quoted(a.neighbor_id)}` : `address=${quoted(a.neighbor_id)}`;
      const result = await executeMikrotikCommand(`/ipv6 neighbor remove [find ${selector}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 neighbor: ${result}`;
      return `IPv6 neighbor '${a.neighbor_id}' removed successfully.`;
    },
  }),
];
