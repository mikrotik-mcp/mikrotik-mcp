/** RADIUS client — `/radius`. The router authenticates against external RADIUS servers. */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { redactSecrets } from "../utils";

export const radiusTools: ToolModule = [
  defineTool({
    name: "add_radius_server",
    title: "Add RADIUS Server Entry",
    annotations: WRITE,
    description:
      "Adds a RADIUS server entry (`/radius add`) — configures the router as a RADIUS client" +
      " that authenticates PPP users, hotspot clients, wireless stations, DHCP leases, login" +
      " sessions, IPsec peers, or dot1x supplicants against an external RADIUS server." +
      " For listing existing entries use `list_radius_servers`." +
      " Returns the created entry's detail with the shared secret redacted." +
      ' `service` is a comma-separated list, e.g. `"login,ppp,hotspot,wireless,dhcp,ipsec,dot1x"`;' +
      ' `timeout` is a RouterOS duration string, e.g. `"300ms"`;' +
      " default authentication port is 1812 and accounting port is 1813.",
    inputSchema: {
      address: z.string().describe("RADIUS server IP address or hostname"),
      secret: z.string().describe("Shared secret used with the RADIUS server"),
      service: z
        .string()
        .describe('Comma-separated services, e.g. "login,ppp,hotspot,wireless,dhcp,ipsec,dot1x"'),
      authentication_port: z.number().int().default(1812),
      accounting_port: z.number().int().default(1813),
      timeout: z.string().optional().describe('Request timeout, e.g. "300ms"'),
      src_address: z.string().optional(),
      realm: z.string().optional(),
      called_id: z.string().optional(),
      domain: z.string().optional(),
      protocol: z
        .enum(["udp", "radsec"])
        .optional()
        .describe("Transport protocol used to reach the server (default udp)"),
      certificate: z
        .string()
        .optional()
        .describe("Certificate name to present when protocol is radsec"),
      accounting_backup: z
        .boolean()
        .default(false)
        .describe("Mark this entry as a backup accounting server"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding RADIUS server: address=${a.address}, service=${a.service}`);
      const cmd = new Cmd("/radius add")
        .set("address", a.address)
        .set("secret", a.secret)
        .set("service", a.service)
        .opt("authentication-port", a.authentication_port)
        .opt("accounting-port", a.accounting_port)
        .opt("timeout", a.timeout)
        .opt("src-address", a.src_address)
        .opt("realm", a.realm)
        .opt("called-id", a.called_id)
        .opt("domain", a.domain)
        .opt("protocol", a.protocol)
        .opt("certificate", a.certificate)
        .flag("accounting-backup", a.accounting_backup)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add RADIUS server: ${result}`;

      const details = await executeMikrotikCommand(
        `/radius print detail where address=${quoted(a.address)}`,
        ctx,
      );
      return details.trim()
        ? `RADIUS server added successfully:\n\n${redactSecrets(details)}`
        : "RADIUS server creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_radius_servers",
    title: "List RADIUS Server Entries",
    annotations: READ,
    description:
      "Lists all configured RADIUS server entries (`/radius print`) — the router's RADIUS" +
      " client table. Optionally filter by partial service name or partial address string." +
      " Returns all matching entries with shared secrets redacted; use the `.id` values from" +
      " this output with `get_radius_server`, `update_radius_server`, `remove_radius_server`," +
      " `enable_radius_server`, or `disable_radius_server`.",
    inputSchema: {
      service_filter: z.string().optional().describe("Partial service match"),
      address_filter: z.string().optional().describe("Partial address match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing RADIUS servers");
      const filters: string[] = [];
      if (a.service_filter) filters.push(`service~${quoted(a.service_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);

      const result = await executeMikrotikCommand(`/radius print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No RADIUS servers found matching the criteria."
        : `RADIUS SERVERS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_radius_server",
    title: "Get RADIUS Server Entry Detail",
    annotations: READ,
    description:
      "Retrieves full detail of a single RADIUS server entry (`/radius print detail where .id=`)" +
      " — use when you need the exact current configuration of one entry." +
      " The `radius_id` is the `.id` returned by `list_radius_servers` (e.g. `'*1'`)." +
      " Returns the entry's full field set with the shared secret redacted." +
      " For a summary list of all entries use `list_radius_servers`.",
    inputSchema: {
      radius_id: z.string().describe("RADIUS entry internal .id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting RADIUS server details: radius_id=${a.radius_id}`);
      const result = await executeMikrotikCommand(
        `/radius print detail where .id=${quoted(a.radius_id)}`,
        ctx,
      );
      return isEmpty(result)
        ? `RADIUS server '${a.radius_id}' not found.`
        : `RADIUS SERVER DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "update_radius_server",
    title: "Update RADIUS Server Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates one or more fields on an existing RADIUS server entry (`/radius set <id>`) —" +
      " use to change the address, shared secret, services, ports, timeout, realm, or enabled" +
      " state without recreating the entry. The `radius_id` is the `.id` returned by" +
      " `list_radius_servers`. Returns the updated entry's full detail with the shared secret" +
      " redacted. To create a new entry use `add_radius_server`; to toggle enabled state only" +
      " use `enable_radius_server` or `disable_radius_server`.",
    inputSchema: {
      unset: unsetProperties,
      radius_id: z.string().describe("RADIUS entry internal .id, e.g. '*1'"),
      address: z.string().optional(),
      secret: z.string().optional(),
      service: z.string().optional(),
      authentication_port: z.number().int().optional(),
      accounting_port: z.number().int().optional(),
      timeout: z.string().optional(),
      src_address: z.string().optional(),
      realm: z.string().optional(),
      called_id: z.string().optional(),
      domain: z.string().optional(),
      protocol: z
        .enum(["udp", "radsec"])
        .optional()
        .describe("Transport protocol used to reach the server (default udp)"),
      certificate: z
        .string()
        .optional()
        .describe("Certificate name to present when protocol is radsec"),
      accounting_backup: z
        .boolean()
        .optional()
        .describe("Mark this entry as a backup accounting server"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating RADIUS server: radius_id=${a.radius_id}`);
      const cmd = new Cmd(`/radius set ${a.radius_id}`)
        .opt("address", a.address)
        .opt("secret", a.secret)
        .opt("service", a.service)
        .opt("authentication-port", a.authentication_port)
        .opt("accounting-port", a.accounting_port)
        .opt("timeout", a.timeout)
        .opt("src-address", a.src_address)
        .opt("realm", a.realm)
        .opt("called-id", a.called_id)
        .opt("domain", a.domain)
        .opt("protocol", a.protocol)
        .opt("certificate", a.certificate)
        .bool("accounting-backup", a.accounting_backup)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      // No updates supplied -> the command would just be the `set <id>` stem.
      if (!/[=!]/.test(cmd)) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update RADIUS server: ${result}`;

      const details = await executeMikrotikCommand(
        `/radius print detail where .id=${quoted(a.radius_id)}`,
        ctx,
      );
      return `RADIUS server updated successfully:\n\n${redactSecrets(details)}`;
    },
  }),

  defineTool({
    name: "remove_radius_server",
    title: "Remove RADIUS Server Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a RADIUS server entry (`/radius remove [find .id=...]`) — use when" +
      " an external RADIUS server is decommissioned or should no longer be used for any service." +
      " The `radius_id` is the `.id` returned by `list_radius_servers`." +
      " Performs an existence check before removal and reports if the entry is not found." +
      " To temporarily stop using a server without deleting it use `disable_radius_server`.",
    inputSchema: {
      radius_id: z.string().describe("RADIUS entry internal .id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing RADIUS server: radius_id=${a.radius_id}`);
      const count = await executeMikrotikCommand(
        `/radius print count-only where .id=${quoted(a.radius_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `RADIUS server '${a.radius_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/radius remove [find .id=${quoted(a.radius_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove RADIUS server: ${result}`;
      return `RADIUS server '${a.radius_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_radius_server",
    title: "Enable RADIUS Server Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-enables a previously disabled RADIUS server entry (`/radius enable [find .id=...]`) —" +
      " the router resumes sending authentication/accounting requests to this server for the" +
      " services it covers. The `radius_id` is the `.id` returned by `list_radius_servers`." +
      " To disable without deleting use `disable_radius_server`;" +
      " to remove permanently use `remove_radius_server`.",
    inputSchema: {
      radius_id: z.string().describe("RADIUS entry internal .id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Enabling RADIUS server: radius_id=${a.radius_id}`);
      const result = await executeMikrotikCommand(
        `/radius enable [find .id=${quoted(a.radius_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable RADIUS server: ${result}`;
      return `RADIUS server '${a.radius_id}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_radius_server",
    title: "Disable RADIUS Server Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables a RADIUS server entry without removing it (`/radius disable [find .id=...]`) —" +
      " the router stops sending authentication/accounting requests to this server but preserves" +
      " its configuration for later re-activation. The `radius_id` is the `.id` returned by" +
      " `list_radius_servers`. To re-enable use `enable_radius_server`;" +
      " to delete permanently use `remove_radius_server`.",
    inputSchema: {
      radius_id: z.string().describe("RADIUS entry internal .id, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Disabling RADIUS server: radius_id=${a.radius_id}`);
      const result = await executeMikrotikCommand(
        `/radius disable [find .id=${quoted(a.radius_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable RADIUS server: ${result}`;
      return `RADIUS server '${a.radius_id}' disabled successfully.`;
    },
  }),

  defineTool({
    name: "get_radius_incoming",
    title: "Get RADIUS Incoming (CoA) Settings",
    annotations: READ,
    description:
      "Reads the global RADIUS Change of Authorization (CoA) listener settings" +
      " (`/radius incoming print`) — shows whether the router accepts incoming CoA/Disconnect" +
      " packets from RADIUS servers and on which UDP port it listens." +
      " This is a router-wide singleton; no `radius_id` is needed." +
      " To change these settings use `set_radius_incoming`.",
    async handler(_a, ctx) {
      ctx.info("Getting RADIUS incoming (CoA) settings");
      const result = await executeMikrotikCommand("/radius incoming print", ctx);
      return isEmpty(result)
        ? "No RADIUS incoming settings found."
        : `RADIUS INCOMING (CoA):\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_radius_incoming",
    title: "Set RADIUS Incoming (CoA) Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configures the global RADIUS Change of Authorization (CoA) listener" +
      " (`/radius incoming set`) — controls whether the router accepts unsolicited CoA or" +
      " Disconnect-Request packets pushed by the RADIUS server to forcibly terminate or update" +
      " active sessions. `accept` enables/disables the listener; `port` sets the UDP listen" +
      " port (default 3799). This is a router-wide singleton; no `radius_id` is needed." +
      " To read current CoA settings use `get_radius_incoming`.",
    inputSchema: {
      accept: z.boolean().optional().describe("Whether to accept incoming CoA requests"),
      port: z.number().int().optional().describe("UDP port to listen on for CoA requests"),
    },
    async handler(a, ctx) {
      ctx.info("Setting RADIUS incoming (CoA) settings");
      const cmd = new Cmd("/radius incoming set")
        .bool("accept", a.accept)
        .opt("port", a.port)
        .build();

      // No updates supplied -> the command would just be the `set` stem.
      if (!cmd.includes("=")) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set RADIUS incoming: ${result}`;

      const details = await executeMikrotikCommand("/radius incoming print", ctx);
      return `RADIUS incoming updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "reset_radius_counters",
    title: "Reset RADIUS Counters",
    annotations: DESTRUCTIVE,
    description:
      "Zeroes all RADIUS request/response packet counters on the router (`/radius reset-counters`)" +
      " — use after a measurement window ends or before starting a new traffic test to get a" +
      " clean baseline. This does not modify any server entry configuration;" +
      " to delete an entry use `remove_radius_server`.",
    async handler(_a, ctx) {
      ctx.info("Resetting RADIUS counters");
      const result = await executeMikrotikCommand("/radius reset-counters", ctx);
      if (looksLikeError(result)) return `Failed to reset RADIUS counters: ${result}`;
      return "RADIUS counters reset.";
    },
  }),
];
