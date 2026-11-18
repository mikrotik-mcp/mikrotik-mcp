/** Routing tables (FIB) — `/routing table` (RouterOS v7). */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, looksLikeError, isEmpty, commandUnsupported, Cmd, quoted } from "../core/routeros";

const UNSUPPORTED =
  "Routing tables are not available on this device (requires RouterOS v7 with the routing package).";

/**
 * Render the `fib` token for `/routing table`. `fib` is a VALUE-LESS RouterOS
 * property — the default `main` table prints as a bare `fib` flag, and writing
 * `fib=yes`/`fib=no` makes the parser reject the command with
 * "expected end of command". So: enable with a bare `fib`, and on `set` clear it
 * with `!fib` (RouterOS's unset idiom). On `add`, a falsy fib is simply omitted
 * (the table is then RIB-only). Returns `undefined` when nothing should be added.
 */
export function fibToken(fib: boolean | undefined, onSet = false): string | undefined {
  if (fib === undefined) return undefined;
  if (fib) return "fib";
  return onSet ? "!fib" : undefined;
}

/** Build the `/routing table add` command (pure — unit-tested). */
export function buildAddRoutingTableCommand(a: {
  name: string;
  fib: boolean;
  comment?: string;
  disabled: boolean;
}): string {
  return new Cmd("/routing table add")
    .set("name", a.name)
    .raw(fibToken(a.fib))
    .opt("comment", a.comment)
    .flag("disabled", a.disabled)
    .build();
}

export const routingTableTools: ToolModule = [
  defineTool({
    name: "list_routing_tables",
    title: "List Routing Table Definitions",
    annotations: READ,
    description:
      "Lists named routing table definitions (`/routing table print detail`) — the RIB (Routing Information Base) " +
      "containers used by RouterOS v7 policy-based routing. Each table isolates a routing domain; `fib=true` means its " +
      "routes are installed into the forwarding plane. The built-in `main` table is always present. " +
      "For actual IPv4 routes stored inside a table use `list_routes`; for IPv6 routes use `list_ipv6_routes`; " +
      "for the policy rules that steer packets into a table use `list_routing_rules`. " +
      "Returns all table definitions with name, fib flag, disabled state, and comment; " +
      "supports optional `name_filter` substring match.",
    inputSchema: {
      name_filter: z.string().optional().describe("Substring match on table name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing tables");
      const where = a.name_filter ? ` where name~${quoted(a.name_filter)}` : "";
      const result = await executeMikrotikCommand(`/routing table print detail${where}`, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No routing tables found." : `ROUTING TABLES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_routing_table_def",
    title: "Get Routing Table Definition",
    annotations: READ,
    description:
      "Gets the definition of a single named routing table (`/routing table print detail where name=…`) — " +
      "inspects whether `fib` is active and whether the table is disabled. " +
      "For listing all tables use `list_routing_tables`. " +
      "For the IPv4 routes stored inside a table use `list_routes`; for IPv6 routes use `list_ipv6_routes`. " +
      "Returns the full detail record for the named table, or a not-found message if the name does not exist.",
    inputSchema: { name: z.string().describe("Routing table name") },
    async handler(a, ctx) {
      ctx.info(`Getting routing table: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing table print detail where name=${quoted(a.name)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? `Routing table '${a.name}' not found.`
        : `ROUTING TABLE:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_routing_table",
    title: "Add Routing Table Definition",
    annotations: WRITE,
    description:
      "Creates a named routing table (`/routing table add`) on RouterOS v7 — establishes a new RIB container " +
      "for policy-based routing. `fib` defaults to `true`, which installs the table's routes into the forwarding plane; " +
      "set `fib=false` to keep it RIB-only, used purely for lookups by routing rules/marks. " +
      "After creation, assign IPv4 routes to this table via `add_route` (set its `routing-table` argument); " +
      "for IPv6 routes use `add_ipv6_route`. " +
      "For the policy rules that steer packets into a table use `list_routing_rules` / `update_routing_rule`. " +
      "To modify an existing table use `update_routing_table`. " +
      "Returns the new table's full detail record on success.",
    inputSchema: {
      name: z.string().describe("Unique table name, referenced by routes and routing rules"),
      fib: z.boolean().default(true).describe("Install routes into the FIB (forwarding plane)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding routing table: ${a.name}`);
      const cmd = buildAddRoutingTableCommand(a);

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add routing table: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing table print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Routing table '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "update_routing_table",
    title: "Update Routing Table Definition",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing routing table (`/routing table set [find name=…]`) — changes its `fib` flag, " +
      "`comment`, or `disabled` state. " +
      "To create a new table use `add_routing_table`; to toggle only the enabled/disabled state use `set_routing_table_enabled`. " +
      "No-ops safely if no optional arguments are provided. " +
      "Returns the updated table's full detail record on success.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Existing routing table name"),
      fib: z.boolean().optional().describe("Install routes into the FIB"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating routing table: ${a.name}`);
      const base = `/routing table set [find name=${quoted(a.name)}]`;
      const cmd = new Cmd(base);
      cmd.raw(fibToken(a.fib, true)); // value-less flag: `fib` / `!fib`, never `fib=yes`
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing table: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing table print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Routing table '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_routing_table",
    title: "Remove Routing Table Definition",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named routing table (`/routing table remove [find name=…]`). " +
      "The built-in `main` table cannot be removed. " +
      "Routes referencing this table should be removed first via `remove_route` to avoid orphaned entries. " +
      "To disable without deleting use `set_routing_table_enabled`; to modify properties use `update_routing_table`. " +
      "Confirms deletion by name on success.",
    inputSchema: { name: z.string().describe("Routing table name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing routing table: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing table remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove routing table: ${result}`;
      return `Routing table '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_routing_table_enabled",
    title: "Enable or Disable Routing Table",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables or disables a named routing table (`/routing table set [find name=…] disabled=yes/no`) without " +
      "removing it — a disabled table is inactive in the routing engine. " +
      "To permanently delete a table use `remove_routing_table`; to change other properties (fib, comment) use `update_routing_table`. " +
      "Pass `enabled=true` to enable, `enabled=false` to disable. " +
      "Confirms the new state by name on success.",
    inputSchema: {
      name: z.string().describe("Routing table name"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    },
    async handler(a, ctx) {
      ctx.info(`Setting routing table ${a.name} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing table set [find name=${quoted(a.name)}] disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing table: ${result}`;
      return `Routing table '${a.name}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),
];
