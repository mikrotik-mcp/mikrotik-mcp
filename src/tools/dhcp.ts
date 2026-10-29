/** DHCP servers, networks, and address pools — `/ip dhcp-server` and `/ip pool`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const Authoritative = z.enum(["yes", "no", "after-2sec-delay"]);

export const dhcpTools: ToolModule = [
  defineTool({
    name: "create_dhcp_server",
    title: "Create DHCP Server Instance",
    annotations: WRITE,
    description:
      "Creates an IPv4 DHCP server (`/ip dhcp-server`) bound to a specific interface — assigns a name, address pool, lease time, and authoritative mode to the server process. " +
      "For the subnet parameters pushed to clients (gateway, DNS, domain, NTP) use `create_dhcp_network`. " +
      "For the IP address range the server draws from use `create_dhcp_pool`. " +
      "Returns the created server's full detail including its `.id`.\n\n" +
      'Notes:\n    lease_time: duration e.g. "1d", "12h", "30m", "1h30m"\n' +
      '    authoritative: "yes" | "no" | "after-2sec-delay"',
    inputSchema: {
      name: z.string(),
      interface: z.string(),
      lease_time: z
        .string()
        .default("1d")
        .describe('Lease duration e.g. "1d", "12h", "30m", "1h30m"'),
      address_pool: z.string().optional(),
      disabled: z.boolean().default(false),
      authoritative: Authoritative.default("yes"),
      delay_threshold: z.string().optional(),
      add_arp: z
        .boolean()
        .optional()
        .describe(
          "Add dynamic ARP entry for each lease (use with reply-only ARP on the interface)",
        ),
      always_broadcast: z.boolean().optional().describe("Always send replies as broadcast"),
      ipv6_only_preferred: z
        .boolean()
        .optional()
        .describe("RouterOS 7.25+ advertise DHCP option 108 for IPv6-only preferred clients"),
      bootp_support: z
        .enum(["none", "static", "dynamic"])
        .optional()
        .describe("Which BOOTP requests to answer"),
      conflict_detection: z
        .boolean()
        .optional()
        .describe("Ping/ARP-probe an address before offering it to detect conflicts"),
      use_radius: z
        .enum(["yes", "no", "accounting"])
        .optional()
        .describe("Use RADIUS for leases (accounting = RADIUS accounting only)"),
      relay: z.string().optional().describe("DHCP relay address this server services"),
      server_address: z
        .string()
        .optional()
        .describe("Override the server identifier address sent to clients"),
      lease_script: z.string().optional().describe("Script run on lease assign/release"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating DHCP server: name=${a.name}, interface=${a.interface}`);

      const cmd = new Cmd("/ip dhcp-server add")
        .set("name", a.name)
        .set("interface", a.interface)
        .set("lease-time", a.lease_time)
        .opt("address-pool", a.address_pool)
        .flag("disabled", a.disabled)
        .raw(a.authoritative !== "yes" ? `authoritative=${a.authoritative}` : null)
        .opt("delay-threshold", a.delay_threshold)
        .bool("add-arp", a.add_arp)
        .bool("always-broadcast", a.always_broadcast)
        .bool("ipv6-only-preferred", a.ipv6_only_preferred)
        .opt("bootp-support", a.bootp_support)
        .bool("conflict-detection", a.conflict_detection)
        .opt("use-radius", a.use_radius)
        .opt("relay", a.relay)
        .opt("server-address", a.server_address)
        .opt("lease-script", a.lease_script)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create DHCP server: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip dhcp-server print detail where name="${a.name}"`,
        ctx,
      );
      return `DHCP server created successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_dhcp_servers",
    title: "List DHCP Servers",
    annotations: READ,
    description:
      "Lists all IPv4 DHCP server instances (`/ip dhcp-server`) — returns name, interface, address-pool, lease-time, authoritative mode, and enabled/disabled state for each. " +
      "Optionally filter by name substring (`name_filter`), exact interface (`interface_filter`), disabled-only, or invalid-only. " +
      "To inspect a single server in full detail use `get_dhcp_server`. " +
      "To configure the subnet/gateway/DNS parameters pushed to clients use `create_dhcp_network`; to configure the IP address ranges use `create_dhcp_pool`.",
    inputSchema: {
      name_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(
        `Listing DHCP servers with filters: name=${a.name_filter}, interface=${a.interface_filter}`,
      );

      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");

      const result = await executeMikrotikCommand(
        `/ip dhcp-server print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCP servers found matching the criteria."
        : `DHCP SERVERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_dhcp_server",
    title: "Get DHCP Server Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPv4 DHCP server (`/ip dhcp-server print detail`) by name — returns all fields including `.id`, bound interface, address-pool, lease-time, authoritative mode, and status flags. " +
      "Use `list_dhcp_servers` first to discover server names. " +
      "To create or update the subnet/gateway/DNS parameters this server advertises use `create_dhcp_network`; to create or update the IP pool range use `create_dhcp_pool`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting DHCP server details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip dhcp-server print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `DHCP server '${a.name}' not found.`
        : `DHCP SERVER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "create_dhcp_network",
    title: "Create DHCP Network (Subnet Parameters)",
    annotations: WRITE,
    description:
      "Creates an IPv4 DHCP network entry (`/ip dhcp-server network`) that defines the subnet parameters pushed to DHCP clients — including gateway, DNS servers, domain, WINS servers, NTP servers, and DHCP options for a given address prefix. " +
      "This is the network/scope record, NOT the server process; to create the server process itself use `create_dhcp_server`. " +
      "To define the IP range the server assigns use `create_dhcp_pool`. " +
      "dns_servers, wins_servers, and ntp_servers accept arrays of IP address strings; dhcp_option accepts an array of DHCP option names. " +
      "Returns the created network entry's full detail.",
    inputSchema: {
      network: z.string(),
      gateway: z.string(),
      netmask: z.string().optional(),
      dns_servers: z.array(z.string()).optional(),
      domain: z.string().optional(),
      wins_servers: z.array(z.string()).optional(),
      ntp_servers: z.array(z.string()).optional(),
      dhcp_option: z.array(z.string()).optional(),
      dhcp_option_set: z
        .string()
        .optional()
        .describe("Named option set (`/ip dhcp-server option sets`) to append"),
      dns_none: z
        .boolean()
        .optional()
        .describe("Do not send any DNS server to clients (overrides dns_servers)"),
      next_server: z.string().optional().describe("Next-server (siaddr) address for PXE/TFTP boot"),
      boot_file_name: z
        .string()
        .optional()
        .describe("Boot file name (option 67) for PXE/TFTP boot"),
      caps_manager: z
        .array(z.string())
        .optional()
        .describe("CAPsMAN address(es) advertised to CAPs via DHCP"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating DHCP network: network=${a.network}, gateway=${a.gateway}`);

      const cmd = new Cmd("/ip dhcp-server network add")
        .set("address", a.network)
        .set("gateway", a.gateway)
        .opt("netmask", a.netmask)
        .opt("dns-server", a.dns_servers?.length ? a.dns_servers.join(",") : undefined)
        .opt("domain", a.domain)
        .opt("wins-server", a.wins_servers?.length ? a.wins_servers.join(",") : undefined)
        .opt("ntp-server", a.ntp_servers?.length ? a.ntp_servers.join(",") : undefined)
        .opt("dhcp-option", a.dhcp_option?.length ? a.dhcp_option.join(",") : undefined)
        .opt("dhcp-option-set", a.dhcp_option_set)
        .bool("dns-none", a.dns_none)
        .opt("next-server", a.next_server)
        .opt("boot-file-name", a.boot_file_name)
        .opt("caps-manager", a.caps_manager?.length ? a.caps_manager.join(",") : undefined)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create DHCP network: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip dhcp-server network print detail where address="${a.network}"`,
        ctx,
      );
      return `DHCP network created successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "create_dhcp_pool",
    title: "Create IP Address Pool",
    annotations: WRITE,
    description:
      "Creates an IPv4 address pool (`/ip pool`) that defines IP ranges a DHCP server (or PPP) can assign to clients. " +
      "To create the DHCP server process that uses this pool, call `create_dhcp_server` with `address_pool` set to this pool's name. " +
      "Optionally chains to `next_pool` when this pool is exhausted. " +
      "Returns the created pool's full detail including its `.id`.\n\n" +
      'Notes:\n    ranges: hyphen-separated range e.g. "192.168.1.1-192.168.1.100"\n' +
      '        Multiple ranges comma-separated: "10.0.0.1-10.0.0.50,10.0.0.100-10.0.0.120"',
    inputSchema: {
      name: z.string(),
      ranges: z.string().describe('IP range(s) e.g. "192.168.1.1-192.168.1.100"'),
      next_pool: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating DHCP pool: name=${a.name}, ranges=${a.ranges}`);

      const cmd = new Cmd("/ip pool add")
        .set("name", a.name)
        .set("ranges", a.ranges)
        .opt("next-pool", a.next_pool)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create DHCP pool: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip pool print detail where name="${a.name}"`,
        ctx,
      );
      return `DHCP pool created successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_dhcp_server",
    title: "Remove DHCP Server Instance",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes an IPv4 DHCP server instance (`/ip dhcp-server remove`) by name — first verifies existence via count-only, then deletes. " +
      "Does NOT remove the associated network entry (`/ip dhcp-server network`) or address pool (`/ip pool`); those must be removed separately. " +
      "Stops DHCP service on the bound interface immediately. " +
      "Use `list_dhcp_servers` to confirm the server name before removing.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCP server: name=${a.name}`);

      const count = await executeMikrotikCommand(
        `/ip dhcp-server print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `DHCP server '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip dhcp-server remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCP server: ${result}`;

      return `DHCP server '${a.name}' removed successfully.`;
    },
  }),
];
