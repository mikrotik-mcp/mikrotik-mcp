/** Routing filters — `/routing filter rule`, `select-rule`, `num-list` (RouterOS v7). */
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
  "Routing filters are not available on this device (requires RouterOS v7 with the routing package).";

export const routingFilterTools: ToolModule = [
  // ── Filter rules (chain + script-like rule) ───────────────────────────────
  defineTool({
    name: "list_routing_filter_rules",
    title: "List Routing Filter Rules",
    annotations: READ,
    description:
      "Lists routing filter rules (`/routing filter rule`) — the script-expression match/action chains used as " +
      "BGP/OSPF input and output filters on RouterOS v7. Each rule belongs to a named chain (e.g. `bgp-in`) " +
      "and is written as a script-like expression such as `if (dst in 10.0.0.0/8) { set distance 30; accept }`. " +
      "Returns all rules with their chain, expression, comment, and enabled state; narrow by chain with `chain_filter`. " +
      "For structured chain-dispatch (select-rule) entries use list_routing_filter_select_rules; " +
      "for IPv4 packet firewall rules use list_filter_rules; for routing policy rules use list_routing_rules.",
    inputSchema: {
      chain_filter: z.string().optional().describe("Show only rules in this chain"),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing filter rules");
      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${quoted(a.chain_filter)}`);
      const result = await executeMikrotikCommand(
        `/routing filter rule print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No routing filter rules found."
        : `ROUTING FILTER RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_routing_filter_rule",
    title: "Add Routing Filter Rule",
    annotations: WRITE,
    description:
      "Adds a routing filter rule to a named chain (`/routing filter rule add`) — defines the match/action " +
      "script expressions that BGP/OSPF consult as input/output filters on RouterOS v7. " +
      '`rule` is the full script expression, e.g. `"if (dst-len <= 24) { accept } else { reject }"`. ' +
      "Specifying a new `chain` name implicitly creates that chain; reference it from a BGP/OSPF filter setting. " +
      "`place_before` takes a `.id` from list_routing_filter_rules to control insertion order. " +
      "Returns the new rule's `.id` on success. For structured chain-dispatch rules use list_routing_filter_select_rules.",
    inputSchema: {
      chain: z.string().describe("Filter chain name, e.g. 'bgp-in'"),
      rule: z
        .string()
        .describe('Match/action expression, e.g. "if (dst-len <= 24) { accept } else { reject }"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      place_before: z
        .string()
        .optional()
        .describe("Insert before this rule id to control ordering"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding routing filter rule to chain ${a.chain}`);
      const cmd = new Cmd("/routing filter rule add")
        .set("chain", a.chain)
        .set("rule", a.rule)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .opt("place-before", a.place_before)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add routing filter rule: ${result}`;
      const t = result.trim();
      return t ? `Routing filter rule added (id ${t}).` : "Routing filter rule added successfully.";
    },
  }),

  defineTool({
    name: "update_routing_filter_rule",
    title: "Update Routing Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing routing filter rule's chain, script expression, comment, or enabled state " +
      "(`/routing filter rule set`) on RouterOS v7. `rule_id` takes the `.id` from list_routing_filter_rules " +
      '(e.g. `"*3"`). Returns the updated rule\'s full detail. ' +
      "To toggle only enabled/disabled state use set_routing_filter_rule_enabled.",
    inputSchema: {
      unset: unsetProperties,
      rule_id: z.string().describe('Rule id, e.g. "*3"'),
      chain: z.string().optional(),
      rule: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating routing filter rule ${a.rule_id}`);
      const base = `/routing filter rule set ${a.rule_id}`;
      const cmd = new Cmd(base);
      if (a.chain !== undefined) cmd.set("chain", a.chain);
      if (a.rule !== undefined) cmd.set("rule", a.rule);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing filter rule: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing filter rule print detail where .id=${a.rule_id}`,
        ctx,
      );
      return `Routing filter rule updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_routing_filter_rule",
    title: "Remove Routing Filter Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a routing filter rule (`/routing filter rule remove`) on RouterOS v7. " +
      '`rule_id` takes the `.id` from list_routing_filter_rules (e.g. `"*3"`). ' +
      "This is destructive — the rule cannot be recovered. " +
      "To deactivate without deleting use set_routing_filter_rule_enabled.",
    inputSchema: { rule_id: z.string().describe('Rule id, e.g. "*3"') },
    async handler(a, ctx) {
      ctx.info(`Removing routing filter rule ${a.rule_id}`);
      const result = await executeMikrotikCommand(`/routing filter rule remove ${a.rule_id}`, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove routing filter rule: ${result}`;
      return `Routing filter rule '${a.rule_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_routing_filter_rule_enabled",
    title: "Enable or Disable Routing Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables or disables a routing filter rule (`/routing filter rule set disabled=`) on RouterOS v7 " +
      'without removing it. `rule_id` takes the `.id` from list_routing_filter_rules (e.g. `"*3"`). ' +
      "Set `enabled=true` to activate or `enabled=false` to deactivate. " +
      "To permanently delete a rule use remove_routing_filter_rule; " +
      "to modify the rule's chain or expression use update_routing_filter_rule.",
    inputSchema: {
      rule_id: z.string().describe('Rule id, e.g. "*3"'),
      enabled: z.boolean(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting routing filter rule ${a.rule_id} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing filter rule set ${a.rule_id} disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing filter rule: ${result}`;
      return `Routing filter rule '${a.rule_id}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),

  // ── Select-rules (chain dispatch) ─────────────────────────────────────────
  defineTool({
    name: "list_routing_filter_select_rules",
    title: "List Routing Filter Select-Rules",
    annotations: READ,
    description:
      "Lists routing filter select-rules (`/routing filter select-rule`) — structured prefix/length matchers " +
      "that dispatch into a named filter chain on RouterOS v7. Select-rules are the structured front-end to chain " +
      "dispatch; the chain logic itself (script expressions) is defined via add_routing_filter_rule. " +
      "Returns all select-rules with their match conditions and target chain. " +
      "For the script-expression rules inside chains use list_routing_filter_rules.",
    async handler(_a, ctx) {
      ctx.info("Listing routing filter select-rules");
      const result = await executeMikrotikCommand("/routing filter select-rule print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No routing filter select-rules found."
        : `ROUTING FILTER SELECT-RULES:\n\n${result}`;
    },
  }),

  // ── Num-lists (named numeric/prefix range lists) ──────────────────────────
  defineTool({
    name: "list_routing_filter_num_lists",
    title: "List Routing Filter Num-Lists",
    annotations: READ,
    description:
      "Lists routing filter num-lists (`/routing filter num-list`) — named sets of numeric ranges " +
      "(AS numbers, BGP communities, prefix lengths) that routing filter rules can match against by name on RouterOS v7. " +
      "Optionally filter to a specific named list with `list_filter`. " +
      "Returns each entry's list name, range, and comment. " +
      "To add entries use add_routing_filter_num_list; to view the rules that reference these lists use list_routing_filter_rules.",
    inputSchema: {
      list_filter: z.string().optional().describe("Show only entries of this named list"),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing filter num-lists");
      const filters: string[] = [];
      if (a.list_filter) filters.push(`list=${quoted(a.list_filter)}`);
      const result = await executeMikrotikCommand(
        `/routing filter num-list print detail${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No routing filter num-lists found."
        : `ROUTING FILTER NUM-LISTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_routing_filter_num_list",
    title: "Add Routing Filter Num-List Entry",
    annotations: WRITE,
    description:
      "Adds a numeric range entry to a named num-list (`/routing filter num-list add`) on RouterOS v7. " +
      "Num-lists hold AS numbers, BGP communities, or prefix lengths that routing filter rules match by list name. " +
      "`list` is the target num-list name (created implicitly if new); " +
      '`range` is a single value or hyphen-separated range (e.g. `"65000-65010"` or `"100"`). ' +
      "Returns the new entry's `.id`. " +
      "To view existing entries use list_routing_filter_num_lists; to remove an entry use remove_routing_filter_num_list.",
    inputSchema: {
      list: z.string().describe("Num-list name to add to"),
      range: z.string().describe('Numeric range or single value, e.g. "65000-65010" or "100"'),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding num-list entry to ${a.list}`);
      const cmd = new Cmd("/routing filter num-list add")
        .set("list", a.list)
        .set("range", a.range)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add num-list entry: ${result}`;
      const t = result.trim();
      return t ? `Num-list entry added (id ${t}).` : "Num-list entry added successfully.";
    },
  }),

  defineTool({
    name: "remove_routing_filter_num_list",
    title: "Remove Routing Filter Num-List Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a numeric range entry from a num-list (`/routing filter num-list remove`) on RouterOS v7. " +
      '`entry_id` takes the `.id` from list_routing_filter_num_lists (e.g. `"*3"`). ' +
      "Removing an entry affects any routing filter rule that matches against the parent list by name. " +
      "To add entries use add_routing_filter_num_list.",
    inputSchema: { entry_id: z.string().describe('Entry id, e.g. "*3"') },
    async handler(a, ctx) {
      ctx.info(`Removing num-list entry ${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/routing filter num-list remove ${a.entry_id}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove num-list entry: ${result}`;
      return `Num-list entry '${a.entry_id}' removed successfully.`;
    },
  }),
];
