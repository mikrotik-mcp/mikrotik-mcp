/** L2TP VPN server and clients — `/interface l2tp-server` and `/interface l2tp-client`. Users come from `/ppp secret`. */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { redactSecrets } from "../utils";

const UseIpsecServer = z.enum(["yes", "no", "required"]);
const UseIpsecClient = z.enum(["yes", "no"]);
const CallerIdType = z.enum(["ip-address", "number"]);

export const l2tpTools: ToolModule = [
  // ── SERVER `/interface l2tp-server server` ────────────────────────────────
  defineTool({
    name: "get_l2tp_server",
    title: "Get L2TP Server Configuration",
    annotations: READ,
    description:
      "Reads the global L2TP server settings (`/interface l2tp-server server`). " +
      "Use to inspect whether the server is enabled, which authentication methods are accepted, and whether IPsec is required. " +
      "For outbound dial-out tunnels use `list_l2tp_clients`; for PPP user credentials use `list_ppp_secrets`. " +
      "Returns the current server-wide settings: enabled flag, authentication, use-ipsec, ipsec-secret, MTU/MRU, and default-profile.",
    async handler(_a, ctx) {
      ctx.info("Getting L2TP server configuration");
      const result = await executeMikrotikCommand("/interface l2tp-server server print", ctx);
      return isEmpty(result)
        ? "L2TP server configuration not available."
        : `L2TP SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_l2tp_server",
    title: "Configure L2TP Server Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Applies global L2TP server settings (`/interface l2tp-server server set`). " +
      "Use to enable or disable the inbound L2TP server, change accepted authentication methods " +
      "(comma-separated, e.g. `mschap2,mschap1`), or configure L2TP/IPsec road-warrior mode " +
      "by setting `use_ipsec='required'` and supplying `ipsec_secret`. " +
      "For creating outbound dial-out tunnels use `create_l2tp_client`; for managing PPP user accounts use `create_ppp_secret`. " +
      "Returns the updated server configuration after applying changes.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Enable or disable the L2TP server"),
      default_profile: z.string().optional(),
      authentication: z.string().optional().describe("Comma-separated, e.g. 'mschap2,mschap1'"),
      use_ipsec: UseIpsecServer.optional(),
      ipsec_secret: z.string().optional().describe("Pre-shared key for L2TP/IPsec"),
      max_mtu: z.number().int().optional(),
      max_mru: z.number().int().optional(),
      mrru: z
        .number()
        .int()
        .optional()
        .describe("Max receive reconstructed unit for MRRU (multilink)"),
      keepalive_timeout: z
        .number()
        .int()
        .optional()
        .describe("Seconds before an idle tunnel is considered down"),
      max_sessions: z.number().int().optional().describe("Maximum simultaneous client sessions"),
      one_session_per_host: z
        .boolean()
        .optional()
        .describe("Allow only one active session per host"),
      caller_id_type: CallerIdType.optional().describe("Caller ID format: ip-address or number"),
    },
    async handler(a, ctx) {
      ctx.info("Configuring L2TP server");
      const cmd = new Cmd("/interface l2tp-server server set")
        .bool("enabled", a.enabled)
        .opt("default-profile", a.default_profile)
        .opt("authentication", a.authentication)
        .opt("use-ipsec", a.use_ipsec)
        .opt("ipsec-secret", a.ipsec_secret)
        .opt("max-mtu", a.max_mtu)
        .opt("max-mru", a.max_mru)
        .opt("mrru", a.mrru)
        .opt("keepalive-timeout", a.keepalive_timeout)
        .opt("max-sessions", a.max_sessions)
        .bool("one-session-per-host", a.one_session_per_host)
        .opt("caller-id-type", a.caller_id_type)
        .build();

      if (cmd.trim() === "/interface l2tp-server server set") return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to configure L2TP server: ${result}`;

      const details = await executeMikrotikCommand("/interface l2tp-server server print", ctx);
      return `L2TP server configured successfully:\n\n${details}`;
    },
  }),

  // ── CLIENT `/interface l2tp-client` ───────────────────────────────────────
  defineTool({
    name: "create_l2tp_client",
    title: "Create L2TP Client Interface",
    annotations: WRITE,
    description:
      "Creates an L2TP dial-out client interface (`/interface l2tp-client add`) that connects this router to a remote L2TP server. " +
      "Use when this router is the tunnel initiator (client side). " +
      "For PPTP tunnels use `create_pptp_client`, for SSTP use `create_sstp_client`, for OpenVPN use `create_ovpn_client`. " +
      "`connect_to` takes the remote server address; set `use_ipsec='yes'` and `ipsec_secret` to layer IPsec on top. " +
      "Returns the created interface details with passwords redacted.",
    inputSchema: {
      name: interfaceName("Name for the new L2TP client interface"),
      connect_to: z.string().describe("Remote L2TP server address"),
      user: z.string().describe("Username for authentication"),
      password: z.string().describe("Password for authentication"),
      profile: z.string().default("default-encryption"),
      add_default_route: z.boolean().optional(),
      default_route_distance: z
        .number()
        .int()
        .optional()
        .describe("Distance of the auto-added default route"),
      use_ipsec: UseIpsecClient.optional(),
      ipsec_secret: z.string().optional().describe("Pre-shared key for L2TP/IPsec"),
      allow: z
        .string()
        .optional()
        .describe("Allowed auth protocols, comma-separated (pap,chap,mschap1,mschap2)"),
      use_peer_dns: z.boolean().optional().describe("Use DNS servers offered by the remote peer"),
      dial_on_demand: z.boolean().optional().describe("Connect only when traffic is present"),
      keepalive_timeout: z
        .number()
        .int()
        .optional()
        .describe("Seconds before an idle tunnel is considered down"),
      max_mtu: z.number().int().optional().describe("Maximum transmission unit"),
      max_mru: z.number().int().optional().describe("Maximum receive unit"),
      mrru: z
        .number()
        .int()
        .optional()
        .describe("Max receive reconstructed unit for MRRU (multilink)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating L2TP client: name=${a.name}, connect_to=${a.connect_to}`);
      const cmd = new Cmd("/interface l2tp-client add")
        .set("name", a.name)
        .set("connect-to", a.connect_to)
        .set("user", a.user)
        .set("password", a.password)
        .opt("profile", a.profile)
        .bool("add-default-route", a.add_default_route)
        .opt("default-route-distance", a.default_route_distance)
        .opt("use-ipsec", a.use_ipsec)
        .opt("ipsec-secret", a.ipsec_secret)
        .opt("allow", a.allow)
        .bool("use-peer-dns", a.use_peer_dns)
        .bool("dial-on-demand", a.dial_on_demand)
        .opt("keepalive-timeout", a.keepalive_timeout)
        .opt("max-mtu", a.max_mtu)
        .opt("max-mru", a.max_mru)
        .opt("mrru", a.mrru)
        .opt("comment", a.comment)
        // `.bool` so `disabled=false` emits an explicit `disabled=no` rather than
        // omitting it (which can leave the new interface disabled).
        .bool("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create L2TP client: ${redactSecrets(result)}`;

      const details = await executeMikrotikCommand(
        `/interface l2tp-client print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `L2TP client created successfully:\n\n${redactSecrets(details)}`
        : "L2TP client creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_l2tp_clients",
    title: "List L2TP Client Interfaces",
    annotations: READ,
    description:
      "Lists all L2TP dial-out client interfaces (`/interface l2tp-client print`) configured on this router. " +
      "Use to discover existing L2TP tunnels and their connection state. " +
      "For PPTP tunnels use `list_pptp_clients`, for SSTP use `list_sstp_clients`, for OpenVPN use `list_ovpn_clients`. " +
      "Supports optional `name_filter` for partial name matching. " +
      "Returns interface names, connection status, and remote addresses — passwords are redacted.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing L2TP clients");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface l2tp-client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No L2TP clients found matching the criteria."
        : `L2TP CLIENTS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_l2tp_client",
    title: "Get L2TP Client Interface Detail",
    annotations: READ,
    description:
      "Retrieves full detail of a single named L2TP client interface (`/interface l2tp-client print detail where name=...`). " +
      "Use to inspect the full configuration of a specific tunnel after finding its name with `list_l2tp_clients`. " +
      "For PPTP tunnel detail use `get_pptp_client`, for SSTP use `get_sstp_client`. " +
      "Returns all interface properties; the password field is redacted.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting L2TP client details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface l2tp-client print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `L2TP client '${a.name}' not found.`
        : `L2TP CLIENT DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "remove_l2tp_client",
    title: "Remove L2TP Client Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named L2TP client interface (`/interface l2tp-client remove [find name=...]`). " +
      "First verifies the interface exists via `count-only` and returns an error if not found. " +
      "For PPTP tunnel removal use `remove_pptp_client`, for SSTP use `remove_sstp_client`. " +
      "This is destructive and cannot be undone — use `disable_l2tp_client` to deactivate without deleting.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing L2TP client: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface l2tp-client print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `L2TP client '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface l2tp-client remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove L2TP client: ${result}`;
      return `L2TP client '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_l2tp_client",
    title: "Enable L2TP Client Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled L2TP client interface (`/interface l2tp-client enable [find name=...]`), " +
      "causing the router to attempt connection to the remote server. " +
      "Use to reactivate a tunnel previously stopped with `disable_l2tp_client`. " +
      "For OpenVPN tunnel enable/disable use `enable_ovpn_client`. " +
      "Identifies the interface by name — use `create_l2tp_client` to create a new one.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling L2TP client: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface l2tp-client enable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable L2TP client: ${result}`;
      return `L2TP client '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_l2tp_client",
    title: "Disable L2TP Client Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active L2TP client interface (`/interface l2tp-client disable [find name=...]`), " +
      "tearing down the tunnel without removing its configuration. " +
      "Use to temporarily stop a tunnel while preserving its settings for later reuse. " +
      "To re-enable use `enable_l2tp_client`; to permanently remove use `remove_l2tp_client`. " +
      "For OpenVPN tunnel enable/disable use `disable_ovpn_client`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling L2TP client: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface l2tp-client disable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable L2TP client: ${result}`;
      return `L2TP client '${a.name}' disabled successfully.`;
    },
  }),
];
