/**
 * Traffic Flow — `/ip traffic-flow` on the device, plus the host-side collector
 * and the analytics over what it collects.
 *
 * Three groups of tools in one module because they are one workflow: configure
 * the exporter, point it at this host, then read what arrived. The composite
 * ("enable + target + collector, all at once") is deliberately NOT a tool — it
 * makes the device send traffic metadata to a host, which the model should
 * explain before doing, so it lives in `prompts/setup-traffic-flow.md`.
 *
 * Flow data carries no payload, which is precisely what makes it cheap and
 * privacy-preserving next to the packet sniffer — worth repeating in the
 * descriptions the model reads.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DESTRUCTIVE, READ, WRITE, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, isEmpty, looksLikeError, yesno } from "../core/routeros";
import { getConfig, resolveDeviceName } from "../core/runtime";
import {
  applicationName,
  conversations,
  detectAnomalies,
  humanBytes,
  protocolMix,
  summarize,
  topTalkers,
} from "../flows/aggregate";
import type { TalkerDimension } from "../flows/aggregate";
import { getFlowCollector } from "../flows/collector";
import type { FlowRecord } from "../flows/decode";
import { openFlowStore } from "../flows/store";
import type { FlowStore } from "../flows/store";
import { logger } from "../logger";

// One store per process, opened lazily so importing this module touches no disk.
let storePromise: Promise<FlowStore> | null = null;

function flowStore(): Promise<FlowStore> {
  storePromise ??= (() => {
    const cfg = getConfig().flows;
    return openFlowStore(cfg.db, {
      retentionHours: cfg.retentionHours,
      rollupDays: cfg.rollupDays,
      maxRows: cfg.maxRows,
      onEvict: (rows, reason) => logger.info(`Flow store evicted ${rows} row(s): ${reason}`),
    });
  })();
  return storePromise;
}

const WINDOWS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
};

const windowSchema = z
  .enum(["5m", "15m", "1h", "6h", "24h"])
  .default("1h")
  .describe("How far back to look");

/** Read the flows for a window, flushing anything the collector still holds. */
async function windowRecords(window: string, address?: string): Promise<FlowRecord[]> {
  getFlowCollector().drain();
  const store = await flowStore();
  const to = Date.now();
  const from = to - (WINDOWS[window] ?? WINDOWS["1h"]);
  return store.query({ from, to, address, limit: 200_000 });
}

function noDataHint(): string {
  const stats = getFlowCollector().stats();
  if (!stats.running) {
    return (
      "No flows collected — the collector is NOT running. Start it with start_flow_collector, " +
      "then point the device at this host with add_traffic_flow_target."
    );
  }
  if (stats.packets === 0) {
    return (
      `No flows collected — the collector is listening on UDP ${stats.port} but has received ` +
      "nothing. Check that traffic-flow is enabled (get_traffic_flow_settings), that a target " +
      "points at this host's address, and that nothing between them blocks that UDP port."
    );
  }
  if (stats.templatesPending > 0) {
    return (
      `No flows decoded yet — ${stats.packets} packet(s) received but ${stats.templatesPending} ` +
      "data set(s) are still waiting for their template. v9/IPFIX exporters resend templates " +
      "every few minutes; this resolves itself shortly after the next refresh."
    );
  }
  if (stats.decodeErrors > 0) {
    return (
      `No flows decoded — ${stats.decodeErrors} packet(s) could not be decoded ` +
      `(last: ${stats.lastError ?? "unknown"}). Check the target's version= setting; v9 or ipfix.`
    );
  }
  return "No flows in this window — the link may simply have been idle.";
}

function talkerTable(
  title: string,
  rows: { key: string; bytes: number; packets: number; flows: number; share: number }[],
): string {
  if (rows.length === 0) return "";
  const lines = [`${title}:`];
  for (const [i, r] of rows.entries()) {
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${r.key.padEnd(34)} ${humanBytes(r.bytes).padStart(9)}  ` +
        `${(r.share * 100).toFixed(1).padStart(5)}%  ${r.flows} flow(s)`,
    );
  }
  return lines.join("\n");
}

export const trafficFlowTools: ToolModule = [
  defineTool({
    name: "get_traffic_flow_settings",
    title: "Get Traffic Flow Settings",
    annotations: READ,
    description:
      "Reads `/ip traffic-flow` — whether NetFlow/IPFIX export is enabled, which interfaces are " +
      "sampled, the cache size and the active/inactive flow timeouts. " +
      "Traffic Flow is the cheap, continuous alternative to the packet sniffer: it exports flow " +
      "METADATA (who talked to whom, how much) and never any payload. " +
      "To see where the flows are sent use list_traffic_flow_targets; to change these settings use " +
      "set_traffic_flow_settings.",
    async handler(_a, ctx) {
      ctx.info("Reading traffic-flow settings");
      const result = await executeMikrotikCommand("/ip traffic-flow print", ctx);
      if (looksLikeError(result)) return `Failed to read traffic-flow settings: ${result}`;
      return isEmpty(result) ? "No traffic-flow settings returned." : `TRAFFIC FLOW:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_traffic_flow_settings",
    title: "Set Traffic Flow Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configures `/ip traffic-flow` — enable/disable export, choose interfaces, and tune the flow " +
      "cache and timeouts. Idempotent: setting the same values twice changes nothing. " +
      "`active_flow_timeout` (default 30m) caps how long a long-lived flow is held before it is " +
      "reported, so a lower value gives fresher data at the cost of more exports; " +
      "`inactive_flow_timeout` (default 15s) is how quickly a finished flow is flushed. " +
      "`cache_entries` bounds device memory — raise it on a busy router that reports dropped flows. " +
      "Enabling export alone does nothing until a collector target exists (add_traffic_flow_target).",
    inputSchema: {
      enabled: z.boolean().optional().describe("Turn flow export on or off"),
      interfaces: z
        .string()
        .optional()
        .describe('Interface list, or "all" (default). e.g. "ether1,bridge"'),
      cache_entries: z
        .string()
        .optional()
        .describe('Flow cache size, e.g. "4k", "16k" — bound on device memory'),
      active_flow_timeout: z.string().optional().describe('e.g. "30m" — report long flows sooner'),
      inactive_flow_timeout: z.string().optional().describe('e.g. "15s"'),
    },
    async handler(a, ctx) {
      ctx.info("Updating traffic-flow settings");
      const cmd = new Cmd("/ip traffic-flow set");
      if (a.enabled !== undefined) cmd.raw(`enabled=${yesno(a.enabled)}`);
      cmd
        .opt("interfaces", a.interfaces)
        .opt("cache-entries", a.cache_entries)
        .opt("active-flow-timeout", a.active_flow_timeout)
        .opt("inactive-flow-timeout", a.inactive_flow_timeout);

      const built = cmd.build();
      if (built === "/ip traffic-flow set") return "No settings specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update traffic-flow settings: ${result}`;
      const details = await executeMikrotikCommand("/ip traffic-flow print", ctx);
      return `Traffic-flow settings updated:\n\n${details}`;
    },
  }),

  defineTool({
    name: "list_traffic_flow_targets",
    title: "List Traffic Flow Targets",
    annotations: READ,
    description:
      "Lists the collectors the device exports flows to (`/ip traffic-flow target print`) — each " +
      "target's destination address, port and NetFlow version. " +
      "Use this to confirm the device is pointed at this MCP host before wondering why the Flows " +
      "page is empty. To add one use add_traffic_flow_target.",
    async handler(_a, ctx) {
      ctx.info("Listing traffic-flow targets");
      const result = await executeMikrotikCommand("/ip traffic-flow target print detail", ctx);
      if (looksLikeError(result)) return `Failed to list traffic-flow targets: ${result}`;
      return isEmpty(result)
        ? "No traffic-flow targets configured — the device is exporting nowhere."
        : `TRAFFIC FLOW TARGETS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_traffic_flow_target",
    title: "Add Traffic Flow Target",
    annotations: WRITE,
    description:
      "Points the device at a flow collector (`/ip traffic-flow target add`) — normally THIS MCP " +
      "host, so the flows land in the local collector and the Flows dashboard. " +
      "`version` should be **9 or ipfix**: v5 is IPv4-only and has no template mechanism, so IPv6 " +
      "flows are simply absent from it. " +
      "The device will send flow metadata (addresses, ports, byte counts — never payload) to " +
      "`dst_address` continuously, so point it somewhere you control. " +
      "Start the local receiver first with start_flow_collector, or the exports go nowhere.",
    inputSchema: {
      dst_address: z
        .string()
        .describe("Collector IP — the address of this MCP host as the router sees it"),
      port: z.coerce.number().int().positive().default(2055).describe("Collector UDP port"),
      version: z
        .enum(["1", "5", "9", "ipfix"])
        .default("9")
        .describe("Export version; prefer 9 or ipfix"),
      v9_template_refresh: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Packets between template resends (v9/IPFIX)"),
      v9_template_timeout: z
        .string()
        .optional()
        .describe('Time between template resends, e.g. "30s" — lower means faster first decode'),
    },
    async handler(a, ctx) {
      ctx.info(`Adding traffic-flow target ${a.dst_address}:${a.port} (v${a.version})`);
      const cmd = new Cmd("/ip traffic-flow target add")
        .set("dst-address", a.dst_address)
        .set("port", a.port)
        .set("version", a.version)
        .opt("v9-template-refresh", a.v9_template_refresh)
        .opt("v9-template-timeout", a.v9_template_timeout)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add traffic-flow target: ${result}`;
      const details = await executeMikrotikCommand(
        `/ip traffic-flow target print detail where dst-address="${a.dst_address}"`,
        ctx,
      );
      const note =
        a.version === "5" || a.version === "1"
          ? "\n\nNote: v5/v1 carry IPv4 only — IPv6 flows will be missing. Prefer version=9 or ipfix."
          : "";
      return `Traffic-flow target added:\n\n${details}${note}`;
    },
  }),

  defineTool({
    name: "remove_traffic_flow_target",
    title: "Remove Traffic Flow Target",
    annotations: DESTRUCTIVE,
    description:
      "Removes a flow collector target (`/ip traffic-flow target remove`), stopping export to that " +
      "address. Verifies the target exists first. " +
      "Removing every target leaves flow export enabled but going nowhere — to stop collection " +
      "entirely also set enabled=no with set_traffic_flow_settings.",
    inputSchema: {
      dst_address: z.string().describe("Collector address of the target to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing traffic-flow target ${a.dst_address}`);
      const count = await executeMikrotikCommand(
        `/ip traffic-flow target print count-only where dst-address="${a.dst_address}"`,
        ctx,
      );
      if (count.trim() === "0") return `No traffic-flow target for '${a.dst_address}'.`;

      const result = await executeMikrotikCommand(
        `/ip traffic-flow target remove [find dst-address="${a.dst_address}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove traffic-flow target: ${result}`;
      return `Traffic-flow target '${a.dst_address}' removed.`;
    },
  }),

  defineTool({
    name: "start_flow_collector",
    title: "Start Local Flow Collector",
    annotations: WRITE,
    description:
      "Starts the MCP host's UDP collector so exported NetFlow/IPFIX packets are decoded and " +
      "stored locally. Nothing on the router changes — this is the receiving half. " +
      "Point the device at this host with add_traffic_flow_target (same port). " +
      "Records are kept per the `flows` config (24 h raw, 30 d of 1-minute rollups by default) and " +
      "contain no payload. " +
      "Reports the listening port and current health counters; stop with stop_flow_collector.",
    inputSchema: {
      port: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("UDP port to listen on (defaults to the configured flows.port, 2055)"),
    },
    async handler(a, ctx) {
      const cfg = getConfig().flows;
      const port = a.port ?? cfg.port;
      const collector = getFlowCollector();
      if (collector.running) {
        const stats = collector.stats();
        return `Flow collector is already running on UDP ${stats.port} (${stats.packets} packet(s) received).`;
      }

      ctx.info(`Starting flow collector on UDP ${port}`);
      const result = await collector.start(await flowStore(), port);
      if (!result.ok) {
        return (
          `Failed to start the flow collector on UDP ${port}: ${result.error ?? "unknown error"}. ` +
          "Another process may already hold that port, or binding it may need privileges."
        );
      }
      return (
        `Flow collector listening on UDP ${port}.\n\n` +
        `Next: add_traffic_flow_target dst_address=<this host's IP as the router sees it> port=${port} version=9, ` +
        "and make sure set_traffic_flow_settings has enabled=true.\n" +
        "First flows appear once the exporter sends a template (usually within a minute or two)."
      );
    },
  }),

  defineTool({
    name: "stop_flow_collector",
    title: "Stop Local Flow Collector",
    annotations: WRITE,
    description:
      "Stops the local UDP flow collector and releases the port. Already-collected flows stay in " +
      "the store and remain queryable; anything the device exports while stopped is lost. " +
      "The device keeps exporting until you also remove its target (remove_traffic_flow_target).",
    handler(_a, ctx) {
      const collector = getFlowCollector();
      if (!collector.running) return "Flow collector is not running.";
      const stats = collector.stats();
      ctx.info("Stopping flow collector");
      collector.stop();
      return (
        `Flow collector stopped. Received ${stats.packets} packet(s) and decoded ${stats.flows} ` +
        "flow(s) this session; stored flows remain queryable."
      );
    },
  }),

  defineTool({
    name: "flow_top_talkers",
    title: "Flow Top Talkers",
    annotations: READ,
    description:
      "Ranks collected flows by bytes over a window — the direct answer to 'who is using my " +
      "bandwidth'. Group by `source`, `destination`, `conversation` (an address pair) or " +
      "`application` (well-known port naming). " +
      "Needs the local collector running and the device exporting to it; if the result is empty " +
      "the tool explains which of those is missing. " +
      "For a fuller narrative including protocol mix and anomalies use analyze_flows.",
    inputSchema: {
      dimension: z
        .enum(["source", "destination", "conversation", "application"])
        .default("source")
        .describe("What to rank by"),
      window: windowSchema,
      limit: z.coerce.number().int().positive().max(100).default(10),
      address: z.string().optional().describe("Restrict to flows touching this address"),
    },
    async handler(a, ctx) {
      ctx.info(`Top ${a.dimension} over ${a.window}`);
      const records = await windowRecords(a.window, a.address);
      if (records.length === 0) return noDataHint();

      const totals = summarize(records);
      const rows = topTalkers(records, a.dimension as TalkerDimension, a.limit, true);
      return [
        `TOP ${a.dimension.toUpperCase()} — last ${a.window}`,
        `${totals.flows} flow(s), ${humanBytes(totals.bytes)}, ${totals.sources} source(s) → ${totals.destinations} destination(s)`,
        "",
        talkerTable("By bytes", rows),
      ].join("\n");
    },
  }),

  defineTool({
    name: "analyze_flows",
    title: "Analyze Traffic Flows",
    annotations: READ,
    description:
      "A rendered traffic report over the collected flows: top talkers, busiest conversations with " +
      "the applications inside them, protocol mix, and anomalies — talkers well above their own " +
      "baseline from the preceding period, or ones never seen before. " +
      "This is the tool to reach for when asked 'what is using the bandwidth', 'is anything " +
      "unusual on the network', or 'what is that host doing'. " +
      "Reads only the local flow store; no device command is issued.",
    inputSchema: {
      window: windowSchema,
      address: z.string().optional().describe("Focus the whole report on one address"),
      anomaly_ratio: z.coerce
        .number()
        .positive()
        .default(3)
        .describe("Flag a talker at this multiple of its baseline"),
    },
    async handler(a, ctx) {
      ctx.info(`Analyzing flows over ${a.window}`);
      const records = await windowRecords(a.window, a.address);
      if (records.length === 0) return noDataHint();

      const windowMs = WINDOWS[a.window] ?? WINDOWS["1h"];
      const now = Date.now();
      // Baseline = the four windows before this one, averaged. Comparing a window
      // against itself would flag nothing; against a single previous window it
      // would flag every normal fluctuation.
      const store = await flowStore();
      const baseline = store.query({
        from: now - windowMs * 5,
        to: now - windowMs,
        address: a.address,
        limit: 200_000,
      });

      const totals = summarize(records);
      const anomalies = detectAnomalies(records, baseline, {
        ratio: a.anomaly_ratio,
        baselineWindows: 4,
      });
      const talks = conversations(records, 5);
      const mix = protocolMix(records);

      const sections = [
        `TRAFFIC FLOW ANALYSIS — last ${a.window}${a.address ? ` for ${a.address}` : ""}`,
        `${totals.flows} flow(s) · ${humanBytes(totals.bytes)} · ${totals.packets.toLocaleString()} packets · ` +
          `${totals.sources} source(s) → ${totals.destinations} destination(s)`,
        "",
        talkerTable("Top sources", topTalkers(records, "source", 5, true)),
        "",
        talkerTable("Top applications", topTalkers(records, "application", 5, true)),
        "",
        "Busiest conversations:",
        ...talks.map(
          (c, i) =>
            `  ${i + 1}. ${c.src} ↔ ${c.dst}  ${humanBytes(c.bytes)}  [${c.applications.slice(0, 3).join(", ")}]`,
        ),
        "",
        `Protocol mix: ${mix
          .slice(0, 5)
          .map((m) => `${m.protocol} ${(m.share * 100).toFixed(0)}%`)
          .join(" · ")}`,
      ];

      if (anomalies.length === 0) {
        sections.push("", "Anomalies: none — every talker is within its usual range.");
      } else {
        sections.push("", "Anomalies (vs the preceding period):");
        for (const x of anomalies.slice(0, 10)) {
          sections.push(`  ! ${x.key} — ${humanBytes(x.bytes)}, ${x.reason}`);
        }
        sections.push(
          "",
          "An anomaly is a volume comparison, not a verdict — a backup window or a software update " +
            "looks the same as exfiltration. Check the conversations above before acting.",
        );
      }

      const collector = getFlowCollector().stats();
      if (collector.templatesPending > 0) {
        sections.push(
          "",
          `Note: ${collector.templatesPending} data set(s) are still awaiting a template, so this ` +
            "window may under-report until the exporter's next template refresh.",
        );
      }
      return sections.filter((s) => s !== "").join("\n");
    },
  }),
];

/** Exposed for the dashboard routes, which read the same store. */
export { flowStore };

/** Re-exported so the dashboard can name applications identically to the tools. */
export { applicationName, resolveDeviceName };
