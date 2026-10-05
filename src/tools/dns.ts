/** DNS server, static records, cache, and regexp — `/ip dns`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { dnsResolveCommand } from "../core/dns-resolve";
import type { ToolContext } from "../core/context";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

interface AddDnsStaticArgs {
  name: string;
  type?: string;
  address?: string;
  cname?: string;
  ns?: string;
  forward_to?: string;
  match_subdomain?: boolean;
  address_list?: string;
  mx_preference?: number;
  mx_exchange?: string;
  text?: string;
  srv_priority?: number;
  srv_weight?: number;
  srv_port?: number;
  srv_target?: string;
  ttl?: string;
  comment?: string;
  disabled?: boolean;
  regexp?: string;
}

interface UpdateDnsStaticArgs {
  entry_id: string;
  name?: string;
  type?: string;
  address?: string;
  cname?: string;
  ns?: string;
  forward_to?: string;
  match_subdomain?: boolean;
  address_list?: string;
  mx_preference?: number;
  mx_exchange?: string;
  text?: string;
  srv_priority?: number;
  srv_weight?: number;
  srv_port?: number;
  srv_target?: string;
  ttl?: string;
  comment?: string;
  disabled?: boolean;
  regexp?: string;
}

async function addDnsStatic(a: AddDnsStaticArgs, ctx: ToolContext): Promise<string> {
  ctx.info(`Adding static DNS entry: name=${a.name}`);

  const cmd = new Cmd("/ip dns static add").set("name", a.name);
  cmd.opt("type", a.type);
  cmd.opt("address", a.address);
  cmd.opt("cname", a.cname);
  cmd.opt("ns", a.ns);
  cmd.opt("forward-to", a.forward_to);
  cmd.flag("match-subdomain", a.match_subdomain);
  cmd.opt("address-list", a.address_list);
  if (a.mx_preference !== undefined && a.mx_exchange) {
    cmd.set("mx-preference", a.mx_preference).set("mx-exchange", a.mx_exchange);
  }
  cmd.opt("text", a.text);
  if (
    a.srv_priority !== undefined &&
    a.srv_weight !== undefined &&
    a.srv_port !== undefined &&
    a.srv_target
  ) {
    cmd
      .set("srv-priority", a.srv_priority)
      .set("srv-weight", a.srv_weight)
      .set("srv-port", a.srv_port)
      .set("srv-target", a.srv_target);
  }
  cmd.opt("ttl", a.ttl);
  cmd.opt("comment", a.comment);
  cmd.flag("disabled", a.disabled);
  cmd.opt("regexp", a.regexp);

  const result = await executeMikrotikCommand(cmd.build(), ctx);

  if (result.trim()) {
    if (result.includes("*") || /^\d+$/.test(result.trim())) {
      const entryId = result.trim();
      const details = await executeMikrotikCommand(
        `/ip dns static print detail where .id=${entryId}`,
        ctx,
      );
      return details.trim()
        ? `Static DNS entry added successfully:\n\n${details}`
        : `Static DNS entry added with ID: ${result}`;
    }
    return `Failed to add static DNS entry: ${result}`;
  }

  const details = await executeMikrotikCommand(
    `/ip dns static print detail where name="${a.name}"`,
    ctx,
  );
  return details.trim()
    ? `Static DNS entry added successfully:\n\n${details}`
    : "Static DNS entry addition completed but unable to verify.";
}

async function updateDnsStatic(a: UpdateDnsStaticArgs, ctx: ToolContext): Promise<string> {
  ctx.info(`Updating static DNS entry: entry_id=${a.entry_id}`);

  const updates: string[] = [];
  if (a.name) updates.push(`name=${quoteValue(a.name)}`);
  if (a.type !== undefined) updates.push(a.type === "" ? "!type" : `type=${quoteValue(a.type)}`);
  if (a.address !== undefined)
    updates.push(a.address === "" ? "!address" : `address=${quoteValue(a.address)}`);
  if (a.cname !== undefined)
    updates.push(a.cname === "" ? "!cname" : `cname=${quoteValue(a.cname)}`);
  if (a.ns !== undefined) updates.push(a.ns === "" ? "!ns" : `ns=${quoteValue(a.ns)}`);
  if (a.forward_to !== undefined)
    updates.push(a.forward_to === "" ? "!forward-to" : `forward-to=${quoteValue(a.forward_to)}`);
  if (a.match_subdomain !== undefined) updates.push(`match-subdomain=${yesno(a.match_subdomain)}`);
  if (a.address_list !== undefined)
    updates.push(
      a.address_list === "" ? "!address-list" : `address-list=${quoteValue(a.address_list)}`,
    );
  if (a.mx_preference !== undefined) updates.push(`mx-preference=${a.mx_preference}`);
  if (a.mx_exchange !== undefined)
    updates.push(
      a.mx_exchange === "" ? "!mx-exchange" : `mx-exchange=${quoteValue(a.mx_exchange)}`,
    );
  if (a.text !== undefined) updates.push(a.text === "" ? "!text" : `text=${quoteValue(a.text)}`);
  if (a.srv_priority !== undefined) updates.push(`srv-priority=${a.srv_priority}`);
  if (a.srv_weight !== undefined) updates.push(`srv-weight=${a.srv_weight}`);
  if (a.srv_port !== undefined) updates.push(`srv-port=${a.srv_port}`);
  if (a.srv_target !== undefined)
    updates.push(a.srv_target === "" ? "!srv-target" : `srv-target=${quoteValue(a.srv_target)}`);
  if (a.ttl !== undefined) updates.push(a.ttl === "" ? "!ttl" : `ttl=${quoteValue(a.ttl)}`);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${yesno(a.disabled)}`);
  if (a.regexp !== undefined)
    updates.push(a.regexp === "" ? "!regexp" : `regexp=${quoteValue(a.regexp)}`);

  if (updates.length === 0) return "No updates specified.";

  const cmd = `/ip dns static set ${a.entry_id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);

  if (looksLikeError(result)) return `Failed to update static DNS entry: ${result}`;

  const details = await executeMikrotikCommand(
    `/ip dns static print detail where .id=${a.entry_id}`,
    ctx,
  );
  return `Static DNS entry updated successfully:\n\n${details}`;
}

export const dnsTools: ToolModule = [
  defineTool({
    name: "set_dns_servers",
    title: "Configure DNS Resolver Settings",
    annotations: WRITE,
    description:
      "Configures the DNS resolver (`/ip dns set`) — sets upstream server IPs, enables or disables " +
      "forwarding client queries to this router (allow_remote_requests), tunes cache limits " +
      "(cache_size in KiB, cache_max_ttl, max_udp_packet_size, max_concurrent_queries), and " +
      "optionally switches to DNS-over-HTTPS (use_doh=true + doh_server URL + verify_doh_cert). " +
      "Use this when you need to CHANGE which servers the router queries or how its resolver behaves. " +
      "To read current settings without changing them use get_dns_settings. " +
      "Returns the updated `/ip dns print` output after applying changes.",
    inputSchema: {
      servers: z.array(z.string()).describe("DNS server IP addresses"),
      allow_remote_requests: z.boolean().default(false),
      max_udp_packet_size: z.number().int().optional(),
      max_concurrent_queries: z.number().int().optional(),
      max_concurrent_tcp_sessions: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of simultaneous TCP DNS sessions"),
      query_server_timeout: z
        .string()
        .optional()
        .describe('Per-upstream-server query timeout, e.g. "2s"'),
      query_total_timeout: z
        .string()
        .optional()
        .describe('Total query timeout across all servers, e.g. "10s"'),
      cache_size: z.number().int().optional(),
      cache_max_ttl: z.string().optional(),
      use_doh: z.boolean().default(false),
      doh_server: z.string().optional(),
      verify_doh_cert: z.boolean().default(true),
      doh_max_server_connections: z
        .number()
        .int()
        .optional()
        .describe("Maximum concurrent connections to the DoH server"),
      doh_max_concurrent_queries: z
        .number()
        .int()
        .optional()
        .describe("Maximum concurrent queries over DoH"),
      doh_timeout: z.string().optional().describe('DoH request timeout, e.g. "5s"'),
      vrf: z.string().optional().describe("VRF the resolver uses for upstream queries"),
    },
    async handler(a, ctx) {
      ctx.info(`Setting DNS servers: ${a.servers.join(", ")}`);

      const cmd = new Cmd("/ip dns set")
        .set("servers", a.servers.join(","))
        .bool("allow-remote-requests", a.allow_remote_requests)
        .opt("max-udp-packet-size", a.max_udp_packet_size)
        .opt("max-concurrent-queries", a.max_concurrent_queries)
        .opt("max-concurrent-tcp-sessions", a.max_concurrent_tcp_sessions)
        .opt("query-server-timeout", a.query_server_timeout)
        .opt("query-total-timeout", a.query_total_timeout)
        .opt("cache-size", a.cache_size)
        .opt("cache-max-ttl", a.cache_max_ttl)
        .opt("vrf", a.vrf);

      if (a.use_doh && a.doh_server) {
        cmd
          .set("use-doh-server", a.doh_server)
          .bool("verify-doh-cert", a.verify_doh_cert)
          .opt("doh-max-server-connections", a.doh_max_server_connections)
          .opt("doh-max-concurrent-queries", a.doh_max_concurrent_queries)
          .opt("doh-timeout", a.doh_timeout);
      }

      const result = await executeMikrotikCommand(cmd.build(), ctx);

      if (looksLikeError(result)) return `Failed to update DNS settings: ${result}`;

      const details = await executeMikrotikCommand("/ip dns print", ctx);
      return `DNS settings updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "get_dns_settings",
    title: "Get DNS Resolver Settings",
    annotations: READ,
    description:
      "Reads the current DNS resolver configuration (`/ip dns print`) — upstream server IPs, " +
      "allow-remote-requests flag, cache-size, cache-max-ttl, max-udp-packet-size, " +
      "max-concurrent-queries, and DNS-over-HTTPS settings. " +
      "To change these settings use set_dns_servers. " +
      "For cache entry counts and utilization metrics use get_dns_cache_statistics. " +
      "Returns the full `/ip dns print` settings block.",
    async handler(_a, ctx) {
      ctx.info("Getting DNS settings");
      const result = await executeMikrotikCommand("/ip dns print", ctx);
      return isEmpty(result) ? "Unable to retrieve DNS settings." : `DNS SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_dns_static",
    title: "Add DNS Static Record",
    annotations: WRITE,
    description:
      "Creates a static DNS record in `/ip dns static` — the local override table that answers " +
      "DNS queries before upstream resolvers are consulted. Supports A (address), CNAME (cname), " +
      "MX (mx_preference + mx_exchange), TXT (text), and SRV (srv_priority + srv_weight + " +
      "srv_port + srv_target) record types; provide exactly one record type's fields per call. " +
      "A regexp pattern may also be set for wildcard hostname matching — for a simpler regexp-only " +
      "interface use add_dns_regexp instead. " +
      "To inspect existing records use list_dns_static. " +
      "Returns the created entry's full detail including its `.id`.",
    inputSchema: {
      name: z.string(),
      type: z
        .string()
        .optional()
        .describe('Record type, e.g. "A", "AAAA", "CNAME", "NS", "FWD", "MX", "SRV", "TXT"'),
      address: z.string().optional(),
      cname: z.string().optional(),
      ns: z.string().optional().describe("Name server FQDN for an NS-type record"),
      forward_to: z.string().optional().describe("DNS server to forward to for a FWD-type record"),
      match_subdomain: z.boolean().optional().describe("Also match all subdomains of name/regexp"),
      address_list: z
        .string()
        .optional()
        .describe("Add resolved addresses to this firewall address-list"),
      mx_preference: z.number().int().optional(),
      mx_exchange: z.string().optional(),
      text: z.string().optional(),
      srv_priority: z.number().int().optional(),
      srv_weight: z.number().int().optional(),
      srv_port: z.number().int().optional(),
      srv_target: z.string().optional(),
      ttl: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      regexp: z.string().optional(),
    },
    handler: addDnsStatic,
  }),

  defineTool({
    name: "list_dns_static",
    title: "List DNS Static Records",
    annotations: READ,
    description:
      "Lists static DNS records from `/ip dns static print` — the local resolver override table. " +
      "Supports optional filters: name_filter (substring match on hostname), address_filter " +
      '(substring match on IP), type_filter (exact record type, e.g. "A", "CNAME", "MX"), ' +
      "disabled_only (only disabled entries), regexp_only (only regexp-pattern entries). " +
      "To retrieve full field detail for one specific entry by `.id` use get_dns_static. " +
      "Returns a table of all matching static DNS records with their `.id` values.",
    inputSchema: {
      name_filter: z.string().optional(),
      address_filter: z.string().optional(),
      type_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      regexp_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Listing static DNS entries with filters: name=${a.name_filter}`);

      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.address_filter) filters.push(`address~"${a.address_filter}"`);
      if (a.type_filter) filters.push(`type="${a.type_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.regexp_only) filters.push('regexp!=""');

      const result = await executeMikrotikCommand(
        `/ip dns static print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No static DNS entries found matching the criteria."
        : `STATIC DNS ENTRIES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_dns_static",
    title: "Get DNS Static Record Detail",
    annotations: READ,
    description:
      "Retrieves full detail of a single static DNS record (`/ip dns static print detail where .id=…`). " +
      "Use when you need all field values for one known entry rather than a table of all records. " +
      "The `entry_id` is the `.id` returned by list_dns_static. " +
      "For a table of all records (or to search by name/address/type) use list_dns_static. " +
      "Returns the full detail output for the specified entry, or a not-found message.",
    inputSchema: { entry_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting static DNS entry details: entry_id=${a.entry_id}`);
      const result = await executeMikrotikCommand(
        `/ip dns static print detail where .id=${a.entry_id}`,
        ctx,
      );
      return isEmpty(result)
        ? `Static DNS entry with ID '${a.entry_id}' not found.`
        : `STATIC DNS ENTRY DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_dns_static",
    title: "Update DNS Static Record",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies fields on an existing static DNS record (`/ip dns static set`) — can update the " +
      "hostname (name), record-type data (address, cname, mx_preference, mx_exchange, text, srv " +
      "fields), ttl, comment, disabled state, or regexp pattern. Pass an empty string for a field " +
      'to clear it (e.g. address="" removes the address field). ' +
      "The `entry_id` is the `.id` from list_dns_static. " +
      "To activate or deactivate without touching other fields use enable_dns_static or " +
      "disable_dns_static. " +
      "Returns the updated entry's full detail.",
    inputSchema: {
      entry_id: z.string(),
      name: z.string().optional(),
      type: z
        .string()
        .optional()
        .describe('Record type, e.g. "A", "AAAA", "CNAME", "NS", "FWD", "MX", "SRV", "TXT"'),
      address: z.string().optional(),
      cname: z.string().optional(),
      ns: z.string().optional().describe("Name server FQDN for an NS-type record"),
      forward_to: z.string().optional().describe("DNS server to forward to for a FWD-type record"),
      match_subdomain: z.boolean().optional().describe("Also match all subdomains of name/regexp"),
      address_list: z
        .string()
        .optional()
        .describe("Add resolved addresses to this firewall address-list"),
      mx_preference: z.number().int().optional(),
      mx_exchange: z.string().optional(),
      text: z.string().optional(),
      srv_priority: z.number().int().optional(),
      srv_weight: z.number().int().optional(),
      srv_port: z.number().int().optional(),
      srv_target: z.string().optional(),
      ttl: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      regexp: z.string().optional(),
    },
    handler: updateDnsStatic,
  }),

  defineTool({
    name: "remove_dns_static",
    title: "Remove DNS Static Record",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a static DNS record from `/ip dns static` — verifies the entry exists " +
      "first via a count-only check, then runs `/ip dns static remove`. " +
      "The `entry_id` is the `.id` from list_dns_static. " +
      "To temporarily suppress a record without deleting it use disable_dns_static. " +
      "Returns confirmation of deletion, or a not-found message if the ID does not exist.",
    inputSchema: { entry_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing static DNS entry: entry_id=${a.entry_id}`);

      const count = await executeMikrotikCommand(
        `/ip dns static print count-only where .id=${a.entry_id}`,
        ctx,
      );
      if (count.trim() === "0") return `Static DNS entry with ID '${a.entry_id}' not found.`;

      const result = await executeMikrotikCommand(`/ip dns static remove ${a.entry_id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove static DNS entry: ${result}`;

      return `Static DNS entry with ID '${a.entry_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_dns_static",
    title: "Enable DNS Static Record",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled static DNS record (`/ip dns static set disabled=no`) so it " +
      "participates in local DNS resolution again. " +
      "The `entry_id` is the `.id` from list_dns_static. " +
      "To suppress a record temporarily use disable_dns_static. " +
      "To permanently delete use remove_dns_static. " +
      "Returns the updated entry's full detail.",
    inputSchema: { entry_id: z.string() },
    handler: (a, ctx) => updateDnsStatic({ entry_id: a.entry_id, disabled: false }, ctx),
  }),

  defineTool({
    name: "disable_dns_static",
    title: "Disable DNS Static Record",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates a static DNS record (`/ip dns static set disabled=yes`) without deleting it — " +
      "the entry is retained but ignored during resolution. " +
      "The `entry_id` is the `.id` from list_dns_static. " +
      "To re-activate use enable_dns_static. " +
      "To permanently delete use remove_dns_static. " +
      "Returns the updated entry's full detail.",
    inputSchema: { entry_id: z.string() },
    handler: (a, ctx) => updateDnsStatic({ entry_id: a.entry_id, disabled: true }, ctx),
  }),

  defineTool({
    name: "get_dns_cache",
    title: "Get DNS Cache Entries",
    annotations: READ,
    description:
      "Lists all hostnames currently held in the router's DNS resolver cache (`/ip dns cache print`). " +
      "Use to inspect what the router has already resolved and what is available without re-querying " +
      "upstream servers. " +
      "For summary statistics (cache-size, cache-used, cache-max-ttl, total entry count) use " +
      "get_dns_cache_statistics. " +
      "To clear the cache use flush_dns_cache. " +
      "Returns the full cache table, or a message if the cache is empty.",
    async handler(_a, ctx) {
      ctx.info("Getting DNS cache");
      const result = await executeMikrotikCommand("/ip dns cache print", ctx);
      return isEmpty(result) ? "DNS cache is empty." : `DNS CACHE:\n\n${result}`;
    },
  }),

  defineTool({
    name: "flush_dns_cache",
    title: "Flush DNS Cache",
    annotations: DESTRUCTIVE,
    description:
      "Clears all cached DNS entries from the router's resolver (`/ip dns cache flush`) — forces " +
      "the router to re-query upstream servers for all subsequent lookups. " +
      "Use after changing upstream servers or adding static records to evict stale cached responses. " +
      "To inspect the cache before flushing use get_dns_cache. " +
      "Returns confirmation of the flush.",
    async handler(_a, ctx) {
      ctx.info("Flushing DNS cache");
      const result = await executeMikrotikCommand("/ip dns cache flush", ctx);
      return result.trim() ? `Flush result: ${result}` : "DNS cache flushed successfully.";
    },
  }),

  defineTool({
    name: "get_dns_cache_statistics",
    title: "Get DNS Cache Statistics",
    annotations: READ,
    description:
      "Reports DNS cache utilization metrics — extracts cache-size, cache-used, and cache-max-ttl " +
      "from `/ip dns print`, then appends the live count of cached entries from " +
      "`/ip dns cache print count-only`. " +
      "Use to assess cache utilization without listing every entry. Works on RouterOS v6 and v7 " +
      "(there is no `/ip dns cache print stats` command). " +
      "To see all cached entries use get_dns_cache. " +
      "To change cache-size or cache-max-ttl use set_dns_servers. " +
      "Returns cache-related fields and the total entry count.",
    async handler(_a, ctx) {
      ctx.info("Getting DNS cache statistics");
      // RouterOS exposes cache stats on the DNS settings, not as a cache sub-command.
      const settings = await executeMikrotikCommand("/ip dns print", ctx);
      if (looksLikeError(settings)) return `Failed to get DNS cache statistics: ${settings}`;
      if (isEmpty(settings)) return "Unable to retrieve DNS cache statistics.";

      // Keep just the cache-related fields (cache-size, cache-used, cache-max-ttl).
      const cacheLines = settings.split("\n").filter((l) => l.toLowerCase().includes("cache"));
      const stats = cacheLines.length ? cacheLines.join("\n") : settings.trim();

      // Add the live count of cached entries.
      const count = (await executeMikrotikCommand("/ip dns cache print count-only", ctx)).trim();
      const entryLine = /^\d+$/.test(count) ? `cached-entries: ${count}\n` : "";

      return `DNS CACHE STATISTICS:\n\n${entryLine}${stats}`;
    },
  }),

  defineTool({
    name: "add_dns_regexp",
    title: "Add DNS Regexp Static Record",
    annotations: WRITE,
    description:
      "Creates a regexp-pattern static DNS record (`/ip dns static add`) that matches any hostname " +
      "satisfying the given regular expression and resolves it to a fixed IP address (IPv4 or IPv6) — useful for " +
      "wildcard domains, captive portals, or ad-blocking. " +
      "Simplified interface requiring only `regexp` (RouterOS regex) and `address` (IPv4 or IPv6), plus " +
      "optional `ttl` (default 1d), `comment`, and `disabled`. " +
      "For full record-type support (CNAME, MX, SRV, TXT) or to set both a hostname and regexp " +
      "use add_dns_static. " +
      "Returns the created entry's full detail including its `.id`.",
    inputSchema: {
      regexp: z.string(),
      address: z.string(),
      ttl: z.string().default("1d"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    handler: (a, ctx) =>
      addDnsStatic(
        {
          name: "dummy",
          address: a.address,
          regexp: a.regexp,
          ttl: a.ttl,
          comment: a.comment,
          disabled: a.disabled,
        },
        ctx,
      ),
  }),

  defineTool({
    name: "test_dns_query",
    title: "Test DNS Resolution From Router",
    annotations: READ,
    description:
      "Resolves a hostname using the router's own DNS resolver (`:put [:resolve ...]`) — tests what address " +
      "the router itself would obtain for a given name. Optionally directs the query to a specific " +
      'upstream `server` (IP). `type` is "A" (IPv4 only, default), "AAAA" (IPv6 only), ' +
      '"ANY" (IPv4 then IPv6 fallback), or "ANY6" (IPv6 then IPv4 fallback). ' +
      "Returns one resolved IP address, not all DNS records; MX queries are not supported. " +
      "Use to verify DNS reachability, that a static record override is active, or that DoH is " +
      "working — all from the router's perspective, not from a client behind it. " +
      "Queries with an explicit server are not cached by RouterOS.",
    inputSchema: {
      name: z.string().trim().min(1).describe("DNS name to resolve, e.g. example.com"),
      server: z.string().trim().min(1).optional().describe("Optional DNS server IP address"),
      type: z.enum(["A", "AAAA", "ANY", "ANY6"]).default("A"),
    },
    async handler(a, ctx) {
      ctx.info(`Testing DNS query: name=${a.name}, type=${a.type}`);

      const typeMap = { A: "ipv4", AAAA: "ipv6", ANY: "any", ANY6: "any6" } as const;
      const type = typeMap[a.type as keyof typeof typeMap];
      const result = await executeMikrotikCommand(dnsResolveCommand(a.name, a.server, type), ctx);
      if (looksLikeError(result)) return `Failed to resolve ${a.name}: ${result}`;
      return isEmpty(result)
        ? `Failed to resolve ${a.name}`
        : `DNS QUERY RESULT for ${a.name}:\n\n${result}`;
    },
  }),

  defineTool({
    name: "export_dns_config",
    title: "Export DNS Configuration to File",
    annotations: READ,
    description:
      "Exports the full DNS configuration (resolver settings and static records) to a RouterOS " +
      "script file on the router's flash storage (`/ip dns export file=<filename>`). " +
      "The router appends `.rsc` to the filename automatically; defaults to `dns_config.rsc`. " +
      "The exported file can be imported on another RouterOS device to replicate DNS configuration. " +
      "To read current settings as structured output without writing a file use get_dns_settings. " +
      "To list static records use list_dns_static. " +
      "Returns the filename of the exported `.rsc` file on the router.",
    inputSchema: { filename: z.string().optional() },
    async handler(a, ctx) {
      ctx.info("Exporting DNS configuration");

      const filename = a.filename || "dns_config";
      const result = await executeMikrotikCommand(`/ip dns export file=${filename}`, ctx);
      return result.trim()
        ? `Export result: ${result}`
        : `DNS configuration exported to ${filename}.rsc`;
    },
  }),
];
