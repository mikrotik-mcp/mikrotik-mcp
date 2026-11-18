/** IGMP Proxy — `/routing igmp-proxy` (settings, interface, mfc) — RouterOS v7. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, looksLikeError, isEmpty, commandUnsupported, Cmd, quoted } from "../core/routeros";

const UNSUPPORTED =
  "IGMP proxy is not available on this device (requires RouterOS v7 with the routing/multicast package).";

export const routingIgmpProxyTools: ToolModule = [
  // ── Global settings ───────────────────────────────────────────────────────
  defineTool({
    name: "get_igmp_proxy_settings",
    title: "Get IGMP Proxy Global Settings",
    annotations: READ,
    description:
      "Read global IGMP proxy settings (`/routing igmp-proxy print`). IGMP proxy forwards IPv4 multicast between a single " +
      "upstream interface and one or more downstream interfaces without a full multicast routing daemon — ideal for " +
      "IPTV distribution. For interface membership configuration use `list_igmp_proxy_interfaces`; for live " +
      "forwarding state use `list_igmp_proxy_mfc`. Returns the current `quick-leave`, `query-interval`, and " +
      "`query-response-interval` values.",
    async handler(_a, ctx) {
      ctx.info("Getting IGMP proxy settings");
      const result = await executeMikrotikCommand("/routing igmp-proxy print", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No IGMP proxy settings reported."
        : `IGMP PROXY SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_igmp_proxy_settings",
    title: "Update IGMP Proxy Global Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update global IGMP proxy settings (`/routing igmp-proxy set`). Tunes IPv4 multicast membership refresh " +
      "timing and fast-leave behaviour for the proxy daemon. For interface-level changes use " +
      "`update_igmp_proxy_interface`. `quick_leave` prunes a multicast group immediately on member leave — " +
      'recommended for IPTV channel zapping; `query_interval` e.g. "125s"; `query_response_interval` e.g. ' +
      '"10s". Returns updated settings on success.',
    inputSchema: {
      quick_leave: z.boolean().optional(),
      query_interval: z.string().optional().describe('e.g. "125s"'),
      query_response_interval: z.string().optional().describe('e.g. "10s"'),
    },
    async handler(a, ctx) {
      ctx.info("Updating IGMP proxy settings");
      const cmd = new Cmd("/routing igmp-proxy set")
        .opt("query-interval", a.query_interval)
        .opt("query-response-interval", a.query_response_interval);
      if (a.quick_leave !== undefined) cmd.bool("quick-leave", a.quick_leave);

      const built = cmd.build();
      if (built === "/routing igmp-proxy set") return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update IGMP proxy settings: ${result}`;
      const details = await executeMikrotikCommand("/routing igmp-proxy print", ctx);
      return `IGMP proxy settings updated:\n\n${details}`;
    },
  }),

  // ── Interfaces ────────────────────────────────────────────────────────────
  defineTool({
    name: "list_igmp_proxy_interfaces",
    title: "List IGMP Proxy Interfaces",
    annotations: READ,
    description:
      "List all IGMP proxy interface entries (`/routing igmp-proxy interface print detail`). Shows each " +
      "interface's role (upstream vs downstream), alternative subnets, TTL threshold, and enabled state. " +
      "Exactly one interface must be `upstream` (toward the IPv4 multicast source); all others are downstream " +
      "toward receivers. For live forwarding state use `list_igmp_proxy_mfc`; to add an entry use " +
      "`add_igmp_proxy_interface`. Returns all configured IGMP proxy interfaces with their properties.",
    async handler(_a, ctx) {
      ctx.info("Listing IGMP proxy interfaces");
      const result = await executeMikrotikCommand(
        "/routing igmp-proxy interface print detail",
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No IGMP proxy interfaces found."
        : `IGMP PROXY INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_igmp_proxy_interface",
    title: "Add IGMP Proxy Interface",
    annotations: WRITE,
    description:
      "Add an interface to the IGMP proxy configuration (`/routing igmp-proxy interface add`). Registers a " +
      "network interface as either upstream (`upstream=true`, toward the IPv4 multicast source) or downstream " +
      "(toward receivers). Only one upstream interface is permitted per proxy instance. " +
      "`alternative_subnets` whitelists extra source subnets reachable through this interface (e.g. " +
      '"10.0.0.0/8"); `threshold` sets the minimum TTL required to forward. For updating an existing entry ' +
      "use `update_igmp_proxy_interface`; to view current entries use `list_igmp_proxy_interfaces`.",
    inputSchema: {
      interface: z.string().describe("Interface name"),
      upstream: z
        .boolean()
        .default(false)
        .describe("true = upstream (toward source), false = downstream"),
      alternative_subnets: z
        .string()
        .optional()
        .describe('Comma list of source subnets, e.g. "10.0.0.0/8"'),
      threshold: z.number().int().optional().describe("Minimum TTL to forward"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding IGMP proxy interface ${a.interface}`);
      const cmd = new Cmd("/routing igmp-proxy interface add")
        .set("interface", a.interface)
        .bool("upstream", a.upstream)
        .opt("alternative-subnets", a.alternative_subnets)
        .opt("threshold", a.threshold)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add IGMP proxy interface: ${result}`;
      return `IGMP proxy interface '${a.interface}' added successfully.`;
    },
  }),

  defineTool({
    name: "update_igmp_proxy_interface",
    title: "Update IGMP Proxy Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update an existing IGMP proxy interface entry by name (`/routing igmp-proxy interface set " +
      "[find interface=...]`). Modifies the upstream/downstream role, alternative subnets, TTL threshold, " +
      "comment, or disabled state of the named interface. For adding a new interface use " +
      "`add_igmp_proxy_interface`; to toggle only the enabled state use `set_igmp_proxy_interface_enabled`. " +
      "Returns updated interface detail on success.",
    inputSchema: {
      unset: unsetProperties,
      interface: z.string().describe("Existing IGMP-proxy interface name"),
      upstream: z.boolean().optional(),
      alternative_subnets: z.string().optional(),
      threshold: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IGMP proxy interface ${a.interface}`);
      const base = `/routing igmp-proxy interface set [find interface=${quoted(a.interface)}]`;
      const cmd = new Cmd(base)
        .opt("alternative-subnets", a.alternative_subnets)
        .opt("threshold", a.threshold);
      if (a.upstream !== undefined) cmd.bool("upstream", a.upstream);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update IGMP proxy interface: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing igmp-proxy interface print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return `IGMP proxy interface '${a.interface}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_igmp_proxy_interface",
    title: "Remove IGMP Proxy Interface",
    annotations: DESTRUCTIVE,
    description:
      "Remove an IGMP proxy interface entry by name (`/routing igmp-proxy interface remove " +
      "[find interface=...]`). Permanently deletes the interface from the proxy configuration; multicast " +
      "groups that relied on it will stop being forwarded. For disabling without removal use " +
      "`set_igmp_proxy_interface_enabled`. Provide the interface name as it appears in " +
      "`list_igmp_proxy_interfaces`.",
    inputSchema: {
      interface: z.string().describe("IGMP-proxy interface name to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IGMP proxy interface ${a.interface}`);
      const result = await executeMikrotikCommand(
        `/routing igmp-proxy interface remove [find interface=${quoted(a.interface)}]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove IGMP proxy interface: ${result}`;
      return `IGMP proxy interface '${a.interface}' removed successfully.`;
    },
  }),

  defineTool({
    name: "set_igmp_proxy_interface_enabled",
    title: "Enable or Disable IGMP Proxy Interface",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enable or disable a single IGMP proxy interface by name (`/routing igmp-proxy interface set " +
      "[find interface=...] disabled=yes/no`). Pauses multicast forwarding through the interface without " +
      "removing its configuration. For full property changes use `update_igmp_proxy_interface`; to " +
      "permanently remove the entry use `remove_igmp_proxy_interface`. Provide the interface name as it " +
      "appears in `list_igmp_proxy_interfaces`.",
    inputSchema: {
      interface: z.string().describe("IGMP-proxy interface name"),
      enabled: z.boolean(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting IGMP proxy interface ${a.interface} enabled=${a.enabled}`);
      const result = await executeMikrotikCommand(
        `/routing igmp-proxy interface set [find interface=${quoted(a.interface)}] disabled=${yesno(!a.enabled)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update IGMP proxy interface: ${result}`;
      return `IGMP proxy interface '${a.interface}' ${a.enabled ? "enabled" : "disabled"}.`;
    },
  }),

  // ── Forwarding cache (read-only) ──────────────────────────────────────────
  defineTool({
    name: "list_igmp_proxy_mfc",
    title: "List IGMP Proxy Multicast Forwarding Cache",
    annotations: READ,
    description:
      "List the live multicast forwarding cache (MFC) entries (`/routing igmp-proxy mfc print detail`). " +
      "Shows each active IPv4 (source, group) pair and the downstream interfaces each is currently being " +
      "forwarded to — runtime state populated by IGMP join messages, not user-configured entries. Read-only; " +
      "entries cannot be created or removed via this tool. For interface configuration see " +
      "`list_igmp_proxy_interfaces`; for global settings see `get_igmp_proxy_settings`.",
    async handler(_a, ctx) {
      ctx.info("Listing IGMP proxy MFC");
      const result = await executeMikrotikCommand("/routing igmp-proxy mfc print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "IGMP proxy forwarding cache is empty."
        : `IGMP PROXY FORWARDING CACHE:\n\n${result}`;
    },
  }),
];
