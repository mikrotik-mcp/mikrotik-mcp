/** Generic interfaces — `/interface`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, quoted } from "../core/routeros";

const InterfaceType = z.enum([
  "ether",
  "wg",
  "bridge",
  "vlan",
  "pppoe-out",
  "pppoe-server",
  "wifi",
  "wireless",
  "lte",
  "loopback",
  "sfp",
  "sfp-sfpplus",
]);

async function verify(name: string, ctx: Parameters<typeof executeMikrotikCommand>[1]) {
  return executeMikrotikCommand(`/interface print detail where name=${quoted(name)}`, ctx);
}

export const interfaceTools: ToolModule = [
  defineTool({
    name: "list_interfaces",
    title: "List All Network Interfaces",
    annotations: READ,
    description:
      "List all interfaces (`/interface print`) — the primary discovery tool for every interface name, type, and running state on the device (ethernet, bridge, WireGuard, PPPoE, VLAN, WiFi, SFP, LTE, loopback). " +
      "Filter by `type_filter` (e.g. 'ether', 'bridge', 'wg'), `name_filter` (partial name match), `running_only`, or `disabled_only`. " +
      "For a single interface's full property block use `get_interface`; to create type-specific interfaces use `create_vlan_interface`, `create_wireguard_interface`, or `create_wireless_interface`. " +
      "Returns name, type, MAC, MTU, and running/disabled state for each matched interface.",
    inputSchema: {
      type_filter: InterfaceType.optional().describe(
        "RouterOS interface type, e.g. 'ether', 'bridge'",
      ),
      name_filter: z.string().optional().describe("Partial name match, e.g. 'ether'"),
      running_only: z.boolean().default(false),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing all interfaces");
      const filters: string[] = [];
      if (a.type_filter) filters.push(`type=${quoted(a.type_filter)}`);
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.running_only) filters.push("running=yes");
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(`/interface print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No interfaces found matching the criteria."
        : `INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_interface",
    title: "Get Network Interface Details",
    annotations: READ,
    description:
      "Get full detail for a single interface by exact name (`/interface print detail where name=<name>`). " +
      "Use when you already know the interface name and need its complete property set (MAC, MTU, type, running state, tx/rx counters). " +
      "To browse all interfaces or find a name first use `list_interfaces`. " +
      "Returns the full RouterOS detail block for the interface, or a not-found message if the name does not exist.",
    inputSchema: {
      name: z.string().describe("Exact interface name, e.g. 'ether1', 'wg0'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting interface details: name=${a.name}`);
      const result = await verify(a.name, ctx);
      return isEmpty(result)
        ? `Interface '${a.name}' not found.`
        : `INTERFACE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "enable_interface",
    title: "Enable a Network Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable a disabled interface (`/interface enable [find name=<name>]`) so it resumes passing traffic. " +
      "Idempotent — safe to call on an already-enabled interface. " +
      "To take an interface offline use `disable_interface`. " +
      "Returns the updated interface detail after enabling, confirming its new running state.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling interface: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface enable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable interface '${a.name}': ${result}`;
      const details = await verify(a.name, ctx);
      return isEmpty(details)
        ? `Interface '${a.name}' not found.`
        : `Interface '${a.name}' enabled successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "disable_interface",
    title: "Disable a Network Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disable an active interface (`/interface disable [find name=<name>]`) so it stops forwarding traffic while remaining fully configured. " +
      "Idempotent — safe to call on an already-disabled interface. " +
      "To bring an interface back up use `enable_interface`. " +
      "Returns the updated interface detail after disabling, confirming its new state.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling interface: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface disable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable interface '${a.name}': ${result}`;
      const details = await verify(a.name, ctx);
      return isEmpty(details)
        ? `Interface '${a.name}' not found.`
        : `Interface '${a.name}' disabled successfully:\n\n${details}`;
    },
  }),
];
