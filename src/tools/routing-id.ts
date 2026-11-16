/** Routing Router-ID — `/routing id` (RouterOS v7). */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, looksLikeError, isEmpty, commandUnsupported, Cmd } from "../core/routeros";

const UNSUPPORTED =
  "Routing Router-ID is not available on this device (requires RouterOS v7 with the routing package).";

export const routingIdTools: ToolModule = [
  defineTool({
    name: "list_routing_ids",
    title: "List Routing ID Instances",
    annotations: READ,
    description:
      "Lists all Router-ID instances (`/routing id print detail`). Router-IDs are named 32-bit identifiers " +
      "assigned to routing processes (OSPF, BGP) to uniquely identify the router within the routing domain; " +
      "each instance can carry a fixed IPv4 address or auto-derive one from an interface/loopback. " +
      "Use `get_routing_id` to inspect a single instance by name. " +
      "For IPv4 route table entries use `list_routes`; for policy routing rules use `list_routing_rules`; " +
      "for BGP connections that reference a router-id use `list_bgp_connections`. " +
      "Returns all instance names, configured IDs, dynamic-selection settings, and enabled/disabled state. " +
      "Requires RouterOS v7 with the routing package.",
    inputSchema: {
      name_filter: z.string().optional().describe("Substring match on the instance name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing routing IDs");
      const where = a.name_filter ? ` where name~"${a.name_filter}"` : "";
      const result = await executeMikrotikCommand(`/routing id print detail${where}`, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No routing IDs found." : `ROUTING IDs:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_routing_id",
    title: "Get Routing ID Instance",
    annotations: READ,
    description:
      "Returns full detail for a single named Router-ID instance (`/routing id print detail where name=...`). " +
      "Use this to inspect the configured or dynamically-selected 32-bit router identifier for a specific OSPF/BGP process. " +
      "Use `list_routing_ids` to enumerate all instances and discover names. " +
      "For IPv4 route table entries use `get_route`; for policy routing rules use `list_routing_rules`. " +
      "Returns all properties (id, select-dynamic-id, disabled, comment) of the named instance, " +
      "or a not-found message if the name does not exist.",
    inputSchema: {
      name: z.string().describe("Router-ID instance name"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting routing ID: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing id print detail where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? `Routing ID '${a.name}' not found.`
        : `ROUTING ID DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_routing_id",
    title: "Add Routing ID Instance",
    annotations: WRITE,
    description:
      "Creates a new Router-ID instance (`/routing id add`) that assigns a stable 32-bit router identifier " +
      "to a routing process (OSPF, BGP). " +
      "Either pin a fixed `id` (an IPv4 address, e.g. '10.0.0.1') or let RouterOS auto-derive it from " +
      "an interface/loopback via `select_dynamic_id` — at least one of the two should be set. " +
      "For BGP connections that consume a router-id use `add_bgp_connection`; " +
      "to modify an existing instance use `update_routing_id`; " +
      "for IPv4 static routes use `add_route`; for IPv6 static routes use `add_ipv6_route`. " +
      "Requires RouterOS v7 with the routing package. " +
      "Returns the created instance's full detail.",
    inputSchema: {
      name: z.string().describe("Unique instance name, referenced by OSPF/BGP"),
      id: z.string().optional().describe("Fixed router-id as an IPv4 address, e.g. '10.0.0.1'"),
      select_dynamic_id: z
        .string()
        .optional()
        .describe("Interface/loopback name to auto-derive the id from when `id` is omitted"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding routing ID: ${a.name}`);
      const cmd = new Cmd("/routing id add")
        .set("name", a.name)
        .opt("id", a.id)
        .opt("select-dynamic-id", a.select_dynamic_id)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add routing ID: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing id print detail where name="${a.name}"`,
        ctx,
      );
      return `Routing ID '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "update_routing_id",
    title: "Update Routing ID Instance",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing Router-ID instance (`/routing id set [find name=...]`). " +
      "Supply any combination of fields to change; omitted fields are left untouched. " +
      'Pass `""` for `id` to clear the fixed router-id (RouterOS unsets it with `!id`); ' +
      'pass `""` for `select_dynamic_id` to clear dynamic interface selection (`!select-dynamic-id`). ' +
      "Use `add_routing_id` to create a new instance; " +
      "use `set_routing_id_enabled` to toggle enabled state without changing other properties. " +
      "For updating IPv4 routes use `update_route`; for policy routing rules use `update_routing_rule`. " +
      "Returns the updated instance's full detail.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Existing Router-ID instance name"),
      id: z.string().optional().describe('IPv4 router-id, or "" to clear'),
      select_dynamic_id: z.string().optional().describe('Interface/loopback name, or "" to clear'),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating routing ID: ${a.name}`);
      const base = `/routing id set [find name="${a.name}"]`;
      const cmd = new Cmd(base);
      if (a.id !== undefined) cmd.raw(a.id === "" ? "!id" : `id=${a.id}`);
      if (a.select_dynamic_id !== undefined) {
        cmd.raw(
          a.select_dynamic_id === ""
            ? "!select-dynamic-id"
            : `select-dynamic-id=${a.select_dynamic_id}`,
        );
      }
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing ID: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing id print detail where name="${a.name}"`,
        ctx,
      );
      return `Routing ID '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_routing_id",
    title: "Remove Routing ID Instance",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named Router-ID instance (`/routing id remove [find name=...]`). " +
      "Removing a router-id that is actively referenced by an OSPF or BGP process will break that " +
      "process's identifier — verify dependencies before removing. " +
      "Use `list_routing_ids` to discover instance names. " +
      "To disable without deleting use `set_routing_id_enabled`. " +
      "For removing IPv4 routes use `remove_route`; for IPv6 routes use `remove_ipv6_route`. " +
      "Returns a success confirmation or an error message.",
    inputSchema: {
      name: z.string().describe("Router-ID instance name to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing routing ID: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing id remove [find name="${a.name}"]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove routing ID: ${result}`;
      return `Routing ID '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_routing_id_enabled",
    title: "Enable or Disable Routing ID Instance",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables or disables a named Router-ID instance (`/routing id set [find name=...] disabled=yes/no`). " +
      "Disabling prevents the instance from being advertised or used by OSPF/BGP without removing it. " +
      "Use `add_routing_id` to create a new instance; " +
      "use `update_routing_id` to change the ID value or other properties; " +
      "use `remove_routing_id` for permanent deletion. " +
      "Set `enabled=true` to enable, `enabled=false` to disable. " +
      "Returns a confirmation string.",
    inputSchema: {
      name: z.string().describe("Router-ID instance name"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    },
    async handler(a, ctx) {
      ctx.info(`Setting routing ID ${a.name} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing id set [find name="${a.name}"] disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update routing ID: ${result}`;
      return `Routing ID '${a.name}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),
];
