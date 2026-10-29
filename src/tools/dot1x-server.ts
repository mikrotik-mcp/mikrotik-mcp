/** 802.1X authenticator — `/interface dot1x server`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const AuthTypes = z.enum(["dot1x", "mac-auth", "dot1x,mac-auth"]);
const MacAuthMode = z.enum(["mac-as-username", "mac-as-username-and-password"]);

export const dot1xServerTools: ToolModule = [
  defineTool({
    name: "add_dot1x_server",
    title: "Add 802.1X Server (Authenticator) Entry",
    annotations: WRITE,
    description:
      "Creates an 802.1X authenticator entry on an interface (`/interface dot1x server add`), " +
      "enabling port-based network access control (IEEE 802.1X) enforced against a RADIUS server. " +
      "Use this to require EAP supplicant authentication (`dot1x`), MAC-bypass authentication " +
      "(`mac-auth`), or both on a physical port before granting network access. " +
      "For viewing existing entries use `list_dot1x_servers`; for modifying use `update_dot1x_server`; " +
      "for removal use `remove_dot1x_server`. " +
      "Returns the created entry's full detail.\n\n" +
      "Notes:\n" +
      "    auth_types: 'dot1x' (EAP supplicant), 'mac-auth' (MAC bypass), or\n" +
      "        'dot1x,mac-auth' (both).\n" +
      "    guest_vlan_id / reject_vlan_id / server_fail_vlan_id: VLAN to assign\n" +
      "        when there is no supplicant, on auth failure, or when RADIUS is\n" +
      "        unreachable (number, or 'none').\n" +
      "    interim_update: RADIUS interim-accounting update interval, e.g. '5m' or '0s'.",
    inputSchema: {
      interface: z.string(),
      auth_types: AuthTypes.optional(),
      accounting: z.boolean().optional(),
      interim_update: z.string().optional().describe("e.g. '5m' or '0s'"),
      mac_auth_mode: MacAuthMode.optional(),
      guest_vlan_id: z.string().optional().describe("VLAN id or 'none'"),
      reject_vlan_id: z.string().optional().describe("VLAN id or 'none'"),
      server_fail_vlan_id: z.string().optional().describe("VLAN id or 'none'"),
      reauth_timeout: z.string().optional().describe("Re-auth period or 'none'"),
      reauth_period: z.string().optional().describe("RouterOS 7.25+ re-authentication period"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      if (a.reauth_period !== undefined && a.reauth_timeout !== undefined)
        return "Specify either reauth_period (RouterOS 7.25+) or reauth_timeout (older RouterOS), not both.";
      ctx.info(`Adding dot1x server: interface=${a.interface}`);
      const cmd = new Cmd("/interface dot1x server add")
        .set("interface", a.interface)
        .opt("auth-types", a.auth_types)
        .bool("accounting", a.accounting)
        .opt("interim-update", a.interim_update)
        .opt("mac-auth-mode", a.mac_auth_mode)
        .opt("guest-vlan-id", a.guest_vlan_id)
        .opt("reject-vlan-id", a.reject_vlan_id)
        .opt("server-fail-vlan-id", a.server_fail_vlan_id)
        .opt("reauth-timeout", a.reauth_timeout)
        .opt("reauth-period", a.reauth_period)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add dot1x server: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface dot1x server print detail where interface="${a.interface}"`,
        ctx,
      );
      return details.trim()
        ? `Dot1x server added successfully:\n\n${details}`
        : "Dot1x server addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_dot1x_servers",
    title: "List 802.1X Server (Authenticator) Entries",
    annotations: READ,
    description:
      "Lists all 802.1X authenticator entries (`/interface dot1x server print`). " +
      "Optionally filter by interface name (`interface_filter`) or restrict output to disabled entries only (`disabled_only=true`). " +
      "For full detail on a single entry use `get_dot1x_server`. " +
      "Returns the tabular RouterOS print output including each entry's `.id`, interface, auth-types, and VLAN assignments.",
    inputSchema: {
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing dot1x servers");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/interface dot1x server print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No dot1x servers found matching the criteria."
        : `DOT1X SERVERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_dot1x_server",
    title: "Get 802.1X Server (Authenticator) Entry Detail",
    annotations: READ,
    description:
      "Retrieves full detail of a single 802.1X authenticator entry (`/interface dot1x server print detail`). " +
      "Accepts either the RouterOS `.id` (e.g. `*1`, from `list_dot1x_servers`) or the interface name (e.g. `ether2`) as `server_id`; " +
      "tries `.id` lookup first, then falls back to interface-name lookup. " +
      "For a summary list of all entries use `list_dot1x_servers`. " +
      "Returns the detailed entry or a not-found message if no match exists.",
    inputSchema: {
      server_id: z.string().describe("Interface name (e.g. 'ether2') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting dot1x server: server_id=${a.server_id}`);
      let result = await executeMikrotikCommand(
        `/interface dot1x server print detail where .id="${a.server_id}"`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/interface dot1x server print detail where interface="${a.server_id}"`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `Dot1x server '${a.server_id}' not found.`
        : `DOT1X SERVER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_dot1x_server",
    title: "Update 802.1X Server (Authenticator) Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing 802.1X authenticator entry (`/interface dot1x server set`) identified by interface name or RouterOS `.id`. " +
      "Pass `server_id` as a `.id` string (starts with `*`, e.g. `*1` — obtain from `list_dot1x_servers`) or as the interface name (e.g. `ether2`). " +
      'Omit any optional field to leave it unchanged; pass `comment=""` to clear the comment. ' +
      "For creating a new entry use `add_dot1x_server`; for deletion use `remove_dot1x_server`. " +
      "Returns the updated entry's full detail after the change.",
    inputSchema: {
      server_id: z.string().describe("Interface name or RouterOS '.id'"),
      auth_types: AuthTypes.optional(),
      accounting: z.boolean().optional(),
      interim_update: z.string().optional(),
      mac_auth_mode: MacAuthMode.optional(),
      guest_vlan_id: z.string().optional(),
      reject_vlan_id: z.string().optional(),
      server_fail_vlan_id: z.string().optional(),
      reauth_timeout: z.string().optional(),
      reauth_period: z.string().optional().describe("RouterOS 7.25+ re-authentication period"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      if (a.reauth_period !== undefined && a.reauth_timeout !== undefined)
        return "Specify either reauth_period (RouterOS 7.25+) or reauth_timeout (older RouterOS), not both.";
      ctx.info(`Updating dot1x server: server_id=${a.server_id}`);
      const selector = a.server_id.startsWith("*")
        ? `.id="${a.server_id}"`
        : `interface="${a.server_id}"`;
      const base = `/interface dot1x server set [find ${selector}]`;
      const cmd = new Cmd(base)
        .opt("auth-types", a.auth_types)
        .bool("accounting", a.accounting)
        .opt("interim-update", a.interim_update)
        .opt("mac-auth-mode", a.mac_auth_mode)
        .opt("guest-vlan-id", a.guest_vlan_id)
        .opt("reject-vlan-id", a.reject_vlan_id)
        .opt("server-fail-vlan-id", a.server_fail_vlan_id)
        .opt("reauth-timeout", a.reauth_timeout);
      cmd.opt("reauth-period", a.reauth_period);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);
      if (a.disabled !== undefined) cmd.raw(`disabled=${yesno(a.disabled)}`);

      const built = cmd.build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update dot1x server: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface dot1x server print detail where ${selector}`,
        ctx,
      );
      return `Dot1x server updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_dot1x_server",
    title: "Remove 802.1X Server (Authenticator) Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes an 802.1X authenticator entry (`/interface dot1x server remove`) identified by interface name or RouterOS `.id`. " +
      "Pass `server_id` as a `.id` string (starts with `*`, e.g. `*1` — obtain from `list_dot1x_servers`) or as the interface name (e.g. `ether2`). " +
      "Verifies the entry exists via a `count-only` check before deletion — returns a not-found message if absent. " +
      "For creating an entry use `add_dot1x_server`; for non-destructive disabling use `update_dot1x_server` with `disabled=true`.",
    inputSchema: {
      server_id: z.string().describe("Interface name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing dot1x server: server_id=${a.server_id}`);
      const selector = a.server_id.startsWith("*")
        ? `.id="${a.server_id}"`
        : `interface="${a.server_id}"`;
      const count = await executeMikrotikCommand(
        `/interface dot1x server print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `Dot1x server '${a.server_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface dot1x server remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove dot1x server: ${result}`;
      return `Dot1x server '${a.server_id}' removed successfully.`;
    },
  }),
];
