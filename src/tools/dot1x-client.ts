/** 802.1X supplicant — `/interface dot1x client`. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

export const dot1xClientTools: ToolModule = [
  defineTool({
    name: "add_dot1x_client",
    title: "Add 802.1X Supplicant Client",
    annotations: WRITE,
    description:
      "Adds an 802.1X supplicant client entry on a specific interface (`/interface dot1x client add`) " +
      "so the router authenticates itself to an upstream 802.1X authenticator (e.g. a managed switch " +
      "or wireless AP). Use this when the MikroTik device is the *supplicant* (client) side of 802.1X " +
      "— not the server/authenticator side. " +
      "`eap_methods` is a comma-separated list, e.g. `'eap-tls'`, `'eap-peap'`, `'eap-mschapv2'`, " +
      "`'eap-ttls'`; `certificate` is required for eap-tls; `identity`/`password` are required for " +
      "password-based EAP methods. " +
      "Returns the created entry's full detail (including its `.id`) which is used by " +
      "update_dot1x_client, get_dot1x_client, and remove_dot1x_client.",
    inputSchema: {
      interface: z.string(),
      eap_methods: z
        .string()
        .describe("Comma-separated EAP methods, e.g. 'eap-tls' or 'eap-peap,eap-mschapv2'"),
      identity: z.string().optional().describe("EAP identity (username)"),
      anonymous_identity: z.string().optional(),
      certificate: z.string().optional().describe("Client certificate name (required for eap-tls)"),
      password: z.string().optional().describe("EAP password (password methods)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      // Note: password is intentionally not logged.
      ctx.info(`Adding dot1x client: interface=${a.interface}`);
      const cmd = new Cmd("/interface dot1x client add")
        .set("interface", a.interface)
        .set("eap-methods", a.eap_methods)
        .opt("identity", a.identity)
        .opt("anonymous-identity", a.anonymous_identity)
        .opt("certificate", a.certificate)
        .opt("password", a.password)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add dot1x client: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface dot1x client print detail where interface="${a.interface}"`,
        ctx,
      );
      return details.trim()
        ? `Dot1x client added successfully:\n\n${details}`
        : "Dot1x client addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_dot1x_clients",
    title: "List 802.1X Supplicant Clients",
    annotations: READ,
    description:
      "Lists all 802.1X supplicant client entries configured on the device (`/interface dot1x client print`). " +
      "Optionally filters by interface name (`interface_filter`), authentication status string " +
      "(`status_filter`, e.g. `'authenticated'`, `'authenticating'`), or disabled state (`disabled_only`). " +
      "Returns a table of all matching supplicant entries with their interface, EAP method, and status; " +
      "for full detail on a single entry use get_dot1x_client.",
    inputSchema: {
      interface_filter: z.string().optional(),
      status_filter: z
        .string()
        .optional()
        .describe("Match status, e.g. 'authenticated', 'authenticating'"),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing dot1x clients");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.status_filter) filters.push(`status~"${a.status_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/interface dot1x client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No dot1x clients found matching the criteria."
        : `DOT1X CLIENTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_dot1x_client",
    title: "Get 802.1X Supplicant Client Detail",
    annotations: READ,
    description:
      "Fetches full detail for a single 802.1X supplicant client entry (`/interface dot1x client print detail`). " +
      "Accepts either an interface name (e.g. `'ether3'`) or a RouterOS `.id` string (e.g. `'*1'`) from " +
      "list_dot1x_clients as `client_id` — tries `.id` lookup first, then falls back to interface name. " +
      "Returns the complete supplicant configuration including EAP method, identity, certificate, and current " +
      "authentication status. For a bulk view of all entries use list_dot1x_clients.",
    inputSchema: {
      client_id: z.string().describe("Interface name (e.g. 'ether3') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting dot1x client: client_id=${a.client_id}`);
      let result = await executeMikrotikCommand(
        `/interface dot1x client print detail where .id="${a.client_id}"`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/interface dot1x client print detail where interface="${a.client_id}"`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `Dot1x client '${a.client_id}' not found.`
        : `DOT1X CLIENT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_dot1x_client",
    title: "Update 802.1X Supplicant Client",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing 802.1X supplicant client entry (`/interface dot1x client set`) identified by " +
      "interface name or RouterOS `.id` from list_dot1x_clients. `client_id` accepts an interface name " +
      "(e.g. `'ether3'`) or a `.id` string starting with `'*'`. Only supplied fields are changed; " +
      'pass `comment=""` to clear the comment. ' +
      "Returns the updated entry's full detail after the change. To add a new supplicant entry use add_dot1x_client; " +
      "to delete one use remove_dot1x_client.",
    inputSchema: {
      unset: unsetProperties,
      client_id: z.string().describe("Interface name or RouterOS '.id'"),
      eap_methods: z.string().optional(),
      identity: z.string().optional(),
      anonymous_identity: z.string().optional(),
      certificate: z.string().optional(),
      password: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating dot1x client: client_id=${a.client_id}`);
      const selector = a.client_id.startsWith("*")
        ? `.id="${a.client_id}"`
        : `interface="${a.client_id}"`;
      const base = `/interface dot1x client set [find ${selector}]`;
      const cmd = new Cmd(base)
        .opt("eap-methods", a.eap_methods)
        .opt("identity", a.identity)
        .opt("anonymous-identity", a.anonymous_identity)
        .opt("certificate", a.certificate)
        .opt("password", a.password);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);
      if (a.disabled !== undefined) cmd.raw(`disabled=${yesno(a.disabled)}`);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update dot1x client: ${result}`;
      const details = await executeMikrotikCommand(
        `/interface dot1x client print detail where ${selector}`,
        ctx,
      );
      return `Dot1x client updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_dot1x_client",
    title: "Remove 802.1X Supplicant Client",
    annotations: DESTRUCTIVE,
    description:
      "Removes an 802.1X supplicant client entry (`/interface dot1x client remove`) identified by interface " +
      "name or RouterOS `.id` from list_dot1x_clients. `client_id` accepts an interface name (e.g. `'ether3'`) " +
      "or a `.id` string starting with `'*'`. Verifies the entry exists with a count-only check before deletion " +
      "and returns an error if not found. Permanently stops 802.1X authentication on that interface; " +
      "to temporarily halt authentication without deleting the entry use update_dot1x_client with `disabled=true`.",
    inputSchema: {
      client_id: z.string().describe("Interface name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing dot1x client: client_id=${a.client_id}`);
      const selector = a.client_id.startsWith("*")
        ? `.id="${a.client_id}"`
        : `interface="${a.client_id}"`;
      const count = await executeMikrotikCommand(
        `/interface dot1x client print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `Dot1x client '${a.client_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface dot1x client remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove dot1x client: ${result}`;
      return `Dot1x client '${a.client_id}' removed successfully.`;
    },
  }),
];
