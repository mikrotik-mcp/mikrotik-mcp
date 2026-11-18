/**
 * PPTP VPN server and clients — `/interface pptp-server` and `/interface pptp-client`.
 *
 * NOTE: PPTP is legacy and cryptographically weak (MS-CHAPv2/MPPE). Prefer
 * L2TP/IPsec, SSTP, or WireGuard for new deployments.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { redactSecrets } from "../utils";

export const pptpTools: ToolModule = [
  // ── SERVER `/interface pptp-server server` ────────────────────────────────
  defineTool({
    name: "get_pptp_server",
    title: "Get PPTP Server Configuration",
    annotations: READ,
    description:
      "Reads the PPTP server singleton configuration (`/interface pptp-server server print`) — shows enabled state, " +
      "default PPP profile, allowed authentication methods (mschap2/mschap1/pap/chap), max-mtu, and max-mru. " +
      "Use this to inspect current server state before calling set_pptp_server to change it. " +
      "For dial-out client interfaces use list_pptp_clients. " +
      "NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. " +
      "Returns the raw server property block.",
    async handler(_a, ctx) {
      ctx.info("Getting PPTP server configuration");
      const result = await executeMikrotikCommand("/interface pptp-server server print", ctx);
      return isEmpty(result)
        ? "PPTP server configuration not available."
        : `PPTP SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_pptp_server",
    title: "Configure PPTP Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configures the PPTP server singleton (`/interface pptp-server server set`) — toggle the server on/off, " +
      "change the default PPP profile, allowed authentication methods, and MTU/MRU limits. " +
      "Use get_pptp_server first to inspect current values. For managing dial-out tunnels use create_pptp_client. " +
      "`authentication` accepts a comma-separated list, e.g. 'mschap2,mschap1'. " +
      "NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. " +
      "Returns the updated server configuration.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Enable or disable the PPTP server"),
      default_profile: z.string().optional(),
      authentication: z.string().optional().describe("Comma-separated, e.g. 'mschap2,mschap1'"),
      max_mtu: z.number().int().optional(),
      max_mru: z.number().int().optional(),
      mrru: z.string().optional().describe("Max packet size for MP reassembly, or 'disabled'"),
      keepalive_timeout: z
        .string()
        .optional()
        .describe("Keepalive timeout in seconds, or 'disabled'"),
    },
    async handler(a, ctx) {
      ctx.info("Configuring PPTP server");
      const cmd = new Cmd("/interface pptp-server server set")
        .bool("enabled", a.enabled)
        .opt("default-profile", a.default_profile)
        .opt("authentication", a.authentication)
        .opt("max-mtu", a.max_mtu)
        .opt("max-mru", a.max_mru)
        .opt("mrru", a.mrru)
        .opt("keepalive-timeout", a.keepalive_timeout)
        .build();

      if (cmd.trim() === "/interface pptp-server server set") return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to configure PPTP server: ${result}`;

      const details = await executeMikrotikCommand("/interface pptp-server server print", ctx);
      return `PPTP server configured successfully:\n\n${details}`;
    },
  }),

  // ── CLIENT `/interface pptp-client` ───────────────────────────────────────
  defineTool({
    name: "create_pptp_client",
    title: "Create PPTP Client Interface",
    annotations: WRITE,
    description:
      "Creates a PPTP dial-out client interface (`/interface pptp-client add`) — adds a new named tunnel that " +
      "connects outward to a remote PPTP server. For L2TP dial-out use create_l2tp_client; for SSTP dial-out use " +
      "create_sstp_client; for OpenVPN dial-out use create_ovpn_client. " +
      "`name` sets the interface name; `connect_to` is the remote server address; `password` is redacted in returned output. " +
      "`add_default_route` installs a default route via this tunnel when set to true. " +
      "NOTE: PPTP is cryptographically weak (MS-CHAPv2/MPPE); prefer L2TP/IPsec, SSTP, or WireGuard for new deployments. " +
      "Returns the created client's detail including its `.id`.",
    inputSchema: {
      name: interfaceName("Name for the new PPTP client interface"),
      connect_to: z.string().describe("Remote PPTP server address"),
      user: z.string().describe("Username for authentication"),
      password: z.string().describe("Password for authentication"),
      profile: z.string().optional(),
      add_default_route: z.boolean().optional(),
      default_route_distance: z
        .number()
        .int()
        .optional()
        .describe("Distance for the default route installed via this tunnel"),
      allow: z
        .string()
        .optional()
        .describe("Allowed auth protocols, comma-separated, e.g. 'mschap2,mschap1'"),
      dial_on_demand: z
        .boolean()
        .optional()
        .describe("Connect only when outbound traffic is generated"),
      max_mtu: z.number().int().optional(),
      max_mru: z.number().int().optional(),
      mrru: z.string().optional().describe("Max packet size for MP reassembly, or 'disabled'"),
      keepalive_timeout: z
        .string()
        .optional()
        .describe("Keepalive timeout in seconds, or 'disabled'"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating PPTP client: name=${a.name}, connect_to=${a.connect_to}`);
      const cmd = new Cmd("/interface pptp-client add")
        .set("name", a.name)
        .set("connect-to", a.connect_to)
        .set("user", a.user)
        .set("password", a.password)
        .opt("profile", a.profile)
        .bool("add-default-route", a.add_default_route)
        .opt("default-route-distance", a.default_route_distance)
        .opt("allow", a.allow)
        .bool("dial-on-demand", a.dial_on_demand)
        .opt("max-mtu", a.max_mtu)
        .opt("max-mru", a.max_mru)
        .opt("mrru", a.mrru)
        .opt("keepalive-timeout", a.keepalive_timeout)
        .opt("comment", a.comment)
        // `.bool` so `disabled=false` emits an explicit `disabled=no` rather than
        // omitting it (which can leave the new interface disabled).
        .bool("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create PPTP client: ${redactSecrets(result)}`;

      const details = await executeMikrotikCommand(
        `/interface pptp-client print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `PPTP client created successfully:\n\n${redactSecrets(details)}`
        : "PPTP client creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_pptp_clients",
    title: "List PPTP Client Interfaces",
    annotations: READ,
    description:
      "Lists all PPTP dial-out client interfaces (`/interface pptp-client print`) — shows name, connect-to address, " +
      "enabled/disabled state, and profile for each tunnel; passwords are redacted. " +
      "Optionally filters by partial name match via `name_filter`. " +
      "Use get_pptp_client for full detail on a single entry. " +
      "For L2TP, SSTP, or OpenVPN clients use the corresponding list_* tool for that VPN type. " +
      "Returns the filtered client list or an empty notice if none match.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing PPTP clients");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface pptp-client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No PPTP clients found matching the criteria."
        : `PPTP CLIENTS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_pptp_client",
    title: "Get PPTP Client Interface Detail",
    annotations: READ,
    description:
      "Fetches detailed properties of a single PPTP client interface (`/interface pptp-client print detail`) by " +
      "exact name — shows all parameters including connect-to address, profile, enabled state, and run-time statistics; " +
      "the password is redacted. Use list_pptp_clients to find the exact interface name first. " +
      "For L2TP, SSTP, or OpenVPN client detail use the corresponding get_* tool for that VPN type. " +
      "Returns the full detail block or a not-found message if the name does not match.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting PPTP client details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface pptp-client print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `PPTP client '${a.name}' not found.`
        : `PPTP CLIENT DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "remove_pptp_client",
    title: "Remove PPTP Client Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a PPTP dial-out client interface (`/interface pptp-client remove`) by exact name — " +
      "first verifies the interface exists with a count-only check, then deletes it. " +
      "Use list_pptp_clients to find the exact name before calling this. " +
      "This is destructive and not reversible without recreating the interface with create_pptp_client. " +
      "For L2TP, SSTP, or OpenVPN client removal use the corresponding remove_* tool for that VPN type. " +
      "Returns a success confirmation or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing PPTP client: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface pptp-client print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `PPTP client '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface pptp-client remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove PPTP client: ${result}`;
      return `PPTP client '${a.name}' removed successfully.`;
    },
  }),
];
