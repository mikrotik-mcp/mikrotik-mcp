/** IPv6 Neighbor Discovery / Router Advertisements — `/ipv6 nd` and `/ipv6 nd prefix`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const RaPreference = z.enum(["low", "medium", "high"]);

export const ipv6NdTools: ToolModule = [
  // ── ND interface configuration ──────────────────────────────────────────────
  defineTool({
    name: "add_ipv6_nd",
    title: "Add IPv6 ND Interface Configuration",
    annotations: WRITE,
    description:
      "Create an IPv6 Neighbor Discovery / Router Advertisement interface entry (`/ipv6 nd`) — " +
      "controls RA emission (intervals, lifetime, preference), M/O DHCPv6 flags, hop limit, " +
      "MTU, reachable/retransmit timers, and DNS/MAC advertisement for a specific interface. " +
      "Use when a new interface needs its own ND settings distinct from the global 'all' entry; " +
      "to change an existing entry (including 'all') use update_ipv6_nd. " +
      "To advertise IPv6 prefixes via RA, use add_ipv6_nd_prefix. " +
      "Returns the created entry's full detail including its `.id`.\n\n" +
      "Notes:\n" +
      "    managed_address_configuration (M flag): tell hosts to use DHCPv6 for addresses.\n" +
      "    other_configuration (O flag): tell hosts to use DHCPv6 for other info (e.g. DNS).\n" +
      "    ra_interval: min-max range, e.g. '3m20s-10m'.",
    inputSchema: {
      interface: z.string(),
      ra_interval: z.string().optional().describe("RA min-max interval range, e.g. '3m20s-10m'"),
      ra_delay: z.string().optional(),
      ra_lifetime: z.string().optional().describe("e.g. '30m' or 'none'"),
      ra_preference: RaPreference.optional(),
      hop_limit: z.string().optional().describe("Advertised hop limit (0-255 or 'unspecified')"),
      mtu: z.number().int().optional(),
      reachable_time: z.string().optional(),
      retransmit_interval: z.string().optional(),
      managed_address_configuration: z.boolean().optional(),
      other_configuration: z.boolean().optional(),
      advertise_dns: z.boolean().optional(),
      advertise_mac_address: z.boolean().optional(),
      dns: z
        .string()
        .optional()
        .describe("Recursive DNS servers advertised via RA (RDNSS), comma-separated IPv6"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding IPv6 ND config: interface=${a.interface}`);
      const cmd = new Cmd("/ipv6 nd add")
        .set("interface", a.interface)
        .opt("ra-interval", a.ra_interval)
        .opt("ra-delay", a.ra_delay)
        .opt("ra-lifetime", a.ra_lifetime)
        .opt("ra-preference", a.ra_preference)
        .opt("hop-limit", a.hop_limit)
        .opt("mtu", a.mtu)
        .opt("reachable-time", a.reachable_time)
        .opt("retransmit-interval", a.retransmit_interval)
        .bool("managed-address-configuration", a.managed_address_configuration)
        .bool("other-configuration", a.other_configuration)
        .bool("advertise-dns", a.advertise_dns)
        .bool("advertise-mac-address", a.advertise_mac_address)
        .opt("dns", a.dns)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add IPv6 ND config: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 nd print detail where interface="${a.interface}"`,
        ctx,
      );
      return details.trim()
        ? `IPv6 ND config added successfully:\n\n${details}`
        : "IPv6 ND config addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_nd",
    title: "List IPv6 ND Interface Configurations",
    annotations: READ,
    description:
      "List all per-interface IPv6 Neighbor Discovery / Router Advertisement configurations " +
      "(`/ipv6 nd print`) — shows RA intervals, M/O DHCPv6 flags, hop-limit, MTU, and " +
      "enabled state for each interface entry including the global 'all'. " +
      "To view the prefixes those RAs advertise, use list_ipv6_nd_prefixes. " +
      "Supports optional filters by interface name or disabled-only. " +
      "Returns all matching entries; use get_ipv6_nd for full detail on a single entry.",
    inputSchema: {
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 ND configs");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(`/ipv6 nd print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No IPv6 ND configs found matching the criteria."
        : `IPV6 ND CONFIGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_nd",
    title: "Get IPv6 ND Interface Configuration",
    annotations: READ,
    description:
      "Fetch full detail of a single IPv6 Neighbor Discovery interface configuration " +
      "(`/ipv6 nd print detail`) by RouterOS `.id` (e.g. '*1') or interface name — " +
      "tries `.id` first, falls back to interface name match. " +
      "For a summary table of all interfaces use list_ipv6_nd. " +
      "For advertised prefix entries use list_ipv6_nd_prefixes. " +
      "Returns all RA parameters for the matched entry, or a not-found message.",
    inputSchema: {
      nd_id: z.string().describe("RouterOS .id (e.g. '*1') or the interface name"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 ND config: nd_id=${a.nd_id}`);
      let result = await executeMikrotikCommand(
        `/ipv6 nd print detail where .id="${a.nd_id}"`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/ipv6 nd print detail where interface="${a.nd_id}"`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `IPv6 ND config '${a.nd_id}' not found.`
        : `IPV6 ND CONFIG DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_nd",
    title: "Update IPv6 ND Interface Configuration",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify an existing IPv6 Neighbor Discovery / Router Advertisement configuration " +
      "(`/ipv6 nd set`) by interface name (e.g. 'all', 'ether1') or `.id` — " +
      "use this to tune the global 'all' entry or any per-interface override. " +
      "Selects by `.id` when nd_id starts with '*', otherwise by interface name. " +
      "For adding a brand-new interface entry use add_ipv6_nd. " +
      "For changes to advertised prefixes use add_ipv6_nd_prefix or remove_ipv6_nd_prefix. " +
      "Returns the updated entry's full detail.",
    inputSchema: {
      unset: unsetProperties,
      nd_id: z.string().describe("Interface name (e.g. 'all', 'ether1') or '.id'"),
      ra_interval: z.string().optional(),
      ra_delay: z.string().optional(),
      ra_lifetime: z.string().optional(),
      ra_preference: RaPreference.optional(),
      hop_limit: z.string().optional(),
      mtu: z.number().int().optional(),
      reachable_time: z.string().optional(),
      retransmit_interval: z.string().optional(),
      managed_address_configuration: z.boolean().optional(),
      other_configuration: z.boolean().optional(),
      advertise_dns: z.boolean().optional(),
      advertise_mac_address: z.boolean().optional(),
      dns: z
        .string()
        .optional()
        .describe("Recursive DNS servers advertised via RA (RDNSS), comma-separated IPv6"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IPv6 ND config: nd_id=${a.nd_id}`);
      const selector = a.nd_id.startsWith("*") ? `.id="${a.nd_id}"` : `interface="${a.nd_id}"`;
      const base = `/ipv6 nd set [find ${selector}]`;
      const cmd = new Cmd(base)
        .opt("ra-interval", a.ra_interval)
        .opt("ra-delay", a.ra_delay)
        .opt("ra-lifetime", a.ra_lifetime)
        .opt("ra-preference", a.ra_preference)
        .opt("hop-limit", a.hop_limit)
        .opt("mtu", a.mtu)
        .opt("reachable-time", a.reachable_time)
        .opt("retransmit-interval", a.retransmit_interval)
        .bool("managed-address-configuration", a.managed_address_configuration)
        .bool("other-configuration", a.other_configuration)
        .bool("advertise-dns", a.advertise_dns)
        .bool("advertise-mac-address", a.advertise_mac_address)
        .opt("dns", a.dns);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);
      if (a.disabled !== undefined) cmd.raw(`disabled=${yesno(a.disabled)}`);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update IPv6 ND config: ${result}`;
      const details = await executeMikrotikCommand(`/ipv6 nd print detail where ${selector}`, ctx);
      return `IPv6 ND config updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_nd",
    title: "Remove IPv6 ND Interface Configuration",
    annotations: DESTRUCTIVE,
    description:
      "Delete a per-interface IPv6 Neighbor Discovery configuration entry " +
      "(`/ipv6 nd remove`) by interface name or `.id` — the `.id` is obtained from list_ipv6_nd. " +
      "The built-in 'all' entry cannot be removed; to disable it use update_ipv6_nd with disabled=true. " +
      "For removing advertised prefix entries use remove_ipv6_nd_prefix. " +
      "Verifies existence via count-only before removal; returns success or not-found.",
    inputSchema: {
      nd_id: z.string().describe("Interface name or '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 ND config: nd_id=${a.nd_id}`);
      const selector = a.nd_id.startsWith("*") ? `.id="${a.nd_id}"` : `interface="${a.nd_id}"`;
      const count = await executeMikrotikCommand(
        `/ipv6 nd print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `IPv6 ND config '${a.nd_id}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 nd remove [find ${selector}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 ND config: ${result}`;
      return `IPv6 ND config '${a.nd_id}' removed successfully.`;
    },
  }),

  // ── ND advertised prefixes ──────────────────────────────────────────────────
  defineTool({
    name: "add_ipv6_nd_prefix",
    title: "Add IPv6 ND Advertised Prefix",
    annotations: WRITE,
    description:
      "Add an IPv6 prefix to the Router Advertisement prefix list (`/ipv6 nd prefix add`) — " +
      "announces the prefix in RA messages so hosts can perform SLAAC (autonomous=true, the A flag) " +
      "or learn the on-link prefix. " +
      "This is distinct from ND interface settings (add_ipv6_nd) which control RA timing and M/O flags; " +
      "this tool controls WHAT prefix is carried inside those RAs. " +
      "To list existing advertised prefixes use list_ipv6_nd_prefixes. " +
      "Returns the added prefix's detail including its `.id`.\n\n" +
      "Notes:\n" +
      "    autonomous: allow hosts to auto-configure addresses from this prefix (SLAAC, the A flag).\n" +
      "    prefix format: e.g. '2001:db8:1::/64'.",
    inputSchema: {
      prefix: z.string().describe("Prefix to advertise, e.g. '2001:db8:1::/64'"),
      interface: z.string().optional(),
      valid_lifetime: z.string().optional(),
      preferred_lifetime: z.string().optional(),
      autonomous: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding IPv6 ND prefix: prefix=${a.prefix}`);
      const cmd = new Cmd("/ipv6 nd prefix add")
        .set("prefix", a.prefix)
        .opt("interface", a.interface)
        .opt("valid-lifetime", a.valid_lifetime)
        .opt("preferred-lifetime", a.preferred_lifetime)
        .bool("autonomous", a.autonomous)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add IPv6 ND prefix: ${result}`;
      const details = await executeMikrotikCommand(
        `/ipv6 nd prefix print detail where prefix="${a.prefix}"`,
        ctx,
      );
      return details.trim()
        ? `IPv6 ND prefix added successfully:\n\n${details}`
        : "IPv6 ND prefix addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_ipv6_nd_prefixes",
    title: "List IPv6 ND Advertised Prefixes",
    annotations: READ,
    description:
      "List all IPv6 prefixes advertised in Router Advertisement messages (`/ipv6 nd prefix print`) — " +
      "shows each prefix, its interface, valid/preferred lifetimes, and autonomous (SLAAC A-flag) status. " +
      "To see ND interface settings (RA intervals, M/O flags) rather than the advertised prefixes, " +
      "use list_ipv6_nd. " +
      "Supports optional filters by interface name, prefix substring, or dynamic-only. " +
      "Returns all matching entries; use the `.id` values with remove_ipv6_nd_prefix.",
    inputSchema: {
      interface_filter: z.string().optional(),
      prefix_filter: z.string().optional(),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 ND prefixes");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.prefix_filter) filters.push(`prefix~"${a.prefix_filter}"`);
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 nd prefix print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 ND prefixes found matching the criteria."
        : `IPV6 ND PREFIXES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipv6_nd_prefix",
    title: "Remove IPv6 ND Advertised Prefix",
    annotations: DESTRUCTIVE,
    description:
      "Delete an IPv6 ND advertised prefix entry (`/ipv6 nd prefix remove`) by RouterOS `.id` " +
      "(e.g. '*1') or prefix value (e.g. '2001:db8:1::/64') — the `.id` is obtained from " +
      "list_ipv6_nd_prefixes. Tries `.id` match first, falls back to prefix string match. " +
      "To remove the ND interface configuration (not a prefix) use remove_ipv6_nd. " +
      "Verifies existence via count-only before deletion; returns success or not-found.",
    inputSchema: {
      prefix_id: z.string().describe("RouterOS .id (e.g. '*1') or the prefix"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 ND prefix: prefix_id=${a.prefix_id}`);
      let byId = true;
      let count = await executeMikrotikCommand(
        `/ipv6 nd prefix print count-only where .id="${a.prefix_id}"`,
        ctx,
      );
      if (count.trim() === "0") {
        byId = false;
        count = await executeMikrotikCommand(
          `/ipv6 nd prefix print count-only where prefix="${a.prefix_id}"`,
          ctx,
        );
        if (count.trim() === "0") return `IPv6 ND prefix '${a.prefix_id}' not found.`;
      }
      const selector = byId ? `.id="${a.prefix_id}"` : `prefix="${a.prefix_id}"`;
      const result = await executeMikrotikCommand(`/ipv6 nd prefix remove [find ${selector}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 ND prefix: ${result}`;
      return `IPv6 ND prefix '${a.prefix_id}' removed successfully.`;
    },
  }),
];
