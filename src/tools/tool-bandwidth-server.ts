/** Bandwidth-test server — `/tool bandwidth-server`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

export const bandwidthServerTools: ToolModule = [
  defineTool({
    name: "get_bandwidth_server",
    title: "Get Bandwidth Test Server Settings",
    annotations: READ,
    description:
      "Reads bandwidth-test server configuration (`/tool bandwidth-server print`) — " +
      "use to inspect whether the server is enabled, requires client authentication, " +
      "and what session/port limits are active. " +
      "For live in-progress tests use `list_bandwidth_server_sessions`. " +
      "Returns the full settings block including `enabled`, `authenticate`, " +
      "`max-sessions`, and `allocate-udp-ports-from`.",
    async handler(_a, ctx) {
      ctx.info("Getting bandwidth-server settings");
      const result = await executeMikrotikCommand("/tool bandwidth-server print", ctx);
      return isEmpty(result)
        ? "Unable to read bandwidth-server settings."
        : `BANDWIDTH SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_bandwidth_server",
    title: "Update Bandwidth Test Server Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configures the bandwidth-test server (`/tool bandwidth-server set`) — " +
      "enables or disables the server, toggles client authentication, caps concurrent " +
      "sessions, sets the UDP port allocation base and restricts client IP prefixes. " +
      "An empty allowlist allows all clients; retain authentication and firewall restrictions. " +
      "To inspect current values before changing them use `get_bandwidth_server`. " +
      "Returns the updated settings block after applying changes.\n\n" +
      "Arguments:\n" +
      "    `enabled`: accept incoming bandwidth-test sessions.\n" +
      "    `authenticate`: require valid device credentials from test clients.\n" +
      "    `max_sessions`: cap concurrent test sessions.\n" +
      "    `allocate_udp_ports_from`: first UDP port used for test streams.",
    inputSchema: {
      enabled: z.boolean().optional(),
      authenticate: z.boolean().optional(),
      max_sessions: z.number().int().min(1).optional(),
      allocate_udp_ports_from: z.number().int().optional(),
      allowed_addresses4: z.array(z.union([z.ipv4(), z.cidrv4()])).optional(),
      allowed_addresses6: z.array(z.union([z.ipv6(), z.cidrv6()])).optional(),
    },
    async handler(a, ctx) {
      ctx.info("Updating bandwidth-server settings");
      const cmd = new Cmd("/tool bandwidth-server set")
        .bool("enabled", a.enabled)
        .bool("authenticate", a.authenticate)
        .opt("max-sessions", a.max_sessions)
        .opt("allocate-udp-ports-from", a.allocate_udp_ports_from);
      if (a.allowed_addresses4 !== undefined)
        cmd.set("allowed-addresses4", a.allowed_addresses4.join(","));
      if (a.allowed_addresses6 !== undefined)
        cmd.set("allowed-addresses6", a.allowed_addresses6.join(","));

      const built = cmd.build();
      if (built === "/tool bandwidth-server set") return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update bandwidth-server: ${result}`;

      const details = await executeMikrotikCommand("/tool bandwidth-server print", ctx);
      return `Bandwidth server updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_bandwidth_server_sessions",
    title: "List Active Bandwidth Test Server Sessions",
    annotations: READ,
    description:
      "Lists currently active bandwidth-test server sessions " +
      "(`/tool bandwidth-server session print`) — use to see in-progress tests " +
      "accepted by this device's server side, including remote client usernames. " +
      "Optionally filter by partial username with `user_filter`. " +
      "To inspect or change the server's global settings use `get_bandwidth_server` " +
      "or `update_bandwidth_server`. " +
      "Returns zero or more active session records; empty when no tests are running.",
    inputSchema: {
      user_filter: z.string().optional().describe("Partial user match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing bandwidth-server sessions");
      const filters: string[] = [];
      if (a.user_filter) filters.push(`user~"${a.user_filter}"`);

      const result = await executeMikrotikCommand(
        `/tool bandwidth-server session print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No active bandwidth-server sessions."
        : `BANDWIDTH SERVER SESSIONS:\n\n${result}`;
    },
  }),
];
