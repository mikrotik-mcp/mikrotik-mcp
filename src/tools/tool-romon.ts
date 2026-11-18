/** RoMON (Router Management Overlay Network) — `/tool romon`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const romonTools: ToolModule = [
  defineTool({
    name: "get_romon",
    title: "Get RoMON Global Settings",
    annotations: READ,
    description:
      "Read the global RoMON (Router Management Overlay Network) settings (`/tool romon print`). " +
      "Use to check whether the Layer-2 management overlay is enabled, inspect the RoMON ID, " +
      "and review configured secrets. " +
      "Returns the current `enabled`, `id`, and `secrets` fields. " +
      "For per-interface port entries use `list_romon_ports`.",
    async handler(_a, ctx) {
      ctx.info("Getting romon settings");
      const result = await executeMikrotikCommand("/tool romon print", ctx);
      return isEmpty(result) ? "Unable to read romon settings." : `ROMON:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_romon",
    title: "Update RoMON Global Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Set global RoMON (Router Management Overlay Network) parameters (`/tool romon set`) — " +
      "toggle the Layer-2 management overlay on/off, change the RoMON ID, or update shared secrets. " +
      "For per-interface participation settings use `add_romon_port` or `remove_romon_port`. " +
      "Returns the full updated settings after applying changes. " +
      "Arguments: `enabled` (bool, turns overlay on/off), `id` (MAC-style RoMON node ID, " +
      "defaults to device MAC), `secrets` (comma-separated shared secret(s) for the overlay).",
    inputSchema: {
      enabled: z.boolean().optional(),
      id: z.string().optional().describe("RoMON ID (MAC-style)"),
      secrets: z.string().optional().describe("Comma-separated shared secret(s)"),
    },
    async handler(a, ctx) {
      // secrets intentionally not logged.
      ctx.info(`Updating romon settings (enabled=${a.enabled ?? "unchanged"})`);
      const cmd = new Cmd("/tool romon set")
        .bool("enabled", a.enabled)
        .opt("id", a.id)
        .opt("secrets", a.secrets);

      const built = cmd.build();
      if (built === "/tool romon set") return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update romon: ${result}`;
      const details = await executeMikrotikCommand("/tool romon print", ctx);
      return `RoMON updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "add_romon_port",
    title: "Add RoMON Port Entry",
    annotations: WRITE,
    description:
      "Add an interface entry to the RoMON port table (`/tool romon port add`) — " +
      "controls which interfaces participate in the Layer-2 management overlay and their path cost. " +
      "Use `interface='all'` to configure the global default entry that applies to all interfaces. " +
      "For listing existing entries use `list_romon_ports`; to delete an entry use `remove_romon_port`. " +
      "Returns port detail for the added interface after creation. " +
      "Arguments: `interface` (interface name or 'all'), `cost` (integer path cost for the overlay), " +
      "`secrets` (per-port shared secret), `forbid` (bool, block RoMON on this interface), " +
      "`disabled` (bool).",
    inputSchema: {
      interface: z.string().default("all").describe("Interface, or 'all' for the default entry"),
      cost: z.number().int().optional().describe("Path cost for the overlay"),
      secrets: z.string().optional(),
      forbid: z.boolean().optional().describe("Forbid RoMON on this interface"),
      disabled: z.boolean().default(false),
      comment: z.string().optional().describe("Free-form comment for the port entry"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding romon port: interface=${a.interface}`);
      const cmd = new Cmd("/tool romon port add")
        .set("interface", a.interface)
        .opt("cost", a.cost)
        .opt("secrets", a.secrets)
        .bool("forbid", a.forbid)
        .flag("disabled", a.disabled)
        .opt("comment", a.comment)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add romon port: ${result}`;
      const details = await executeMikrotikCommand(
        `/tool romon port print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return details.trim()
        ? `RoMON port added successfully:\n\n${details}`
        : "RoMON port addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_romon_ports",
    title: "List RoMON Port Entries",
    annotations: READ,
    description:
      "List RoMON port entries (`/tool romon port print`) — shows all interfaces registered " +
      "in the Layer-2 management overlay with their cost, secrets, forbid, and disabled flags. " +
      "Optionally filter by `interface_filter` to narrow results to a single interface name. " +
      "For the global RoMON toggle and ID use `get_romon`; " +
      "to add or delete a port entry use `add_romon_port` or `remove_romon_port`. " +
      "Returns the `.id` values needed by `remove_romon_port`.",
    inputSchema: {
      interface_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing romon ports");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);

      const result = await executeMikrotikCommand(
        `/tool romon port print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No RoMON ports found matching the criteria."
        : `ROMON PORTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_romon_port",
    title: "Remove RoMON Port Entry",
    annotations: DESTRUCTIVE,
    description:
      "Remove a RoMON port entry from the overlay port table (`/tool romon port remove`). " +
      "`port_id` accepts either an interface name (e.g. `ether1`) or a RouterOS `.id` " +
      "(e.g. `*1`) taken from `list_romon_ports`. " +
      "Verifies the entry exists before removing and returns an error if not found. " +
      "To recreate an entry with different parameters use `add_romon_port`; " +
      "to change global overlay settings use `update_romon`.",
    inputSchema: {
      port_id: z.string().describe("Interface name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing romon port: port_id=${a.port_id}`);
      const selector = a.port_id.startsWith("*")
        ? `.id=${quoted(a.port_id)}`
        : `interface=${quoted(a.port_id)}`;
      const count = await executeMikrotikCommand(
        `/tool romon port print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `RoMON port '${a.port_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/tool romon port remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove romon port: ${result}`;
      return `RoMON port '${a.port_id}' removed successfully.`;
    },
  }),
];
