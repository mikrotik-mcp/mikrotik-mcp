/**
 * Network diagnostic & monitoring tools — `/ping`, `/tool ...`.
 *
 * Covers bounded diagnostics (ping, traceroute, bandwidth-test, DNS resolve)
 * plus netwatch host monitoring. Diagnostic runs are bounded by an explicit
 * `count`/`duration` so they terminate instead of streaming indefinitely.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { dnsResolveCommand } from "../core/dns-resolve";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, flattenLiveOutput, Cmd } from "../core/routeros";

export const networkToolTools: ToolModule = [
  defineTool({
    name: "ping",
    title: "Ping Host via Router",
    annotations: READ,
    description:
      "Sends ICMP echo requests to a target host (`/ping`) from the RouterOS device — use to verify reachability or measure round-trip latency from the router's vantage point. " +
      "Output is a single bounded run of `count` packets (1–100, default 4); it does not stream continuously. " +
      "Optional `interface` pins egress to a specific interface; `src_address` sets the source IP for the probe. " +
      "Returns packet statistics (sent/received/loss/RTT) or a failure message if unreachable. " +
      "For hop-by-hop path discovery use `traceroute`; for throughput measurement use `bandwidth_test`.",
    inputSchema: {
      address: z.string().describe("Target host or IP to ping"),
      count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(4)
        .describe("Number of echo requests (1-100)"),
      interface: z.string().optional().describe("Outgoing interface"),
      src_address: z.string().optional().describe("Source address to ping from"),
      size: z.number().int().optional().describe("Packet size in bytes"),
    },
    async handler(a, ctx) {
      ctx.info(`Pinging ${a.address} (count=${a.count})`);
      const cmd = new Cmd(`/ping ${a.address}`)
        .set("count", a.count)
        .opt("interface", a.interface)
        .opt("src-address", a.src_address)
        .opt("size", a.size)
        .build();
      // Each echo takes ~1s; cap the read so an unreachable host can't hang.
      const result = flattenLiveOutput(
        await executeMikrotikCommand(cmd, ctx, { maxMs: a.count * 1500 + 6000 }),
      );
      if (looksLikeError(result)) return `Failed to ping ${a.address}: ${result}`;
      return isEmpty(result) ? `No response from ${a.address}.` : `PING ${a.address}:\n\n${result}`;
    },
  }),

  defineTool({
    name: "traceroute",
    title: "Traceroute to Host",
    annotations: READ,
    description:
      "Traces the network path to a target host hop by hop (`/tool traceroute`) — use to diagnose routing problems or identify where packets are dropped between the router and a destination. " +
      "Output is a bounded run of `count` probes per hop (default 3; keep small to prevent long runtimes). " +
      "Set `use_dns=true` to resolve hop addresses to hostnames. " +
      "Returns a hop-by-hop list with RTTs, or an error if the command fails. " +
      "For simple reachability checks use `ping`; for throughput measurement use `bandwidth_test`.",
    inputSchema: {
      address: z.string().describe("Target host or IP to trace"),
      count: z
        .number()
        .int()
        .default(3)
        .describe("Number of probes per hop (keep small to bound the run)"),
      use_dns: z.boolean().optional().describe("Resolve hop addresses to names"),
    },
    async handler(a, ctx) {
      ctx.info(`Tracerouting ${a.address} (count=${a.count})`);
      const cmd = new Cmd(`/tool traceroute ${a.address}`)
        .set("count", a.count)
        .flag("use-dns", a.use_dns)
        .build();
      // traceroute keeps probing per hop and rarely self-terminates over exec —
      // cap the read generously, then flatten the live redraw.
      const result = flattenLiveOutput(
        await executeMikrotikCommand(cmd, ctx, { maxMs: 30_000 + a.count * 3000 }),
      );
      if (looksLikeError(result)) return `Failed to traceroute ${a.address}: ${result}`;
      return isEmpty(result)
        ? `No route information for ${a.address}.`
        : `TRACEROUTE ${a.address}:\n\n${result}`;
    },
  }),

  defineTool({
    name: "bandwidth_test",
    title: "Run Bandwidth Test",
    annotations: READ,
    description:
      "Runs a RouterOS throughput test to a remote host (`/tool bandwidth-test`) — use to measure available bandwidth between the router and a target that must be running the RouterOS bandwidth-test server. " +
      "`direction` controls traffic flow: `receive` (download from server), `transmit` (upload to server), or `both`. " +
      "`duration` (default 5 s) bounds the run so it terminates; it does not run indefinitely. " +
      "`protocol` is `tcp` (default) or `udp`. Supply `user`/`password` if the remote server requires authentication. " +
      "Returns throughput results or a failure message if the remote end is unreachable or not running the bandwidth-test server. " +
      "For reachability checks use `ping`; for path diagnostics use `traceroute`.",
    inputSchema: {
      address: z.string().describe("Target running a bandwidth-test server"),
      duration: z.number().int().default(5).describe("Test duration in seconds"),
      direction: z.enum(["receive", "transmit", "both"]).default("receive"),
      user: z.string().optional().describe("Username for the bandwidth-test server"),
      password: z.string().optional().describe("Password for the bandwidth-test server"),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
    },
    async handler(a, ctx) {
      ctx.info(
        `Bandwidth test to ${a.address} (duration=${a.duration}s, direction=${a.direction})`,
      );
      const cmd = new Cmd(`/tool bandwidth-test ${a.address}`)
        .set("duration", `${a.duration}s`)
        .set("direction", a.direction)
        .set("protocol", a.protocol)
        .opt("user", a.user)
        .opt("password", a.password)
        .build();
      // bandwidth-test streams a live counter and may not close the channel even
      // after `duration` — cap the read at duration + slack and flatten the
      // redraw so the final throughput figures are returned, never a hang.
      const result = flattenLiveOutput(
        await executeMikrotikCommand(cmd, ctx, { maxMs: a.duration * 1000 + 12_000 }),
      );
      if (looksLikeError(result)) return `Failed to run bandwidth test to ${a.address}: ${result}`;
      return isEmpty(result)
        ? `No bandwidth test results for ${a.address}.`
        : `BANDWIDTH TEST:\n\n${result}`;
    },
  }),

  defineTool({
    name: "resolve_dns",
    title: "Resolve DNS Name on Device",
    annotations: READ,
    description:
      "Resolves a DNS hostname to an IP address (`[:resolve]`) using the RouterOS device's configured system resolver — use to verify that DNS resolution works correctly from the router's own perspective. " +
      "The optional `server` IP directs the query to that DNS server instead of the system resolver; explicit-server queries are not cached by RouterOS. " +
      "Returns the resolved IP address string, or an error if resolution fails. " +
      "For managing static DNS entries on the device use `add_dns_static`.",
    inputSchema: {
      name: z.string().trim().min(1).describe("DNS name to resolve, e.g. 'example.com'"),
      server: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Specific DNS server IP to query; defaults to the system resolver"),
    },
    async handler(a, ctx) {
      ctx.info(`Resolving DNS name ${a.name}`);
      const result = await executeMikrotikCommand(dnsResolveCommand(a.name, a.server), ctx);
      if (looksLikeError(result)) return `Failed to resolve ${a.name}: ${result}`;
      return isEmpty(result)
        ? `Failed to resolve ${a.name}: the router returned no address.`
        : `DNS RESOLVE ${a.name}:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_netwatch",
    title: "Add Netwatch Host Monitor",
    annotations: WRITE,
    description:
      "Creates a host-monitoring entry (`/tool netwatch add`) that probes a host at a set interval and runs RouterOS scripts on up/down state transitions — use to trigger automated responses (e.g. failover scripts) when a host becomes reachable or unreachable. " +
      "`interval` and `timeout` accept RouterOS time strings (e.g. `'00:00:10'`). " +
      "`up_script` and `down_script` are inline RouterOS script strings executed on state change. " +
      "Returns the detail of the created entry, confirmed by a follow-up `/tool netwatch print detail` lookup. " +
      "To view existing entries use `list_netwatch`; to inspect one entry's detail use `get_netwatch`; to delete use `remove_netwatch`.",
    inputSchema: {
      host: z.string().describe("Host to monitor"),
      type: z
        .enum(["simple", "icmp", "tcp-conn", "http-get"])
        .optional()
        .describe("Probe type: simple, icmp, tcp-conn, or http-get"),
      port: z.number().int().optional().describe("Target port (tcp-conn/http-get types)"),
      src_address: z.string().optional().describe("Source address for the probe"),
      interval: z.string().optional().describe("Probe interval, e.g. '00:00:10'"),
      timeout: z.string().optional().describe("Probe timeout, e.g. '00:00:01'"),
      up_script: z.string().optional().describe("Script to run when the host comes up"),
      down_script: z.string().optional().describe("Script to run when the host goes down"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding netwatch for host ${a.host}`);
      const cmd = new Cmd("/tool netwatch add")
        .set("host", a.host)
        .opt("type", a.type)
        .opt("port", a.port)
        .opt("src-address", a.src_address)
        .opt("interval", a.interval)
        .opt("timeout", a.timeout)
        .opt("up-script", a.up_script)
        .opt("down-script", a.down_script)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add netwatch: ${result}`;

      const details = await executeMikrotikCommand(
        `/tool netwatch print detail where host="${a.host}"`,
        ctx,
      );
      return details.trim()
        ? `Netwatch entry added successfully:\n\n${details}`
        : "Netwatch entry added but unable to verify.";
    },
  }),

  defineTool({
    name: "list_netwatch",
    title: "List Netwatch Host Monitor Entries",
    annotations: READ,
    description:
      "Returns all netwatch host-monitoring entries (`/tool netwatch print`) — use to review which hosts are being probed and their current up/down status. " +
      "Optionally filter by partial hostname with `host_filter`. " +
      "Returns the full netwatch table, or a message if no entries match. " +
      "For a single entry's full configuration detail use `get_netwatch`; to create an entry use `add_netwatch`; to delete one use `remove_netwatch`.",
    inputSchema: {
      host_filter: z.string().optional().describe("Partial host match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing netwatch entries");
      const filters: string[] = [];
      if (a.host_filter) filters.push(`host~"${a.host_filter}"`);
      const result = await executeMikrotikCommand(
        `/tool netwatch print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No netwatch entries found matching the criteria."
        : `NETWATCH:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_netwatch",
    title: "Get Netwatch Entry Detail",
    annotations: READ,
    description:
      "Returns full detail for a single netwatch host-monitoring entry (`/tool netwatch print detail where host=`) — use to inspect the current up/down status, probe interval, timeout, and up/down scripts for one monitored host. " +
      "Looks up by exact `host` value (same string used in `add_netwatch`). " +
      "Returns the detailed record, or a not-found message if no entry matches. " +
      "For a summary list of all entries use `list_netwatch`; to delete this entry use `remove_netwatch`.",
    inputSchema: { host: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting netwatch details for host ${a.host}`);
      const result = await executeMikrotikCommand(
        `/tool netwatch print detail where host="${a.host}"`,
        ctx,
      );
      return isEmpty(result)
        ? `Netwatch entry for '${a.host}' not found.`
        : `NETWATCH DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_netwatch",
    title: "Remove Netwatch Host Monitor Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a netwatch host-monitoring entry (`/tool netwatch remove [find host=]`) — use to stop monitoring a host and delete its associated up/down scripts. " +
      "Performs a `count-only` existence check first and returns an error if no entry matches the given `host`. " +
      "Takes the exact `host` value (same string used in `add_netwatch`). " +
      "To review entries before deleting use `list_netwatch` or `get_netwatch`.",
    inputSchema: { host: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing netwatch for host ${a.host}`);
      const count = await executeMikrotikCommand(
        `/tool netwatch print count-only where host="${a.host}"`,
        ctx,
      );
      if (count.trim() === "0") return `Netwatch entry for '${a.host}' not found.`;

      const result = await executeMikrotikCommand(
        `/tool netwatch remove [find host="${a.host}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove netwatch: ${result}`;
      return `Netwatch entry for '${a.host}' removed successfully.`;
    },
  }),
];
