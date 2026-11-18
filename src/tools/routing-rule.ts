/** Policy routing rules — `/routing rule` (RouterOS v7). */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  yesno,
  whereClause,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
  quoted,
} from "../core/routeros";

const UNSUPPORTED =
  "Routing rules are not available on this device (requires RouterOS v7 with the routing package).";

const ACTIONS = ["lookup", "lookup-only-in-table", "drop", "unreachable"] as const;

export const routingRuleTools: ToolModule = [
  defineTool({
    name: "list_routing_rules",
    title: "List Policy Routing Rules",
    annotations: READ,
    description:
      "List policy routing rules (`/routing rule`) — the ordered table that steers packets into specific " +
      "routing tables based on src/dst prefix, incoming interface, or routing-mark. Rules are evaluated " +
      "top-down; requires RouterOS v7 with the routing package. For static routes in the main table use " +
      "`list_routes`; for IPv6 static routes use `list_ipv6_routes`. Returns all matching rules with full " +
      "detail, including `.id` values needed by `get_routing_rule`, `update_routing_rule`, " +
      "`remove_routing_rule`, and `set_routing_rule_enabled`.",
    inputSchema: {
      table_filter: z.string().optional().describe("Match rules targeting this table"),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing rules");
      const filters: string[] = [];
      if (a.table_filter) filters.push(`table=${quoted(a.table_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      const result = await executeMikrotikCommand(
        `/routing rule print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No routing rules found." : `ROUTING RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_routing_rule",
    title: "Get Policy Routing Rule",
    annotations: READ,
    description:
      "Fetch full detail for a single policy routing rule (`/routing rule`) by its `.id` " +
      "(obtain the `.id` from `list_routing_rules`). Requires RouterOS v7 with the routing package. " +
      "For static route details use `get_route`. Returns the rule's complete property set, or a not-found " +
      "message if the id does not exist.",
    inputSchema: {
      rule_id: z.string().describe('Rule id from list output, e.g. "*3"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting routing rule: ${a.rule_id}`);
      const result = await executeMikrotikCommand(
        `/routing rule print detail where .id=${a.rule_id}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? `Routing rule '${a.rule_id}' not found.`
        : `ROUTING RULE:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_routing_rule",
    title: "Add Policy Routing Rule",
    annotations: WRITE,
    description:
      "Add a policy routing rule (`/routing rule add`) to steer matched packets into a specific routing table. " +
      "Rules are evaluated top-down: `action=lookup` consults `table` then falls through to lower-priority " +
      "tables on no match; `lookup-only-in-table` stops at that table; `drop`/`unreachable` discard the packet. " +
      'Match on `src_address` (e.g. `"192.168.10.0/24"`), `dst_address`, `routing_mark`, or incoming ' +
      "`interface`. Use `place_before` with a rule `.id` to control insertion order. Requires RouterOS v7 with " +
      "the routing package. For static routes in the main or a named table use `add_route`; for IPv6 static " +
      "routes use `add_ipv6_route`. Returns the new rule's `.id`.",
    inputSchema: {
      action: z.enum(ACTIONS).default("lookup"),
      table: z.string().optional().describe("Target routing table for lookup actions"),
      src_address: z.string().optional().describe('Source prefix, e.g. "192.168.10.0/24"'),
      dst_address: z.string().optional().describe("Destination prefix"),
      routing_mark: z.string().optional().describe("Match packets carrying this routing-mark"),
      interface: z.string().optional().describe("Match this incoming interface"),
      min_prefix: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      place_before: z
        .string()
        .optional()
        .describe("Insert before this rule id to control ordering"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding routing rule: action=${a.action}, table=${a.table}`);
      const cmd = new Cmd("/routing rule add")
        .set("action", a.action)
        .opt("table", a.table)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("routing-mark", a.routing_mark)
        .opt("interface", a.interface)
        .opt("min-prefix", a.min_prefix)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .opt("place-before", a.place_before)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add routing rule: ${result}`;
      const t = result.trim();
      return t ? `Routing rule added (id ${t}).` : "Routing rule added successfully.";
    },
  }),

  defineTool({
    name: "update_routing_rule",
    title: "Update Policy Routing Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify an existing policy routing rule (`/routing rule set`) by its `.id` (obtain from `list_routing_rules`). " +
      'Pass `""` for `src_address`, `dst_address`, `routing_mark`, `interface`, or `table` to clear that field. ' +
      "Requires RouterOS v7 with the routing package. For updating static routes use `update_route`. " +
      "Returns the rule's updated detail after applying changes.",
    inputSchema: {
      unset: unsetProperties,
      rule_id: z.string().describe('Rule id, e.g. "*3"'),
      action: z.enum(ACTIONS).optional(),
      table: z.string().optional(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      routing_mark: z.string().optional(),
      interface: z.string().optional(),
      min_prefix: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating routing rule: ${a.rule_id}`);
      const base = `/routing rule set ${a.rule_id}`;
      const cmd = new Cmd(base);
      if (a.action !== undefined) cmd.set("action", a.action);
      const clearable: Array<[string, string | undefined]> = [
        ["table", a.table],
        ["src-address", a.src_address],
        ["dst-address", a.dst_address],
        ["routing-mark", a.routing_mark],
        ["interface", a.interface],
      ];
      for (const [key, val] of clearable) {
        if (val !== undefined) cmd.raw(val === "" ? `!${key}` : `${key}=${val}`);
      }
      cmd.opt("min-prefix", a.min_prefix);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing rule: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing rule print detail where .id=${a.rule_id}`,
        ctx,
      );
      return `Routing rule updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_routing_rule",
    title: "Remove Policy Routing Rule",
    annotations: DESTRUCTIVE,
    description:
      "Delete a policy routing rule (`/routing rule remove`) by its `.id` (obtain from `list_routing_rules`). " +
      "This is irreversible — confirm the correct rule with `get_routing_rule` before removing. Requires RouterOS v7 " +
      "with the routing package. For removing static routes use `remove_route`. Returns a confirmation message on success.",
    inputSchema: { rule_id: z.string().describe('Rule id, e.g. "*3"') },
    async handler(a, ctx) {
      ctx.info(`Removing routing rule: ${a.rule_id}`);
      const result = await executeMikrotikCommand(`/routing rule remove ${a.rule_id}`, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove routing rule: ${result}`;
      return `Routing rule '${a.rule_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_routing_rule_enabled",
    title: "Enable or Disable Policy Routing Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable or disable a policy routing rule (`/routing rule set disabled=yes/no`) by its `.id` " +
      "(obtain from `list_routing_rules`). Set `enabled=true` to activate or `enabled=false` to temporarily " +
      "suspend the rule without deleting it. Requires RouterOS v7 with the routing package. To permanently " +
      "delete a rule use `remove_routing_rule`. Returns a confirmation of the new enabled/disabled state.",
    inputSchema: {
      rule_id: z.string().describe('Rule id, e.g. "*3"'),
      enabled: z.boolean().describe("true to enable, false to disable"),
    },
    async handler(a, ctx) {
      ctx.info(`Setting routing rule ${a.rule_id} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing rule set ${a.rule_id} disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing rule: ${result}`;
      return `Routing rule '${a.rule_id}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),
];
