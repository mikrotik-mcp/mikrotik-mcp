/**
 * Intelligent Root-Cause Analyzer — `diagnose`, `trace_path`,
 * `correlate_events`, `suggest_fix`.
 *
 * When something breaks, these tools autonomously investigate across multiple
 * diagnostic dimensions (interfaces, routing, firewall, NAT, ARP/DHCP, DNS,
 * system resources, logs, VPN) and correlate the evidence to deliver a
 * plain-language root-cause diagnosis with exact fix commands.
 */
import { z } from "zod";
import type { ToolContext } from "../core/context";
import { ALL_DIMENSIONS, analyzeRootCause, renderDiagnosisReport } from "../core/root-cause";
import type {
  ArpEntry,
  DhcpLease,
  DiagnosticData,
  DiagnosticDimension,
  FirewallRuleSnapshot,
  InterfaceSnapshot,
  LogEntry,
  RouteSnapshot,
  RoutingNeighbor,
} from "../core/root-cause";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { isYes } from "../utils/yes";
import { resolveDeviceName } from "../core/runtime";
import { isEmpty, quoteValue } from "../core/routeros";
import { parseKeyValues, parsePercent, parseRecords, parseSize } from "../core/routeros-parse";
import { isIpAddress, isIpLike } from "../utils/ip";
import { num } from "../utils/num";
import { safe } from "../utils/safe-exec";
import { parsePingSummary } from "./dr-drill";

/** Collect interface snapshots. */
async function collectInterfaces(ctx: ToolContext): Promise<InterfaceSnapshot[]> {
  const raw = await safe("/interface print detail", ctx);
  if (!raw) return [];
  return parseRecords(raw).rows.map((r) => ({
    name: r.name ?? "",
    type: r.type ?? "",
    running: (r.flags ?? "").includes("R") || r.running === "true",
    disabled: (r.flags ?? "").includes("X") || r.disabled === "true",
    txBytes: num(r["tx-byte"]),
    rxBytes: num(r["rx-byte"]),
    txErrors: num(r["tx-error"]),
    rxErrors: num(r["rx-error"]),
    linkDowns: num(r["link-downs"]),
    lastLinkDownTime: r["last-link-down-time"],
    mtu: num(r.mtu) || 1500,
  }));
}

/** Collect route information. */
async function collectRoutes(ctx: ToolContext): Promise<{
  routes: RouteSnapshot[];
  count: number;
  hasDefault: boolean;
}> {
  const raw = await safe("/ip route print detail", ctx);
  if (!raw) return { routes: [], count: 0, hasDefault: false };
  const rows = parseRecords(raw).rows;
  const routes: RouteSnapshot[] = rows.map((r) => ({
    dst: r["dst-address"] ?? "",
    gateway: r.gateway ?? "",
    distance: num(r.distance),
    active: (r.flags ?? "").includes("A") || r.active === "true",
    dynamic: (r.flags ?? "").includes("D") || r.dynamic === "true",
  }));
  const hasDefault = routes.some((r) => r.dst === "0.0.0.0/0" && r.active);
  return { routes, count: routes.length, hasDefault };
}

/** Collect OSPF neighbors. */
async function collectOspfNeighbors(ctx: ToolContext): Promise<RoutingNeighbor[]> {
  const raw = await safe("/routing ospf neighbor print detail", ctx);
  if (!raw || isEmpty(raw)) return [];
  return parseRecords(raw)
    .rows.map((r) => ({
      id: r["neighbor-id"] ?? r.router ?? "",
      address: r.address ?? "",
      state: r.state ?? "",
      interface: r.interface ?? "",
      uptime: r.uptime,
    }))
    .filter((n) => n.id || n.address); // skip entries with no identifying fields
}

/** Collect BGP peers. */
async function collectBgpPeers(ctx: ToolContext): Promise<RoutingNeighbor[]> {
  const raw = await safe("/routing bgp session print detail", ctx);
  if (!raw || isEmpty(raw)) {
    // Try older v6 syntax
    const raw2 = await safe("/routing bgp peer print detail", ctx);
    if (!raw2 || isEmpty(raw2)) return [];
    return parseRecords(raw2)
      .rows.map((r) => ({
        id: r.name ?? "",
        address: r["remote-address"] ?? "",
        state: r.state ?? "",
        interface: r.interface ?? "",
        uptime: r.uptime,
      }))
      .filter((p) => p.id || p.address);
  }
  return parseRecords(raw)
    .rows.map((r) => ({
      id: r.name ?? r["remote.address"] ?? "",
      address: r["remote.address"] ?? r["remote-address"] ?? "",
      state: r.state ?? r.established ?? "",
      interface: r.interface ?? "",
      uptime: r.uptime,
    }))
    .filter((p) => p.id || p.address);
}

/** Collect firewall rules matching a target address. */
async function collectFirewallRules(
  target: string,
  ctx: ToolContext,
): Promise<{ matching: FirewallRuleSnapshot[]; totalCount: number }> {
  const raw = await safe("/ip firewall filter print detail", ctx);
  if (!raw) return { matching: [], totalCount: 0 };
  const rows = parseRecords(raw).rows;
  const all = rows.map(parseFirewallRow);

  // Filter rules that could affect the target
  const isIp = isIpAddress(target);
  const matching = isIp
    ? all.filter(
        (r) => !r.srcAddress || r.srcAddress === target || !r.dstAddress || r.dstAddress === target,
      )
    : all;

  return { matching, totalCount: all.length };
}

function parseFirewallRow(r: Record<string, string>, i: number): FirewallRuleSnapshot {
  return {
    index: i,
    chain: r.chain ?? "",
    action: r.action ?? "",
    srcAddress: r["src-address"],
    dstAddress: r["dst-address"],
    protocol: r.protocol,
    dstPort: r["dst-port"],
    bytes: num(r.bytes),
    packets: num(r.packets),
    disabled: (r.flags ?? "").includes("X") || r.disabled === "true",
    comment: r.comment,
  };
}

/** Collect NAT rules. */
async function collectNatRules(ctx: ToolContext): Promise<FirewallRuleSnapshot[]> {
  const raw = await safe("/ip firewall nat print detail", ctx);
  if (!raw) return [];
  return parseRecords(raw).rows.map(parseFirewallRow);
}

/** Collect ARP entries. */
async function collectArp(ctx: ToolContext): Promise<ArpEntry[]> {
  const raw = await safe("/ip arp print detail", ctx);
  if (!raw) return [];
  return parseRecords(raw).rows.map((r) => ({
    address: r.address ?? "",
    macAddress: r["mac-address"] ?? "",
    interface: r.interface ?? "",
    complete: (r.flags ?? "").includes("C") || r.complete === "true",
    dynamic: (r.flags ?? "").includes("D") || r.dynamic === "true",
  }));
}

/** Collect DHCP leases. */
async function collectDhcpLeases(ctx: ToolContext): Promise<DhcpLease[]> {
  const raw = await safe("/ip dhcp-server lease print detail", ctx);
  if (!raw) return [];
  return parseRecords(raw).rows.map((r) => ({
    address: r.address ?? "",
    macAddress: r["mac-address"] ?? "",
    hostName: r["host-name"] ?? "",
    status: r.status ?? "",
    lastSeen: r["last-seen"],
    server: r.server ?? "",
  }));
}

/** Collect recent logs. */
async function collectLogs(target: string, ctx: ToolContext): Promise<LogEntry[]> {
  // Get logs from the last 10 minutes with relevant topics
  const raw = await safe(
    '/log print where topics~"error" or topics~"warning" or topics~"critical" or topics~"firewall" or topics~"system"',
    ctx,
  );
  if (!raw) return [];
  const rows = parseRecords(raw).rows;
  // Take last 50 entries
  return rows.slice(-50).map((r) => ({
    time: r.time ?? "",
    topics: r.topics ?? "",
    message: r.message ?? "",
  }));
}

/** Collect tunnel interfaces. */
async function collectTunnels(ctx: ToolContext): Promise<InterfaceSnapshot[]> {
  const raw = await safe(
    '/interface print detail where type~"gre|ipip|eoip|vxlan|wireguard|ovpn|sstp|pptp|l2tp"',
    ctx,
  );
  if (!raw) return [];
  return parseRecords(raw).rows.map((r) => ({
    name: r.name ?? "",
    type: r.type ?? "",
    running: (r.flags ?? "").includes("R") || r.running === "true",
    disabled: (r.flags ?? "").includes("X") || r.disabled === "true",
    txBytes: num(r["tx-byte"]),
    rxBytes: num(r["rx-byte"]),
    txErrors: num(r["tx-error"]),
    rxErrors: num(r["rx-error"]),
    linkDowns: num(r["link-downs"]),
    mtu: num(r.mtu) || 1500,
  }));
}

/** Full diagnostic data collection across all dimensions. */
async function collectDiagnosticData(
  target: string,
  ctx: ToolContext,
  dimensions?: DiagnosticDimension[],
): Promise<DiagnosticData> {
  const dims = new Set(dimensions ?? ALL_DIMENSIONS);

  // Parallel fetch — each wrapped to not block others
  const [
    pingResult,
    interfaces,
    routeInfo,
    ospfNeighbors,
    bgpPeers,
    fwInfo,
    natRules,
    connCountRaw,
    arpEntries,
    dhcpLeases,
    dnsResult,
    dnsSettingsParts,
    resourceRaw,
    logs,
    tunnels,
  ] = await Promise.all([
    dims.has("connectivity")
      ? safe(`/ping ${quoteValue(target)} count=5`, ctx)
      : Promise.resolve(""),
    dims.has("interfaces") ? collectInterfaces(ctx) : Promise.resolve([]),
    dims.has("routing")
      ? collectRoutes(ctx)
      : Promise.resolve({ routes: [] as RouteSnapshot[], count: 0, hasDefault: true }),
    dims.has("routing") ? collectOspfNeighbors(ctx) : Promise.resolve([]),
    dims.has("routing") ? collectBgpPeers(ctx) : Promise.resolve([]),
    dims.has("firewall")
      ? collectFirewallRules(target, ctx)
      : Promise.resolve({ matching: [] as FirewallRuleSnapshot[], totalCount: 0 }),
    dims.has("nat") ? collectNatRules(ctx) : Promise.resolve([]),
    dims.has("nat") ? safe("/ip firewall connection print count-only", ctx) : Promise.resolve("0"),
    dims.has("arp_dhcp") ? collectArp(ctx) : Promise.resolve([]),
    dims.has("arp_dhcp") ? collectDhcpLeases(ctx) : Promise.resolve([]),
    dims.has("dns") && !isIpLike(target)
      ? safe(`[:resolve ${quoteValue(target)}]`, ctx)
      : Promise.resolve(undefined),
    // Fetch DNS servers with `:put` for reliable single-line output. RouterOS
    // 7.23+ wraps long values across continuation lines in `/ip dns print`, which
    // the line-oriented parseKeyValues misses — `:put` always returns one line.
    dims.has("dns")
      ? Promise.all([
          safe(":put [/ip dns get servers]", ctx),
          safe(":put [/ip dns get dynamic-servers]", ctx),
          safe(":put [/ip dns get allow-remote-requests]", ctx),
        ])
      : Promise.resolve(["", "", ""]),
    dims.has("resources") ? safe("/system resource print", ctx) : Promise.resolve(""),
    dims.has("logs") ? collectLogs(target, ctx) : Promise.resolve([]),
    dims.has("vpn") ? collectTunnels(ctx) : Promise.resolve([]),
  ]);

  // Parse ping
  const ping = pingResult ? (parsePingSummary(pingResult) ?? undefined) : undefined;

  // Parse DNS settings — now comes as three individual `:put` results.
  const [dnsServersRaw, dnsDynamicRaw, dnsAllowRemoteRaw] = dnsSettingsParts as [
    string,
    string,
    string,
  ];

  // Parse resources — use the battle-tested parsers from routeros-parse that
  // handle "12%", "256.0MiB", "1.2 GiB" etc. correctly across RouterOS versions.
  const resKv = parseKeyValues(resourceRaw);
  const totalMem = parseSize(resKv["total-memory"]) ?? 0;
  const freeMem = parseSize(resKv["free-memory"]) ?? 0;
  const memUsedPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

  return {
    target,
    ping,
    traceroute: undefined, // filled by trace_path tool
    interfaces,
    routeCount: routeInfo.count,
    defaultRouteExists: routeInfo.hasDefault,
    activeRoutes: routeInfo.routes.filter((r) => r.active),
    ospfNeighbors,
    bgpPeers,
    matchingFilterRules: fwInfo.matching,
    filterRuleCount: fwInfo.totalCount,
    natRules,
    connectionCount: Number.parseInt(connCountRaw.trim(), 10) || 0,
    arpEntries,
    dhcpLeases,
    dnsResolveResult: dnsResult ?? undefined,
    dnsServers: [dnsServersRaw.trim(), dnsDynamicRaw.trim()].filter(Boolean).join(",") || "",
    dnsAllowRemote: isYes(dnsAllowRemoteRaw),
    cpuLoad: parsePercent(resKv["cpu-load"]) ?? 0,
    memoryUsedPct: memUsedPct,
    uptime: resKv.uptime ?? "",
    rosVersion: resKv.version ?? "",
    relevantLogs: logs,
    tunnelInterfaces: tunnels,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const dimensionEnum = z
  .enum(ALL_DIMENSIONS as unknown as [string, ...string[]])
  .describe("Diagnostic dimension to investigate.");

export const rootCauseTools: ToolModule = [
  // ── diagnose ──────────────────────────────────────────────────────────
  defineTool({
    name: "diagnose",
    title: "Intelligent Root-Cause Diagnosis",
    annotations: READ,
    description:
      "Autonomously investigate a network problem across all diagnostic dimensions: " +
      "connectivity (ping), interface state & error counters, routing table & BGP/OSPF " +
      "neighbors, firewall rules & hit counters, NAT & connection tracking, ARP/DHCP " +
      "state, DNS resolution, CPU/memory pressure, system logs, and VPN tunnel state. " +
      "Correlates the evidence to deliver ranked root-cause hypotheses with confidence " +
      "levels, plain-language explanations, and exact RouterOS fix commands. " +
      "Pass an IP address, hostname, or symptom description as the target. " +
      "For hop-by-hop path analysis use `trace_path`; for log-specific investigation " +
      "use `correlate_events`; for fix commands only use `suggest_fix`.",
    inputSchema: {
      target: z
        .string()
        .describe(
          "The target to investigate — an IP address (e.g. '8.8.8.8'), hostname " +
            "(e.g. 'google.com'), or network/subnet (e.g. '10.0.0.0/24').",
        ),
      dimensions: z
        .array(dimensionEnum)
        .optional()
        .describe(
          `Limit investigation to specific dimensions. ` +
            `Omit to check all: ${ALL_DIMENSIONS.join(", ")}`,
        ),
      symptom: z
        .string()
        .optional()
        .describe(
          "Free-text symptom description (e.g. 'client cannot reach internet', " +
            "'VPN tunnel keeps dropping', 'slow throughput').",
        ),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Root-cause diagnosis on '${device}' — target: ${a.target}`);

      const data = await collectDiagnosticData(
        a.target,
        ctx,
        a.dimensions as DiagnosticDimension[] | undefined,
      );

      const report = analyzeRootCause(data);

      const lines: string[] = [];
      lines.push(renderDiagnosisReport(report, device));

      if (a.symptom) {
        lines.push("");
        lines.push(`Reported symptom: "${a.symptom}"`);
      }

      return lines.join("\n");
    },
  }),

  // ── trace_path ────────────────────────────────────────────────────────
  defineTool({
    name: "trace_path",
    title: "Trace Network Path",
    annotations: READ,
    description:
      "Trace the full network path from this device to a destination with hop-by-hop " +
      "analysis. Runs a traceroute, then for each hop that is a locally-connected device, " +
      "checks interface state and routing. Also runs a parallel ping to measure " +
      "end-to-end reachability and latency. " +
      "Use for path-specific troubleshooting — where packets are being dropped or " +
      "rerouted. For full multi-dimensional root-cause analysis use `diagnose`.",
    inputSchema: {
      target: z.string().describe("Destination IP or hostname to trace to."),
      count: z.number().int().min(1).max(10).default(3).describe("Probes per hop (default: 3)."),
      use_dns: z.boolean().default(true).describe("Resolve hop addresses to hostnames."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Tracing path from '${device}' to ${a.target}`);

      // Run traceroute and ping in parallel
      const [traceResult, pingResult, routeResult] = await Promise.all([
        safe(
          `/tool traceroute ${quoteValue(a.target)} count=${a.count} use-dns=${a.use_dns ? "yes" : "no"}`,
          ctx,
        ),
        safe(`/ping ${quoteValue(a.target)} count=5`, ctx),
        safe(`/ip route print where dst-address=0.0.0.0/0`, ctx),
      ]);

      const ping = parsePingSummary(pingResult);

      const lines: string[] = [];
      lines.push(`NETWORK PATH TRACE — ${device} → ${a.target}`);
      lines.push("");

      // Ping summary
      if (ping) {
        const status =
          ping.lossPct === 0 ? "REACHABLE" : ping.lossPct === 100 ? "UNREACHABLE" : "PARTIAL LOSS";
        lines.push(
          `End-to-end: ${status} (${ping.lossPct}% loss, ${ping.received}/${ping.sent} received)`,
        );
      } else {
        lines.push("End-to-end: PING FAILED");
      }
      lines.push("");

      // Default route
      if (routeResult && !isEmpty(routeResult)) {
        lines.push("── DEFAULT ROUTE ──────────────────────────────────────────────");
        lines.push(routeResult.trim());
        lines.push("");
      }

      // Traceroute
      if (traceResult && !isEmpty(traceResult)) {
        lines.push("── TRACEROUTE ─────────────────────────────────────────────────");
        lines.push(traceResult.trim());
      } else {
        lines.push("Traceroute returned no data — target may be unreachable or ICMP filtered.");
      }

      // Analysis
      lines.push("");
      lines.push("── ANALYSIS ───────────────────────────────────────────────────");
      if (ping?.lossPct === 100) {
        lines.push(
          "  Target is completely unreachable. Check the traceroute above to identify " +
            "the last responding hop — the issue lies between that hop and the destination.",
        );
        lines.push("  Use `diagnose` for full root-cause analysis.");
      } else if (ping && ping.lossPct > 0) {
        lines.push(
          `  Partial packet loss (${ping.lossPct}%) detected. This may indicate ` +
            "congestion, flapping links, or rate-limiting along the path.",
        );
      } else if (ping?.lossPct === 0) {
        lines.push("  Path is healthy — all packets delivered with 0% loss.");
      }

      return lines.join("\n");
    },
  }),

  // ── correlate_events ──────────────────────────────────────────────────
  defineTool({
    name: "correlate_events",
    title: "Correlate System Events",
    annotations: READ,
    description:
      "Search and correlate system log events across topics (firewall, DHCP, routing, " +
      "system, interface) to find patterns around a given time window or keyword. " +
      "Groups related events chronologically and highlights sequences that indicate " +
      "cascading failures (e.g. interface down → OSPF neighbor lost → route withdrawn). " +
      "For full root-cause analysis use `diagnose`; for path tracing use `trace_path`.",
    inputSchema: {
      keyword: z
        .string()
        .optional()
        .describe(
          "Filter logs by keyword (IP address, interface name, error message). " +
            "Omit to show all error/warning/critical events.",
        ),
      topics: z
        .string()
        .optional()
        .describe(
          "Comma-separated log topics to search (e.g. 'firewall,dhcp,system'). " +
            "Default: error, warning, critical, firewall, system, interface.",
        ),
      time_window: z
        .string()
        .default("30m")
        .describe("How far back to search: '10m', '1h', '6h', '1d' (default: 30m)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum log entries to return (default: 100)."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Correlating events on '${device}'`);

      // Build log query
      const filters: string[] = [];
      if (a.topics) {
        filters.push(`topics~"${a.topics.replace(/,/g, "|")}"`);
      } else {
        filters.push('topics~"error|warning|critical|firewall|system|interface|dhcp|ospf|bgp"');
      }
      if (a.keyword) {
        filters.push(`message~"${a.keyword}"`);
      }

      const where = filters.length > 0 ? ` where ${filters.join(" ")}` : "";
      const raw = await safe(`/log print detail${where}`, ctx);

      if (!raw || isEmpty(raw)) {
        return `No matching log events found on '${device}' in the last ${a.time_window}.`;
      }

      const rows = parseRecords(raw).rows;
      const entries = rows.slice(-a.limit);

      const lines: string[] = [];
      lines.push(`EVENT CORRELATION — ${device}`);
      lines.push(
        `  Time window: ${a.time_window}  |  Filter: ${a.keyword ?? "(all)"}  |  Entries: ${entries.length}`,
      );
      lines.push("");

      // Group by topic clusters
      const topicCounts = new Map<string, number>();
      for (const e of entries) {
        const topic = e.topics ?? "unknown";
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }

      lines.push("── TOPIC DISTRIBUTION ─────────────────────────────────────────");
      const sorted = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [topic, count] of sorted) {
        lines.push(`  ${String(count).padStart(4)}  ${topic}`);
      }
      lines.push("");

      // Detect event bursts (multiple events within short windows)
      lines.push("── EVENT TIMELINE ─────────────────────────────────────────────");
      let prevTopic = "";
      let burstCount = 0;
      for (const e of entries) {
        const time = e.time ?? "";
        const topic = e.topics ?? "";
        const msg = e.message ?? "";
        const isRepeat = topic === prevTopic;
        if (isRepeat) burstCount++;
        else burstCount = 0;

        // Show event (compress bursts)
        if (burstCount < 3 || burstCount === entries.length - 1) {
          lines.push(`  [${time}] ${topic}: ${msg}`);
        } else if (burstCount === 3) {
          lines.push(`  ... (repeated ${topic} events)`);
        }
        prevTopic = topic;
      }

      // Pattern analysis
      lines.push("");
      lines.push("── PATTERN ANALYSIS ───────────────────────────────────────────");
      const hasFirewall = topicCounts.has("firewall") && (topicCounts.get("firewall") ?? 0) > 5;
      const hasInterface = entries.some((e) =>
        (e.message ?? "").toLowerCase().includes("link down"),
      );
      const hasAuth = entries.some(
        (e) =>
          (e.message ?? "").toLowerCase().includes("login failure") ||
          (e.message ?? "").toLowerCase().includes("denied"),
      );
      const hasRouting = entries.some(
        (e) => (e.topics ?? "").includes("ospf") || (e.topics ?? "").includes("bgp"),
      );

      if (hasFirewall) lines.push("  ! High firewall activity — traffic being blocked");
      if (hasInterface) lines.push("  ! Interface link-down events detected");
      if (hasAuth) lines.push("  ! Authentication failures detected — possible brute-force");
      if (hasRouting) lines.push("  ! Routing protocol events — neighbor changes or flaps");
      if (!hasFirewall && !hasInterface && !hasAuth && !hasRouting) {
        lines.push("  No obvious cascading failure patterns detected.");
      }

      return lines.join("\n");
    },
  }),

  // ── suggest_fix ───────────────────────────────────────────────────────
  defineTool({
    name: "suggest_fix",
    title: "Suggest Fix Commands",
    annotations: READ,
    description:
      "Run a quick diagnosis and return ONLY the actionable fix commands — no verbose " +
      "report. Useful when you already know the symptom and just need the remediation " +
      "steps. Each fix command comes with a one-line explanation of what it addresses. " +
      "For the full diagnostic report use `diagnose`.",
    inputSchema: {
      target: z.string().describe("Target to investigate (IP, hostname, or subnet)."),
      dimensions: z
        .array(dimensionEnum)
        .optional()
        .describe("Limit investigation to specific dimensions."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Generating fix suggestions on '${device}' for ${a.target}`);

      const data = await collectDiagnosticData(
        a.target,
        ctx,
        a.dimensions as DiagnosticDimension[] | undefined,
      );
      const report = analyzeRootCause(data);

      if (report.rootCauses.length === 0) {
        return `No issues detected for target '${a.target}' on '${device}'.`;
      }

      const lines: string[] = [];
      lines.push(`FIX SUGGESTIONS — ${device} → ${a.target}`);
      lines.push("");

      let fixCount = 0;
      for (const rc of report.rootCauses) {
        if (rc.fixes.length === 0) continue;
        lines.push(`# ${rc.cause} [${rc.confidence} confidence]`);
        lines.push(`# ${rc.explanation.substring(0, 120)}`);
        for (const f of rc.fixes) {
          lines.push(f);
          fixCount++;
        }
        lines.push("");
      }

      if (fixCount === 0) {
        lines.push("No automated fixes available — manual investigation recommended.");
        lines.push("Use `diagnose` for the full diagnostic report.");
      } else {
        lines.push(`# Total: ${fixCount} fix command(s)`);
        lines.push("# Review each command before applying.");
      }

      return lines.join("\n");
    },
  }),
];
