/** IPv6 addresses — `/ipv6 address`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { findAddressConflicts } from "../utils/ip-overlap";

export const ipv6AddressTools: ToolModule = [
  defineTool({
    name: "add_ipv6_address",
    title: "Add IPv6 Address to Interface",
    annotations: WRITE,
    description:
      "Assigns an IPv6 address to an interface (`/ipv6 address add`) — use this to give an interface a static or pool-derived IPv6 address and optionally advertise the prefix via Router Advertisements (ND). " +
      "For IPv4 address assignment use add_ip_address. For IPv6 routing entries (next-hop/gateway records) use add_ipv6_route. " +
      "Returns the created entry's full detail including its `.id`.\n\n" +
      "Before creating, this checks the existing `/ipv6 address` list and REFUSES to add an" +
      " address that duplicates or overlaps an already-assigned prefix, returning the" +
      " conflicting entries so you can pick a non-overlapping address. To intentionally add" +
      " an overlapping/secondary address set `allow_overlap: true`.\n\n" +
      "Notes:\n" +
      "    address: IPv6 with prefix length, e.g. '2001:db8::1/64'. When from_pool\n" +
      "        is set the host part may be omitted and is taken from the pool.\n" +
      "    eui_64: derive the host part from the interface MAC (modified EUI-64).\n" +
      "    advertise: include this prefix in Router Advertisements (ND).",
    inputSchema: {
      address: z.string().describe("IPv6 address with prefix, e.g. '2001:db8::1/64'"),
      interface: z.string(),
      advertise: z.boolean().optional().describe("Advertise the prefix via Router Advertisements"),
      eui_64: z
        .boolean()
        .optional()
        .describe("Derive the host part from the interface MAC (EUI-64)"),
      from_pool: z.string().optional().describe("IPv6 pool name to take the prefix from"),
      no_dad: z.boolean().optional().describe("Skip Duplicate Address Detection for this address"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      allow_overlap: z
        .boolean()
        .default(false)
        .describe(
          "Bypass the duplicate/overlap guard to add a secondary address in an existing prefix",
        ),
    },
    async handler(a, ctx) {
      ctx.info(`Adding IPv6 address: address=${a.address}, interface=${a.interface}`);
      // eui-64/from-pool derive the host part later, so an overlap check on the
      // bare prefix would be meaningless — only guard fully-specified addresses.
      if (!a.allow_overlap && !a.eui_64 && !a.from_pool) {
        const conflicts = await findAddressConflicts("/ipv6 address", a.address, ctx);
        if (conflicts.length > 0) {
          return (
            `Refused: ${a.address} duplicates or overlaps ${conflicts.length} existing` +
            ` address(es): ${conflicts.join(", ")}. Choose a non-overlapping address, or` +
            ` re-run with allow_overlap=true to add it intentionally.`
          );
        }
      }
      const cmd = new Cmd("/ipv6 address add")
        .set("address", a.address)
        .set("interface", a.interface)
        .bool("advertise", a.advertise)
        .bool("eui-64", a.eui_64)
        .opt("from-pool", a.from_pool)
        .bool("no-dad", a.no_dad)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add IPv6 address: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 address print detail where address=${quoted(a.address)}`,
        ctx,
      );
      return details.trim()
        ? `IPv6 address added successfully:\n\n${details}`
        : "IPv6 address addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_addresses",
    title: "List IPv6 Addresses",
    annotations: READ,
    description:
      "List all IPv6 addresses assigned to interfaces (`/ipv6 address print`) — use this to survey which IPv6 addresses exist on the device, optionally filtered by interface name, address substring, disabled state, dynamic flag, or link-local flag. " +
      "For IPv4 interface addresses use list_ip_addresses. For IPv6 routing table entries use list_ipv6_routes. " +
      "Returns a table of matching address entries; use get_ipv6_address to fetch a single entry's full detail by `.id`.",
    inputSchema: {
      interface_filter: z.string().optional(),
      address_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
      link_local_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 addresses");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");
      if (a.link_local_only) filters.push("link-local=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 address print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 addresses found matching the criteria."
        : `IPV6 ADDRESSES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_address",
    title: "Get IPv6 Address Details",
    annotations: READ,
    description:
      "Fetch full detail for a single IPv6 address entry (`/ipv6 address print detail`) by its RouterOS `.id` (e.g. '*1') or by the address value (e.g. '2001:db8::1/64') — use this to inspect flags, advertise state, EUI-64, DAD status, and dynamic/invalid markers for one specific entry. " +
      "For browsing all entries use list_ipv6_addresses. For IPv6 routing entries use list_ipv6_routes. " +
      "The `.id` is returned by list_ipv6_addresses or add_ipv6_address.",
    inputSchema: {
      address_id: z.string().describe("RouterOS .id (e.g. '*1') or the address value"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 address details: address_id=${a.address_id}`);
      let result = await executeMikrotikCommand(
        `/ipv6 address print detail where .id=${quoted(a.address_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ipv6 address print detail where address=${quoted(a.address_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `IPv6 address '${a.address_id}' not found.`
        : `IPV6 ADDRESS DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_address",
    title: "Remove IPv6 Address",
    annotations: DESTRUCTIVE,
    description:
      "Delete an IPv6 address from an interface (`/ipv6 address remove`) — verifies the entry exists first via a count-only check, then removes it. " +
      "Accepts either the RouterOS `.id` (e.g. '*1', from list_ipv6_addresses) or the address value (e.g. '2001:db8::1/64'). " +
      "For IPv4 interface address removal use remove_ip_address. For removing an IPv6 routing entry use remove_ipv6_route. " +
      "Returns a confirmation string on success.",
    inputSchema: { address_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 address: address_id=${a.address_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ipv6 address print count-only where .id=${quoted(a.address_id)}`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ipv6 address print count-only where address=${quoted(a.address_id)}`,
          ctx,
        );
        if (count.trim() === "0") return `IPv6 address '${a.address_id}' not found.`;
      }
      const selector = byId ? `.id=${quoted(a.address_id)}` : `address=${quoted(a.address_id)}`;
      const result = await executeMikrotikCommand(`/ipv6 address remove [find ${selector}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 address: ${result}`;
      return `IPv6 address '${a.address_id}' removed successfully.`;
    },
  }),
];
