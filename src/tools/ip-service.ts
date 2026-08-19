/**
 * IP management services — `/ip service`.
 *
 * The built-in management service ports (telnet, ftp, www, ssh, www-ssl, api,
 * api-ssl, winbox). Useful for hardening: restrict ports/source addresses or
 * disable the insecure services (telnet/ftp/www).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, isEmpty, portConflictError, Cmd } from "../core/routeros";

/**
 * Select exactly the ONE configurable `/ip service` row for a name.
 *
 * A bare `[find name="telnet"]` can match more than one row: RouterOS also
 * carries dynamic service entries (flagged `D`), and handing `set`/`disable`
 * two ids makes the device reject the whole command with
 * `failure: this is configured elsewhere (/ip/service/set *0 = telnet)`.
 * That failure is indistinguishable at a glance from a port collision, so it
 * used to surface as a bogus "that port is already used by …" message and
 * blocked hardening outright. `and !dynamic` narrows to the static row; when no
 * dynamic row exists it selects the same single row as before.
 */
const staticService = (name: string): string => `[find name="${name}" and !dynamic]`;

export const ipServiceTools: ToolModule = [
  defineTool({
    name: "list_ip_services",
    title: "List IP Management Services",
    annotations: READ,
    description:
      "Lists all built-in router management services (`/ip service`) — telnet, ftp, www, ssh, www-ssl, api, api-ssl, winbox — with their port, allowed source subnets, certificate, and enabled/disabled state. Use this to audit which management protocols are exposed before hardening. Returns the full `/ip service print` table. For a single service's detail use `get_ip_service`.",
    async handler(_a, ctx) {
      ctx.info("Listing IP services");
      const result = await executeMikrotikCommand("/ip service print", ctx);
      return isEmpty(result) ? "No IP services found." : `IP SERVICES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ip_service",
    title: "Get IP Management Service Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single router management service (`/ip service print detail`) — port, allowed source subnets, TLS certificate, and enabled/disabled state. Accepts a service name such as `ssh`, `www`, `winbox`, `api`, `api-ssl`, `telnet`, `ftp`, or `www-ssl`. To view all services at once use `list_ip_services`; to change the service use `set_ip_service`.",
    inputSchema: {
      name: z.string().describe("Service name, e.g. 'ssh', 'www', 'winbox'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IP service details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip service print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `IP service '${a.name}' not found.`
        : `IP SERVICE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_ip_service",
    title: "Configure IP Management Service",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates one or more attributes of a router management service (`/ip service set`) — port number, allowed source subnets (`address`, comma-separated CIDRs), TLS certificate name, or enabled/disabled state (`disabled: true/false`). Accepts a service name such as `ssh`, `winbox`, `api`, or `api-ssl`. Note: two services cannot share a port — if the chosen port is already used by another service the device rejects it (list_ip_services shows current ports). To toggle only the enabled state use `enable_ip_service` or `disable_ip_service` instead. Returns updated service detail on success.",
    inputSchema: {
      name: z.string().describe("Service name to update, e.g. 'ssh'"),
      port: z.number().int().optional().describe("Listening port"),
      address: z.string().optional().describe("Allowed source subnets, comma-separated"),
      disabled: z.boolean().optional().describe("Disable (true) or enable (false) the service"),
      certificate: z.string().optional().describe("Certificate name (for TLS services)"),
      vrf: z.string().optional().describe("VRF the service is bound to (default 'main')"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IP service: name=${a.name}`);
      const cmd = new Cmd(`/ip service set ${staticService(a.name)}`)
        .opt("port", a.port)
        .opt("address", a.address)
        .bool("disabled", a.disabled)
        .opt("certificate", a.certificate)
        .opt("vrf", a.vrf)
        .build();

      if (!cmd.includes("=", cmd.indexOf("]"))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) {
        const hint = portConflictError(result, a.port);
        return `Failed to update IP service '${a.name}': ${hint ?? result}`;
      }

      const details = await executeMikrotikCommand(
        `/ip service print detail where name="${a.name}"`,
        ctx,
      );
      return `IP service updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "enable_ip_service",
    title: "Enable IP Management Service",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a previously disabled router management service (`/ip service enable`). Accepts a service name such as `ssh`, `winbox`, or `api`. To also change the port, source address filter, or certificate use `set_ip_service` instead; to disable a service use `disable_ip_service`.",
    inputSchema: {
      name: z.string().describe("Service name to enable, e.g. 'ssh'"),
    },
    async handler(a, ctx) {
      ctx.info(`Enabling IP service: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip service enable ${staticService(a.name)}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable IP service: ${result}`;
      return `IP service '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_ip_service",
    title: "Disable IP Management Service",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables a router management service (`/ip service disable`) — use this to harden the router by turning off insecure or unused protocols such as `telnet`, `ftp`, or `www`. Accepts a service name. To also change the port, source address filter, or certificate use `set_ip_service` instead; to re-enable a service use `enable_ip_service`.",
    inputSchema: {
      name: z.string().describe("Service name to disable, e.g. 'telnet'"),
    },
    async handler(a, ctx) {
      ctx.info(`Disabling IP service: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip service disable ${staticService(a.name)}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable IP service: ${result}`;
      return `IP service '${a.name}' disabled successfully.`;
    },
  }),
];
