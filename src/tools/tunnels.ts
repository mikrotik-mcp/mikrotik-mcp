/**
 * L2/L3 tunnel interfaces — GRE, IPIP, EoIP, VXLAN.
 *
 * Covers `/interface gre`, `/interface ipip`, `/interface eoip`, and
 * `/interface vxlan`. Each tunnel type exposes the same create/list/get/remove
 * lifecycle and follows the canonical tool-module pattern (see `vlan.ts`).
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

const DontFragment = z.enum(["inherit", "no"]);
const Arp = z.enum(["disabled", "enabled", "local-proxy-arp", "proxy-arp", "reply-only"]);
const VtepsIpVersion = z.enum(["ipv4", "ipv6"]);

export const tunnelTools: ToolModule = [
  // ── GRE — `/interface gre` ────────────────────────────────────────────────
  defineTool({
    name: "create_gre_tunnel",
    title: "Create GRE Tunnel Interface",
    annotations: WRITE,
    description:
      "Creates an IPv4 GRE (Generic Routing Encapsulation) L3 tunnel interface (`/interface gre`)." +
      " Use to encapsulate routed traffic between two endpoints for site-to-site connectivity when IPsec encryption is not needed." +
      " GRE is L3-only and not bridgeable; for bridgeable L2 Ethernet-over-IP tunnels use create_eoip_tunnel;" +
      " for raw IP-in-IP with less overhead use create_ipip_tunnel; for L2 VXLAN overlays use create_vxlan_tunnel;" +
      " for VPN client interfaces use create_l2tp_client, create_pptp_client, create_sstp_client, or create_ovpn_client." +
      " Keepalive format: '<interval>,<retries>', e.g. '10s,3'." +
      " Returns the created interface detail including name, remote-address, and run-time status.",
    inputSchema: {
      name: interfaceName("Name for the new GRE tunnel interface, e.g. 'gre-to-hq'"),
      remote_address: z.string().describe("Remote endpoint IP address"),
      local_address: z.string().optional().describe("Local endpoint IP address"),
      keepalive: z.string().optional().describe("Keepalive interval/retries, e.g. '10s,3'"),
      dont_fragment: DontFragment.optional().describe("Don't-fragment behavior"),
      clamp_tcp_mss: z.boolean().optional().describe("Clamp TCP MSS to the tunnel MTU"),
      allow_fast_path: z.boolean().optional().describe("Allow FastPath processing for this tunnel"),
      ipsec_secret: z
        .string()
        .optional()
        .describe("Pre-shared key to auto-create an IPsec policy securing the tunnel"),
      dscp: z.string().optional().describe("DSCP for encapsulated packets: 'inherit' or 0-63"),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating GRE tunnel: name=${a.name}, remote_address=${a.remote_address}`);
      const cmd = new Cmd("/interface gre add")
        .set("name", a.name)
        .set("remote-address", a.remote_address)
        .opt("local-address", a.local_address)
        .opt("keepalive", a.keepalive)
        .opt("dont-fragment", a.dont_fragment)
        .bool("clamp-tcp-mss", a.clamp_tcp_mss)
        .bool("allow-fast-path", a.allow_fast_path)
        .opt("ipsec-secret", a.ipsec_secret)
        .opt("dscp", a.dscp)
        .opt("mtu", a.mtu)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create GRE tunnel: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface gre print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `GRE tunnel created successfully:\n\n${details}`
        : "GRE tunnel creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_gre_tunnels",
    title: "List GRE Tunnel Interfaces",
    annotations: READ,
    description:
      "Lists all GRE tunnel interfaces (`/interface gre print`)." +
      " Use to inventory or audit existing GRE tunnels and their remote endpoints." +
      " Supports optional partial name filter via name_filter." +
      " For full detail on one tunnel use get_gre_tunnel; for IPIP tunnels use list_ipip_tunnels;" +
      " for EoIP tunnels use list_eoip_tunnels; for VXLAN use list_vxlan_tunnels." +
      " Returns name, remote-address, local-address, MTU, and run-time status for each interface.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing GRE tunnels");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface gre print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No GRE tunnels found matching the criteria."
        : `GRE TUNNELS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_gre_tunnel",
    title: "Get GRE Tunnel Interface Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single GRE tunnel interface by name (`/interface gre print detail where name=...`)." +
      " Use to inspect all parameters of one tunnel — remote-address, local-address, keepalive, MTU, dont-fragment, and status." +
      " For a summary list of all GRE tunnels use list_gre_tunnels." +
      " For IPIP detail use get_ipip_tunnel; for EoIP detail use get_eoip_tunnel; for VXLAN detail use get_vxlan_tunnel." +
      " Returns the complete property set for the named interface, or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting GRE tunnel details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface gre print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `GRE tunnel '${a.name}' not found.`
        : `GRE TUNNEL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_gre_tunnel",
    title: "Remove GRE Tunnel Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a GRE tunnel interface by name (`/interface gre remove [find name=...]`)." +
      " Verifies existence via count-only before removal and returns a not-found message if the interface does not exist." +
      " This is destructive and immediately disconnects any traffic using the tunnel." +
      " For IPIP removal use remove_ipip_tunnel; for EoIP use remove_eoip_tunnel; for VXLAN use remove_vxlan_tunnel.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing GRE tunnel: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface gre print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `GRE tunnel '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface gre remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove GRE tunnel: ${result}`;
      return `GRE tunnel '${a.name}' removed successfully.`;
    },
  }),

  // ── IPIP — `/interface ipip` ──────────────────────────────────────────────
  defineTool({
    name: "create_ipip_tunnel",
    title: "Create IPIP Tunnel Interface",
    annotations: WRITE,
    description:
      "Creates an IPv4 IPIP (IP-in-IP) L3 tunnel interface (`/interface ipip`)." +
      " Use for lightweight point-to-point IP encapsulation with minimal overhead when GRE's extra header byte is undesirable." +
      " IPIP is L3-only and not bridgeable; for GRE encapsulation (with dont-fragment support) use create_gre_tunnel;" +
      " for L2 Ethernet-over-IP tunnels use create_eoip_tunnel; for VXLAN L2 overlays use create_vxlan_tunnel." +
      " Keepalive format: '<interval>,<retries>', e.g. '10s,3'." +
      " Returns the created interface detail including name, remote-address, and run-time status.",
    inputSchema: {
      name: interfaceName("Name for the new IPIP tunnel interface, e.g. 'ipip-to-hq'"),
      remote_address: z.string().describe("Remote endpoint IP address"),
      local_address: z.string().optional().describe("Local endpoint IP address"),
      keepalive: z.string().optional().describe("Keepalive interval/retries, e.g. '10s,3'"),
      dont_fragment: DontFragment.optional().describe("Don't-fragment behavior"),
      clamp_tcp_mss: z.boolean().optional().describe("Clamp TCP MSS to the tunnel MTU"),
      allow_fast_path: z.boolean().optional().describe("Allow FastPath processing for this tunnel"),
      ipsec_secret: z
        .string()
        .optional()
        .describe("Pre-shared key to auto-create an IPsec policy securing the tunnel"),
      dscp: z.string().optional().describe("DSCP for encapsulated packets: 'inherit' or 0-63"),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPIP tunnel: name=${a.name}, remote_address=${a.remote_address}`);
      const cmd = new Cmd("/interface ipip add")
        .set("name", a.name)
        .set("remote-address", a.remote_address)
        .opt("local-address", a.local_address)
        .opt("keepalive", a.keepalive)
        .opt("dont-fragment", a.dont_fragment)
        .bool("clamp-tcp-mss", a.clamp_tcp_mss)
        .bool("allow-fast-path", a.allow_fast_path)
        .opt("ipsec-secret", a.ipsec_secret)
        .opt("dscp", a.dscp)
        .opt("mtu", a.mtu)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPIP tunnel: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface ipip print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `IPIP tunnel created successfully:\n\n${details}`
        : "IPIP tunnel creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipip_tunnels",
    title: "List IPIP Tunnel Interfaces",
    annotations: READ,
    description:
      "Lists all IPIP tunnel interfaces (`/interface ipip print`)." +
      " Use to inventory existing IPIP tunnels and their remote endpoints." +
      " Supports optional partial name filter via name_filter." +
      " For full detail on one tunnel use get_ipip_tunnel; for GRE tunnels use list_gre_tunnels;" +
      " for EoIP tunnels use list_eoip_tunnels; for VXLAN use list_vxlan_tunnels." +
      " Returns name, remote-address, local-address, MTU, and run-time status for each interface.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPIP tunnels");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface ipip print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPIP tunnels found matching the criteria."
        : `IPIP TUNNELS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipip_tunnel",
    title: "Get IPIP Tunnel Interface Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single IPIP tunnel interface by name (`/interface ipip print detail where name=...`)." +
      " Use to inspect all parameters of one tunnel — remote-address, local-address, keepalive, MTU, and status." +
      " For a summary list of all IPIP tunnels use list_ipip_tunnels." +
      " For GRE detail use get_gre_tunnel; for EoIP detail use get_eoip_tunnel; for VXLAN detail use get_vxlan_tunnel." +
      " Returns the complete property set for the named interface, or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IPIP tunnel details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface ipip print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPIP tunnel '${a.name}' not found.`
        : `IPIP TUNNEL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipip_tunnel",
    title: "Remove IPIP Tunnel Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPIP tunnel interface by name (`/interface ipip remove [find name=...]`)." +
      " Verifies existence via count-only before removal and returns a not-found message if the interface does not exist." +
      " This is destructive and immediately disconnects any traffic using the tunnel." +
      " For GRE removal use remove_gre_tunnel; for EoIP use remove_eoip_tunnel; for VXLAN use remove_vxlan_tunnel.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPIP tunnel: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface ipip print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPIP tunnel '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ipip remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPIP tunnel: ${result}`;
      return `IPIP tunnel '${a.name}' removed successfully.`;
    },
  }),

  // ── EoIP — `/interface eoip` (Ethernet over IP, L2) ───────────────────────
  defineTool({
    name: "create_eoip_tunnel",
    title: "Create EoIP Tunnel Interface",
    annotations: WRITE,
    description:
      "Creates an EoIP (Ethernet over IP) L2 tunnel interface (`/interface eoip`)." +
      " Use when you need a bridgeable L2 link between two MikroTik devices — traffic appears as raw Ethernet frames over IP." +
      " Each tunnel requires a unique tunnel_id (0-65535) that must match identically on both peers; mismatched IDs are the most common misconfiguration." +
      " EoIP is MikroTik-proprietary — both endpoints must run RouterOS." +
      " For L3-only encapsulation use create_gre_tunnel or create_ipip_tunnel; for open-standard L2 overlays use create_vxlan_tunnel." +
      " Keepalive format: '<interval>,<retries>', e.g. '10s,3'." +
      " Returns the created interface detail including name, remote-address, tunnel-id, and run-time status.",
    inputSchema: {
      name: interfaceName("Name for the new EoIP tunnel interface, e.g. 'eoip-to-hq'"),
      remote_address: z.string().describe("Remote endpoint IP address"),
      tunnel_id: z.number().int().describe("Unique tunnel ID, must match on both peers"),
      local_address: z.string().optional().describe("Local endpoint IP address"),
      keepalive: z.string().optional().describe("Keepalive interval/retries, e.g. '10s,3'"),
      dont_fragment: DontFragment.optional().describe("Don't-fragment behavior"),
      clamp_tcp_mss: z.boolean().optional().describe("Clamp TCP MSS to the tunnel MTU"),
      allow_fast_path: z.boolean().optional().describe("Allow FastPath processing for this tunnel"),
      ipsec_secret: z
        .string()
        .optional()
        .describe("Pre-shared key to auto-create an IPsec policy securing the tunnel"),
      dscp: z.string().optional().describe("DSCP for encapsulated packets: 'inherit' or 0-63"),
      mac_address: z.string().optional().describe("MAC address of the EoIP interface"),
      arp: Arp.optional().describe("Address Resolution Protocol mode for the interface"),
      arp_timeout: z.string().optional().describe("ARP entry timeout, e.g. '30s' or 'auto'"),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(
        `Creating EoIP tunnel: name=${a.name}, remote_address=${a.remote_address}, tunnel_id=${a.tunnel_id}`,
      );
      const cmd = new Cmd("/interface eoip add")
        .set("name", a.name)
        .set("remote-address", a.remote_address)
        .set("tunnel-id", a.tunnel_id)
        .opt("local-address", a.local_address)
        .opt("keepalive", a.keepalive)
        .opt("dont-fragment", a.dont_fragment)
        .bool("clamp-tcp-mss", a.clamp_tcp_mss)
        .bool("allow-fast-path", a.allow_fast_path)
        .opt("ipsec-secret", a.ipsec_secret)
        .opt("dscp", a.dscp)
        .opt("mac-address", a.mac_address)
        .opt("arp", a.arp)
        .opt("arp-timeout", a.arp_timeout)
        .opt("mtu", a.mtu)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create EoIP tunnel: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface eoip print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `EoIP tunnel created successfully:\n\n${details}`
        : "EoIP tunnel creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_eoip_tunnels",
    title: "List EoIP Tunnel Interfaces",
    annotations: READ,
    description:
      "Lists all EoIP tunnel interfaces (`/interface eoip print`)." +
      " Use to inventory existing EoIP tunnels and check their tunnel-id assignments to detect duplicates or mismatches." +
      " Supports optional partial name filter via name_filter." +
      " For full detail on one tunnel use get_eoip_tunnel; for GRE tunnels use list_gre_tunnels;" +
      " for IPIP tunnels use list_ipip_tunnels; for VXLAN use list_vxlan_tunnels." +
      " Returns name, remote-address, tunnel-id, MTU, and run-time status for each interface.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing EoIP tunnels");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface eoip print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No EoIP tunnels found matching the criteria."
        : `EOIP TUNNELS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_eoip_tunnel",
    title: "Get EoIP Tunnel Interface Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single EoIP tunnel interface by name (`/interface eoip print detail where name=...`)." +
      " Use to inspect the tunnel-id, remote-address, local-address, keepalive, MTU, and status of one tunnel." +
      " For a summary list of all EoIP tunnels use list_eoip_tunnels." +
      " For GRE detail use get_gre_tunnel; for IPIP detail use get_ipip_tunnel; for VXLAN detail use get_vxlan_tunnel." +
      " Returns the complete property set for the named interface, or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting EoIP tunnel details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface eoip print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `EoIP tunnel '${a.name}' not found.`
        : `EOIP TUNNEL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_eoip_tunnel",
    title: "Remove EoIP Tunnel Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an EoIP tunnel interface by name (`/interface eoip remove [find name=...]`)." +
      " Verifies existence via count-only before removal and returns a not-found message if the interface does not exist." +
      " This is destructive and immediately severs the L2 bridge link using this tunnel." +
      " For GRE removal use remove_gre_tunnel; for IPIP use remove_ipip_tunnel; for VXLAN use remove_vxlan_tunnel.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing EoIP tunnel: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface eoip print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `EoIP tunnel '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface eoip remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove EoIP tunnel: ${result}`;
      return `EoIP tunnel '${a.name}' removed successfully.`;
    },
  }),

  // ── VXLAN — `/interface vxlan` ────────────────────────────────────────────
  defineTool({
    name: "create_vxlan_tunnel",
    title: "Create VXLAN Tunnel Interface",
    annotations: WRITE,
    description:
      "Creates a VXLAN (Virtual Extensible LAN) L2 overlay interface (`/interface vxlan`)." +
      " Use to build scalable L2 overlays across L3 networks — the VNI (VXLAN Network Identifier) scopes the broadcast domain, suited for multi-tenant or data-centre scenarios." +
      " VXLAN is an open standard and works with non-MikroTik peers; for MikroTik-proprietary L2 tunnels use create_eoip_tunnel;" +
      " for L3-only encapsulation use create_gre_tunnel or create_ipip_tunnel." +
      " UDP port defaults to 8472; VNI must match on all participating VTEPs." +
      " Returns the created interface detail including name, VNI, port, and run-time status.",
    inputSchema: {
      name: interfaceName("Name for the new VXLAN interface, e.g. 'vxlan1'"),
      vni: z.number().int().describe("VXLAN Network Identifier (VNI)"),
      port: z.number().int().default(8472).describe("UDP port (default 8472)"),
      local_address: z.string().optional().describe("Local source IP address"),
      interface: z.string().optional().describe("Source interface"),
      group: z
        .string()
        .optional()
        .describe("Multicast group address for broadcast/unknown-unicast flooding"),
      vteps_ip_version: VtepsIpVersion.optional().describe("IP version used for VTEP addressing"),
      mac_address: z.string().optional().describe("MAC address of the VXLAN interface"),
      arp: Arp.optional().describe("Address Resolution Protocol mode for the interface"),
      arp_timeout: z.string().optional().describe("ARP entry timeout, e.g. '30s' or 'auto'"),
      max_fdb_size: z.number().int().optional().describe("Maximum forwarding database (FDB) size"),
      allow_fast_path: z
        .boolean()
        .optional()
        .describe("Allow FastPath processing for this interface"),
      mtu: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating VXLAN tunnel: name=${a.name}, vni=${a.vni}`);
      const cmd = new Cmd("/interface vxlan add")
        .set("name", a.name)
        .set("vni", a.vni)
        .opt("port", a.port)
        .opt("local-address", a.local_address)
        .opt("interface", a.interface)
        .opt("group", a.group)
        .opt("vteps-ip-version", a.vteps_ip_version)
        .opt("mac-address", a.mac_address)
        .opt("arp", a.arp)
        .opt("arp-timeout", a.arp_timeout)
        .opt("max-fdb-size", a.max_fdb_size)
        .bool("allow-fast-path", a.allow_fast_path)
        .opt("mtu", a.mtu)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create VXLAN tunnel: ${result}`;

      const details = await executeMikrotikCommand(
        `/interface vxlan print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `VXLAN tunnel created successfully:\n\n${details}`
        : "VXLAN tunnel creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_vxlan_tunnels",
    title: "List VXLAN Tunnel Interfaces",
    annotations: READ,
    description:
      "Lists all VXLAN interfaces (`/interface vxlan print`)." +
      " Use to inventory existing VXLAN overlays and check their VNI and UDP port assignments." +
      " Supports optional partial name filter via name_filter." +
      " For full detail on one interface use get_vxlan_tunnel; for EoIP tunnels use list_eoip_tunnels;" +
      " for GRE tunnels use list_gre_tunnels; for IPIP tunnels use list_ipip_tunnels." +
      " Returns name, VNI, port, local-address, MTU, and run-time status for each interface.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing VXLAN tunnels");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/interface vxlan print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No VXLAN tunnels found matching the criteria."
        : `VXLAN TUNNELS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_vxlan_tunnel",
    title: "Get VXLAN Tunnel Interface Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single VXLAN interface by name (`/interface vxlan print detail where name=...`)." +
      " Use to inspect the VNI, UDP port, local-address, source interface, MTU, and status of one VXLAN interface." +
      " For a summary list of all VXLAN interfaces use list_vxlan_tunnels." +
      " For EoIP detail use get_eoip_tunnel; for GRE detail use get_gre_tunnel; for IPIP detail use get_ipip_tunnel." +
      " Returns the complete property set for the named interface, or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting VXLAN tunnel details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface vxlan print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `VXLAN tunnel '${a.name}' not found.`
        : `VXLAN TUNNEL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_vxlan_tunnel",
    title: "Remove VXLAN Tunnel Interface",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a VXLAN interface by name (`/interface vxlan remove [find name=...]`)." +
      " Verifies existence via count-only before removal and returns a not-found message if the interface does not exist." +
      " This is destructive and immediately severs all L2 overlay traffic using this VNI endpoint." +
      " For EoIP removal use remove_eoip_tunnel; for GRE use remove_gre_tunnel; for IPIP use remove_ipip_tunnel.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing VXLAN tunnel: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/interface vxlan print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `VXLAN tunnel '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface vxlan remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove VXLAN tunnel: ${result}`;
      return `VXLAN tunnel '${a.name}' removed successfully.`;
    },
  }),
];
