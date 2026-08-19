/**
 * WireGuard interfaces and peers — `/interface wireguard` and `/interface wireguard peers`.
 *
 * Covers interface CRUD plus enable/disable, peer CRUD plus enable/disable, and a
 * pure config-text generator (`generate_wireguard_client_config`) that never
 * touches the device.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import { notFoundMessage, ruleResolver } from "./_resolve-rule-id";

/**
 * Peer ids drift: removing any peer renumbers the row positions below it, and a
 * `.id` is reassigned over time. Resolve `peer_id` to a concrete `.id` right
 * before use so the write and its verification read address the same peer —
 * `set <N>` takes a bare number as a row position while `where .id=<N>` matches
 * nothing, so the unresolved form edited one peer and reported another.
 */
const resolvePeerId = ruleResolver("/interface wireguard peers");

const peerNotFound = (id: string): string =>
  notFoundMessage("WireGuard peer", id, "list_wireguard_peers");

export const wireguardTools: ToolModule = [
  // ── WireGuard Interface Management ────────────────────────────────────────
  defineTool({
    name: "create_wireguard_interface",
    title: "Create WireGuard Interface",
    annotations: WRITE,
    description:
      "Creates a WireGuard tunnel interface (`/interface wireguard`) — the local VPN endpoint" +
      " with a UDP listen port and private key. Use this to establish the server-side or site-to-site" +
      " WireGuard interface before adding remote peers with add_wireguard_peer." +
      " For IPsec tunnels use create_ipsec_peer; for L2TP use create_l2tp_client;" +
      " for OpenVPN use create_ovpn_client. Returns the created interface's detail including" +
      " its name and RouterOS-generated public key.",
    inputSchema: {
      name: interfaceName(
        "WireGuard interface name to create, e.g. 'wireguard-internal' (no spaces).",
      ),
      listen_port: z.number().int().optional(),
      private_key: z.string().optional(),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating WireGuard interface: name=${a.name}`);
      const cmd = new Cmd("/interface wireguard add")
        .set("name", a.name)
        .opt("listen-port", a.listen_port)
        .opt("private-key", a.private_key)
        .opt("mtu", a.mtu)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create WireGuard interface: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface wireguard print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `WireGuard interface created successfully:\n\n${details}`
        : "WireGuard interface created successfully.";
    },
  }),

  defineTool({
    name: "list_wireguard_interfaces",
    title: "List WireGuard Interfaces",
    annotations: READ,
    description:
      "`list_wireguard_interfaces` — READ / list / show / inspect all WireGuard tunnel interfaces" +
      " (`/interface wireguard print`). The go-to tool to read the current WireGuard state on a" +
      " device. Returns each interface's name, listen-port, public-key, MTU, and running/disabled" +
      " status. Filter by name substring (name_filter), disabled-only, or running-only." +
      " For one interface's full detail use get_wireguard_interface; for the peer table use" +
      " list_wireguard_peers; for interfaces AND peers in one call use get_wireguard_status.",
    inputSchema: {
      name_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      running_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing WireGuard interfaces");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.running_only) filters.push("running=yes");

      const result = await executeMikrotikCommand(
        `/interface wireguard print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No WireGuard interfaces found."
        : `WIREGUARD INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_wireguard_interface",
    title: "Get WireGuard Interface Details",
    annotations: READ,
    description:
      "`get_wireguard_interface` — READ / get / show the full detail of ONE WireGuard tunnel interface" +
      " (`/interface wireguard print detail`) looked up by name. Returns listen-port, private-key," +
      " public-key, MTU, running state, and comment. To list all interfaces use" +
      " list_wireguard_interfaces; for that interface's peers use list_wireguard_peers; for" +
      " interfaces AND peers in one call use get_wireguard_status.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting WireGuard interface details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface wireguard print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `WireGuard interface '${a.name}' not found.`
        : `WIREGUARD INTERFACE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_wireguard_status",
    title: "Get WireGuard Status (Interfaces + Peers)",
    annotations: READ,
    description:
      "`get_wireguard_status` — READ the current WireGuard state on a device in ONE call: ALL tunnel" +
      " interfaces AND ALL peers together. Use this FIRST to inspect / show / check WireGuard before" +
      " changing anything (e.g. to read public keys, see which side initiates, or confirm the tunnel" +
      " is up). Interfaces report name, listen-port, public-key, MTU and running state; peers report" +
      " .id, interface, public-key, allowed-address, endpoint/current-endpoint, last-handshake time" +
      " and rx/tx bytes. Combines list_wireguard_interfaces + list_wireguard_peers; optionally filter" +
      " both to one interface with interface_filter.",
    inputSchema: {
      interface_filter: z
        .string()
        .optional()
        .describe("Limit to one interface name, e.g. 'wg-mesh'"),
    },
    async handler(a, ctx) {
      ctx.info("Reading WireGuard status (interfaces + peers)");
      const ifFilters = a.interface_filter ? [`name="${a.interface_filter}"`] : [];
      const peerFilters = a.interface_filter ? [`interface="${a.interface_filter}"`] : [];
      const interfaces = await executeMikrotikCommand(
        `/interface wireguard print${whereClause(ifFilters)}`,
        ctx,
      );
      const peers = await executeMikrotikCommand(
        `/interface wireguard peers print${whereClause(peerFilters)}`,
        ctx,
      );
      const ifBlock = isEmpty(interfaces) ? "(none)" : interfaces;
      const peerBlock = isEmpty(peers) ? "(none)" : peers;
      return `WIREGUARD INTERFACES:\n\n${ifBlock}\n\nWIREGUARD PEERS:\n\n${peerBlock}`;
    },
  }),

  defineTool({
    name: "update_wireguard_interface",
    title: "Update WireGuard Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies settings on an existing WireGuard tunnel interface (`/interface wireguard set [find name=]`)" +
      " — rename (new_name), change listen-port, rotate private-key, adjust MTU, or toggle disabled state." +
      " Only supplied fields are changed; omitted fields are left as-is." +
      " For updating remote peers use update_wireguard_peer." +
      " Returns the updated interface's detail.",
    inputSchema: {
      name: z.string(),
      new_name: interfaceName().optional().describe("Rename the interface to this (no spaces)."),
      listen_port: z.number().int().optional(),
      private_key: z.string().optional(),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating WireGuard interface: name=${a.name}`);
      const base = `/interface wireguard set [find name="${a.name}"]`;
      const cmd = new Cmd(base)
        .opt("name", a.new_name)
        .opt("listen-port", a.listen_port)
        .opt("private-key", a.private_key)
        .opt("mtu", a.mtu)
        .raw(a.comment !== undefined ? `comment=${quoteValue(a.comment)}` : null)
        .bool("disabled", a.disabled)
        .build();

      if (cmd === base) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update WireGuard interface: ${result}`;

      const lookupName = a.new_name ? a.new_name : a.name;
      const details = await executeMikrotikCommand(
        `/interface wireguard print detail where name="${lookupName}"`,
        ctx,
      );
      return `WireGuard interface updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_wireguard_interface",
    title: "Remove WireGuard Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a WireGuard tunnel interface (`/interface wireguard remove`) by name," +
      " together with every peer bound to it. Verifies existence first with count-only." +
      " For removing only a specific peer without touching the interface use remove_wireguard_peer." +
      " Reports how many peers were removed alongside the interface.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing WireGuard interface: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface wireguard print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `WireGuard interface '${a.name}' not found.`;

      // RouterOS does NOT cascade this: peers survive the removal of their
      // interface and are left pointing at a now-dead name, which then shows up
      // in `list_wireguard_peers` as a phantom row with a raw `*N` where the
      // interface name should be. Delete the peers FIRST — after the interface
      // is gone, `[find interface=...]` no longer matches them and the orphans
      // can only be cleaned up by internal .id.
      const peerCount = (
        await executeMikrotikCommand(
          `/interface wireguard peers print count-only where interface="${a.name}"`,
          ctx,
        )
      ).trim();
      if (peerCount !== "0" && !looksLikeError(peerCount)) {
        const peerResult = await executeMikrotikCommand(
          `/interface wireguard peers remove [find interface="${a.name}"]`,
          ctx,
        );
        if (looksLikeError(peerResult)) {
          return (
            `Failed to remove the peers bound to '${a.name}': ${peerResult}\n` +
            "The interface was NOT removed — removing it now would orphan those peers."
          );
        }
      }

      const result = await executeMikrotikCommand(
        `/interface wireguard remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove WireGuard interface: ${result}`;
      const peers =
        peerCount === "0" ? "no peers were bound to it" : `${peerCount} peer(s) removed`;
      return `WireGuard interface '${a.name}' removed successfully (${peers}).`;
    },
  }),

  defineTool({
    name: "enable_wireguard_interface",
    title: "Enable WireGuard Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled WireGuard tunnel interface (`/interface wireguard enable`) by name," +
      " allowing it to accept and establish tunnel connections." +
      " For enabling a specific peer without affecting the interface use enable_wireguard_peer." +
      " To undo, use disable_wireguard_interface.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling WireGuard interface: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface wireguard enable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable WireGuard interface: ${result}`;
      return `WireGuard interface '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_wireguard_interface",
    title: "Disable WireGuard Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables a WireGuard tunnel interface (`/interface wireguard disable`) by name," +
      " stopping all tunnel traffic through it without removing the interface or its peers." +
      " For disabling only a specific peer use disable_wireguard_peer." +
      " To re-enable use enable_wireguard_interface.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling WireGuard interface: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface wireguard disable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable WireGuard interface: ${result}`;
      return `WireGuard interface '${a.name}' disabled successfully.`;
    },
  }),

  // ── WireGuard Peer Management ─────────────────────────────────────────────
  defineTool({
    name: "add_wireguard_peer",
    title: "Add WireGuard Peer",
    annotations: WRITE,
    description:
      "Adds a remote peer entry (`/interface wireguard peers add`) to an existing WireGuard interface" +
      " — associates a public key with allowed source/destination CIDRs and an optional remote endpoint." +
      " Use this for each client or remote site connecting to a WireGuard interface created with create_wireguard_interface." +
      " For IPsec peers use create_ipsec_peer." +
      " Returns the created peer's detail including its .id.\n\n" +
      "Notes:\n" +
      '  allowed_address: CIDR, comma-separated for multiple e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24"\n' +
      '  endpoint_address: remote host IP or hostname e.g. "203.0.113.1" (omit for road-warrior clients that dial in)\n' +
      '  persistent_keepalive: seconds as string e.g. "25"',
    inputSchema: {
      interface: z.string(),
      public_key: z.string(),
      allowed_address: z
        .string()
        .describe(
          'CIDR, comma-separated for multiple e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24"',
        ),
      endpoint_address: z
        .string()
        .optional()
        .describe('remote host IP or hostname e.g. "203.0.113.1"'),
      endpoint_port: z.number().int().optional(),
      preshared_key: z.string().optional(),
      persistent_keepalive: z.string().optional().describe('seconds as string e.g. "25"'),
      name: z.string().optional().describe("optional peer name label"),
      private_key: z
        .string()
        .optional()
        .describe("peer's private key (lets the router generate this peer's client config)"),
      responder: z
        .boolean()
        .optional()
        .describe("only respond to handshakes, never initiate (for road-warrior clients)"),
      client_address: z
        .string()
        .optional()
        .describe("client tunnel address(es) for the generated client config"),
      client_dns: z
        .string()
        .optional()
        .describe("DNS server(s) written into the generated client config"),
      client_endpoint: z
        .string()
        .optional()
        .describe("server endpoint host[:port] written into the generated client config"),
      client_keepalive: z
        .string()
        .optional()
        .describe('client persistent-keepalive for the generated config e.g. "25s"'),
      client_listen_port: z
        .number()
        .int()
        .optional()
        .describe("listen-port written into the generated client config"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(
        `Adding WireGuard peer: interface=${a.interface}, public_key=${a.public_key.slice(0, 12)}...`,
      );
      const cmd = new Cmd("/interface wireguard peers add")
        .set("interface", a.interface)
        .set("public-key", a.public_key)
        .set("allowed-address", a.allowed_address)
        .opt("endpoint-address", a.endpoint_address)
        .opt("endpoint-port", a.endpoint_port)
        .opt("preshared-key", a.preshared_key)
        .opt("persistent-keepalive", a.persistent_keepalive)
        .opt("name", a.name)
        .opt("private-key", a.private_key)
        .bool("responder", a.responder)
        .opt("client-address", a.client_address)
        .opt("client-dns", a.client_dns)
        .opt("client-endpoint", a.client_endpoint)
        .opt("client-keepalive", a.client_keepalive)
        .opt("client-listen-port", a.client_listen_port)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add WireGuard peer: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface wireguard peers print detail where interface="${a.interface}" public-key="${a.public_key}"`,
        ctx,
      );
      return details.trim()
        ? `WireGuard peer added successfully:\n\n${details}`
        : "WireGuard peer added successfully.";
    },
  }),

  defineTool({
    name: "list_wireguard_peers",
    title: "List WireGuard Peers",
    annotations: READ,
    description:
      "`list_wireguard_peers` — READ / list / show / inspect all WireGuard peers" +
      " (`/interface wireguard peers print`). Use this to read which peers are configured and" +
      " whether the tunnel is up (handshake). Returns each peer's .id, interface, public-key," +
      " allowed-address, endpoint/current-endpoint, last-handshake time, and rx/tx byte counters." +
      " Filter by interface name (interface_filter) or disabled-only. For the interface table use" +
      " list_wireguard_interfaces; for one peer's full detail use get_wireguard_peer; for interfaces" +
      " AND peers in one call use get_wireguard_status. Use the .id from this output with" +
      " update_wireguard_peer, remove_wireguard_peer, enable_wireguard_peer, or disable_wireguard_peer.",
    inputSchema: {
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing WireGuard peers");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/interface wireguard peers print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No WireGuard peers found." : `WIREGUARD PEERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_wireguard_peer",
    title: "Get WireGuard Peer Details",
    annotations: READ,
    description:
      "`get_wireguard_peer` — READ / get / show the full detail of ONE WireGuard peer" +
      " (`/interface wireguard peers print detail`) by its .id. Returns public-key, allowed-address," +
      " endpoint/current-endpoint, preshared-key presence, last-handshake time, and rx/tx bytes." +
      " To list all peers use list_wireguard_peers; for interfaces AND peers in one call use" +
      " get_wireguard_status.\n\n" +
      "Notes:\n" +
      '  peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"',
    inputSchema: {
      peer_id: z.string().describe('"*N" or "N" from list output e.g. "*2"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting WireGuard peer details: peer_id=${a.peer_id}`);
      const id = await resolvePeerId(a.peer_id, ctx);
      if (!id) return peerNotFound(a.peer_id);
      const result = await executeMikrotikCommand(
        `/interface wireguard peers print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result) ? peerNotFound(a.peer_id) : `WIREGUARD PEER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_wireguard_peer",
    title: "Update WireGuard Peer",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing WireGuard peer (`/interface wireguard peers set`) by its .id" +
      " — change allowed addresses, endpoint address/port, preshared key, keepalive interval, or disabled state." +
      " Only supplied fields are changed; omitted fields are left as-is." +
      " For updating the parent interface use update_wireguard_interface." +
      " Returns the updated peer's detail.\n\n" +
      "Notes:\n" +
      '  peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"\n' +
      '  allowed_address: CIDR, comma-separated e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24"\n' +
      '  persistent_keepalive: seconds as string e.g. "25"\n' +
      '  Pass "" for endpoint_address or preshared_key to clear them.',
    inputSchema: {
      peer_id: z.string().describe('"*N" or "N" from list output e.g. "*2"'),
      public_key: z
        .string()
        .optional()
        .describe(
          "The peer's base64 public key — re-key a peer in place instead of removing and " +
            "re-adding it (which would lose the rest of its configuration).",
        ),
      allowed_address: z.string().optional(),
      endpoint_address: z.string().optional(),
      endpoint_port: z.number().int().optional(),
      preshared_key: z.string().optional(),
      persistent_keepalive: z.string().optional(),
      name: z.string().optional().describe("optional peer name label"),
      private_key: z
        .string()
        .optional()
        .describe("peer's private key (lets the router generate this peer's client config)"),
      responder: z.boolean().optional().describe("only respond to handshakes, never initiate"),
      client_address: z
        .string()
        .optional()
        .describe("client tunnel address(es) for the generated client config"),
      client_dns: z
        .string()
        .optional()
        .describe("DNS server(s) written into the generated client config"),
      client_endpoint: z
        .string()
        .optional()
        .describe("server endpoint host[:port] written into the generated client config"),
      client_keepalive: z
        .string()
        .optional()
        .describe('client persistent-keepalive for the generated config e.g. "25s"'),
      client_listen_port: z
        .number()
        .int()
        .optional()
        .describe("listen-port written into the generated client config"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating WireGuard peer: peer_id=${a.peer_id}`);
      const id = await resolvePeerId(a.peer_id, ctx);
      if (!id) return peerNotFound(a.peer_id);
      const base = `/interface wireguard peers set ${id}`;
      const cmd = new Cmd(base)
        .raw(a.public_key !== undefined ? `public-key=${quoteValue(a.public_key)}` : null)
        .raw(
          a.allowed_address !== undefined
            ? `allowed-address=${quoteValue(a.allowed_address)}`
            : null,
        )
        .raw(
          a.endpoint_address !== undefined
            ? a.endpoint_address === ""
              ? "!endpoint-address"
              : `endpoint-address=${quoteValue(a.endpoint_address)}`
            : null,
        )
        .opt("endpoint-port", a.endpoint_port)
        .raw(
          a.preshared_key !== undefined
            ? a.preshared_key === ""
              ? "!preshared-key"
              : `preshared-key=${quoteValue(a.preshared_key)}`
            : null,
        )
        .raw(
          a.persistent_keepalive !== undefined
            ? `persistent-keepalive=${a.persistent_keepalive}`
            : null,
        )
        .opt("name", a.name)
        .opt("private-key", a.private_key)
        .bool("responder", a.responder)
        .raw(
          a.client_address !== undefined
            ? a.client_address === ""
              ? "!client-address"
              : `client-address=${quoteValue(a.client_address)}`
            : null,
        )
        .raw(
          a.client_dns !== undefined
            ? a.client_dns === ""
              ? "!client-dns"
              : `client-dns=${quoteValue(a.client_dns)}`
            : null,
        )
        .raw(
          a.client_endpoint !== undefined
            ? a.client_endpoint === ""
              ? "!client-endpoint"
              : `client-endpoint=${quoteValue(a.client_endpoint)}`
            : null,
        )
        .opt("client-keepalive", a.client_keepalive)
        .opt("client-listen-port", a.client_listen_port)
        .raw(a.comment !== undefined ? `comment=${quoteValue(a.comment)}` : null)
        .bool("disabled", a.disabled)
        .build();

      if (cmd === base) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update WireGuard peer: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface wireguard peers print detail where .id=${id}`,
        ctx,
      );
      return `WireGuard peer ${id} updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_wireguard_peer",
    title: "Remove WireGuard Peer",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a single WireGuard peer entry (`/interface wireguard peers remove`) by its .id." +
      " Verifies existence first with count-only. Leaves the parent WireGuard interface untouched." +
      " To remove the entire interface and all its peers use remove_wireguard_interface.\n\n" +
      "Notes:\n" +
      '  peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"',
    inputSchema: {
      peer_id: z.string().describe('"*N" or "N" from list output e.g. "*2"'),
    },
    async handler(a, ctx) {
      ctx.info(`Removing WireGuard peer: peer_id=${a.peer_id}`);
      const id = await resolvePeerId(a.peer_id, ctx);
      if (!id) return peerNotFound(a.peer_id);

      // Capture what is about to be deleted so a drifted row position is
      // visible in the result rather than silently taking out a neighbour.
      const doomed = await executeMikrotikCommand(
        `/interface wireguard peers print detail where .id=${id}`,
        ctx,
      );
      const result = await executeMikrotikCommand(`/interface wireguard peers remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove WireGuard peer: ${result}`;
      return `WireGuard peer ${id} removed successfully. Removed entry was:\n\n${doomed}`;
    },
  }),

  defineTool({
    name: "enable_wireguard_peer",
    title: "Enable WireGuard Peer",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled WireGuard peer (`/interface wireguard peers enable`) by its .id," +
      " allowing traffic through that peer's tunnel without affecting the parent interface." +
      " For enabling the parent interface use enable_wireguard_interface." +
      " To undo, use disable_wireguard_peer.\n\n" +
      "Notes:\n" +
      '  peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"',
    inputSchema: {
      peer_id: z.string().describe('"*N" or "N" from list output e.g. "*2"'),
    },
    async handler(a, ctx) {
      ctx.info(`Enabling WireGuard peer: peer_id=${a.peer_id}`);
      const id = await resolvePeerId(a.peer_id, ctx);
      if (!id) return peerNotFound(a.peer_id);
      const result = await executeMikrotikCommand(`/interface wireguard peers enable ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to enable WireGuard peer: ${result}`;
      return `WireGuard peer ${id} enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_wireguard_peer",
    title: "Disable WireGuard Peer",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables a WireGuard peer (`/interface wireguard peers disable`) by its .id," +
      " blocking tunnel traffic for that peer without removing it or affecting the parent interface." +
      " For disabling the parent interface use disable_wireguard_interface." +
      " To re-enable use enable_wireguard_peer.\n\n" +
      "Notes:\n" +
      '  peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"',
    inputSchema: {
      peer_id: z.string().describe('"*N" or "N" from list output e.g. "*2"'),
    },
    async handler(a, ctx) {
      ctx.info(`Disabling WireGuard peer: peer_id=${a.peer_id}`);
      const id = await resolvePeerId(a.peer_id, ctx);
      if (!id) return peerNotFound(a.peer_id);
      const result = await executeMikrotikCommand(`/interface wireguard peers disable ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to disable WireGuard peer: ${result}`;
      return `WireGuard peer ${id} disabled successfully.`;
    },
  }),

  defineTool({
    name: "generate_wireguard_client_config",
    title: "Generate WireGuard Client Config File",
    annotations: READ,
    description:
      "Generates a standard wg0.conf client configuration file (`[Interface] + [Peer]` sections)" +
      " entirely from the provided keys and server endpoint — runs locally, never contacts the router." +
      " Use this after registering a client's public key with add_wireguard_peer to produce the config text" +
      " to distribute to that client." +
      " Returns the config text ready to save as /etc/wireguard/wg0.conf (Linux) or import into" +
      " the WireGuard app, with instructions for generating client keys and bringing the tunnel up.\n\n" +
      "Notes:\n" +
      '  allowed_ips: CIDRs routed through the tunnel by the client, default "0.0.0.0/0" (all IPv4 traffic; add ::/0 to also route IPv6)\n' +
      "  persistent_keepalive: seconds integer, default 25",
    inputSchema: {
      client_private_key: z.string(),
      client_address: z.string(),
      server_public_key: z.string(),
      server_endpoint: z.string(),
      server_port: z.number().int().default(51820),
      allowed_ips: z.string().default("0.0.0.0/0"),
      dns: z.string().optional(),
      persistent_keepalive: z.number().int().default(25),
    },
    async handler(a, ctx) {
      ctx.info("Generating WireGuard client configuration");

      const lines = [
        "[Interface]",
        `PrivateKey = ${a.client_private_key}`,
        `Address = ${a.client_address}`,
      ];

      if (a.dns) lines.push(`DNS = ${a.dns}`);

      lines.push(
        "",
        "[Peer]",
        `PublicKey = ${a.server_public_key}`,
        `Endpoint = ${a.server_endpoint}:${a.server_port}`,
        `AllowedIPs = ${a.allowed_ips}`,
      );

      if (a.persistent_keepalive > 0) lines.push(`PersistentKeepalive = ${a.persistent_keepalive}`);

      const configText = lines.join("\n");

      return (
        "WIREGUARD CLIENT CONFIGURATION\n" +
        "Save as /etc/wireguard/wg0.conf (Linux) or import into your WireGuard app:\n\n" +
        `${configText}\n\n` +
        "NEXT STEPS:\n" +
        "1. Generate the client key-pair on the client device:\n" +
        "     wg genkey | tee private.key | wg pubkey > public.key\n" +
        "2. Replace 'PrivateKey' above with the content of private.key.\n" +
        "3. Register the client's public key on the server with add_wireguard_peer,\n" +
        `   setting allowed_address to ${a.client_address.split("/")[0]}/32.\n` +
        "4. Bring the tunnel up:\n" +
        "     wg-quick up wg0"
      );
    },
  }),
];
