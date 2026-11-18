/** IP addresses — `/ip address`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { findAddressConflicts } from "../utils/ip-overlap";

export const ipAddressTools: ToolModule = [
  defineTool({
    name: "add_ip_address",
    title: "Add IPv4 Address to Interface",
    annotations: WRITE,
    description:
      "Assigns an IPv4 address to an interface (`/ip address add`). Use this to add a CIDR" +
      " address (e.g. '192.168.1.1/24') as the router's own address on a network segment —" +
      " sets the interface's local address, optional network, and broadcast. For IPv6 use" +
      " add_ipv6_address. Before creating, this checks the existing `/ip address` list and" +
      " REFUSES to add an address that duplicates or overlaps an already-assigned subnet," +
      " returning the conflicting entries so you can pick a non-overlapping address. To" +
      " intentionally add an overlapping/secondary address, set `allow_overlap: true`." +
      " Returns the full detail of the new address entry including its `.id`.",
    inputSchema: {
      address: z.string().describe("Address with CIDR, e.g. '192.168.1.1/24'"),
      interface: z.string(),
      network: z.string().optional(),
      broadcast: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      allow_overlap: z
        .boolean()
        .default(false)
        .describe(
          "Bypass the duplicate/overlap guard to add a secondary address in an existing subnet",
        ),
    },
    async handler(a, ctx) {
      ctx.info(`Adding IP address: address=${a.address}, interface=${a.interface}`);
      if (!a.allow_overlap) {
        const conflicts = await findAddressConflicts("/ip address", a.address, ctx);
        if (conflicts.length > 0) {
          return (
            `Refused: ${a.address} duplicates or overlaps ${conflicts.length} existing` +
            ` address(es): ${conflicts.join(", ")}. Choose a non-overlapping address, or` +
            ` re-run with allow_overlap=true to add it intentionally.`
          );
        }
      }
      const cmd = new Cmd("/ip address add")
        .set("address", a.address)
        .set("interface", a.interface)
        .opt("network", a.network)
        .opt("broadcast", a.broadcast)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add IP address: ${result}`;
      const details = await executeMikrotikCommand(
        `/ip address print detail where address=${quoted(a.address)}`,
        ctx,
      );
      return `IP address added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_ip_addresses",
    title: "List IPv4 Addresses",
    annotations: READ,
    description:
      "Lists IPv4 interface address assignments (`/ip address print`). Use this to enumerate" +
      " which addresses are bound to which interfaces, or to find `.id` values needed by" +
      " get_ip_address and remove_ip_address. Supports filtering by interface name" +
      " (interface_filter), address substring (address_filter), network (network_filter)," +
      " disabled-only, or dynamic-only. For IPv6 use list_ipv6_addresses. Returns all matching" +
      " entries with address/prefix, interface, network, flags, and `.id`.",
    inputSchema: {
      interface_filter: z.string().optional(),
      address_filter: z.string().optional(),
      network_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IP addresses");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.network_filter) filters.push(`network=${quoted(a.network_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(`/ip address print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No IP addresses found matching the criteria."
        : `IP ADDRESSES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ip_address",
    title: "Get IPv4 Address Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single IPv4 address entry (`/ip address print detail`)." +
      " Accepts either a RouterOS `.id` (e.g. '*1', obtained from list_ip_addresses) or the" +
      " dotted-decimal CIDR address string (e.g. '192.168.1.1/24'). Use this to inspect one" +
      " specific assignment rather than the full list. For IPv6 use get_ipv6_address. Returns" +
      " the complete record including interface, network, broadcast, flags, and `.id`.",
    inputSchema: {
      address_id: z.string().describe("RouterOS .id (e.g. '*1') or the address value"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IP address details: address_id=${a.address_id}`);
      let result = await executeMikrotikCommand(
        `/ip address print detail where .id=${quoted(a.address_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ip address print detail where address=${quoted(a.address_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `IP address '${a.address_id}' not found.`
        : `IP ADDRESS DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ip_address",
    title: "Remove IPv4 Address",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPv4 interface address from the device (`/ip address remove`). Accepts" +
      " either a RouterOS `.id` (e.g. '*1', from list_ip_addresses) or the CIDR address value" +
      " (e.g. '192.168.1.1/24'); performs an existence check before deletion and returns a" +
      " not-found message if the entry is absent. For IPv6 use remove_ipv6_address. Returns" +
      " confirmation of successful removal.",
    inputSchema: { address_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IP address: address_id=${a.address_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ip address print count-only where .id=${quoted(a.address_id)}`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ip address print count-only where address=${quoted(a.address_id)}`,
          ctx,
        );
        if (count.trim() === "0") return `IP address '${a.address_id}' not found.`;
      }
      const selector = byId ? `.id=${quoted(a.address_id)}` : `address=${quoted(a.address_id)}`;
      const result = await executeMikrotikCommand(`/ip address remove [find ${selector}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IP address: ${result}`;
      return `IP address '${a.address_id}' removed successfully.`;
    },
  }),
];
