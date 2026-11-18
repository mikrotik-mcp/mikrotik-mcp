/** IPv4 DHCP client — `/ip dhcp-client` (get an address/gateway/DNS on an interface). */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const ipDhcpClientTools: ToolModule = [
  defineTool({
    name: "list_dhcp_clients",
    title: "List DHCP Clients",
    annotations: READ,
    description:
      "Lists IPv4 DHCP clients (`/ip dhcp-client print`) — each interface configured to obtain its " +
      "address/gateway/DNS from an upstream DHCP server (typically a WAN port). Shows the bound address, " +
      "status, and whether a default route / peer DNS is used. Optional `interface_filter`. For one " +
      "client's detail use get_dhcp_client; to add one use add_dhcp_client.",
    inputSchema: {
      interface_filter: z.string().optional().describe("Substring match on interface"),
    },
    async handler(a, ctx) {
      ctx.info("Listing DHCP clients");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface~${quoted(a.interface_filter)}`);
      const result = await executeMikrotikCommand(
        `/ip dhcp-client print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No DHCP clients found." : `DHCP CLIENTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_dhcp_client",
    title: "Get DHCP Client Detail",
    annotations: READ,
    description:
      "Full detail for the DHCP client on an interface (`/ip dhcp-client print detail where " +
      "interface=...`) — bound address, gateway, lease time, status, and options. Use list_dhcp_clients " +
      "to find interfaces. Returns the detail block or a not-found message.",
    inputSchema: { interface: z.string().describe("Interface name, e.g. 'ether1'") },
    async handler(a, ctx) {
      ctx.info(`Getting DHCP client: ${a.interface}`);
      const result = await executeMikrotikCommand(
        `/ip dhcp-client print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return isEmpty(result)
        ? `No DHCP client on '${a.interface}'.`
        : `DHCP CLIENT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_dhcp_client",
    title: "Add DHCP Client",
    annotations: WRITE,
    description:
      "Adds an IPv4 DHCP client on an interface (`/ip dhcp-client add`) so it obtains an address from " +
      "an upstream DHCP server — the usual way to configure a WAN port. `add_default_route` installs " +
      "the received gateway; `use_peer_dns`/`use_peer_ntp` adopt the server's DNS/NTP. Returns the " +
      "created client's detail.",
    inputSchema: {
      interface: z.string().describe("Interface to run the DHCP client on, e.g. 'ether1'"),
      add_default_route: z.boolean().default(true).describe("Install the received default gateway"),
      default_route_distance: z
        .number()
        .int()
        .optional()
        .describe("Administrative distance of the installed default route"),
      use_peer_dns: z.boolean().default(true),
      use_peer_ntp: z.boolean().default(true),
      dhcp_options: z
        .string()
        .optional()
        .describe("Comma-separated DHCP options to send, e.g. 'hostname,clientid'"),
      client_id: z
        .string()
        .optional()
        .describe("Override the DHCP client identifier sent to the server"),
      host_name: z.string().optional().describe("Host name sent to the DHCP server"),
      script: z.string().optional().describe("Script run on lease bound/released"),
      disabled: z.boolean().default(false),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding DHCP client on ${a.interface}`);
      const cmd = new Cmd("/ip dhcp-client add")
        .set("interface", a.interface)
        .bool("add-default-route", a.add_default_route)
        .opt("default-route-distance", a.default_route_distance)
        .bool("use-peer-dns", a.use_peer_dns)
        .bool("use-peer-ntp", a.use_peer_ntp)
        .opt("dhcp-options", a.dhcp_options)
        .opt("client-id", a.client_id)
        .opt("host-name", a.host_name)
        .opt("script", a.script)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add DHCP client: ${result}`;
      const details = await executeMikrotikCommand(
        `/ip dhcp-client print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return `DHCP client added on '${a.interface}':\n\n${details}`;
    },
  }),

  defineTool({
    name: "set_dhcp_client",
    title: "Update DHCP Client",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates the DHCP client on an interface (`/ip dhcp-client set [find interface=...]`) — toggle " +
      "`add_default_route`, `use_peer_dns`, `use_peer_ntp`, or `disabled`. No-ops if nothing is " +
      "supplied. Returns the updated detail.",
    inputSchema: {
      interface: z.string(),
      add_default_route: z.boolean().optional(),
      default_route_distance: z
        .number()
        .int()
        .optional()
        .describe("Administrative distance of the installed default route"),
      use_peer_dns: z.boolean().optional(),
      use_peer_ntp: z.boolean().optional(),
      dhcp_options: z
        .string()
        .optional()
        .describe("Comma-separated DHCP options to send, e.g. 'hostname,clientid'"),
      client_id: z
        .string()
        .optional()
        .describe("Override the DHCP client identifier sent to the server"),
      host_name: z.string().optional().describe("Host name sent to the DHCP server"),
      script: z.string().optional().describe("Script run on lease bound/released"),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating DHCP client on ${a.interface}`);
      const base = `/ip dhcp-client set [find interface=${quoted(a.interface)}]`;
      const cmd = new Cmd(base)
        .bool("add-default-route", a.add_default_route)
        .opt("default-route-distance", a.default_route_distance)
        .bool("use-peer-dns", a.use_peer_dns)
        .bool("use-peer-ntp", a.use_peer_ntp)
        .opt("dhcp-options", a.dhcp_options)
        .opt("client-id", a.client_id)
        .opt("host-name", a.host_name)
        .opt("script", a.script)
        .bool("disabled", a.disabled)
        .build();
      if (cmd === base) return "No updates specified.";
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update DHCP client: ${result}`;
      const details = await executeMikrotikCommand(
        `/ip dhcp-client print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return `DHCP client updated:\n\n${details}`;
    },
  }),

  defineTool({
    name: "renew_dhcp_client",
    title: "Renew / Release DHCP Lease",
    annotations: WRITE,
    description:
      "Renews or releases the DHCP lease on an interface (`/ip dhcp-client renew|release`). " +
      "`release=true` drops the current lease; otherwise it renews — use to re-pull WAN settings after " +
      "an upstream change. Returns the client status afterward.",
    inputSchema: {
      interface: z.string(),
      release: z.boolean().default(false).describe("true = release the lease; false = renew"),
    },
    async handler(a, ctx) {
      const action = a.release ? "release" : "renew";
      ctx.info(`${action} DHCP lease on ${a.interface}`);
      const result = await executeMikrotikCommand(
        `/ip dhcp-client ${action} [find interface=${quoted(a.interface)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to ${action} DHCP lease: ${result}`;
      const details = await executeMikrotikCommand(
        `/ip dhcp-client print detail where interface=${quoted(a.interface)}`,
        ctx,
      );
      return `DHCP lease ${action}ed on '${a.interface}':\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_dhcp_client",
    title: "Remove DHCP Client",
    annotations: DESTRUCTIVE,
    description:
      "Removes the DHCP client from an interface (`/ip dhcp-client remove [find interface=...]`) — the " +
      "interface stops obtaining an address from DHCP (set a static address separately if needed). " +
      "Confirms removal or reports not-found.",
    inputSchema: { interface: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing DHCP client on ${a.interface}`);
      const count = await executeMikrotikCommand(
        `/ip dhcp-client print count-only where interface=${quoted(a.interface)}`,
        ctx,
      );
      if (count.trim() === "0") return `No DHCP client on '${a.interface}'.`;
      const result = await executeMikrotikCommand(
        `/ip dhcp-client remove [find interface=${quoted(a.interface)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove DHCP client: ${result}`;
      return `DHCP client removed from '${a.interface}'.`;
    },
  }),
];
