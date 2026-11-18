/** GMP (Group Management Protocol: IGMP/MLD) — `/routing gmp` (RouterOS v7). */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, isEmpty, commandUnsupported, quoted } from "../core/routeros";

const UNSUPPORTED =
  "GMP is not available on this device (requires RouterOS v7 with the routing/multicast package).";

export const routingGmpTools: ToolModule = [
  defineTool({
    name: "list_gmp_interfaces",
    title: "List GMP Interfaces",
    annotations: READ,
    description:
      "Lists GMP interface records (`/routing gmp interface`) — returns per-interface querier role, protocol version, " +
      "and timer state for RouterOS's Group Management Protocol layer (IGMP for IPv4, MLD for IPv6), which PIM-SM " +
      "and IGMP-proxy use to discover downstream receiver group memberships. " +
      "For the actual multicast groups joined on each interface use list_gmp_group_memberships. " +
      "Read-only; requires RouterOS v7 with the routing/multicast package.",
    async handler(_a, ctx) {
      ctx.info("Listing GMP interfaces");
      const result = await executeMikrotikCommand("/routing gmp interface print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No GMP interfaces found." : `GMP INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_gmp_group_memberships",
    title: "List GMP Group Memberships",
    annotations: READ,
    description:
      "Lists GMP group membership records (`/routing gmp group`) — returns the multicast groups currently joined " +
      "per interface as learned from downstream IGMP (IPv4) or MLD (IPv6) reports; the source of truth for which " +
      "segments want which groups, used by PIM-SM and IGMP-proxy for forwarding decisions. " +
      "For per-interface querier role and timer state use list_gmp_interfaces. " +
      "Accepts optional filters: interface_filter (exact interface name) and group_filter (regex match on multicast group address). " +
      "Read-only; requires RouterOS v7 with the routing/multicast package.",
    inputSchema: {
      interface_filter: z.string().optional().describe("Show only memberships on this interface"),
      group_filter: z.string().optional().describe("Regex match on the multicast group address"),
    },
    async handler(a, ctx) {
      ctx.info("Listing GMP group memberships");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.group_filter) filters.push(`group~${quoted(a.group_filter)}`);
      const result = await executeMikrotikCommand(
        `/routing gmp group print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No GMP group memberships found."
        : `GMP GROUP MEMBERSHIPS:\n\n${result}`;
    },
  }),
];
