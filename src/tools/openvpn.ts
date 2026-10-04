/** OpenVPN (OVPN) — `/interface ovpn-server` + `/interface ovpn-client`. RouterOS 7 supports UDP + TCP. */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  looksLikeError,
  isEmpty,
  containsRawParserError,
  Cmd,
} from "../core/routeros";
import { redactSecrets } from "../utils";
import {
  listOpenVpnSessions,
  disconnectOpenVpnSession,
  disconnectOpenVpnInput,
} from "../core/openvpn-sessions";

export const openvpnTools: ToolModule = [
  defineTool({
    name: "list_ovpn_sessions",
    title: "List Active OpenVPN Connections",
    annotations: READ,
    description:
      "Read currently connected OpenVPN users on an explicit router, including assigned IP, caller address, uptime, encoding and RADIUS status. Reads only /ppp active where service=ovpn; does not read secrets, historical sessions, or outbound clients. Returns structured JSON and short-lived disconnect tokens for individual sessions. A cached read is at most two seconds old; errors are not an empty list.",
    inputSchema: {},
    async handler(_a, ctx) {
      return JSON.stringify(await listOpenVpnSessions(ctx));
    },
  }),
  defineTool({
    name: "disconnect_ovpn_session",
    title: "Disconnect One OpenVPN Connection",
    annotations: DESTRUCTIVE,
    description:
      "Disconnect exactly one observed OpenVPN connection after explicit operator approval. First list_ovpn_sessions on the same explicit router, then supply its fresh disconnectToken. Rechecks internal ID, session ID, username, addresses and uptime before removal, then verifies absence. Does not disable or delete the account; clients can reconnect and PPP on-down hooks may run. Can interrupt your own management tunnel. Unknown outcomes must be reconciled by reading again, never automatically retried. Not available during Safe Mode.",
    inputSchema: disconnectOpenVpnInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await disconnectOpenVpnSession(a, ctx));
    },
  }),
  defineTool({
    name: "get_ovpn_server",
    title: "Get OpenVPN Server Configuration",
    annotations: READ,
    description:
      "`get_ovpn_server` — READ / get / show / inspect the OpenVPN (OVPN) server settings and status" +
      " (`/interface ovpn-server server print`) — the singleton inbound-server instance: whether it is" +
      " enabled/running, certificate, auth/cipher algorithms, port, protocol, netmask, mode, max_mtu," +
      " default_profile, require_client_certificate. Use set_ovpn_server to modify these settings. For" +
      " outbound OVPN tunnels to a remote server use list_ovpn_clients or get_ovpn_client. For other VPN" +
      " tunnel types use create_l2tp_client, create_pptp_client, or create_sstp_client. Returns the full" +
      " server parameter block or a not-found message.",
    async handler(_a, ctx) {
      ctx.info("Getting OpenVPN server configuration");
      const result = await executeMikrotikCommand("/interface ovpn-server server print", ctx);
      return isEmpty(result)
        ? "No OpenVPN server configuration found."
        : `OPENVPN SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_ovpn_server",
    title: "Configure OpenVPN Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Apply settings to the OpenVPN server singleton (`/interface ovpn-server server set`) —" +
      " enables or disables the inbound server, sets the TLS certificate, auth algorithms" +
      " (comma-separated, e.g. 'sha256,sha1'), cipher suites (e.g. 'aes256-cbc,aes256-gcm')," +
      " TCP/UDP port, protocol (RouterOS 7 supports both tcp and udp), ip or ethernet mode," +
      " netmask, max_mtu, default_profile, and client certificate requirements. To read current" +
      " settings use get_ovpn_server. For managing outbound OVPN client tunnels use" +
      " create_ovpn_client. Returns the updated server parameter block on success.",
    inputSchema: {
      enabled: z.boolean().optional(),
      certificate: z.string().optional(),
      auth: z.string().optional().describe("Comma-separated, e.g. 'sha256,sha1'"),
      cipher: z.string().optional().describe("Comma-separated, e.g. 'aes256-cbc,aes256-gcm'"),
      netmask: z.number().int().optional(),
      mode: z.enum(["ip", "ethernet"]).optional(),
      port: z.number().int().optional(),
      protocol: z.enum(["tcp", "udp"]).optional(),
      tls_version: z.enum(["any", "only-1.2"]).optional().describe("Accepted TLS version"),
      default_profile: z.string().optional(),
      require_client_certificate: z.boolean().optional(),
      max_mtu: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Configuring OpenVPN server");

      // Everything except the enable/disable toggle is version-stable.
      const params = () =>
        new Cmd("/interface ovpn-server server set")
          .opt("certificate", a.certificate)
          .opt("auth", a.auth)
          .opt("cipher", a.cipher)
          .opt("netmask", a.netmask)
          .opt("mode", a.mode)
          .opt("port", a.port)
          .opt("protocol", a.protocol)
          .opt("tls-version", a.tls_version)
          .opt("default-profile", a.default_profile)
          .bool("require-client-certificate", a.require_client_certificate)
          .opt("max-mtu", a.max_mtu);

      // RouterOS 7.17 replaced this menu's legacy `enabled` property with an
      // (inverted) `disabled` one as part of multi-server support, so the old
      // `enabled=yes` is rejected as a parser error on 7.17+. Send the modern
      // `disabled` form first and fall back to `enabled` only when an older
      // device's parser rejects it.
      const cmd = params()
        .bool("disabled", a.enabled === undefined ? undefined : !a.enabled)
        .build();

      if (cmd === "/interface ovpn-server server set") return "No updates specified.";

      let result = await executeMikrotikCommand(cmd, ctx);
      if (a.enabled !== undefined && containsRawParserError(result)) {
        const legacy = params().bool("enabled", a.enabled).build();
        result = await executeMikrotikCommand(legacy, ctx);
      }
      if (looksLikeError(result)) return `Failed to configure OpenVPN server: ${result}`;

      const details = await executeMikrotikCommand("/interface ovpn-server server print", ctx);
      return `OpenVPN server configured successfully:\n\n${details}`;
    },
  }),

  // ── Multi-server model (RouterOS 7.17+) ───────────────────────────────────
  // 7.17 turned `/interface ovpn-server server` from a single selector-less
  // entry into a list of NAMED server instances. These tools manage those named
  // instances; the legacy get_ovpn_server/set_ovpn_server above still drive the
  // selector-less form on older devices and single-server setups.

  defineTool({
    name: "add_ovpn_server",
    title: "Add Named OpenVPN Server",
    annotations: WRITE,
    description:
      "Add a named inbound OpenVPN server instance (`/interface ovpn-server server add`) — the" +
      " RouterOS 7.17+ multi-server model, where several OVPN servers can run side by side, each on" +
      " its own port/certificate/profile. Provide a unique name; port defaults to 1194. Supports" +
      " protocol (tcp/udp), ip or ethernet mode, certificate, auth/cipher algorithm lists, netmask," +
      " max_mtu, default_profile, mac_address (ethernet mode) and require_client_certificate. For the" +
      " legacy single-server (selector-less) menu on older RouterOS use set_ovpn_server. To remove a" +
      " named server use remove_ovpn_server; to list them use list_ovpn_servers. For outbound tunnels" +
      " use create_ovpn_client. Returns the created server's detail including its name.",
    inputSchema: {
      name: interfaceName("Unique name for the new OpenVPN server instance"),
      port: z.number().int().default(1194),
      protocol: z.enum(["tcp", "udp"]).optional(),
      mode: z.enum(["ip", "ethernet"]).optional(),
      netmask: z.number().int().optional(),
      mac_address: z.string().optional().describe("Server MAC for ethernet mode"),
      certificate: z.string().optional(),
      auth: z.string().optional().describe("Comma-separated, e.g. 'sha256,sha1'"),
      cipher: z.string().optional().describe("Comma-separated, e.g. 'aes256-cbc,aes256-gcm'"),
      tls_version: z.enum(["any", "only-1.2"]).optional().describe("Accepted TLS version"),
      max_mtu: z.number().int().optional(),
      default_profile: z.string().optional(),
      require_client_certificate: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding OpenVPN server: name=${a.name}`);
      const cmd = new Cmd("/interface ovpn-server server add")
        .set("name", a.name)
        .opt("port", a.port)
        .opt("protocol", a.protocol)
        .opt("mode", a.mode)
        .opt("netmask", a.netmask)
        .opt("mac-address", a.mac_address)
        .opt("certificate", a.certificate)
        .opt("auth", a.auth)
        .opt("cipher", a.cipher)
        .opt("tls-version", a.tls_version)
        .opt("max-mtu", a.max_mtu)
        .opt("default-profile", a.default_profile)
        .bool("require-client-certificate", a.require_client_certificate)
        .opt("comment", a.comment)
        // `.bool` so `disabled=false` emits an explicit `disabled=no` rather than
        // omitting it (which can leave the new interface/server disabled).
        .bool("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (containsRawParserError(result)) {
        return (
          "Failed to add OpenVPN server: this RouterOS build does not support named OpenVPN" +
          " server instances (the multi-server model requires RouterOS 7.17+). Use set_ovpn_server" +
          ` to configure the single legacy server instead.\n\n${result}`
        );
      }
      if (looksLikeError(result)) return `Failed to add OpenVPN server: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface ovpn-server server print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `OpenVPN server '${a.name}' added successfully:\n\n${details}`
        : "OpenVPN server creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ovpn_servers",
    title: "List Named OpenVPN Servers",
    annotations: READ,
    description:
      "`list_ovpn_servers` — READ / list / show / inspect all named OpenVPN server instances" +
      " (`/interface ovpn-server server print detail`) on the RouterOS 7.17+ multi-server model," +
      " optionally filtered by partial name (name_filter). Returns each server's name, port, protocol," +
      " certificate, profile and disabled state. Pass a name_filter to fetch one server's full detail" +
      " (this doubles as get-by-name). The `.id`/name values feed update_ovpn_server," +
      " remove_ovpn_server, enable_ovpn_server and disable_ovpn_server. For the legacy single-server" +
      " menu use get_ovpn_server; for outbound tunnels use list_ovpn_clients.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing OpenVPN servers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      const result = await executeMikrotikCommand(
        `/interface ovpn-server server print detail${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No named OpenVPN servers found (the device may use the legacy single-server menu — try get_ovpn_server)."
        : `OPENVPN SERVERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ovpn_server",
    title: "Update Named OpenVPN Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify a named OpenVPN server instance (`/interface ovpn-server server set [find name=...]`) on" +
      " the RouterOS 7.17+ multi-server model — change port, protocol, mode, certificate, auth/cipher," +
      " netmask, max_mtu, default_profile, mac_address, comment or require_client_certificate without" +
      " recreating it. To toggle only the enabled state use enable_ovpn_server / disable_ovpn_server." +
      " To create a server use add_ovpn_server; to remove one use remove_ovpn_server. For the legacy" +
      " single-server menu use set_ovpn_server. Returns the updated server's detail.",
    inputSchema: {
      name: z.string().describe("Existing OpenVPN server instance name"),
      port: z.number().int().optional(),
      protocol: z.enum(["tcp", "udp"]).optional(),
      mode: z.enum(["ip", "ethernet"]).optional(),
      netmask: z.number().int().optional(),
      mac_address: z.string().optional(),
      certificate: z.string().optional(),
      auth: z.string().optional(),
      cipher: z.string().optional(),
      tls_version: z.enum(["any", "only-1.2"]).optional().describe("Accepted TLS version"),
      max_mtu: z.number().int().optional(),
      default_profile: z.string().optional(),
      require_client_certificate: z.boolean().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating OpenVPN server: name=${a.name}`);
      const base = `/interface ovpn-server server set [find name="${a.name}"]`;
      const cmd = new Cmd(base)
        .opt("port", a.port)
        .opt("protocol", a.protocol)
        .opt("mode", a.mode)
        .opt("netmask", a.netmask)
        .opt("mac-address", a.mac_address)
        .opt("certificate", a.certificate)
        .opt("auth", a.auth)
        .opt("cipher", a.cipher)
        .opt("tls-version", a.tls_version)
        .opt("max-mtu", a.max_mtu)
        .opt("default-profile", a.default_profile)
        .bool("require-client-certificate", a.require_client_certificate)
        .opt("comment", a.comment)
        .build();

      if (cmd === base) return "No updates specified.";

      const count = await executeMikrotikCommand(
        `/interface ovpn-server server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `OpenVPN server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update OpenVPN server: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface ovpn-server server print detail where name="${a.name}"`,
        ctx,
      );
      return `OpenVPN server '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ovpn_server",
    title: "Remove Named OpenVPN Server",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a named OpenVPN server instance (`/interface ovpn-server server remove" +
      " [find name=...]`) on the RouterOS 7.17+ multi-server model — verifies existence with a" +
      " count-only check before deleting. Use list_ovpn_servers to confirm the name. To stop a server" +
      " without deleting it use disable_ovpn_server. This does not touch the legacy single-server menu" +
      " (use set_ovpn_server with enabled=false for that) or any OVPN clients. Returns a success or" +
      " not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing OpenVPN server: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface ovpn-server server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `OpenVPN server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ovpn-server server remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove OpenVPN server: ${result}`;
      return `OpenVPN server '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_ovpn_server",
    title: "Enable Named OpenVPN Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable a disabled named OpenVPN server instance (`/interface ovpn-server server enable" +
      " [find name=...]`) on the RouterOS 7.17+ multi-server model, so it starts accepting clients." +
      " Use list_ovpn_servers to confirm the name. To deactivate use disable_ovpn_server; to delete" +
      " use remove_ovpn_server. For the legacy single-server menu use set_ovpn_server with" +
      " enabled=true. Returns a success or error message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling OpenVPN server: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface ovpn-server server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `OpenVPN server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ovpn-server server enable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable OpenVPN server: ${result}`;
      return `OpenVPN server '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_ovpn_server",
    title: "Disable Named OpenVPN Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disable an active named OpenVPN server instance (`/interface ovpn-server server disable" +
      " [find name=...]`) on the RouterOS 7.17+ multi-server model, stopping it without deleting its" +
      " configuration. Use list_ovpn_servers to confirm the name. To re-activate use" +
      " enable_ovpn_server; to delete use remove_ovpn_server. For the legacy single-server menu use" +
      " set_ovpn_server with enabled=false. Returns a success or error message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling OpenVPN server: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface ovpn-server server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `OpenVPN server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ovpn-server server disable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable OpenVPN server: ${result}`;
      return `OpenVPN server '${a.name}' disabled successfully.`;
    },
  }),

  defineTool({
    name: "create_ovpn_client",
    title: "Create OpenVPN Client Interface",
    annotations: WRITE,
    description:
      "Create an outbound OpenVPN client tunnel (`/interface ovpn-client add`) that connects this" +
      " router to a remote OpenVPN server — use this to bring up a VPN uplink on a new interface." +
      " Provide a unique interface name and the remote server address (connect_to); port defaults to" +
      " 1194. Supports username/password and/or certificate auth, cipher/auth algorithm overrides," +
      " ip or ethernet mode, tcp or udp protocol, and optional add_default_route. For other outbound" +
      " VPN tunnel types use create_l2tp_client, create_pptp_client, or create_sstp_client. For" +
      " inbound OVPN server configuration use set_ovpn_server. Returns the created interface detail" +
      " including its name.",
    inputSchema: {
      name: interfaceName("Name for the new OpenVPN client interface"),
      connect_to: z.string().describe("Remote OpenVPN server address"),
      port: z.number().int().default(1194),
      user: z.string().optional(),
      password: z.string().optional(),
      certificate: z.string().optional(),
      cipher: z.string().optional(),
      auth: z.string().optional(),
      tls_version: z.enum(["any", "only-1.2"]).optional().describe("Accepted TLS version"),
      mode: z.enum(["ip", "ethernet"]).optional(),
      protocol: z.enum(["tcp", "udp"]).optional(),
      mac_address: z.string().optional().describe("Client MAC for ethernet mode"),
      max_mtu: z.number().int().optional(),
      profile: z.string().optional(),
      add_default_route: z.boolean().optional(),
      route_nopull: z.boolean().optional().describe("Ignore routes pushed by the server"),
      use_peer_dns: z.boolean().optional().describe("Use DNS servers pushed by the server"),
      verify_server_certificate: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating OpenVPN client: name=${a.name}, connect_to=${a.connect_to}`);
      const cmd = new Cmd("/interface ovpn-client add")
        .set("name", a.name)
        .set("connect-to", a.connect_to)
        .opt("port", a.port)
        .opt("user", a.user)
        .opt("password", a.password)
        .opt("certificate", a.certificate)
        .opt("cipher", a.cipher)
        .opt("auth", a.auth)
        .opt("tls-version", a.tls_version)
        .opt("mode", a.mode)
        .opt("protocol", a.protocol)
        .opt("mac-address", a.mac_address)
        .opt("max-mtu", a.max_mtu)
        .opt("profile", a.profile)
        .bool("add-default-route", a.add_default_route)
        .bool("route-nopull", a.route_nopull)
        .bool("use-peer-dns", a.use_peer_dns)
        .bool("verify-server-certificate", a.verify_server_certificate)
        .opt("comment", a.comment)
        // `.bool` so `disabled=false` emits an explicit `disabled=no` rather than
        // omitting it (which can leave the new interface/server disabled).
        .bool("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result))
        return `Failed to create OpenVPN client: ${redactSecrets(result)}`;

      const details = await executeMikrotikCommand(
        `/interface ovpn-client print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `OpenVPN client created successfully:\n\n${redactSecrets(details)}`
        : "OpenVPN client creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ovpn_clients",
    title: "List OpenVPN Client Interfaces",
    annotations: READ,
    description:
      "`list_ovpn_clients` — READ / list / show / inspect / enumerate all OpenVPN (OVPN) client" +
      " interfaces (`/interface ovpn-client print`) and whether each tunnel is running/connected," +
      " optionally filtered by partial interface name (name_filter). Returns each client's name," +
      " running status, remote server (connect-to), port, mode and user. Use this to read existing OVPN" +
      " uplinks and their status before calling get_ovpn_client, enable_ovpn_client," +
      " disable_ovpn_client, or remove_ovpn_client. For inbound server settings use get_ovpn_server." +
      " For L2TP, PPTP, or SSTP tunnels use the respective tools." +
      " Returns a redacted table of all matching OVPN client interfaces.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing OpenVPN clients");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/interface ovpn-client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No OpenVPN clients found matching the criteria."
        : `OPENVPN CLIENTS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_ovpn_client",
    title: "Get OpenVPN Client Interface Detail",
    annotations: READ,
    description:
      "`get_ovpn_client` — READ / get / show / inspect one OpenVPN (OVPN) client interface's full" +
      " detail and running status by name (`/interface ovpn-client print detail where name=...`):" +
      " running/connected state, remote server (connect-to), port, mode, user, profile, certificate," +
      " cipher and auth. Use list_ovpn_clients first to enumerate available interface names. For the" +
      " inbound OVPN server settings use get_ovpn_server. Returns the full interface detail with" +
      " secrets redacted, or a not-found message if the name does not exist.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting OpenVPN client details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface ovpn-client print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `OpenVPN client '${a.name}' not found.`
        : `OPENVPN CLIENT DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "remove_ovpn_client",
    title: "Remove OpenVPN Client Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a named OpenVPN client interface (`/interface ovpn-client remove" +
      " [find name=...]`) — verifies existence with a count-only check before deleting. Use" +
      " list_ovpn_clients to confirm the interface name. To temporarily stop the tunnel without" +
      " deleting its config use disable_ovpn_client. Does not affect the inbound OVPN server —" +
      " use set_ovpn_server with enabled=false to stop that. Returns a success or not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing OpenVPN client: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface ovpn-client print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `OpenVPN client '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ovpn-client remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove OpenVPN client: ${result}`;
      return `OpenVPN client '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_ovpn_client",
    title: "Enable OpenVPN Client Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable a previously disabled OpenVPN client interface by name (`/interface ovpn-client" +
      " enable [find name=...]`), causing it to initiate its tunnel connection. Use list_ovpn_clients" +
      " to confirm the interface name. To deactivate without removing use disable_ovpn_client; to" +
      " permanently delete use remove_ovpn_client. Does not affect the inbound OVPN server — use" +
      " set_ovpn_server with enabled=true for that. Returns a success or error message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling OpenVPN client: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface ovpn-client enable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable OpenVPN client: ${result}`;
      return `OpenVPN client '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_ovpn_client",
    title: "Disable OpenVPN Client Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disable an active OpenVPN client interface by name (`/interface ovpn-client disable" +
      " [find name=...]`), dropping the tunnel without deleting its configuration. Use" +
      " list_ovpn_clients to confirm the interface name. To re-activate use enable_ovpn_client; to" +
      " permanently delete use remove_ovpn_client. Does not affect the inbound OVPN server — use" +
      " set_ovpn_server with enabled=false for that. Returns a success or error message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling OpenVPN client: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface ovpn-client disable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable OpenVPN client: ${result}`;
      return `OpenVPN client '${a.name}' disabled successfully.`;
    },
  }),
];
