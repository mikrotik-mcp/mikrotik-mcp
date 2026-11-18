/** DHCPv6 relay — `/ipv6 dhcp-relay`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const ipv6DhcpRelayTools: ToolModule = [
  defineTool({
    name: "add_ipv6_dhcp_relay",
    title: "Add IPv6 DHCP Relay",
    annotations: WRITE,
    description:
      "Creates an IPv6 DHCP relay agent (`/ipv6 dhcp-relay`) that forwards DHCPv6 client " +
      "requests from a local interface to one or more upstream DHCPv6 servers. Use when clients " +
      "on a subnet cannot reach the DHCPv6 server directly and need relay forwarding. " +
      "For serving DHCPv6 addresses directly (no relay) use create_ipv6_dhcp_server. " +
      "Returns the created relay's full detail on success.\n\n" +
      "Args:\n" +
      "    dhcp_server: comma-separated IPv6 address(es) of upstream DHCPv6 servers.\n" +
      "    interface: the interface facing the DHCPv6 clients.",
    inputSchema: {
      name: z.string(),
      interface: z.string().describe("Interface facing the DHCPv6 clients"),
      dhcp_server: z.string().describe("Comma-separated upstream DHCPv6 server IPv6 address(es)"),
      delay_time: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding DHCPv6 relay: name=${a.name}`);
      const cmd = new Cmd("/ipv6 dhcp-relay add")
        .set("name", a.name)
        .set("interface", a.interface)
        .set("dhcp-server", a.dhcp_server)
        .opt("delay-time", a.delay_time)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add DHCPv6 relay: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 dhcp-relay print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `DHCPv6 relay added successfully:\n\n${details}`
        : "DHCPv6 relay addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_dhcp_relays",
    title: "List IPv6 DHCP Relays",
    annotations: READ,
    description:
      "Lists IPv6 DHCP relay agents (`/ipv6 dhcp-relay`) configured on the device. " +
      "Use to enumerate all DHCPv6 relay forwarders or to find a relay's `name` for use with " +
      "get_ipv6_dhcp_relay, enable_ipv6_dhcp_relay, disable_ipv6_dhcp_relay, or " +
      "remove_ipv6_dhcp_relay. Supports optional filtering by name substring, interface, or " +
      "disabled state. Returns all matching relay entries.",
    inputSchema: {
      name_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing DHCPv6 relays");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.interface_filter) filters.push(`interface=${quoted(a.interface_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-relay print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No DHCPv6 relays found matching the criteria."
        : `DHCPV6 RELAYS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_dhcp_relay",
    title: "Get IPv6 DHCP Relay Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single IPv6 DHCP relay agent (`/ipv6 dhcp-relay print detail`) " +
      "by name. Use to inspect a specific relay's configuration including its upstream servers and " +
      "client-facing interface. For a summary listing of all relays use list_ipv6_dhcp_relays. " +
      "Returns all fields for the named relay, or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting DHCPv6 relay details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-relay print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `DHCPv6 relay '${a.name}' not found.`
        : `DHCPV6 RELAY DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "enable_ipv6_dhcp_relay",
    title: "Enable IPv6 DHCP Relay",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled IPv6 DHCP relay agent (`/ipv6 dhcp-relay enable`) by name. " +
      "Use to re-activate relay forwarding that was previously stopped without deleting the entry. " +
      "For the inverse operation use disable_ipv6_dhcp_relay; to create a new relay use " +
      "add_ipv6_dhcp_relay. The `name` must match an entry returned by list_ipv6_dhcp_relays.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling DHCPv6 relay: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-relay enable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable DHCPv6 relay: ${result}`;
      return `DHCPv6 relay '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_ipv6_dhcp_relay",
    title: "Disable IPv6 DHCP Relay",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv6 DHCP relay agent (`/ipv6 dhcp-relay disable`) by name without " +
      "removing it. Use to temporarily stop DHCPv6 request forwarding on a relay. " +
      "For the inverse operation use enable_ipv6_dhcp_relay; to permanently delete the relay use " +
      "remove_ipv6_dhcp_relay. The `name` must match an entry returned by list_ipv6_dhcp_relays.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling DHCPv6 relay: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-relay disable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable DHCPv6 relay: ${result}`;
      return `DHCPv6 relay '${a.name}' disabled successfully.`;
    },
  }),

  defineTool({
    name: "remove_ipv6_dhcp_relay",
    title: "Remove IPv6 DHCP Relay",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 DHCP relay agent (`/ipv6 dhcp-relay remove`) by name. " +
      "First confirms existence with a count-only check before removing. " +
      "Use to permanently tear down relay forwarding for a subnet; to disable temporarily " +
      "without deleting use disable_ipv6_dhcp_relay. " +
      "The `name` must match an entry returned by list_ipv6_dhcp_relays.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCPv6 relay: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ipv6 dhcp-relay print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `DHCPv6 relay '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 dhcp-relay remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCPv6 relay: ${result}`;
      return `DHCPv6 relay '${a.name}' removed successfully.`;
    },
  }),
];
