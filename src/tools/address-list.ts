/**
 * Firewall address-lists — `/ip firewall address-list`.
 *
 * Named groups of addresses referenced by firewall rules. Entries can be
 * static or dynamically populated (e.g. by rules with action=add-to-list).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const addressListTools: ToolModule = [
  defineTool({
    name: "add_address_list_entry",
    title: "Add Firewall Address-List Entry",
    annotations: WRITE,
    description:
      "Adds an address or subnet to a named IPv4 firewall address-list (`/ip firewall address-list`) — " +
      "the mechanism for grouping IPs so firewall filter, NAT, and mangle rules can match them via " +
      "`src-address-list` or `dst-address-list`. Use this for static entries; dynamic entries are " +
      "auto-populated by firewall rules with `action=add-to-list`. Accepts a `timeout` (e.g. " +
      "`'1d00:00:00'`) to auto-expire the entry. Returns the created entry's details including its `.id`.",
    inputSchema: {
      list: z.string().describe("Address-list name"),
      address: z.string().describe("Address or subnet to add, e.g. '10.0.0.1' or '10.0.0.0/24'"),
      timeout: z.string().optional().describe("Auto-remove timeout, e.g. '1d00:00:00'"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding ${a.address} to address-list '${a.list}'`);
      const cmd = new Cmd("/ip firewall address-list add")
        .set("list", a.list)
        .set("address", a.address)
        .opt("timeout", a.timeout)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add address-list entry: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip firewall address-list print detail where list=${quoted(a.list)} address=${quoted(a.address)}`,
        ctx,
      );
      return details.trim()
        ? `Address-list entry added successfully:\n\n${details}`
        : "Address-list entry added but unable to verify.";
    },
  }),

  defineTool({
    name: "list_address_lists",
    title: "List Firewall Address-List Entries",
    annotations: READ,
    description:
      "Lists all IPv4 firewall address-list entries (`/ip firewall address-list print`) with optional " +
      "filters — partial list name (`list_filter`), partial address match (`address_filter`), or " +
      "dynamic-only entries (`dynamic_only`). Use this to browse all lists and retrieve the `.id` " +
      "values needed by get_address_list_entry, remove_address_list_entry, enable_address_list_entry, " +
      "and disable_address_list_entry. Returns a formatted table of all matching entries.",
    inputSchema: {
      list_filter: z.string().optional().describe("Partial list-name match"),
      address_filter: z.string().optional().describe("Partial address match"),
      dynamic_only: z.boolean().default(false).describe("Only show dynamically-added entries"),
    },
    async handler(a, ctx) {
      ctx.info("Listing address-list entries");
      const filters: string[] = [];
      if (a.list_filter) filters.push(`list~${quoted(a.list_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.dynamic_only) filters.push("dynamic=yes");
      const result = await executeMikrotikCommand(
        `/ip firewall address-list print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No address-list entries found matching the criteria."
        : `FIREWALL ADDRESS-LISTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_address_list_entry",
    title: "Get Firewall Address-List Entry Detail",
    annotations: READ,
    description:
      "Returns full detail for a single IPv4 firewall address-list entry (`/ip firewall address-list " +
      "print detail`) by its `.id` (e.g. `'*1'`). Use this to inspect one entry precisely; to browse " +
      "all entries or find `.id` values use list_address_lists instead.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ip firewall address-list print detail where .id=${quoted(a.entry_id)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Address-list entry '${a.entry_id}' not found.`
        : `ADDRESS-LIST ENTRY DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_address_list_entry",
    title: "Remove Firewall Address-List Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes an IPv4 firewall address-list entry (`/ip firewall address-list remove`) " +
      "by its `.id` (e.g. `'*1'`). Confirms the entry exists first (count-only check) and returns an " +
      "error if not found. To temporarily suspend an entry without deleting it use " +
      "disable_address_list_entry instead. The `entry_id` is the `.id` from list_address_lists output.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing address-list entry ${a.entry_id}`);
      const count = await executeMikrotikCommand(
        `/ip firewall address-list print count-only where .id=${quoted(a.entry_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `Address-list entry '${a.entry_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall address-list remove [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove address-list entry: ${result}`;
      return `Address-list entry '${a.entry_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_address_list_entry",
    title: "Enable Firewall Address-List Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled IPv4 firewall address-list entry (`/ip firewall address-list enable`) " +
      "by its `.id` (e.g. `'*1'`), making it visible again to firewall rules that reference the list. " +
      "Use this to restore an entry suspended with disable_address_list_entry without re-adding it. " +
      "To delete permanently use remove_address_list_entry. The `entry_id` is the `.id` from " +
      "list_address_lists output.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Enabling address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ip firewall address-list enable [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable address-list entry: ${result}`;
      return `Address-list entry '${a.entry_id}' enabled.`;
    },
  }),

  defineTool({
    name: "disable_address_list_entry",
    title: "Disable Firewall Address-List Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Suspends an IPv4 firewall address-list entry (`/ip firewall address-list disable`) by its `.id` " +
      "(e.g. `'*1'`), making firewall rules that reference the list ignore this address without removing " +
      "it. Use enable_address_list_entry to restore it, or remove_address_list_entry to delete it " +
      "permanently. The `entry_id` is the `.id` from list_address_lists output.",
    inputSchema: {
      entry_id: z.string().describe("Internal entry id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Disabling address-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ip firewall address-list disable [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable address-list entry: ${result}`;
      return `Address-list entry '${a.entry_id}' disabled.`;
    },
  }),
];
