/** PPP profiles, secrets, and active sessions — `/ppp`. The shared backend for L2TP/PPTP/SSTP/OpenVPN. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { redactSecrets } from "../utils";

const UseEncryption = z.enum(["default", "yes", "no", "required"]);
const UseMpls = z.enum(["default", "yes", "no", "required"]);
const UseCompression = z.enum(["default", "yes", "no"]);
const ChangeTcpMss = z.enum(["default", "yes", "no"]);
const OnlyOne = z.enum(["default", "yes", "no"]);
const Service = z.enum(["any", "l2tp", "pptp", "sstp", "ovpn", "pppoe"]);

export const pppTools: ToolModule = [
  // ── PROFILE `/ppp profile` ────────────────────────────────────────────────
  defineTool({
    name: "create_ppp_profile",
    title: "Create PPP Profile",
    annotations: WRITE,
    description:
      "Creates a reusable PPP profile (`/ppp profile add`) — a named template that defines local/remote address assignment, DNS push, TCP-MSS clamping, encryption policy, rate-limit, bridge, and single-session enforcement shared across L2TP, PPTP, SSTP, OpenVPN, and PPPoE sessions. " +
      "Use this to standardise connection parameters without repeating them per-user; the profile name is then referenced in create_ppp_secret (`profile` field) and in tunnel client tools (create_l2tp_client, create_pptp_client, create_sstp_client, create_ovpn_client). " +
      "For managing VPN user credentials themselves use create_ppp_secret. " +
      "Returns the created profile's full detail including all fields. Rate-limit format example: '10M/10M'.",
    inputSchema: {
      name: z.string().describe("Name for the new PPP profile"),
      local_address: z.string().optional().describe("Server-side tunnel IP or pool name"),
      remote_address: z.string().optional().describe("Client IP or address pool name"),
      dns_server: z.string().optional(),
      wins_server: z.string().optional().describe("WINS server IP(s) pushed to clients"),
      address_list: z.string().optional().describe("Address list to add the remote address to"),
      incoming_filter: z.string().optional().describe("Firewall chain for incoming packets"),
      outgoing_filter: z.string().optional().describe("Firewall chain for outgoing packets"),
      rate_limit: z.string().optional().describe("Rate limit, e.g. '10M/10M'"),
      session_timeout: z.string().optional().describe("Max session duration, e.g. '1h'"),
      idle_timeout: z.string().optional().describe("Disconnect after this idle time, e.g. '5m'"),
      use_encryption: UseEncryption.optional(),
      use_mpls: UseMpls.optional().describe("MPLS over the link policy"),
      use_compression: UseCompression.optional().describe("Compression policy"),
      change_tcp_mss: ChangeTcpMss.optional(),
      only_one: OnlyOne.optional().describe("Allow only one session per user"),
      bridge: z.string().optional(),
      bridge_horizon: z.number().int().optional().describe("Bridge split-horizon group"),
      bridge_path_cost: z.number().int().optional().describe("Bridge port path cost"),
      bridge_port_priority: z.number().int().optional().describe("Bridge port priority"),
      dhcpv6_pd_pool: z.string().optional().describe("IPv6 prefix delegation pool name"),
      on_up: z.string().optional().describe("Script to run when the session connects"),
      on_down: z.string().optional().describe("Script to run when the session disconnects"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating PPP profile: name=${a.name}`);
      const cmd = new Cmd("/ppp profile add")
        .set("name", a.name)
        .opt("local-address", a.local_address)
        .opt("remote-address", a.remote_address)
        .opt("dns-server", a.dns_server)
        .opt("wins-server", a.wins_server)
        .opt("address-list", a.address_list)
        .opt("incoming-filter", a.incoming_filter)
        .opt("outgoing-filter", a.outgoing_filter)
        .opt("rate-limit", a.rate_limit)
        .opt("session-timeout", a.session_timeout)
        .opt("idle-timeout", a.idle_timeout)
        .opt("use-encryption", a.use_encryption)
        .opt("use-mpls", a.use_mpls)
        .opt("use-compression", a.use_compression)
        .opt("change-tcp-mss", a.change_tcp_mss)
        .opt("only-one", a.only_one)
        .opt("bridge", a.bridge)
        .opt("bridge-horizon", a.bridge_horizon)
        .opt("bridge-path-cost", a.bridge_path_cost)
        .opt("bridge-port-priority", a.bridge_port_priority)
        .opt("dhcpv6-pd-pool", a.dhcpv6_pd_pool)
        .opt("on-up", a.on_up)
        .opt("on-down", a.on_down)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create PPP profile: ${result}`;

      const details = await executeMikrotikCommand(
        `/ppp profile print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `PPP profile created successfully:\n\n${details}`
        : "PPP profile creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ppp_profiles",
    title: "List PPP Profiles",
    annotations: READ,
    description:
      "Lists all PPP profiles (`/ppp profile print`) — reusable connection templates shared by L2TP, PPTP, SSTP, OpenVPN, and PPPoE sessions. " +
      "Use this to discover available profile names before referencing them in create_ppp_secret or tunnel client tools. " +
      "For full detail on a single profile use get_ppp_profile. For VPN user accounts use list_ppp_secrets. " +
      "Supports optional partial-name filter. Returns a table of profiles with their address, DNS, rate-limit, and encryption settings.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing PPP profiles");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(`/ppp profile print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No PPP profiles found matching the criteria."
        : `PPP PROFILES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ppp_profile",
    title: "Get PPP Profile Details",
    annotations: READ,
    description:
      "Fetches full detail for a single named PPP profile (`/ppp profile print detail where name=...`). " +
      "Use list_ppp_profiles to enumerate available profile names first. " +
      "For VPN user accounts (secrets) use get_ppp_secret instead. " +
      "Returns all profile fields: local/remote address, DNS, rate-limit, encryption, TCP-MSS, bridge, only-one, and comment.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting PPP profile details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ppp profile print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `PPP profile '${a.name}' not found.`
        : `PPP PROFILE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ppp_profile",
    title: "Update PPP Profile",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing PPP profile's settings (`/ppp profile set [find name=...]`). " +
      "Targets the profile by its current name; supply `new_name` to rename it. Any combination of fields can be updated — local/remote address, DNS, rate-limit (e.g. '10M/10M'), encryption, TCP-MSS, bridge, only-one. " +
      "For updating VPN user credentials use update_ppp_secret instead. " +
      "Returns the profile's updated detail after the change.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the PPP profile to update"),
      new_name: z.string().optional(),
      local_address: z.string().optional(),
      remote_address: z.string().optional(),
      dns_server: z.string().optional(),
      wins_server: z.string().optional().describe("WINS server IP(s) pushed to clients"),
      address_list: z.string().optional().describe("Address list to add the remote address to"),
      incoming_filter: z.string().optional().describe("Firewall chain for incoming packets"),
      outgoing_filter: z.string().optional().describe("Firewall chain for outgoing packets"),
      rate_limit: z.string().optional(),
      session_timeout: z.string().optional().describe("Max session duration, e.g. '1h'"),
      idle_timeout: z.string().optional().describe("Disconnect after this idle time, e.g. '5m'"),
      use_encryption: UseEncryption.optional(),
      use_mpls: UseMpls.optional().describe("MPLS over the link policy"),
      use_compression: UseCompression.optional().describe("Compression policy"),
      change_tcp_mss: ChangeTcpMss.optional(),
      only_one: OnlyOne.optional(),
      bridge: z.string().optional(),
      bridge_horizon: z.number().int().optional().describe("Bridge split-horizon group"),
      bridge_path_cost: z.number().int().optional().describe("Bridge port path cost"),
      bridge_port_priority: z.number().int().optional().describe("Bridge port priority"),
      dhcpv6_pd_pool: z.string().optional().describe("IPv6 prefix delegation pool name"),
      on_up: z.string().optional().describe("Script to run when the session connects"),
      on_down: z.string().optional().describe("Script to run when the session disconnects"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating PPP profile: name=${a.name}`);
      const cmd = new Cmd(`/ppp profile set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("local-address", a.local_address)
        .opt("remote-address", a.remote_address)
        .opt("dns-server", a.dns_server)
        .opt("wins-server", a.wins_server)
        .opt("address-list", a.address_list)
        .opt("incoming-filter", a.incoming_filter)
        .opt("outgoing-filter", a.outgoing_filter)
        .opt("rate-limit", a.rate_limit)
        .opt("session-timeout", a.session_timeout)
        .opt("idle-timeout", a.idle_timeout)
        .opt("use-encryption", a.use_encryption)
        .opt("use-mpls", a.use_mpls)
        .opt("use-compression", a.use_compression)
        .opt("change-tcp-mss", a.change_tcp_mss)
        .opt("only-one", a.only_one)
        .opt("bridge", a.bridge)
        .opt("bridge-horizon", a.bridge_horizon)
        .opt("bridge-path-cost", a.bridge_path_cost)
        .opt("bridge-port-priority", a.bridge_port_priority)
        .opt("dhcpv6-pd-pool", a.dhcpv6_pd_pool)
        .opt("on-up", a.on_up)
        .opt("on-down", a.on_down)
        .opt("comment", a.comment)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update PPP profile: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/ppp profile print detail where name=${quoted(target)}`,
        ctx,
      );
      return `PPP profile updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ppp_profile",
    title: "Remove PPP Profile",
    annotations: DESTRUCTIVE,
    description:
      "Deletes a named PPP profile (`/ppp profile remove [find name=...]`) — the connection template shared by L2TP/PPTP/SSTP/OpenVPN/PPPoE sessions. " +
      "Performs a count-only existence check first; returns not-found if the profile does not exist. " +
      "Does NOT delete VPN user accounts — for that use remove_ppp_secret. " +
      "Any secret or tunnel client that references this profile will fall back to the router default profile after removal.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing PPP profile: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ppp profile print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `PPP profile '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ppp profile remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove PPP profile: ${result}`;
      return `PPP profile '${a.name}' removed successfully.`;
    },
  }),

  // ── SECRET `/ppp secret` ──────────────────────────────────────────────────
  defineTool({
    name: "create_ppp_secret",
    title: "Create PPP Secret (VPN User Account)",
    annotations: WRITE,
    description:
      "Creates a PPP secret — a VPN user credential (`/ppp secret add`) — used by the router's L2TP, PPTP, SSTP, OpenVPN, and PPPoE servers to authenticate incoming clients. " +
      "A secret stores username, password, the service it applies to (any/l2tp/pptp/sstp/ovpn/pppoe), an optional profile reference (create_ppp_profile), and per-user address overrides. " +
      "This creates the server-side user account; for creating the tunnel client interface itself use create_l2tp_client, create_pptp_client, create_sstp_client, or create_ovpn_client. " +
      "For connection template settings shared across users use create_ppp_profile. " +
      "Returns the created secret's detail (password redacted in output).",
    inputSchema: {
      name: z.string().describe("Username for the secret"),
      password: z.string().describe("Password for the secret"),
      service: Service.default("any").describe("Service this secret applies to"),
      profile: z.string().optional(),
      local_address: z.string().optional(),
      remote_address: z.string().optional(),
      routes: z.string().optional().describe("Routes added while this client is connected"),
      caller_id: z.string().optional(),
      limit_bytes_in: z.number().int().optional().describe("Max bytes the client may upload"),
      limit_bytes_out: z.number().int().optional().describe("Max bytes the client may download"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating PPP secret: name=${a.name}, service=${a.service}`);
      const cmd = new Cmd("/ppp secret add")
        .set("name", a.name)
        .set("password", a.password)
        .opt("service", a.service)
        .opt("profile", a.profile)
        .opt("local-address", a.local_address)
        .opt("remote-address", a.remote_address)
        .opt("routes", a.routes)
        .opt("caller-id", a.caller_id)
        .opt("limit-bytes-in", a.limit_bytes_in)
        .opt("limit-bytes-out", a.limit_bytes_out)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create PPP secret: ${redactSecrets(result)}`;

      const details = await executeMikrotikCommand(
        `/ppp secret print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `PPP secret created successfully:\n\n${redactSecrets(details)}`
        : "PPP secret creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ppp_secrets",
    title: "List PPP Secrets (VPN User Accounts)",
    annotations: READ,
    description:
      "Lists PPP secrets — VPN user credentials (`/ppp secret print`) — configured on the router's L2TP/PPTP/SSTP/OpenVPN/PPPoE servers. " +
      "Passwords are redacted in all output. Supports optional partial-name filter and exact service filter (any/l2tp/pptp/sstp/ovpn/pppoe). " +
      "For full detail on a single user account use get_ppp_secret. For connection templates use list_ppp_profiles. " +
      "Returns a table of secrets with username, service, profile, and address assignments.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
      service_filter: Service.optional().describe("Exact service match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing PPP secrets");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.service_filter) filters.push(`service=${quoted(a.service_filter)}`);

      const result = await executeMikrotikCommand(`/ppp secret print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No PPP secrets found matching the criteria."
        : `PPP SECRETS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_ppp_secret",
    title: "Get PPP Secret Details",
    annotations: READ,
    description:
      "Fetches full detail for a single named PPP secret — a VPN user credential (`/ppp secret print detail where name=...`). " +
      "Password is redacted in the returned output. " +
      "Use list_ppp_secrets to enumerate available usernames first. " +
      "For PPP connection templates use get_ppp_profile instead. " +
      "Returns all secret fields: service, profile, local/remote address, caller-id, disabled state, and comment.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting PPP secret details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ppp secret print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `PPP secret '${a.name}' not found.`
        : `PPP SECRET DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "update_ppp_secret",
    title: "Update PPP Secret (VPN User Account)",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing PPP secret — a VPN user credential (`/ppp secret set [find name=...]`). " +
      "Targets the account by its current username; supply `new_name` to rename it. Any combination of fields can be changed — password, service restriction (any/l2tp/pptp/sstp/ovpn/pppoe), profile, local/remote address, caller-id, comment, or disabled state. " +
      "For updating connection templates (rate-limit, encryption, DNS) use update_ppp_profile instead. " +
      "Password is redacted in the returned output. Returns the account's updated detail after the change.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current username of the secret to update"),
      new_name: z.string().optional(),
      password: z.string().optional(),
      service: Service.optional(),
      profile: z.string().optional(),
      local_address: z.string().optional(),
      remote_address: z.string().optional(),
      routes: z.string().optional().describe("Routes added while this client is connected"),
      caller_id: z.string().optional(),
      limit_bytes_in: z.number().int().optional().describe("Max bytes the client may upload"),
      limit_bytes_out: z.number().int().optional().describe("Max bytes the client may download"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating PPP secret: name=${a.name}`);
      const cmd = new Cmd(`/ppp secret set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("password", a.password)
        .opt("service", a.service)
        .opt("profile", a.profile)
        .opt("local-address", a.local_address)
        .opt("remote-address", a.remote_address)
        .opt("routes", a.routes)
        .opt("caller-id", a.caller_id)
        .opt("limit-bytes-in", a.limit_bytes_in)
        .opt("limit-bytes-out", a.limit_bytes_out)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update PPP secret: ${redactSecrets(result)}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/ppp secret print detail where name=${quoted(target)}`,
        ctx,
      );
      return `PPP secret updated successfully:\n\n${redactSecrets(details)}`;
    },
  }),

  defineTool({
    name: "remove_ppp_secret",
    title: "Remove PPP Secret (VPN User Account)",
    annotations: DESTRUCTIVE,
    description:
      "Deletes a named PPP secret — a VPN user credential (`/ppp secret remove [find name=...]`). " +
      "Performs a count-only existence check first; returns not-found if the username does not exist. " +
      "This removes only the user account — it does NOT disconnect any currently active session for that user; use disconnect_ppp_active for that. " +
      "For removing the connection template use remove_ppp_profile instead.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing PPP secret: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ppp secret print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `PPP secret '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ppp secret remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove PPP secret: ${result}`;
      return `PPP secret '${a.name}' removed successfully.`;
    },
  }),

  // ── ACTIVE `/ppp active` ──────────────────────────────────────────────────
  defineTool({
    name: "get_ppp_active",
    title: "List Active PPP Sessions",
    annotations: READ,
    description:
      "Lists currently connected PPP sessions (`/ppp active print`) — L2TP, PPTP, SSTP, OpenVPN, and PPPoE clients that are live on the router right now. " +
      "Use this to monitor active VPN connections; supports optional partial-username filter. " +
      "Active sessions are read-only runtime state — to force-disconnect one use disconnect_ppp_active; to manage the underlying user account use list_ppp_secrets. " +
      "Returns session entries showing username, service type, assigned IP, uptime, and encoding.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial username match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing active PPP sessions");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(`/ppp active print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No active PPP sessions found."
        : `ACTIVE PPP SESSIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "disconnect_ppp_active",
    title: "Disconnect Active PPP Session",
    annotations: DESTRUCTIVE,
    description:
      "Force-disconnects a currently active PPP session by username (`/ppp active remove [find name=...]`). " +
      "Use get_ppp_active to find the exact username of a live session before calling this. " +
      "This terminates the live connection only — it does NOT delete the underlying user account; use remove_ppp_secret for that. " +
      "The client may immediately reconnect if its credentials remain valid in /ppp secret.",
    inputSchema: {
      name: z.string().describe("Username of the active session to disconnect"),
    },
    async handler(a, ctx) {
      ctx.info(`Disconnecting PPP session: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ppp active remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disconnect PPP session: ${result}`;
      return `PPP session '${a.name}' disconnected.`;
    },
  }),
];
