/** MAC server — `/tool mac-server` (MAC-Telnet, MAC-Winbox, MAC-ping). */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const macServerTools: ToolModule = [
  // ── MAC-Telnet server ───────────────────────────────────────────────────────
  defineTool({
    name: "get_mac_server",
    title: "Get MAC-Telnet Server Settings",
    annotations: READ,
    description:
      "Read MAC-Telnet server settings (`/tool mac-server`). Returns the current " +
      "`allowed-interface-list` controlling which interfaces accept inbound MAC-Telnet " +
      "connections — the Layer-2 terminal protocol that reaches MikroTik devices by MAC " +
      "address when no IP is reachable. For MAC-Winbox settings use `get_mac_winbox`; " +
      "for MAC-ping use `get_mac_ping`. Returns the full `/tool mac-server print` output.",
    async handler(_a, ctx) {
      ctx.info("Getting mac-server settings");
      const result = await executeMikrotikCommand("/tool mac-server print", ctx);
      return isEmpty(result) ? "Unable to read mac-server settings." : `MAC SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_mac_server",
    title: "Update MAC-Telnet Server Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update the MAC-Telnet server's `allowed-interface-list` (`/tool mac-server set`). " +
      "Controls which interface list accepts inbound MAC-Telnet sessions — the Layer-2 " +
      "terminal protocol for reaching the router by MAC address without an IP. " +
      "For MAC-Winbox interface control use `update_mac_winbox`; for MAC-ping toggle " +
      "use `update_mac_ping`. Returns the updated settings after the change.\n\n" +
      "Notes:\n" +
      "    allowed_interface_list: interface-list name, or 'all' / 'none'.",
    inputSchema: {
      allowed_interface_list: z.string().describe("Interface-list name, or 'all' / 'none'"),
    },
    async handler(a, ctx) {
      ctx.info("Updating mac-server settings");
      const cmd = new Cmd("/tool mac-server set")
        .set("allowed-interface-list", a.allowed_interface_list)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update mac-server: ${result}`;
      const details = await executeMikrotikCommand("/tool mac-server print", ctx);
      return `MAC server updated successfully:\n\n${details}`;
    },
  }),

  // ── MAC-Winbox server ───────────────────────────────────────────────────────
  defineTool({
    name: "get_mac_winbox",
    title: "Get MAC-Winbox Server Settings",
    annotations: READ,
    description:
      "Read MAC-Winbox server settings (`/tool mac-server mac-winbox`). Returns which " +
      "interface list is allowed to connect via Winbox over MAC (Layer-2 Winbox access " +
      "without an IP address). Distinct from MAC-Telnet — for MAC-Telnet settings use " +
      "`get_mac_server`; for MAC-ping use `get_mac_ping`. Returns the full " +
      "`/tool mac-server mac-winbox print` output.",
    async handler(_a, ctx) {
      ctx.info("Getting mac-winbox settings");
      const result = await executeMikrotikCommand("/tool mac-server mac-winbox print", ctx);
      return isEmpty(result)
        ? "Unable to read mac-winbox settings."
        : `MAC WINBOX SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_mac_winbox",
    title: "Update MAC-Winbox Server Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update the MAC-Winbox server's `allowed-interface-list` " +
      "(`/tool mac-server mac-winbox set`). Controls which interfaces accept Winbox " +
      "connections over MAC (Layer-2, no IP required). Set to an interface-list name, " +
      "'all', or 'none'. For MAC-Telnet interface control use `update_mac_server`; " +
      "for MAC-ping toggle use `update_mac_ping`. Returns the updated settings after the change.",
    inputSchema: {
      allowed_interface_list: z.string().describe("Interface-list name, or 'all' / 'none'"),
    },
    async handler(a, ctx) {
      ctx.info("Updating mac-winbox settings");
      const cmd = new Cmd("/tool mac-server mac-winbox set")
        .set("allowed-interface-list", a.allowed_interface_list)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update mac-winbox: ${result}`;
      const details = await executeMikrotikCommand("/tool mac-server mac-winbox print", ctx);
      return `MAC Winbox server updated successfully:\n\n${details}`;
    },
  }),

  // ── MAC-ping ────────────────────────────────────────────────────────────────
  defineTool({
    name: "get_mac_ping",
    title: "Get MAC-Ping Server Settings",
    annotations: READ,
    description:
      "Read MAC-ping server settings (`/tool mac-server ping`). Returns whether MAC-ping " +
      "is enabled — the Layer-2 ping that reaches devices by MAC address rather than IP, " +
      "used to check reachability when no IP is configured. For MAC-Telnet settings use " +
      "`get_mac_server`; for MAC-Winbox settings use `get_mac_winbox`. Returns the full " +
      "`/tool mac-server ping print` output.",
    async handler(_a, ctx) {
      ctx.info("Getting mac-ping settings");
      const result = await executeMikrotikCommand("/tool mac-server ping print", ctx);
      return isEmpty(result) ? "Unable to read mac-ping settings." : `MAC PING:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_mac_ping",
    title: "Update MAC-Ping Server Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable or disable the MAC-ping server (`/tool mac-server ping set`). Toggles " +
      "whether the router responds to Layer-2 MAC-ping requests (pings by MAC address, " +
      "no IP needed). Accepts a boolean `enabled` argument. For MAC-Telnet interface " +
      "control use `update_mac_server`; for MAC-Winbox use `update_mac_winbox`. " +
      "Returns the updated settings after the change.",
    inputSchema: {
      enabled: z.boolean().describe("Whether MAC-ping is enabled"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating mac-ping: enabled=${a.enabled}`);
      const cmd = new Cmd("/tool mac-server ping set").bool("enabled", a.enabled).build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update mac-ping: ${result}`;
      const details = await executeMikrotikCommand("/tool mac-server ping print", ctx);
      return `MAC ping updated successfully:\n\n${details}`;
    },
  }),

  // ── Sessions ────────────────────────────────────────────────────────────────
  defineTool({
    name: "list_mac_server_sessions",
    title: "List Active MAC-Telnet Sessions",
    annotations: READ,
    description:
      "List active MAC-Telnet sessions (`/tool mac-server session`). Shows currently " +
      "connected MAC-Telnet clients — useful for auditing who has Layer-2 terminal access " +
      "to the router without an IP. Optionally filter by `interface_filter` (interface name " +
      "string). Distinct from MAC-Winbox connections (managed via `get_mac_winbox`/ " +
      "`update_mac_winbox`). Returns all active session entries or a no-sessions message.",
    inputSchema: {
      interface_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing mac-server sessions");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);

      const result = await executeMikrotikCommand(
        `/tool mac-server session print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No active MAC-server sessions."
        : `MAC SERVER SESSIONS:\n\n${result}`;
    },
  }),
];
