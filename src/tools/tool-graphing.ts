/** Graphing — `/tool graphing` (interface / queue / resource graph rules). */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted, quoteValue } from "../core/routeros";

const Kind = z.enum(["interface", "queue", "resource"]);

export const graphingTools: ToolModule = [
  defineTool({
    name: "add_graphing_interface",
    title: "Add Interface Graphing Rule",
    annotations: WRITE,
    description:
      "Adds an interface graphing rule (`/tool graphing interface add`) so the device begins " +
      "recording per-interface bandwidth graphs viewable via the router's built-in web graph page. " +
      "Use `interface='all'` to graph every interface. `allow_address` restricts which subnet may " +
      "view the graphs (e.g. '0.0.0.0/0' for all). " +
      "For simple-queue bandwidth graphs use `add_graphing_queue`; " +
      "for CPU/memory/disk graphs use `add_graphing_resource`. " +
      "Returns a confirmation string on success.",
    inputSchema: {
      interface: z.string().default("all").describe("Interface to graph, or 'all'"),
      allow_address: z
        .string()
        .optional()
        .describe("Subnet allowed to view the graphs, e.g. '0.0.0.0/0'"),
      store_on_disk: z.boolean().optional(),
      disabled: z.boolean().optional().describe("Whether the graphing rule is disabled"),
      comment: z.string().optional().describe("Free-text comment for the rule"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding interface graphing: interface=${a.interface}`);
      const cmd = new Cmd("/tool graphing interface add")
        .set("interface", a.interface)
        .opt("allow-address", a.allow_address)
        .bool("store-on-disk", a.store_on_disk)
        .bool("disabled", a.disabled)
        .opt("comment", a.comment)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add interface graphing: ${result}`;
      return `Interface graphing rule added for '${a.interface}'.`;
    },
  }),

  defineTool({
    name: "add_graphing_queue",
    title: "Add Queue Graphing Rule",
    annotations: WRITE,
    description:
      "Adds a simple-queue graphing rule (`/tool graphing queue add`) so the device records " +
      "bandwidth graphs for a named simple queue, viewable via the router's built-in web graph page. " +
      "Use `simple_queue='all'` to graph every simple queue. `allow_address` restricts which subnet " +
      "may view the graphs (e.g. '0.0.0.0/0' for all). " +
      "For interface traffic graphs use `add_graphing_interface`; " +
      "for CPU/memory/disk graphs use `add_graphing_resource`. " +
      "Note: this targets simple queues only — for queue-tree entries there is no separate graphing scope. " +
      "Returns a confirmation string on success.",
    inputSchema: {
      simple_queue: z.string().default("all").describe("Simple queue to graph, or 'all'"),
      allow_address: z.string().optional(),
      store_on_disk: z.boolean().optional(),
      disabled: z.boolean().optional().describe("Whether the graphing rule is disabled"),
      comment: z.string().optional().describe("Free-text comment for the rule"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding queue graphing: simple_queue=${a.simple_queue}`);
      const cmd = new Cmd("/tool graphing queue add")
        .set("simple-queue", a.simple_queue)
        .opt("allow-address", a.allow_address)
        .bool("store-on-disk", a.store_on_disk)
        .bool("disabled", a.disabled)
        .opt("comment", a.comment)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add queue graphing: ${result}`;
      return `Queue graphing rule added for '${a.simple_queue}'.`;
    },
  }),

  defineTool({
    name: "add_graphing_resource",
    title: "Add Resource Graphing Rule",
    annotations: WRITE,
    description:
      "Adds a system-resource graphing rule (`/tool graphing resource add`) so the device records " +
      "CPU load, memory usage, and disk usage graphs viewable via the router's built-in web graph page. " +
      "`allow_address` restricts which subnet may view the graphs (e.g. '0.0.0.0/0' for all). " +
      "For per-interface bandwidth graphs use `add_graphing_interface`; " +
      "for simple-queue graphs use `add_graphing_queue`. " +
      "Returns a confirmation string on success.",
    inputSchema: {
      allow_address: z.string().optional(),
      store_on_disk: z.boolean().optional(),
      disabled: z.boolean().optional().describe("Whether the graphing rule is disabled"),
      comment: z.string().optional().describe("Free-text comment for the rule"),
    },
    async handler(a, ctx) {
      ctx.info("Adding resource graphing");
      const cmd = new Cmd("/tool graphing resource add")
        .opt("allow-address", a.allow_address)
        .bool("store-on-disk", a.store_on_disk)
        .bool("disabled", a.disabled)
        .opt("comment", a.comment)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add resource graphing: ${result}`;
      return "Resource graphing rule added.";
    },
  }),

  defineTool({
    name: "list_graphing",
    title: "List Graphing Rules",
    annotations: READ,
    description:
      "Lists all graphing rules of a given kind (`/tool graphing {kind} print`) — specify `kind` " +
      "as `interface`, `queue`, or `resource` to select the matching table. " +
      "Use this to audit which interfaces, queues, or resource metrics are being graphed and to " +
      "retrieve the `.id` values needed by `remove_graphing`. " +
      "Returns all configured graphing entries for the selected table, or an empty-result message.",
    inputSchema: {
      kind: Kind.describe("Which graphing table to list"),
    },
    async handler(a, ctx) {
      ctx.info(`Listing ${a.kind} graphing rules`);
      const result = await executeMikrotikCommand(
        `/tool graphing ${quoteValue(a.kind)} print${whereClause([])}`,
        ctx,
      );
      return isEmpty(result)
        ? `No ${a.kind} graphing rules found.`
        : `GRAPHING (${a.kind.toUpperCase()}):\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_graphing",
    title: "Remove Graphing Rule",
    annotations: DESTRUCTIVE,
    description:
      "Removes a graphing rule of the given kind (`/tool graphing {kind} remove`) by `.id`, " +
      "stopping the device from recording graphs for that entry. " +
      "Verifies the entry exists with a count-only check before deleting. " +
      "`kind` must be `interface`, `queue`, or `resource`; `entry_id` is the RouterOS `.id` " +
      "(e.g. '*1') obtained from `list_graphing`. " +
      "Returns a confirmation string on success, or a not-found message if the `.id` does not exist.",
    inputSchema: {
      kind: Kind,
      entry_id: z.string().describe("RouterOS '.id', e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing ${a.kind} graphing rule: entry_id=${a.entry_id}`);
      const count = await executeMikrotikCommand(
        `/tool graphing ${quoteValue(a.kind)} print count-only where .id=${quoted(a.entry_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `${a.kind} graphing rule '${a.entry_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/tool graphing ${quoteValue(a.kind)} remove [find .id=${quoted(a.entry_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove ${a.kind} graphing rule: ${result}`;
      return `${a.kind} graphing rule '${a.entry_id}' removed successfully.`;
    },
  }),
];
