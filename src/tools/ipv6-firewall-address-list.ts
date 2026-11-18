/**
 * IPv6 firewall address-lists — `/ipv6 firewall address-list`.
 *
 * Named groups of IPv6 addresses/prefixes referenced by IPv6 firewall rules.
 * Entries can be static or dynamically populated (e.g. by rules with
 * action=add-src-to-address-list).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const ipv6FirewallAddressListTools: ToolModule = [
  defineTool({
    name: "add_ipv6_address_list_entry",
    title: "Add IPv6 Firewall Address-List Entry",
    annotations: WRITE,
    description:
      "Adds an IPv6 address or prefix to a named group (`/ipv6 firewall address-list`) " +
      "referenced by IPv6 filter, mangle, NAT, and raw rules — use this to build blocklists, " +
      "allowlists, or dynamic-population targets for IPv6 traffic. " +
      "For IPv4 address lists use `add_address_list_entry`. " +
      "Accepts a static entry or a timeout-expiring one (e.g. `1d00:00:00`); address formats: " +
      "`2001:db8::1` or `2001:db8::/32`. " +
      "Returns the created entry's detail including its `.id`.",
    inputSchema: {
      list: z.string().describe("Address-list name"),
      address: z
        .string()
        .describe("IPv6 address or prefix to add, e.g. '2001:db8::1' or '2001:db8::/32'"),
      timeout: z.string().optional().describe("Auto-remove timeout, e.g. '1d00:00:00'"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding ${a.address} to IPv6 address-list '${a.list}'`);
      const cmd = new Cmd("/ipv6 firewall address-list add")
        .set("list", a.list)
        .set("address", a.address)
        .opt("timeout", a.timeout)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add IPv6 address-list entry: ${result}`;

      const details = await executeMikrotikCommand(
        `/ipv6 firewall address-list print detail where list=${quoted(a.list)} address=${quoted(a.address)}`,
        ctx,
      );
      return details.trim()
        ? `IPv6 address-list entry added successfully:\n\n${details}`
        : "IPv6 address-list entry added but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_address_lists",
    title: "List IPv6 Firewall Address-List Entries",
    annotations: READ,
    description:
      "Lists all IPv6 firewall address-list entries (`/ipv6 firewall address-list`) — both " +
      "static and dynamically-populated — used as named groups by IPv6 filter, mangle, NAT, " +
      "and raw rules. " +
      "For IPv4 address lists use `list_address_lists`. " +
      "Optionally filter by partial list name (`list_filter`), partial address (`address_filter`), " +
      "or restrict to dynamic-only entries (`dynamic_only`). " +
      "Returns a table of matching entries with their `.id`, list name, address, timeout, and status.",
    inputSchema: {
      list_filter: z.string().optional().describe("Partial list-name match"),
      address_filter: z.string().optional().describe("Partial address match"),
      dynamic_only: z.boolean().default(false).describe("Only show dynamically-added entries"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 address-list entries");
      const filters: string[] = [];
      if (a.list_filter) filters.push(`list~${quoted(a.list_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.dynamic_only) filters.push("dynamic=yes");
      const result = await executeMikrotikCommand(
        `/ipv6 firewall address-list print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 address-list entries found matching the criteria."
        : `IPV6 FIREWALL ADDRESS-LISTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_address_list_entry",
    title: "Get IPv6 Firewall Address-List Entry",
    annotations: READ,
    description:
      "Retrieves full detail for a single IPv6 firewall address-list entry " +
      "(`/ipv6 firewall address-list print detail`) by its `.id`. " +
      "Use to inspect one specific entry; to browse all entries use `list_ipv6_address_lists`. " +
      "For IPv4 address-list entries use `get_address_list_entry`. " +
      "`entry_id` takes the `.id` (e.g. `*1`) returned by `list_ipv6_address_lists`. " +
      "Returns the full entry detail including list name, address, timeout, comment, and dynamic/disabled flags.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ipv6 firewall address-list print detail where .id=${quoted(a.entry_id)}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 address-list entry '${a.entry_id}' not found.`
        : `IPV6 ADDRESS-LIST ENTRY DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_address_list_entry",
    title: "Remove IPv6 Firewall Address-List Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 firewall address-list entry " +
      "(`/ipv6 firewall address-list remove`) by its `.id`. " +
      "Use when an address/prefix should no longer belong to the named group. " +
      "To temporarily suppress the entry without deleting it use `disable_ipv6_address_list_entry`; " +
      "for IPv4 address-list removal use the equivalent IPv4 tool. " +
      "Verifies existence before removing; `entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 address-list entry ${a.entry_id}`);
      const count = await executeMikrotikCommand(
        `/ipv6 firewall address-list print count-only where .id=${quoted(a.entry_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPv6 address-list entry '${a.entry_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall address-list remove [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPv6 address-list entry: ${result}`;
      return `IPv6 address-list entry '${a.entry_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_address_list_entry",
    title: "Enable IPv6 Firewall Address-List Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled IPv6 firewall address-list entry " +
      "(`/ipv6 firewall address-list enable`) by its `.id`, making it visible to IPv6 firewall rules again. " +
      "Counterpart to `disable_ipv6_address_list_entry`. " +
      "`entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`. " +
      "Returns confirmation of the enabled state.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Enabling IPv6 address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ipv6 firewall address-list enable [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable IPv6 address-list entry: ${result}`;
      return `IPv6 address-list entry '${a.entry_id}' enabled.`;
    },
  }),

  defineTool({
    name: "disable_ipv6_address_list_entry",
    title: "Disable IPv6 Firewall Address-List Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates an IPv6 firewall address-list entry (`/ipv6 firewall address-list disable`) " +
      "by its `.id` without deleting it — IPv6 firewall rules referencing the list will no longer " +
      "match this address while it is disabled. " +
      "To permanently delete the entry use `remove_ipv6_address_list_entry`; " +
      "to re-activate use `enable_ipv6_address_list_entry`. " +
      "`entry_id` takes the `.id` (e.g. `*1`) from `list_ipv6_address_lists`. " +
      "Returns confirmation of the disabled state.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Disabling IPv6 address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ipv6 firewall address-list disable [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable IPv6 address-list entry: ${result}`;
      return `IPv6 address-list entry '${a.entry_id}' disabled.`;
    },
  }),
];
