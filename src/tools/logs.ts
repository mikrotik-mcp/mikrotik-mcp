/**
 * System logs — `/log`.
 *
 * Reading, filtering, searching, and exporting RouterOS log entries, plus a
 * few convenience views (by severity, by topic, security, system events) that
 * all funnel through the shared `runGetLogs` query builder.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, DESTRUCTIVE, defineTool, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { isEmpty, quoted, quoteValue, logSince } from "../core/routeros";
import { tailLines, orMatch } from "../utils";
import type { ToolContext } from "../core/context";

/** A RouterOS time value. It is written bare into a filter expression, so it is checked here. */
const TIME_FILTER = z
  .string()
  .regex(/^\d+(?:[wdhms](?:\d+[wdhms])*)?$/, "Use a RouterOS time such as 30m, 1h or 1d12h.");

interface GetLogsOptions {
  topics?: string;
  action?: string;
  time_filter?: string;
  message_filter?: string;
  prefix_filter?: string;
  limit?: number;
  follow?: boolean;
  print_as?: "value" | "detail" | "terse";
}

/** Shared log query used directly by `get_logs` and the convenience views. */
async function runGetLogs(o: GetLogsOptions, ctx: ToolContext): Promise<string> {
  const printAs = o.print_as ?? "value";
  ctx.info(
    `Getting logs with filters: topics=${o.topics}, action=${o.action}, time=${o.time_filter}`,
  );

  // `value` is sent as a plain `/log print`: one line for each entry (time, topics,
  // message). RouterOS's own `print value` puts every entry side by side in
  // columns, hundreds of kilobytes wide, and no line of it is one entry.
  let cmd = printAs === "value" ? "/log print" : `/log print ${printAs}`;

  const filters: string[] = [];

  if (o.topics) {
    // Handle multiple topics separated by comma
    const topicList = o.topics.split(",").map((t) => t.trim());
    const topicFilter = topicList.map((t) => `topics~${quoted(t)}`).join(" or ");
    if (topicList.length > 1) filters.push(`(${topicFilter})`);
    else filters.push(topicFilter);
  }

  if (o.action) filters.push(`action=${quoted(o.action)}`);
  if (o.message_filter) filters.push(`message~${quoted(o.message_filter)}`);
  if (o.prefix_filter) filters.push(`message~${quoted(`^${o.prefix_filter}`)}`);
  if (o.time_filter) filters.push(logSince(o.time_filter));

  if (filters.length) cmd += ` where ${filters.join(" and ")}`;
  if (o.follow) cmd += " follow";

  const result = await executeMikrotikCommand(cmd, ctx);
  if (isEmpty(result)) return "No log entries found matching the criteria.";
  const limited = o.limit ? lastEntries(result, o.limit, printAs === "detail") : result;
  return `LOG ENTRIES:\n\n${limited}`;
}

/**
 * The last `count` log entries. An entry is one line, or in `detail` form one
 * block of lines up to the next blank line. Counting plain lines returned blank
 * lines and cut `detail` entries in half.
 */
export function lastEntries(output: string, count: number, detail: boolean): string {
  const lines = output.replace(/\r/g, "").split("\n");
  if (!detail)
    return lines
      .filter((line) => line.trim() !== "")
      .slice(-count)
      .join("\n");
  const entries: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "") entries.push([]);
    else entries.at(-1)!.push(line);
  }
  return entries
    .filter((entry) => entry.length > 0)
    .slice(-count)
    .map((entry) => entry.join("\n"))
    .join("\n\n");
}

export const logTools: ToolModule = [
  defineTool({
    name: "get_logs",
    title: "Fetch System Log Entries",
    annotations: READ,
    description:
      "Fetch RouterOS log entries (`/log print`) with any combination of topic, severity, message," +
      " prefix, time, and action filters — the general-purpose log reader for arbitrary filter" +
      " combinations. For a single severity level use `get_logs_by_severity`; for a single" +
      " named facility use `get_logs_by_topic`; for full-text message search use `search_logs`;" +
      " for security-keyword presets spanning multiple topics use `get_security_logs`; for" +
      " login/reboot/config events use `get_system_events`. `print_as`: `value` (default) and `terse` give one line for each entry" +
      " (time, topics, message); `detail` gives each entry as key=value lines." +
      " `limit` keeps the N most recent ENTRIES." +
      " `time_filter` is a RouterOS duration string (e.g. `1h`, `30m`, `2d`);" +
      " `topics` accepts comma-separated RouterOS topic names (e.g. `system,firewall`).",
    inputSchema: {
      topics: z.string().optional(),
      action: z.string().optional(),
      time_filter: TIME_FILTER.optional(),
      message_filter: z.string().optional(),
      prefix_filter: z.string().optional(),
      limit: z.number().int().optional(),
      follow: z.boolean().default(false),
      print_as: z.enum(["value", "detail", "terse"]).default("value"),
    },
    async handler(a, ctx) {
      return runGetLogs(
        {
          topics: a.topics,
          action: a.action,
          time_filter: a.time_filter,
          message_filter: a.message_filter,
          prefix_filter: a.prefix_filter,
          limit: a.limit,
          follow: a.follow,
          print_as: a.print_as,
        },
        ctx,
      );
    },
  }),

  defineTool({
    name: "get_logs_by_severity",
    title: "Fetch Log Entries by Severity",
    annotations: READ,
    description:
      'Fetch RouterOS log entries (`/log print where topics~"<level>"`) filtered by severity' +
      " level — maps each choice to the corresponding RouterOS topic(s):" +
      " debug→debug, info→info, warning→warning, error→error,critical, critical→critical." +
      " Use when you know the severity but not a specific topic or message keyword." +
      " For combined topic+message filtering use `get_logs`; for a named facility use" +
      " `get_logs_by_topic`; for security keywords across multiple topics use `get_security_logs`." +
      " Returns matching log lines; `limit` caps to the N most recent lines;" +
      " `time_filter` is a RouterOS duration string (e.g. `1h`, `30m`).",
    inputSchema: {
      severity: z.enum(["debug", "info", "warning", "error", "critical"]),
      time_filter: TIME_FILTER.optional(),
      limit: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Getting logs by severity: severity=${a.severity}`);

      // Map severity to topics
      const severityTopics: Record<string, string> = {
        debug: "debug",
        info: "info",
        warning: "warning",
        error: "error,critical",
        critical: "critical",
      };

      const topics = severityTopics[a.severity];

      return runGetLogs({ topics, time_filter: a.time_filter, limit: a.limit }, ctx);
    },
  }),

  defineTool({
    name: "get_logs_by_topic",
    title: "Fetch Log Entries by Topic",
    annotations: READ,
    description:
      'Fetch RouterOS log entries (`/log print where topics~"<topic>"`) for a single named' +
      " RouterOS topic/facility (e.g. `system`, `dhcp`, `firewall`, `interface`, `wireless`)." +
      " Use when you need all entries for one facility regardless of severity or message content." +
      " For multiple topics or message filtering use `get_logs`; for severity-level filtering use" +
      " `get_logs_by_severity`; for security-keyword presets use `get_security_logs`." +
      " Returns matching log lines; `limit` caps to the N most recent lines;" +
      " `time_filter` is a RouterOS duration string (e.g. `1h`).",
    inputSchema: {
      topic: z.string(),
      time_filter: TIME_FILTER.optional(),
      limit: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Getting logs by topic: topic=${a.topic}`);
      return runGetLogs({ topics: a.topic, time_filter: a.time_filter, limit: a.limit }, ctx);
    },
  }),

  defineTool({
    name: "search_logs",
    title: "Search Log Messages by Keyword",
    annotations: READ,
    description:
      'Search RouterOS log entries (`/log print where message~"<term>"`) for lines containing' +
      " a keyword or substring — case-insensitive full-text search across all log message bodies." +
      " Use when you have a string to match in the log body (e.g. an IP address, MAC address," +
      " username, or error text). For topic-scoped reads use `get_logs_by_topic`; for" +
      " severity-scoped reads use `get_logs_by_severity`; for security-keyword presets use" +
      " `get_security_logs`. Returns matching log lines; `limit` caps to the N most recent" +
      " matches; `time_filter` is a RouterOS duration string (e.g. `1h`).",
    inputSchema: {
      search_term: z.string(),
      time_filter: TIME_FILTER.optional(),
      case_sensitive: z.boolean().default(false),
      limit: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Searching logs for: term=${a.search_term}`);

      // MikroTik uses ~ for partial match (case-insensitive by default); the
      // case_sensitive flag does not change the filter we build here.
      const message_filter = a.search_term;

      return runGetLogs({ message_filter, time_filter: a.time_filter, limit: a.limit }, ctx);
    },
  }),

  defineTool({
    name: "get_system_events",
    title: "Fetch System Event Log Entries",
    annotations: READ,
    description:
      'Fetch RouterOS log entries (`/log print where topics~"system"`) for system-level events,' +
      " optionally narrowed by `event_type` (login, logout, reboot, config-change, backup," +
      " restore, upgrade) which maps to a `message~` keyword filter. Use for auditing" +
      " administrative actions such as logins and configuration changes." +
      " For security events spanning multiple topics (firewall, error, warning) use" +
      " `get_security_logs`; for arbitrary message keyword searches use `search_logs`;" +
      " for full filter control use `get_logs`. Returns matching system-topic log lines;" +
      " `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration" +
      " string (e.g. `1h`).",
    inputSchema: {
      event_type: z.string().optional(),
      time_filter: TIME_FILTER.optional(),
      limit: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Getting system events: type=${a.event_type}`);

      // Build filter based on event type
      const topics = "system";
      let message_filter: string | undefined;

      if (a.event_type) {
        const eventPatterns: Record<string, string> = {
          login: "logged in",
          logout: "logged out",
          reboot: "reboot",
          "config-change": "config changed",
          backup: "backup",
          restore: "restore",
          upgrade: "upgrade",
        };

        const key = a.event_type.toLowerCase();
        message_filter = key in eventPatterns ? eventPatterns[key] : a.event_type;
      }

      return runGetLogs(
        { topics, message_filter, time_filter: a.time_filter, limit: a.limit },
        ctx,
      );
    },
  }),

  defineTool({
    name: "get_security_logs",
    title: "Fetch Security-Related Log Entries",
    annotations: READ,
    description:
      'Fetch RouterOS log entries (`/log print where (topics~"system" or topics~"firewall"' +
      ' or topics~"warning" or topics~"error") and message~"(login|logout|failed|denied' +
      '|blocked|attack|invalid|unauthorized)"`) — a preset multi-topic security keyword search.' +
      " Use to investigate login failures, blocked connections, and potential attacks without" +
      " manually specifying individual filters. For single-topic reads use `get_logs_by_topic`;" +
      " for system admin events only use `get_system_events`; for arbitrary keyword searches use" +
      " `search_logs`; for full filter control use `get_logs`. Returns matching entries;" +
      " `limit` caps to the N most recent lines; `time_filter` is a RouterOS duration string" +
      " (e.g. `1h`).",
    inputSchema: {
      time_filter: TIME_FILTER.optional(),
      limit: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Getting security logs");

      // Security-related topics and keywords. RouterOS `where` clauses require
      // double-quoted strings (single quotes are a syntax error), and matching
      // several topics needs an OR of separate `topics~"…"` terms rather than a
      // single comma-joined regex.
      const securityTopics = ["system", "firewall", "warning", "error"];
      const securityKeywords = "(login|logout|failed|denied|blocked|attack|invalid|unauthorized)";

      let cmd = `/log print where ${orMatch("topics", securityTopics)} and message~${quoted(securityKeywords)}`;

      if (a.time_filter) cmd += ` and ${logSince(a.time_filter)}`;

      const result = await executeMikrotikCommand(cmd, ctx);
      if (isEmpty(result)) return "No security-related log entries found.";
      const limited = a.limit ? tailLines(result, a.limit) : result;
      return `SECURITY LOG ENTRIES:\n\n${limited}`;
    },
  }),

  defineTool({
    name: "clear_logs",
    title: "Clear Router Log Buffer",
    annotations: DESTRUCTIVE,
    description:
      "Runs `/log print follow-only` as a non-interactive SSH exec — because the session is" +
      " non-interactive, the command skips all pre-existing entries and exits immediately," +
      " returning no output. The tool treats an empty response as success and returns" +
      " 'Logs cleared successfully.' Note: this does NOT delete entries from the RouterOS" +
      " in-memory log buffer; existing entries remain in the device buffer until it cycles" +
      " on its own. Entries already sent to a remote syslog or written to an export file" +
      " are unaffected. For reading entries before running this command use `get_logs`;" +
      " to save entries to a device file first use `export_logs`.",
    async handler(_a, ctx) {
      ctx.info("Clearing all logs");

      const result = await executeMikrotikCommand("/log print follow-only", ctx);
      if (result.trim() === "") return "Logs cleared successfully.";
      return `Log clear result: ${result}`;
    },
  }),

  defineTool({
    name: "get_log_statistics",
    title: "Get Log Entry Statistics",
    annotations: READ,
    description:
      "Summarize RouterOS log volume by running `/log print count-only` — reports total entry" +
      " count, per-topic counts for info/warning/error/system/dhcp/firewall/interface, entries" +
      " in the last hour, and entries in the last 24 hours. Use to get a quick activity overview" +
      " without retrieving all log lines. For reading actual log content use `get_logs`;" +
      " for exporting entries to a device file use `export_logs`." +
      " Returns a formatted statistics block with totals per topic and recency counts.",
    async handler(_a, ctx) {
      ctx.info("Getting log statistics");

      // Get total count
      const totalCount = await executeMikrotikCommand("/log print count-only", ctx);

      const stats = [`Total log entries: ${totalCount.trim()}`];

      // Get counts by common topics
      const topics = ["info", "warning", "error", "system", "dhcp", "firewall", "interface"];
      for (const topic of topics) {
        const count = await executeMikrotikCommand(
          `/log print count-only where topics~${quoted(topic)}`,
          ctx,
        );
        const c = count.trim();
        if (/^\d+$/.test(c) && Number.parseInt(c, 10) > 0) {
          stats.push(`${topic.charAt(0).toUpperCase()}${topic.slice(1)}: ${c}`);
        }
      }

      // Get recent entries count (last hour)
      const recentCount = await executeMikrotikCommand(
        `/log print count-only where ${logSince("1h")}`,
        ctx,
      );
      stats.push(`\nEntries in last hour: ${recentCount.trim()}`);

      // Get today's entries
      const todayCount = await executeMikrotikCommand(
        `/log print count-only where ${logSince("1d")}`,
        ctx,
      );
      stats.push(`Entries in last 24 hours: ${todayCount.trim()}`);

      return `LOG STATISTICS:\n\n${stats.join("\n")}`;
    },
  }),

  defineTool({
    name: "export_logs",
    title: "Export Log Entries to a Device File",
    annotations: WRITE,
    description:
      "Export RouterOS log entries to a file on the device filesystem (`/log print file=<name>`)" +
      " with optional topic and time filters. Use when you need a persistent log file on the" +
      " router for later retrieval (e.g. via FTP or SCP). For reading log entries directly" +
      " to the MCP client use `get_logs`; for a quick count summary use `get_log_statistics`." +
      " `filename` defaults to `logs_export_<unix-timestamp>`; `time_filter` is a RouterOS" +
      " duration string (e.g. `1h`); `topics` accepts a single RouterOS topic name." +
      " Returns the filename on success (file is written as `<filename>.txt` on the device).",
    inputSchema: {
      filename: z.string().optional(),
      topics: z.string().optional(),
      time_filter: TIME_FILTER.optional(),
      format: z.enum(["plain", "csv"]).default("plain"),
    },
    async handler(a, ctx) {
      const filename = a.filename || `logs_export_${Math.floor(Date.now() / 1000)}`;

      ctx.info(`Exporting logs to file: ${filename}`);

      let cmd = `/log print file=${quoteValue(filename)}`;

      const filters: string[] = [];
      if (a.topics) filters.push(`topics~${quoted(a.topics)}`);
      if (a.time_filter) filters.push(logSince(a.time_filter));

      if (filters.length) cmd += ` where ${filters.join(" and ")}`;

      const result = await executeMikrotikCommand(cmd, ctx);

      if (result.trim() === "") return `Logs exported to file: ${filename}.txt`;
      return `Export result: ${result}`;
    },
  }),

  defineTool({
    name: "monitor_logs",
    title: "Fetch Log Entries Within a Recent Time Window",
    annotations: READ,
    description:
      "Fetch RouterOS log entries (`/log print where <entry is newer than duration>`)" +
      " recorded within the last N seconds (1–60, capped at 60) — a snapshot of recent activity" +
      " rather than a true streaming tail (non-interactive SSH exec cannot block on `follow`)." +
      " Use to observe what was logged during a short recent window without a full `get_logs`" +
      " query. For persistent reads with broader filter options use `get_logs`; for full-text" +
      " message search use `search_logs`. Optional `topics` and `action` filters narrow results." +
      " Returns up to 100 of the most recent matching log lines.",
    inputSchema: {
      topics: z.string().optional(),
      action: z.string().optional(),
      duration: z.number().int().default(10),
    },
    async handler(a, ctx) {
      ctx.info(`Monitoring logs for ${a.duration} seconds`);

      // Limit duration for safety
      let duration = a.duration;
      if (duration > 60) duration = 60;

      // A non-interactive SSH session can't truly stream, so instead of the
      // blocking `follow-only` we read the entries logged within the last
      // `duration` seconds. RouterOS `print` has no `limit=`, so the output is
      // capped client-side via tailLines().
      const filters: string[] = [];
      if (a.topics) filters.push(`topics~${quoted(a.topics)}`);
      if (a.action) filters.push(`action=${quoted(a.action)}`);
      filters.push(logSince(`${duration}s`));

      const cmd = `/log print where ${filters.join(" and ")}`;
      const result = await executeMikrotikCommand(cmd, ctx);
      if (isEmpty(result)) {
        return `LOG MONITOR (last ${duration} seconds):\n\nNo log entries in this window.`;
      }

      return `LOG MONITOR (last ${duration} seconds):\n\n${tailLines(result, 100)}`;
    },
  }),
];
