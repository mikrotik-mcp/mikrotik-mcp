/**
 * OpenVPN usage & session analytics — automatic collection and exact calculation
 * of historical and live OpenVPN connection metrics.
 *
 * Combines:
 *   1. RouterOS v7 User Manager accounting (`/user-manager session` + `/user-manager user`),
 *      when the `user-manager` package is installed on the target device.
 *   2. Live OpenVPN runtime sessions (`/ppp active where service=ovpn` joined with
 *      dynamic `<ovpn-*>` interface TX/RX counters) plus `/ppp secret` and
 *      `/interface ovpn-server server` metadata.
 *   3. Local SQLite OpenVPN history (`~/.mikrotik-mcp/openvpn-history.db`), when
 *      available on the MCP host, for cached GeoIP/ASN enrichment and historical
 *      fallback on devices that do not run User Manager.
 *
 * All byte counts, session durations, per-user daily breakdowns, per-user totals,
 * and all-users aggregates are computed deterministically here so AI agents never
 * perform arithmetic on raw session dumps.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { executeMikrotikCommand } from "./connector";
import type { ToolContext } from "./context";
import { openVpnClientBytes } from "./openvpn-sessions";
import { connectionDuration, openVpnUptime } from "./openvpn-sessions-model";
import { getConfig, resolveDeviceName } from "./runtime";
import { assertDeviceAccess } from "./scoped-access";
import { humanBytes } from "../flows/aggregate";

const MAX_DAYS = 366;
const DEFAULT_DAYS = 7;
const DEFAULT_SESSION_LIMIT = 100;
const MAX_SESSION_LIMIT = 1000;
const SESSION_CMD_TIMEOUT_MS = 60_000;

/**
 * Quote a string for RouterOS console expressions, additionally escaping `?`
 * because `?` triggers interactive help unless escaped inside double quotes.
 */
export function routerOsStringLiteral(value: string | number | boolean): string {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\?/g, "\\?")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

export const AnalyzeOpenVpnUsageSchema = z.object({
  from: z
    .string()
    .trim()
    .optional()
    .describe(
      "Start of the analysis window in router local time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). " +
        "Alias: `since`, `start_date`. When omitted, `days` (default 7) is used unless `all_time=true`.",
    ),
  since: z
    .string()
    .trim()
    .optional()
    .describe("Alias for `from` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`)."),
  start_date: z
    .string()
    .trim()
    .optional()
    .describe("Alias for `from` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`)."),
  to: z
    .string()
    .trim()
    .optional()
    .describe(
      "End of the analysis window in router local time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`). " +
        "A date-only value (`YYYY-MM-DD`) includes the full day through `23:59:59`. Alias: `until`, `end_date`.",
    ),
  until: z
    .string()
    .trim()
    .optional()
    .describe("Alias for `to` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`)."),
  end_date: z
    .string()
    .trim()
    .optional()
    .describe("Alias for `to` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`)."),
  date: z
    .string()
    .trim()
    .optional()
    .describe(
      "Single calendar day shortcut (`YYYY-MM-DD`), equivalent to setting both `from` and `to` to that day. Alias: `day`.",
    ),
  day: z.string().trim().optional().describe("Alias for `date` (`YYYY-MM-DD`)."),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DAYS)
    .optional()
    .describe(
      `Number of calendar days ending today on the router's clock (1 = today only, 7 = today + previous 6 days). Default ${DEFAULT_DAYS} when no date range is specified.`,
    ),
  all_time: z
    .boolean()
    .optional()
    .describe(
      "When true, analyze all retained accounting records without a start-date cutoff. Warning: on routers with tens of thousands of historical sessions this may take 15–20 seconds.",
    ),
  user: z
    .string()
    .trim()
    .optional()
    .describe(
      "Filter to a specific OpenVPN username (exact match by default, or substring match when `user_match='contains'`; also accepts comma-separated usernames). Alias: `username`.",
    ),
  username: z.string().trim().optional().describe("Alias for `user`."),
  users: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Filter to any of the listed OpenVPN usernames."),
  user_match: z
    .enum(["exact", "contains"])
    .default("exact")
    .describe(
      "How to match `user` / `users`: `'exact'` (case-insensitive exact username match, default) or `'contains'` (case-insensitive substring match).",
    ),
  caller_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Filter by client public source IP (`calling-station-id` / `caller-id`). Matches exact IP or prefix/substring. Alias: `source_ip`, `client_ip`.",
    ),
  source_ip: z.string().trim().optional().describe("Alias for `caller_id`."),
  client_ip: z.string().trim().optional().describe("Alias for `caller_id`."),
  address: z
    .string()
    .trim()
    .optional()
    .describe(
      "Filter by assigned OpenVPN tunnel IP (`user-address` / `address`, e.g. `10.10.6.215`). Alias: `tunnel_ip`.",
    ),
  tunnel_ip: z.string().trim().optional().describe("Alias for `address`."),
  status: z
    .enum(["all", "active", "closed"])
    .default("all")
    .describe(
      "Filter by session state: `'all'` (both active and closed sessions, default), `'active'` (currently connected only), or `'closed'` (disconnected/completed only).",
    ),
  active_only: z
    .boolean()
    .optional()
    .describe("Shortcut for `status='active'` when true, or `status='closed'` when false."),
  terminate_cause: z
    .string()
    .trim()
    .optional()
    .describe(
      "Filter by RADIUS disconnect / terminate cause (e.g. `'lost-carrier'`, `'idle-timeout'`, `'user-request'`, `'session-timeout'`, `'admin-reset'`). Case-insensitive substring or exact match.",
    ),
  exclude_zero_traffic: z
    .boolean()
    .default(false)
    .describe(
      "When true, exclude 0-byte connection attempts (handshake/reconnect retries where download + upload = 0) from the primary aggregations. Even when false, the report separately counts `nonZeroTrafficSessions` vs `zeroTrafficSessions`.",
    ),
  min_total_bytes: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Only include sessions whose combined download + upload bytes are at least this value.",
    ),
  min_download_bytes: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only include sessions whose client download bytes are at least this value."),
  min_upload_bytes: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only include sessions whose client upload bytes are at least this value."),
  min_duration_seconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only include sessions whose duration (uptime in seconds) is at least this value."),
  max_duration_seconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only include sessions whose duration (uptime in seconds) is at most this value."),
  include_daily_breakdown: z
    .boolean()
    .default(true)
    .describe(
      "Include per-user-per-day and all-users-per-day connection counts, durations, and download/upload/total byte breakdowns.",
    ),
  include_sessions: z
    .boolean()
    .default(true)
    .describe(
      "Include the paginated list of individual OpenVPN sessions with per-session download, upload, total bytes, duration, caller IP, tunnel IP, and timestamps.",
    ),
  include_inactive_users: z
    .boolean()
    .default(false)
    .describe(
      "When true (and no user filter is active), include configured OpenVPN/User Manager accounts that had 0 matching connections in the window.",
    ),
  sort_users_by: z
    .enum(["total_bytes", "download_bytes", "upload_bytes", "connections", "duration", "user"])
    .default("total_bytes")
    .describe("How to sort the per-user summary table."),
  sort_sessions_by: z
    .enum([
      "started_desc",
      "started_asc",
      "total_bytes_desc",
      "duration_desc",
      "download_desc",
      "upload_desc",
    ])
    .default("started_desc")
    .describe("How to sort the individual sessions list."),
  session_limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SESSION_LIMIT)
    .default(DEFAULT_SESSION_LIMIT)
    .describe(
      `Maximum number of individual session records to return in \`sessions\` (1–${MAX_SESSION_LIMIT}, default ${DEFAULT_SESSION_LIMIT}). Aggregations always cover 100% of matching sessions regardless of this limit.`,
    ),
  session_offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Pagination offset into the sorted `sessions` list."),
});

export type AnalyzeOpenVpnUsageInput = z.infer<typeof AnalyzeOpenVpnUsageSchema>;

export interface NormalizedOpenVpnQuery {
  from?: string;
  to?: string;
  days?: number;
  allTime: boolean;
  users: string[];
  userMatch: "exact" | "contains";
  callerId?: string;
  address?: string;
  status: "all" | "active" | "closed";
  terminateCause?: string;
  excludeZeroTraffic: boolean;
  minTotalBytes?: number;
  minDownloadBytes?: number;
  minUploadBytes?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  includeDailyBreakdown: boolean;
  includeSessions: boolean;
  includeInactiveUsers: boolean;
  sortUsersBy:
    | "total_bytes"
    | "download_bytes"
    | "upload_bytes"
    | "connections"
    | "duration"
    | "user";
  sortSessionsBy:
    | "started_desc"
    | "started_asc"
    | "total_bytes_desc"
    | "duration_desc"
    | "download_desc"
    | "upload_desc";
  sessionLimit: number;
  sessionOffset: number;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Normalize a user-supplied date or timestamp to RouterOS `YYYY-MM-DD HH:MM:SS`.
 * For `bound="start"`, `YYYY-MM-DD` expands to `YYYY-MM-DD 00:00:00`.
 * For `bound="end"`, `YYYY-MM-DD` expands to `YYYY-MM-DD 23:59:59`.
 */
export function normalizeRouterDateTime(value: string, bound: "start" | "end"): string {
  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    return `${trimmed} ${bound === "start" ? "00:00:00" : "23:59:59"}`;
  }
  if (DATETIME_RE.test(trimmed)) {
    const normalized = trimmed.replace("T", " ");
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const iso = parsed.toISOString().replace("T", " ").slice(0, 19);
    return iso;
  }
  throw new Error(
    `Invalid date/time '${value}'. Use 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' in router local time.`,
  );
}

/** Normalize raw Zod input (including LLM aliases) into a canonical query. */
export function normalizeOpenVpnQuery(raw: AnalyzeOpenVpnUsageInput): NormalizedOpenVpnQuery {
  const parsed = AnalyzeOpenVpnUsageSchema.parse(raw);
  const singleDate = parsed.date || parsed.day;
  const rawFrom = singleDate || parsed.from || parsed.since || parsed.start_date;
  const rawTo = singleDate || parsed.to || parsed.until || parsed.end_date;

  const from = rawFrom ? normalizeRouterDateTime(rawFrom, "start") : undefined;
  const to = rawTo ? normalizeRouterDateTime(rawTo, "end") : undefined;
  if (from && to && from > to) {
    throw new Error(`Invalid time range: 'from' (${from}) is after 'to' (${to}).`);
  }

  const allTime = parsed.all_time === true && !from && !to && parsed.days === undefined;
  const days = !from && !to && !allTime ? (parsed.days ?? DEFAULT_DAYS) : parsed.days;

  const userList: string[] = [];
  const rawUser = parsed.user || parsed.username;
  if (rawUser) {
    for (const part of rawUser.split(",")) {
      const u = part.trim();
      if (u) userList.push(u);
    }
  }
  if (parsed.users) {
    for (const u of parsed.users) {
      const trimmed = u.trim();
      if (trimmed) userList.push(trimmed);
    }
  }
  const users = [...new Set(userList)];

  const callerId = (parsed.caller_id || parsed.source_ip || parsed.client_ip)?.trim() || undefined;
  const address = (parsed.address || parsed.tunnel_ip)?.trim() || undefined;
  const status =
    parsed.active_only === true
      ? "active"
      : parsed.active_only === false && parsed.status === "all"
        ? "closed"
        : parsed.status;

  return {
    from,
    to,
    days,
    allTime,
    users,
    userMatch: parsed.user_match,
    callerId,
    address,
    status,
    terminateCause: parsed.terminate_cause?.trim() || undefined,
    excludeZeroTraffic: parsed.exclude_zero_traffic,
    minTotalBytes: parsed.min_total_bytes,
    minDownloadBytes: parsed.min_download_bytes,
    minUploadBytes: parsed.min_upload_bytes,
    minDurationSeconds: parsed.min_duration_seconds,
    maxDurationSeconds: parsed.max_duration_seconds,
    includeDailyBreakdown: parsed.include_daily_breakdown,
    includeSessions: parsed.include_sessions,
    includeInactiveUsers: parsed.include_inactive_users,
    sortUsersBy: parsed.sort_users_by,
    sortSessionsBy: parsed.sort_sessions_by,
    sessionLimit: parsed.session_limit,
    sessionOffset: parsed.session_offset,
  };
}

/**
 * Build the single-round-trip RouterOS command that reads:
 *   - `/system clock get`
 *   - `/user-manager user` and filtered `/user-manager session` (when User Manager is installed)
 *   - `/ppp active where service=ovpn` joined with dynamic `<ovpn-*>` interface stats
 *   - `/ppp secret where service=ovpn or service=any`
 *   - `/interface ovpn-server server`
 */
export function buildOpenVpnAnalyticsCommand(query: NormalizedOpenVpnQuery): string {
  const whereParts: string[] = [];
  let preScript = ':local cutStr ""; ';
  let parseArgs = "";

  if (query.from) {
    whereParts.push(`started>=${routerOsStringLiteral(query.from)}`);
  } else if (!query.allTime && query.days !== undefined) {
    const lookbackDays = Math.max(0, query.days - 1);
    preScript +=
      ":local nowLocal ([:timestamp] + [:totime ((([/system clock get gmt-offset] + 2147483648) % 4294967296) - 2147483648)]); " +
      `:local cutDate [:pick [:serialize to=json options=json.no-string-conversion value=($nowLocal - ${lookbackDays}d)] 1 11]; ` +
      ':set cutStr ($cutDate . " 00:00:00"); ';
    whereParts.push("(started>=$cutStr or active=yes)");
    parseArgs = " cutStr=$cutStr";
  }

  if (query.to) {
    whereParts.push(`started<=${routerOsStringLiteral(query.to)}`);
  }

  if (query.users.length > 0 && query.userMatch === "exact") {
    const userClauses = query.users.map((u) => `user=${routerOsStringLiteral(u)}`);
    whereParts.push(userClauses.length === 1 ? userClauses[0]! : `(${userClauses.join(" or ")})`);
  }

  if (query.status === "active") {
    whereParts.push("active=yes");
  } else if (query.status === "closed") {
    whereParts.push("active=no");
  }

  const whereSql = whereParts.length > 0 ? ` where ${whereParts.join(" and ")}` : "";
  const umSessionCmd = `:return [/user-manager session print as-value proplist=user,acct-session-id,calling-station-id,user-address,started,ended,uptime,download,upload,active,terminate-cause,status,nas-port-type,nas-ip-address,nas-identifier,last-accounting-packet${whereSql}]`;
  const umUserCmd =
    ":return [/user-manager user print as-value proplist=name,group,disabled,comment]";

  return [
    `{ ${preScript}:local umSessions [:toarray ""]; :local umUsers [:toarray ""]; :local hasUm false; `,
    `:do { :local f [:parse ${routerOsStringLiteral(umSessionCmd)}]; :set umSessions [$f${parseArgs}]; `,
    `:local fu [:parse ${routerOsStringLiteral(umUserCmd)}]; :set umUsers [$fu]; :set hasUm true } on-error={}; `,
    ":local stats [/interface print stats as-value where dynamic=yes]; ",
    ':local activeRows [:toarray ""]; ',
    ":foreach row in=[/ppp active print detail as-value where service=ovpn] do={ ",
    ':local target ("<ovpn-" . ($row->"name") . ">"); ',
    ':foreach iface in=$stats do={ :if (($iface->"name") = $target) do={ ',
    ':set ($row->"rx-byte") ($iface->"rx-byte"); :set ($row->"tx-byte") ($iface->"tx-byte") } }; ',
    ':set ($row->"uptime") [:tostr ($row->"uptime")]; ',
    ':set ($row->"session-id") [:tostr ($row->"session-id")]; ',
    ":set ($activeRows->[:len $activeRows]) $row }; ",
    ":put [:serialize to=json options=json.no-string-conversion value={",
    '"clock"=[/system clock get];',
    '"cutStr"=$cutStr;',
    '"hasUserManager"=$hasUm;',
    '"umUsers"=$umUsers;',
    '"umSessions"=$umSessions;',
    '"pppActive"=$activeRows;',
    '"pppSecrets"=[/ppp secret print as-value proplist=name,service,profile,remote-address,disabled,comment,last-logged-out,last-caller-id,last-disconnect-reason where service=ovpn or service=any];',
    '"ovpnServers"=[/interface ovpn-server server print as-value]',
    "}] }",
  ].join("");
}

/**
 * Parse a RouterOS `/user-manager session` uptime value into seconds.
 *
 * Notice that RouterOS `:serialize to=json options=json.no-string-conversion`
 * serializes durations `< 1d` as `"HH:MM:SS"` and durations `>= 1d` as epoch-based
 * date strings `"1970-01-02 03:04:05"` (where `1970-01-01 00:00:00` is 0s).
 */
export function parseAccountingUptimeSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = openVpnUptime(trimmed);
  if (direct !== null) return direct;
  const epochMatch = /^1970-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (epochMatch) {
    const ms = Date.UTC(
      1970,
      Number(epochMatch[1]) - 1,
      Number(epochMatch[2]),
      Number(epochMatch[3]),
      Number(epochMatch[4]),
      Number(epochMatch[5]),
    );
    return ms >= 0 ? Math.floor(ms / 1000) : null;
  }
  return null;
}

/**
 * Convert a `/ppp active` `session-id` (e.g. `"2168457740"` or `"0x81400a0c"`)
 * into a lowercase 8-character hex string matching User Manager's `acct-session-id`
 * (`"81400a0c"`).
 */
export function normalizeSessionHexId(value: unknown): string {
  const s = (typeof value === "string" || typeof value === "number" ? String(value) : "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  if (/^0x[0-9a-f]+$/.test(s)) return s.slice(2);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n >= 0) return (n >>> 0).toString(16).toLowerCase();
  }
  return s;
}

/** Format a local timestamp (`YYYY-MM-DD HH:MM:SS`) from epoch milliseconds and a GMT offset in seconds. */
export function formatRouterLocalTime(epochMs: number, gmtOffsetSeconds = 0): string {
  const d = new Date(epochMs + gmtOffsetSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Parse a router local timestamp (`YYYY-MM-DD HH:MM:SS`) into pseudo-UTC epoch ms for duration math. */
export function parseRouterLocalTimeMs(timestamp: string | undefined | null): number | null {
  if (!timestamp) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(timestamp.trim());
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

export interface OpenVpnGeoInfo {
  country?: string;
  countryCode?: string;
  asn?: string;
  organization?: string;
}

export interface LocalHistoryFallbackRow {
  id: string;
  user: string;
  ip: string;
  tunnel: string;
  started: number;
  ended: number | null;
  uptime: number | null;
  country: string;
  countryCode: string;
  asn: string;
  organization: string;
}

export interface RawRouterOpenVpnPayload {
  clock?: {
    date?: string;
    time?: string;
    "gmt-offset"?: number | string;
    "time-zone-name"?: string;
  };
  cutStr?: string;
  hasUserManager?: boolean;
  umUsers?: Array<Record<string, unknown>>;
  umSessions?: Array<Record<string, unknown>>;
  pppActive?: Array<Record<string, unknown>>;
  pppSecrets?: Array<Record<string, unknown>>;
  ovpnServers?: Array<Record<string, unknown>>;
}

export interface OpenVpnAnalyzedSession {
  id: string;
  sessionId: string;
  user: string;
  callerId: string;
  address: string;
  started: string;
  ended: string | null;
  day: string;
  active: boolean;
  durationSeconds: number;
  durationFormatted: string;
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  downloadHuman: string;
  uploadHuman: string;
  totalHuman: string;
  terminateCause: string | null;
  status: string[];
  source: "user-manager" | "user-manager+live" | "ppp-active" | "local-history";
  encoding?: string;
  geo?: OpenVpnGeoInfo;
}

export interface OpenVpnDailyBreakdownRow {
  day: string;
  connections: number;
  nonZeroTrafficConnections: number;
  zeroTrafficConnections: number;
  activeConnections: number;
  uniqueUsers: number;
  users?: string[];
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  downloadHuman: string;
  uploadHuman: string;
  totalHuman: string;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  averageDurationSeconds: number;
  averageDurationFormatted: string;
  maxSessionBytes: number;
  maxSessionHuman: string;
}

export interface OpenVpnUserDailyRow {
  day: string;
  connections: number;
  nonZeroTrafficConnections: number;
  zeroTrafficConnections: number;
  activeConnections: number;
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  downloadHuman: string;
  uploadHuman: string;
  totalHuman: string;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  averageDurationSeconds: number;
  averageDurationFormatted: string;
  maxSessionBytes: number;
  maxSessionHuman: string;
  callerIds: string[];
  tunnelAddresses: string[];
}

export interface OpenVpnUserSummary {
  user: string;
  configuredIn: ("user-manager" | "ppp-secret")[];
  disabled: boolean;
  comment?: string;
  connections: number;
  nonZeroTrafficConnections: number;
  zeroTrafficConnections: number;
  activeSessions: number;
  distinctDaysConnected: number;
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  downloadHuman: string;
  uploadHuman: string;
  totalHuman: string;
  trafficSharePercent: number;
  averageBytesPerConnection: number;
  averageBytesPerConnectionHuman: string;
  averageBytesPerNonZeroConnection: number;
  averageBytesPerNonZeroConnectionHuman: string;
  maxSessionBytes: number;
  maxSessionHuman: string;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  averageDurationSeconds: number;
  averageDurationFormatted: string;
  maxDurationSeconds: number;
  maxDurationFormatted: string;
  firstConnectedAt: string | null;
  lastConnectedAt: string | null;
  lastEndedAt: string | null;
  uniqueCallerIds: number;
  callerIds: string[];
  tunnelAddresses: string[];
  terminateCauses: Record<string, number>;
  dailyBreakdown?: OpenVpnUserDailyRow[];
}

export interface OpenVpnUsageReport {
  device: string;
  routerClock: {
    now: string;
    timeZone?: string;
    gmtOffsetSeconds: number;
  };
  dataSources: {
    userManagerAvailable: boolean;
    livePppActive: boolean;
    localHistoryUsed: boolean;
    primaryAccountingSource: "user-manager" | "local-history" | "live-only";
    notes: string[];
  };
  window: {
    from: string | null;
    to: string | null;
    days?: number;
    allTime: boolean;
  };
  filtersApplied: {
    users: string[];
    userMatch: "exact" | "contains";
    callerId?: string;
    address?: string;
    status: "all" | "active" | "closed";
    terminateCause?: string;
    excludeZeroTraffic: boolean;
    minTotalBytes?: number;
    minDownloadBytes?: number;
    minUploadBytes?: number;
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
  };
  summary: {
    totalConnections: number;
    nonZeroTrafficConnections: number;
    zeroTrafficConnections: number;
    activeConnections: number;
    closedConnections: number;
    uniqueUsersConnected: number;
    configuredUsersCount: number;
    distinctDaysWithActivity: number;
    uniqueCallerIds: number;
    uniqueTunnelAddresses: number;
    downloadBytes: number;
    uploadBytes: number;
    totalBytes: number;
    downloadHuman: string;
    uploadHuman: string;
    totalHuman: string;
    averageBytesPerConnection: number;
    averageBytesPerConnectionHuman: string;
    averageBytesPerNonZeroConnection: number;
    averageBytesPerNonZeroConnectionHuman: string;
    maxSessionBytes: number;
    maxSessionHuman: string;
    totalDurationSeconds: number;
    totalDurationFormatted: string;
    averageDurationSeconds: number;
    averageDurationFormatted: string;
    maxDurationSeconds: number;
    maxDurationFormatted: string;
    firstSessionStartedAt: string | null;
    lastSessionStartedAt: string | null;
    terminateCauses: Record<string, number>;
  };
  users: OpenVpnUserSummary[];
  dailyTotals?: OpenVpnDailyBreakdownRow[];
  sessions?: {
    totalMatching: number;
    returned: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    items: OpenVpnAnalyzedSession[];
  };
}

/** Extract the JSON object line from RouterOS `:put [:serialize to=json ...]` output. */
export function parseRouterOpenVpnPayload(output: string): RawRouterOpenVpnPayload {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/);
  const jsonLine = lines.find((l) => l.trim().startsWith("{") && l.trim().endsWith("}"));
  const candidate = jsonLine ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Unexpected non-object payload.");
    }
    return parsed as RawRouterOpenVpnPayload;
  } catch (e) {
    throw new Error(
      `Failed to parse OpenVPN analytics JSON from RouterOS: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function safeBytes(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return 0;
}

function normalizeStatusList(status: unknown): string[] {
  if (Array.isArray(status)) return status.map((s) => String(s)).filter(Boolean);
  if (typeof status === "string" && status.trim()) {
    return status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Pure aggregation engine: merges RouterOS User Manager accounting rows, live
 * `/ppp active` OpenVPN sessions, optional local history rows, and GeoIP metadata,
 * applies all granular filters, and computes exact per-session, per-user-per-day,
 * per-user total, and all-users aggregate statistics.
 */
export function computeOpenVpnUsageReport(
  device: string,
  payload: RawRouterOpenVpnPayload,
  query: NormalizedOpenVpnQuery,
  options: {
    geoByIp?: Map<string, OpenVpnGeoInfo>;
    localHistoryRows?: LocalHistoryFallbackRow[];
  } = {},
): OpenVpnUsageReport {
  const clockDate = typeof payload.clock?.date === "string" ? payload.clock.date : "";
  const clockTime = typeof payload.clock?.time === "string" ? payload.clock.time : "00:00:00";
  const routerNow =
    clockDate && /^\d{4}-\d{2}-\d{2}$/.test(clockDate)
      ? `${clockDate} ${clockTime}`
      : new Date().toISOString().replace("T", " ").slice(0, 19);
  const rawGmt = Number(payload.clock?.["gmt-offset"] ?? 0);
  const gmtOffsetSeconds = Number.isFinite(rawGmt)
    ? ((rawGmt + 2147483648) % 4294967296) - 2147483648
    : 0;
  const routerNowMs = parseRouterLocalTimeMs(routerNow) ?? Date.now();

  const effectiveFrom =
    query.from ??
    (typeof payload.cutStr === "string" && payload.cutStr.trim()
      ? payload.cutStr.trim()
      : !query.allTime && query.days !== undefined
        ? `${formatRouterLocalTime(routerNowMs - Math.max(0, query.days - 1) * 86_400_000, 0).slice(0, 10)} 00:00:00`
        : null);
  const effectiveTo = query.to ?? null;

  const hasUserManager = payload.hasUserManager === true;
  const umSessions = Array.isArray(payload.umSessions) ? payload.umSessions : [];
  const pppActive = Array.isArray(payload.pppActive) ? payload.pppActive : [];
  const umUsers = Array.isArray(payload.umUsers) ? payload.umUsers : [];
  const pppSecrets = Array.isArray(payload.pppSecrets) ? payload.pppSecrets : [];
  const geoByIp = options.geoByIp ?? new Map<string, OpenVpnGeoInfo>();

  // Index configured accounts from both User Manager and PPP secrets.
  const configuredAccounts = new Map<
    string,
    {
      sources: Set<"user-manager" | "ppp-secret">;
      disabled: boolean;
      comment?: string;
    }
  >();
  for (const u of umUsers) {
    const name = str(u.name);
    if (!name) continue;
    const entry = configuredAccounts.get(name) ?? {
      sources: new Set(),
      disabled: false,
    };
    entry.sources.add("user-manager");
    entry.disabled = u.disabled === true || u.disabled === "yes" || u.disabled === "true";
    if (typeof u.comment === "string" && u.comment.trim()) entry.comment = u.comment.trim();
    configuredAccounts.set(name, entry);
  }
  for (const s of pppSecrets) {
    const name = str(s.name);
    if (!name) continue;
    const entry = configuredAccounts.get(name) ?? {
      sources: new Set(),
      disabled: false,
    };
    entry.sources.add("ppp-secret");
    if (!entry.sources.has("user-manager")) {
      entry.disabled = s.disabled === true || s.disabled === "yes" || s.disabled === "true";
    }
    if (!entry.comment && typeof s.comment === "string" && s.comment.trim()) {
      entry.comment = s.comment.trim();
    }
    configuredAccounts.set(name, entry);
  }

  // Index live `/ppp active` OpenVPN sessions for merging and live-counter enrichment.
  const liveByHexId = new Map<string, Record<string, unknown>>();
  const liveByUserAndTuple = new Map<string, Record<string, unknown>>();
  const liveNameCounts = new Map<string, number>();
  for (const row of pppActive) {
    const name = str(row.name);
    if (!name) continue;
    liveNameCounts.set(name, (liveNameCounts.get(name) ?? 0) + 1);
  }
  for (const row of pppActive) {
    const hexId = normalizeSessionHexId(row["session-id"]);
    if (hexId) liveByHexId.set(hexId, row);
    const name = str(row.name);
    const caller = str(row["caller-id"]);
    const addr = str(row.address);
    if (name) liveByUserAndTuple.set(`${name}|${caller}|${addr}`, row);
  }
  const matchedLiveKeys = new Set<Record<string, unknown>>();

  const allSessions: OpenVpnAnalyzedSession[] = [];

  if (hasUserManager) {
    for (const raw of umSessions) {
      const user = str(raw.user);
      if (!user) continue;
      const id = str(raw[".id"]);
      const acctSessionId = str(raw["acct-session-id"]);
      const hexId = normalizeSessionHexId(acctSessionId);
      const callerId = str(raw["calling-station-id"]);
      const address = str(raw["user-address"]);
      const started = str(raw.started);
      if (!started) continue;
      const ended = typeof raw.ended === "string" && raw.ended.trim() ? raw.ended.trim() : null;
      const isUmActive = raw.active === true || raw.active === "yes" || raw.active === "true";

      const liveMatch =
        (hexId ? liveByHexId.get(hexId) : undefined) ??
        (isUmActive ? liveByUserAndTuple.get(`${user}|${callerId}|${address}`) : undefined);

      let downloadBytes = safeBytes(raw.download);
      let uploadBytes = safeBytes(raw.upload);
      let durationSeconds = parseAccountingUptimeSeconds(raw.uptime) ?? 0;
      let source: OpenVpnAnalyzedSession["source"] = "user-manager";
      let encoding: string | undefined;

      if (liveMatch) {
        matchedLiveKeys.add(liveMatch);
        source = "user-manager+live";
        if (typeof liveMatch.encoding === "string" && liveMatch.encoding.trim()) {
          encoding = liveMatch.encoding.trim();
        }
        const liveUptime = openVpnUptime(str(liveMatch.uptime));
        if (liveUptime !== null && liveUptime > durationSeconds) {
          durationSeconds = liveUptime;
        }
        // Only trust `<ovpn-user>` interface byte counters when the user has 1 concurrent session
        // and the live counter is >= User Manager's last interim accounting packet.
        if ((liveNameCounts.get(user) ?? 0) === 1) {
          const [liveDl, liveUl] = openVpnClientBytes(liveMatch["tx-byte"], liveMatch["rx-byte"]);
          if (liveDl !== null && liveDl > downloadBytes) downloadBytes = liveDl;
          if (liveUl !== null && liveUl > uploadBytes) uploadBytes = liveUl;
        }
      } else if (!durationSeconds && started && ended) {
        const sMs = parseRouterLocalTimeMs(started);
        const eMs = parseRouterLocalTimeMs(ended);
        if (sMs !== null && eMs !== null && eMs >= sMs) {
          durationSeconds = Math.floor((eMs - sMs) / 1000);
        }
      }

      const active = isUmActive || Boolean(liveMatch);
      const totalBytes = downloadBytes + uploadBytes;
      const terminateCause =
        typeof raw["terminate-cause"] === "string" && raw["terminate-cause"].trim()
          ? raw["terminate-cause"].trim()
          : null;
      const status = normalizeStatusList(raw.status);
      const geo = callerId ? geoByIp.get(callerId) : undefined;

      allSessions.push({
        id: id || acctSessionId || `${user}:${started}`,
        sessionId: acctSessionId || hexId,
        user,
        callerId,
        address,
        started,
        ended: active ? null : ended,
        day: started.slice(0, 10),
        active,
        durationSeconds,
        durationFormatted: connectionDuration(durationSeconds),
        downloadBytes,
        uploadBytes,
        totalBytes,
        downloadHuman: humanBytes(downloadBytes),
        uploadHuman: humanBytes(uploadBytes),
        totalHuman: humanBytes(totalBytes),
        terminateCause: active ? null : terminateCause,
        status,
        source,
        ...(encoding ? { encoding } : {}),
        ...(geo ? { geo } : {}),
      });
    }
  } else if (options.localHistoryRows && options.localHistoryRows.length > 0) {
    for (const row of options.localHistoryRows) {
      const started = formatRouterLocalTime(row.started, gmtOffsetSeconds);
      const ended = row.ended !== null ? formatRouterLocalTime(row.ended, gmtOffsetSeconds) : null;
      const active = row.ended === null;
      const durationSeconds =
        row.uptime !== null && row.uptime >= 0
          ? row.uptime
          : row.ended !== null && row.ended >= row.started
            ? Math.floor((row.ended - row.started) / 1000)
            : 0;
      const geo: OpenVpnGeoInfo | undefined =
        row.country || row.countryCode || row.asn || row.organization
          ? {
              ...(row.country ? { country: row.country } : {}),
              ...(row.countryCode ? { countryCode: row.countryCode } : {}),
              ...(row.asn ? { asn: row.asn } : {}),
              ...(row.organization ? { organization: row.organization } : {}),
            }
          : geoByIp.get(row.ip);

      allSessions.push({
        id: row.id,
        sessionId: row.id,
        user: row.user,
        callerId: row.ip,
        address: row.tunnel,
        started,
        ended,
        day: started.slice(0, 10),
        active,
        durationSeconds,
        durationFormatted: connectionDuration(durationSeconds),
        downloadBytes: 0,
        uploadBytes: 0,
        totalBytes: 0,
        downloadHuman: humanBytes(0),
        uploadHuman: humanBytes(0),
        totalHuman: humanBytes(0),
        terminateCause: null,
        status: active ? ["start"] : ["start", "stop"],
        source: "local-history",
        ...(geo ? { geo } : {}),
      });
    }
  }

  // Add any live `/ppp active` OpenVPN sessions that were not already represented in User Manager.
  for (const live of pppActive) {
    if (matchedLiveKeys.has(live)) continue;
    const user = str(live.name);
    if (!user) continue;
    const id = str(live[".id"]);
    const rawSessionId = str(live["session-id"]);
    const hexId = normalizeSessionHexId(rawSessionId);
    const callerId = str(live["caller-id"]);
    const address = str(live.address);
    const durationSeconds = openVpnUptime(str(live.uptime)) ?? 0;
    const startedMs = routerNowMs - durationSeconds * 1000;
    const started = formatRouterLocalTime(startedMs, 0);
    const [liveDl, liveUl] =
      (liveNameCounts.get(user) ?? 0) === 1
        ? openVpnClientBytes(live["tx-byte"], live["rx-byte"])
        : [null, null];
    const downloadBytes = liveDl ?? 0;
    const uploadBytes = liveUl ?? 0;
    const totalBytes = downloadBytes + uploadBytes;
    const encoding =
      typeof live.encoding === "string" && live.encoding.trim() ? live.encoding.trim() : undefined;
    const geo = callerId ? geoByIp.get(callerId) : undefined;

    allSessions.push({
      id: id || hexId || `${user}:${started}`,
      sessionId: hexId || rawSessionId,
      user,
      callerId,
      address,
      started,
      ended: null,
      day: started.slice(0, 10),
      active: true,
      durationSeconds,
      durationFormatted: connectionDuration(durationSeconds),
      downloadBytes,
      uploadBytes,
      totalBytes,
      downloadHuman: humanBytes(downloadBytes),
      uploadHuman: humanBytes(uploadBytes),
      totalHuman: humanBytes(totalBytes),
      terminateCause: null,
      status: ["active"],
      source: "ppp-active",
      ...(encoding ? { encoding } : {}),
      ...(geo ? { geo } : {}),
    });
  }

  // Apply granular filters in TypeScript so User Manager, live PPP, and local history
  // all honor the exact same semantics.
  const lowerUsers = query.users.map((u) => u.toLowerCase());
  const lowerCaller = query.callerId?.toLowerCase();
  const lowerAddress = query.address?.toLowerCase();
  const lowerCause = query.terminateCause?.toLowerCase();

  let zeroTrafficDroppedByExclude = 0;

  const filteredSessions = allSessions.filter((s) => {
    if (effectiveFrom && s.started < effectiveFrom && !s.active) return false;
    // If an explicit `from` was requested, even active sessions must have started >= from
    // unless `from` was derived from `days` and the session is still active.
    if (query.from && s.started < query.from) return false;
    if (effectiveTo && s.started > effectiveTo) return false;

    if (lowerUsers.length > 0) {
      const u = s.user.toLowerCase();
      const matched =
        query.userMatch === "contains"
          ? lowerUsers.some((needle) => u.includes(needle))
          : lowerUsers.includes(u);
      if (!matched) return false;
    }

    if (lowerCaller) {
      const c = s.callerId.toLowerCase();
      if (c !== lowerCaller && !c.includes(lowerCaller)) return false;
    }

    if (lowerAddress) {
      const a = s.address.toLowerCase();
      if (a !== lowerAddress && !a.includes(lowerAddress)) return false;
    }

    if (query.status === "active" && !s.active) return false;
    if (query.status === "closed" && s.active) return false;

    if (lowerCause) {
      const tc = (s.terminateCause ?? (s.active ? "active" : "unknown")).toLowerCase();
      if (tc !== lowerCause && !tc.includes(lowerCause)) return false;
    }

    if (query.minTotalBytes !== undefined && s.totalBytes < query.minTotalBytes) return false;
    if (query.minDownloadBytes !== undefined && s.downloadBytes < query.minDownloadBytes)
      return false;
    if (query.minUploadBytes !== undefined && s.uploadBytes < query.minUploadBytes) return false;
    if (query.minDurationSeconds !== undefined && s.durationSeconds < query.minDurationSeconds)
      return false;
    if (query.maxDurationSeconds !== undefined && s.durationSeconds > query.maxDurationSeconds)
      return false;

    if (query.excludeZeroTraffic && s.totalBytes === 0 && !s.active) {
      zeroTrafficDroppedByExclude++;
      return false;
    }

    return true;
  });

  // Global summary metrics
  let totalDownloadBytes = 0;
  let totalUploadBytes = 0;
  let totalDurationSeconds = 0;
  let maxSessionBytes = 0;
  let maxDurationSeconds = 0;
  let nonZeroTrafficConnections = 0;
  let zeroTrafficConnections = 0;
  let activeConnections = 0;
  let closedConnections = 0;
  let firstSessionStartedAt: string | null = null;
  let lastSessionStartedAt: string | null = null;

  const globalUsers = new Set<string>();
  const globalDays = new Set<string>();
  const globalCallers = new Set<string>();
  const globalAddresses = new Set<string>();
  const globalCauses: Record<string, number> = {};

  // Per-user accumulator
  interface UserAcc {
    user: string;
    connections: number;
    nonZeroTrafficConnections: number;
    zeroTrafficConnections: number;
    activeSessions: number;
    days: Set<string>;
    downloadBytes: number;
    uploadBytes: number;
    totalBytes: number;
    maxSessionBytes: number;
    totalDurationSeconds: number;
    maxDurationSeconds: number;
    firstConnectedAt: string | null;
    lastConnectedAt: string | null;
    lastEndedAt: string | null;
    callerIds: Map<string, number>;
    tunnelAddresses: Map<string, number>;
    terminateCauses: Record<string, number>;
    daily: Map<
      string,
      {
        day: string;
        connections: number;
        nonZeroTrafficConnections: number;
        zeroTrafficConnections: number;
        activeConnections: number;
        downloadBytes: number;
        uploadBytes: number;
        totalBytes: number;
        totalDurationSeconds: number;
        maxSessionBytes: number;
        callerIds: Set<string>;
        tunnelAddresses: Set<string>;
      }
    >;
  }

  const userAccMap = new Map<string, UserAcc>();
  const globalDailyMap = new Map<
    string,
    {
      day: string;
      connections: number;
      nonZeroTrafficConnections: number;
      zeroTrafficConnections: number;
      activeConnections: number;
      users: Set<string>;
      downloadBytes: number;
      uploadBytes: number;
      totalBytes: number;
      totalDurationSeconds: number;
      maxSessionBytes: number;
    }
  >();

  const ensureUserAcc = (user: string): UserAcc => {
    let acc = userAccMap.get(user);
    if (!acc) {
      acc = {
        user,
        connections: 0,
        nonZeroTrafficConnections: 0,
        zeroTrafficConnections: 0,
        activeSessions: 0,
        days: new Set(),
        downloadBytes: 0,
        uploadBytes: 0,
        totalBytes: 0,
        maxSessionBytes: 0,
        totalDurationSeconds: 0,
        maxDurationSeconds: 0,
        firstConnectedAt: null,
        lastConnectedAt: null,
        lastEndedAt: null,
        callerIds: new Map(),
        tunnelAddresses: new Map(),
        terminateCauses: {},
        daily: new Map(),
      };
      userAccMap.set(user, acc);
    }
    return acc;
  };

  if (query.includeInactiveUsers && lowerUsers.length === 0) {
    for (const username of configuredAccounts.keys()) {
      ensureUserAcc(username);
    }
  }

  for (const s of filteredSessions) {
    totalDownloadBytes += s.downloadBytes;
    totalUploadBytes += s.uploadBytes;
    totalDurationSeconds += s.durationSeconds;
    if (s.totalBytes > maxSessionBytes) maxSessionBytes = s.totalBytes;
    if (s.durationSeconds > maxDurationSeconds) maxDurationSeconds = s.durationSeconds;
    if (s.totalBytes > 0) nonZeroTrafficConnections++;
    else zeroTrafficConnections++;
    if (s.active) activeConnections++;
    else closedConnections++;

    if (!firstSessionStartedAt || s.started < firstSessionStartedAt)
      firstSessionStartedAt = s.started;
    if (!lastSessionStartedAt || s.started > lastSessionStartedAt) lastSessionStartedAt = s.started;

    globalUsers.add(s.user);
    if (s.day) globalDays.add(s.day);
    if (s.callerId) globalCallers.add(s.callerId);
    if (s.address) globalAddresses.add(s.address);

    const causeKey = s.active ? "active" : s.terminateCause || "unknown";
    globalCauses[causeKey] = (globalCauses[causeKey] ?? 0) + 1;

    // Global daily accumulator
    let gDay = globalDailyMap.get(s.day);
    if (!gDay) {
      gDay = {
        day: s.day,
        connections: 0,
        nonZeroTrafficConnections: 0,
        zeroTrafficConnections: 0,
        activeConnections: 0,
        users: new Set(),
        downloadBytes: 0,
        uploadBytes: 0,
        totalBytes: 0,
        totalDurationSeconds: 0,
        maxSessionBytes: 0,
      };
      globalDailyMap.set(s.day, gDay);
    }
    gDay.connections++;
    if (s.totalBytes > 0) gDay.nonZeroTrafficConnections++;
    else gDay.zeroTrafficConnections++;
    if (s.active) gDay.activeConnections++;
    gDay.users.add(s.user);
    gDay.downloadBytes += s.downloadBytes;
    gDay.uploadBytes += s.uploadBytes;
    gDay.totalBytes += s.totalBytes;
    gDay.totalDurationSeconds += s.durationSeconds;
    if (s.totalBytes > gDay.maxSessionBytes) gDay.maxSessionBytes = s.totalBytes;

    // Per-user accumulator
    const uAcc = ensureUserAcc(s.user);
    uAcc.connections++;
    if (s.totalBytes > 0) uAcc.nonZeroTrafficConnections++;
    else uAcc.zeroTrafficConnections++;
    if (s.active) uAcc.activeSessions++;
    if (s.day) uAcc.days.add(s.day);
    uAcc.downloadBytes += s.downloadBytes;
    uAcc.uploadBytes += s.uploadBytes;
    uAcc.totalBytes += s.totalBytes;
    if (s.totalBytes > uAcc.maxSessionBytes) uAcc.maxSessionBytes = s.totalBytes;
    uAcc.totalDurationSeconds += s.durationSeconds;
    if (s.durationSeconds > uAcc.maxDurationSeconds) uAcc.maxDurationSeconds = s.durationSeconds;
    if (!uAcc.firstConnectedAt || s.started < uAcc.firstConnectedAt)
      uAcc.firstConnectedAt = s.started;
    if (!uAcc.lastConnectedAt || s.started > uAcc.lastConnectedAt) uAcc.lastConnectedAt = s.started;
    if (s.ended && (!uAcc.lastEndedAt || s.ended > uAcc.lastEndedAt)) uAcc.lastEndedAt = s.ended;
    if (s.callerId) uAcc.callerIds.set(s.callerId, (uAcc.callerIds.get(s.callerId) ?? 0) + 1);
    if (s.address)
      uAcc.tunnelAddresses.set(s.address, (uAcc.tunnelAddresses.get(s.address) ?? 0) + 1);
    uAcc.terminateCauses[causeKey] = (uAcc.terminateCauses[causeKey] ?? 0) + 1;

    // Per-user daily accumulator
    let uDay = uAcc.daily.get(s.day);
    if (!uDay) {
      uDay = {
        day: s.day,
        connections: 0,
        nonZeroTrafficConnections: 0,
        zeroTrafficConnections: 0,
        activeConnections: 0,
        downloadBytes: 0,
        uploadBytes: 0,
        totalBytes: 0,
        totalDurationSeconds: 0,
        maxSessionBytes: 0,
        callerIds: new Set(),
        tunnelAddresses: new Set(),
      };
      uAcc.daily.set(s.day, uDay);
    }
    uDay.connections++;
    if (s.totalBytes > 0) uDay.nonZeroTrafficConnections++;
    else uDay.zeroTrafficConnections++;
    if (s.active) uDay.activeConnections++;
    uDay.downloadBytes += s.downloadBytes;
    uDay.uploadBytes += s.uploadBytes;
    uDay.totalBytes += s.totalBytes;
    uDay.totalDurationSeconds += s.durationSeconds;
    if (s.totalBytes > uDay.maxSessionBytes) uDay.maxSessionBytes = s.totalBytes;
    if (s.callerId) uDay.callerIds.add(s.callerId);
    if (s.address) uDay.tunnelAddresses.add(s.address);
  }

  const grandTotalBytes = totalDownloadBytes + totalUploadBytes;
  const totalConnections = filteredSessions.length;
  const avgBytesPerConn = totalConnections > 0 ? Math.round(grandTotalBytes / totalConnections) : 0;
  const avgBytesPerNonZero =
    nonZeroTrafficConnections > 0 ? Math.round(grandTotalBytes / nonZeroTrafficConnections) : 0;
  const avgDurationSeconds =
    totalConnections > 0 ? Math.round(totalDurationSeconds / totalConnections) : 0;

  // Build per-user summary list
  const usersList: OpenVpnUserSummary[] = [...userAccMap.values()].map((uAcc) => {
    const cfg = configuredAccounts.get(uAcc.user);
    const avgUserBytes = uAcc.connections > 0 ? Math.round(uAcc.totalBytes / uAcc.connections) : 0;
    const avgUserNonZeroBytes =
      uAcc.nonZeroTrafficConnections > 0
        ? Math.round(uAcc.totalBytes / uAcc.nonZeroTrafficConnections)
        : 0;
    const avgUserDuration =
      uAcc.connections > 0 ? Math.round(uAcc.totalDurationSeconds / uAcc.connections) : 0;
    const sharePct =
      grandTotalBytes > 0 ? Math.round((uAcc.totalBytes / grandTotalBytes) * 10000) / 100 : 0;

    const sortedCallers = [...uAcc.callerIds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ip]) => ip);
    const sortedTunnels = [...uAcc.tunnelAddresses.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ip]) => ip);

    const dailyBreakdown: OpenVpnUserDailyRow[] | undefined = query.includeDailyBreakdown
      ? [...uAcc.daily.values()]
          .sort((a, b) => b.day.localeCompare(a.day))
          .map((d) => {
            const avgDayDur =
              d.connections > 0 ? Math.round(d.totalDurationSeconds / d.connections) : 0;
            return {
              day: d.day,
              connections: d.connections,
              nonZeroTrafficConnections: d.nonZeroTrafficConnections,
              zeroTrafficConnections: d.zeroTrafficConnections,
              activeConnections: d.activeConnections,
              downloadBytes: d.downloadBytes,
              uploadBytes: d.uploadBytes,
              totalBytes: d.totalBytes,
              downloadHuman: humanBytes(d.downloadBytes),
              uploadHuman: humanBytes(d.uploadBytes),
              totalHuman: humanBytes(d.totalBytes),
              totalDurationSeconds: d.totalDurationSeconds,
              totalDurationFormatted: connectionDuration(d.totalDurationSeconds),
              averageDurationSeconds: avgDayDur,
              averageDurationFormatted: connectionDuration(avgDayDur),
              maxSessionBytes: d.maxSessionBytes,
              maxSessionHuman: humanBytes(d.maxSessionBytes),
              callerIds: [...d.callerIds].sort(),
              tunnelAddresses: [...d.tunnelAddresses].sort(),
            };
          })
      : undefined;

    return {
      user: uAcc.user,
      configuredIn: cfg ? [...cfg.sources] : [],
      disabled: cfg?.disabled ?? false,
      ...(cfg?.comment ? { comment: cfg.comment } : {}),
      connections: uAcc.connections,
      nonZeroTrafficConnections: uAcc.nonZeroTrafficConnections,
      zeroTrafficConnections: uAcc.zeroTrafficConnections,
      activeSessions: uAcc.activeSessions,
      distinctDaysConnected: uAcc.days.size,
      downloadBytes: uAcc.downloadBytes,
      uploadBytes: uAcc.uploadBytes,
      totalBytes: uAcc.totalBytes,
      downloadHuman: humanBytes(uAcc.downloadBytes),
      uploadHuman: humanBytes(uAcc.uploadBytes),
      totalHuman: humanBytes(uAcc.totalBytes),
      trafficSharePercent: sharePct,
      averageBytesPerConnection: avgUserBytes,
      averageBytesPerConnectionHuman: humanBytes(avgUserBytes),
      averageBytesPerNonZeroConnection: avgUserNonZeroBytes,
      averageBytesPerNonZeroConnectionHuman: humanBytes(avgUserNonZeroBytes),
      maxSessionBytes: uAcc.maxSessionBytes,
      maxSessionHuman: humanBytes(uAcc.maxSessionBytes),
      totalDurationSeconds: uAcc.totalDurationSeconds,
      totalDurationFormatted: connectionDuration(uAcc.totalDurationSeconds),
      averageDurationSeconds: avgUserDuration,
      averageDurationFormatted: connectionDuration(avgUserDuration),
      maxDurationSeconds: uAcc.maxDurationSeconds,
      maxDurationFormatted: connectionDuration(uAcc.maxDurationSeconds),
      firstConnectedAt: uAcc.firstConnectedAt,
      lastConnectedAt: uAcc.lastConnectedAt,
      lastEndedAt: uAcc.lastEndedAt,
      uniqueCallerIds: sortedCallers.length,
      callerIds: sortedCallers,
      tunnelAddresses: sortedTunnels,
      terminateCauses: uAcc.terminateCauses,
      ...(dailyBreakdown ? { dailyBreakdown } : {}),
    };
  });

  usersList.sort((a, b) => {
    switch (query.sortUsersBy) {
      case "download_bytes":
        return b.downloadBytes - a.downloadBytes || a.user.localeCompare(b.user);
      case "upload_bytes":
        return b.uploadBytes - a.uploadBytes || a.user.localeCompare(b.user);
      case "connections":
        return (
          b.connections - a.connections ||
          b.totalBytes - a.totalBytes ||
          a.user.localeCompare(b.user)
        );
      case "duration":
        return (
          b.totalDurationSeconds - a.totalDurationSeconds ||
          b.totalBytes - a.totalBytes ||
          a.user.localeCompare(b.user)
        );
      case "user":
        return a.user.localeCompare(b.user);
      case "total_bytes":
      default:
        return (
          b.totalBytes - a.totalBytes ||
          b.connections - a.connections ||
          a.user.localeCompare(b.user)
        );
    }
  });

  const dailyTotals: OpenVpnDailyBreakdownRow[] | undefined = query.includeDailyBreakdown
    ? [...globalDailyMap.values()]
        .sort((a, b) => b.day.localeCompare(a.day))
        .map((d) => {
          const avgDayDur =
            d.connections > 0 ? Math.round(d.totalDurationSeconds / d.connections) : 0;
          return {
            day: d.day,
            connections: d.connections,
            nonZeroTrafficConnections: d.nonZeroTrafficConnections,
            zeroTrafficConnections: d.zeroTrafficConnections,
            activeConnections: d.activeConnections,
            uniqueUsers: d.users.size,
            users: [...d.users].sort(),
            downloadBytes: d.downloadBytes,
            uploadBytes: d.uploadBytes,
            totalBytes: d.totalBytes,
            downloadHuman: humanBytes(d.downloadBytes),
            uploadHuman: humanBytes(d.uploadBytes),
            totalHuman: humanBytes(d.totalBytes),
            totalDurationSeconds: d.totalDurationSeconds,
            totalDurationFormatted: connectionDuration(d.totalDurationSeconds),
            averageDurationSeconds: avgDayDur,
            averageDurationFormatted: connectionDuration(avgDayDur),
            maxSessionBytes: d.maxSessionBytes,
            maxSessionHuman: humanBytes(d.maxSessionBytes),
          };
        })
    : undefined;

  // Sort individual sessions
  const sortedSessions = [...filteredSessions].sort((a, b) => {
    switch (query.sortSessionsBy) {
      case "started_asc":
        return a.started.localeCompare(b.started) || a.id.localeCompare(b.id);
      case "total_bytes_desc":
        return b.totalBytes - a.totalBytes || b.started.localeCompare(a.started);
      case "download_desc":
        return b.downloadBytes - a.downloadBytes || b.started.localeCompare(a.started);
      case "upload_desc":
        return b.uploadBytes - a.uploadBytes || b.started.localeCompare(a.started);
      case "duration_desc":
        return b.durationSeconds - a.durationSeconds || b.started.localeCompare(a.started);
      case "started_desc":
      default:
        return b.started.localeCompare(a.started) || b.id.localeCompare(a.id);
    }
  });

  const pagedSessions = query.includeSessions
    ? sortedSessions.slice(query.sessionOffset, query.sessionOffset + query.sessionLimit)
    : [];

  const notes: string[] = [];
  if (hasUserManager) {
    notes.push(
      "Historical and active OpenVPN accounting records were read from RouterOS User Manager (`/user-manager session`) and merged with live `/ppp active` + `<ovpn-*>` interface byte counters.",
    );
  } else if (options.localHistoryRows && options.localHistoryRows.length > 0) {
    notes.push(
      "User Manager package is not installed on this router; historical session counts and durations were read from the MCP host's local `openvpn-history.db` (per-session historical byte counters require User Manager; live sessions show current `<ovpn-*>` bytes).",
    );
  } else {
    notes.push(
      "User Manager package is not installed on this router and no local history rows were found; reporting currently active `/ppp active` OpenVPN connections only.",
    );
  }
  if (zeroTrafficDroppedByExclude > 0) {
    notes.push(
      `Excluded ${zeroTrafficDroppedByExclude} zero-byte connection attempt(s) because exclude_zero_traffic=true.`,
    );
  }

  return {
    device,
    routerClock: {
      now: routerNow,
      ...(typeof payload.clock?.["time-zone-name"] === "string"
        ? { timeZone: payload.clock["time-zone-name"] }
        : {}),
      gmtOffsetSeconds,
    },
    dataSources: {
      userManagerAvailable: hasUserManager,
      livePppActive: true,
      localHistoryUsed: !hasUserManager && Boolean(options.localHistoryRows?.length),
      primaryAccountingSource: hasUserManager
        ? "user-manager"
        : options.localHistoryRows?.length
          ? "local-history"
          : "live-only",
      notes,
    },
    window: {
      from: effectiveFrom,
      to: effectiveTo,
      ...(query.days !== undefined ? { days: query.days } : {}),
      allTime: query.allTime,
    },
    filtersApplied: {
      users: query.users,
      userMatch: query.userMatch,
      ...(query.callerId ? { callerId: query.callerId } : {}),
      ...(query.address ? { address: query.address } : {}),
      status: query.status,
      ...(query.terminateCause ? { terminateCause: query.terminateCause } : {}),
      excludeZeroTraffic: query.excludeZeroTraffic,
      ...(query.minTotalBytes !== undefined ? { minTotalBytes: query.minTotalBytes } : {}),
      ...(query.minDownloadBytes !== undefined ? { minDownloadBytes: query.minDownloadBytes } : {}),
      ...(query.minUploadBytes !== undefined ? { minUploadBytes: query.minUploadBytes } : {}),
      ...(query.minDurationSeconds !== undefined
        ? { minDurationSeconds: query.minDurationSeconds }
        : {}),
      ...(query.maxDurationSeconds !== undefined
        ? { maxDurationSeconds: query.maxDurationSeconds }
        : {}),
    },
    summary: {
      totalConnections,
      nonZeroTrafficConnections,
      zeroTrafficConnections,
      activeConnections,
      closedConnections,
      uniqueUsersConnected: globalUsers.size,
      configuredUsersCount: configuredAccounts.size,
      distinctDaysWithActivity: globalDays.size,
      uniqueCallerIds: globalCallers.size,
      uniqueTunnelAddresses: globalAddresses.size,
      downloadBytes: totalDownloadBytes,
      uploadBytes: totalUploadBytes,
      totalBytes: grandTotalBytes,
      downloadHuman: humanBytes(totalDownloadBytes),
      uploadHuman: humanBytes(totalUploadBytes),
      totalHuman: humanBytes(grandTotalBytes),
      averageBytesPerConnection: avgBytesPerConn,
      averageBytesPerConnectionHuman: humanBytes(avgBytesPerConn),
      averageBytesPerNonZeroConnection: avgBytesPerNonZero,
      averageBytesPerNonZeroConnectionHuman: humanBytes(avgBytesPerNonZero),
      maxSessionBytes,
      maxSessionHuman: humanBytes(maxSessionBytes),
      totalDurationSeconds,
      totalDurationFormatted: connectionDuration(totalDurationSeconds),
      averageDurationSeconds: avgDurationSeconds,
      averageDurationFormatted: connectionDuration(avgDurationSeconds),
      maxDurationSeconds,
      maxDurationFormatted: connectionDuration(maxDurationSeconds),
      firstSessionStartedAt,
      lastSessionStartedAt,
      terminateCauses: globalCauses,
    },
    users: usersList,
    ...(dailyTotals ? { dailyTotals } : {}),
    ...(query.includeSessions
      ? {
          sessions: {
            totalMatching: sortedSessions.length,
            returned: pagedSessions.length,
            offset: query.sessionOffset,
            limit: query.sessionLimit,
            hasMore: query.sessionOffset + pagedSessions.length < sortedSessions.length,
            items: pagedSessions,
          },
        }
      : {}),
  };
}

/**
 * Render an {@link OpenVpnUsageReport} into a clear, structured Markdown report
 * followed by the complete machine-readable JSON block so an AI agent can quote
 * exact tables or inspect any nested field directly.
 */
export function formatOpenVpnUsageReport(report: OpenVpnUsageReport): string {
  const lines: string[] = [];
  const { summary, window: win } = report;

  const rangeLabel = win.allTime
    ? `All retained history → ${report.routerClock.now}`
    : `${win.from ?? "start"} → ${win.to ?? report.routerClock.now}${win.days ? ` (${win.days}d window)` : ""}`;

  lines.push(`# OpenVPN Usage & Session Analytics — \`${report.device}\``);
  lines.push(
    `- **Window**: ${rangeLabel}${report.routerClock.timeZone ? ` (${report.routerClock.timeZone})` : ""}`,
  );
  lines.push(
    `- **Accounting Source**: \`${report.dataSources.primaryAccountingSource}\` (${report.dataSources.notes.join(" ")})`,
  );
  lines.push("");

  lines.push("## 1. All-Users Aggregate Summary");
  lines.push(
    `- **Total Connections**: **${summary.totalConnections}** (**${summary.nonZeroTrafficConnections}** with data transfer, **${summary.zeroTrafficConnections}** zero-byte retries; **${summary.activeConnections}** active, **${summary.closedConnections}** closed)`,
  );
  lines.push(
    `- **Unique Users Connected**: **${summary.uniqueUsersConnected}** (of **${summary.configuredUsersCount}** configured accounts) across **${summary.distinctDaysWithActivity}** day(s) and **${summary.uniqueCallerIds}** unique client IP(s)`,
  );
  lines.push(
    `- **Total Traffic**: **${summary.totalHuman}** (${summary.totalBytes.toLocaleString("en-US")} B) — Download: **${summary.downloadHuman}** (${summary.downloadBytes.toLocaleString("en-US")} B) · Upload: **${summary.uploadHuman}** (${summary.uploadBytes.toLocaleString("en-US")} B)`,
  );
  lines.push(
    `- **Average Traffic**: **${summary.averageBytesPerConnectionHuman}** / connection (**${summary.averageBytesPerNonZeroConnectionHuman}** / non-zero session) · Peak Session: **${summary.maxSessionHuman}** (${summary.maxSessionBytes.toLocaleString("en-US")} B)`,
  );
  lines.push(
    `- **Total Duration**: **${summary.totalDurationFormatted}** (${summary.totalDurationSeconds.toLocaleString("en-US")} s) · Average: **${summary.averageDurationFormatted}** (${summary.averageDurationSeconds} s) · Longest: **${summary.maxDurationFormatted}** (${summary.maxDurationSeconds} s)`,
  );
  if (Object.keys(summary.terminateCauses).length > 0) {
    const causes = Object.entries(summary.terminateCauses)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `\`${c}\`: ${n}`)
      .join(", ");
    lines.push(`- **Session States / Terminate Causes**: ${causes}`);
  }
  lines.push("");

  lines.push("## 2. Per-User Aggregated Summary");
  if (report.users.length === 0) {
    lines.push("_No matching OpenVPN user activity in this window._");
  } else {
    lines.push(
      "| User | Connections (Non-Zero / 0B) | Active | Days | Download | Upload | Total Traffic | Share | Total Duration | Avg Duration | Peak Session | Unique IPs |",
    );
    lines.push(
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const u of report.users) {
      lines.push(
        `| **${u.user}** | ${u.connections} (${u.nonZeroTrafficConnections} / ${u.zeroTrafficConnections}) | ${u.activeSessions} | ${u.distinctDaysConnected} | ${u.downloadHuman} (${u.downloadBytes.toLocaleString("en-US")} B) | ${u.uploadHuman} (${u.uploadBytes.toLocaleString("en-US")} B) | **${u.totalHuman}** (${u.totalBytes.toLocaleString("en-US")} B) | ${u.trafficSharePercent.toFixed(2)}% | ${u.totalDurationFormatted} | ${u.averageDurationFormatted} | ${u.maxSessionHuman} | ${u.uniqueCallerIds} |`,
      );
    }
  }
  lines.push("");

  if (report.dailyTotals && report.dailyTotals.length > 0) {
    lines.push("## 3. All-Users Daily Totals");
    lines.push(
      "| Date | Connections (Non-Zero / 0B) | Active | Unique Users | Download | Upload | Total Traffic | Total Duration | Avg Duration |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const d of report.dailyTotals) {
      lines.push(
        `| **${d.day}** | ${d.connections} (${d.nonZeroTrafficConnections} / ${d.zeroTrafficConnections}) | ${d.activeConnections} | ${d.uniqueUsers} (${(d.users ?? []).join(", ")}) | ${d.downloadHuman} | ${d.uploadHuman} | **${d.totalHuman}** (${d.totalBytes.toLocaleString("en-US")} B) | ${d.totalDurationFormatted} | ${d.averageDurationFormatted} |`,
      );
    }
    lines.push("");

    lines.push("## 4. Per-User Daily Breakdown");
    for (const u of report.users) {
      if (!u.dailyBreakdown || u.dailyBreakdown.length === 0) continue;
      lines.push(
        `### User: \`${u.user}\` — ${u.connections} connection(s), ${u.totalHuman} total (${u.downloadHuman} down / ${u.uploadHuman} up), ${u.totalDurationFormatted} total uptime`,
      );
      lines.push(
        "| Date | Connections (Non-Zero / 0B) | Active | Download | Upload | Total Traffic | Total Duration | Avg Duration | Peak Session | Client IPs |",
      );
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
      for (const d of u.dailyBreakdown) {
        lines.push(
          `| ${d.day} | ${d.connections} (${d.nonZeroTrafficConnections} / ${d.zeroTrafficConnections}) | ${d.activeConnections} | ${d.downloadHuman} (${d.downloadBytes.toLocaleString("en-US")} B) | ${d.uploadHuman} (${d.uploadBytes.toLocaleString("en-US")} B) | **${d.totalHuman}** (${d.totalBytes.toLocaleString("en-US")} B) | ${d.totalDurationFormatted} | ${d.averageDurationFormatted} | ${d.maxSessionHuman} | ${d.callerIds.slice(0, 5).join(", ")}${d.callerIds.length > 5 ? ` (+${d.callerIds.length - 5})` : ""} |`,
        );
      }
      lines.push("");
    }
  }

  if (report.sessions) {
    lines.push(
      `## 5. Individual OpenVPN Sessions (showing ${report.sessions.returned} of ${report.sessions.totalMatching}, offset ${report.sessions.offset})`,
    );
    if (report.sessions.items.length === 0) {
      lines.push("_No matching sessions._");
    } else {
      lines.push(
        "| User | Started | Ended / State | Duration | Download | Upload | Total Traffic | Caller IP | Tunnel IP | Terminate Cause |",
      );
      lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
      for (const s of report.sessions.items) {
        const geoLabel = s.geo?.organization || s.geo?.asn || s.geo?.countryCode?.toUpperCase();
        const callerCol = geoLabel ? `${s.callerId} (${geoLabel})` : s.callerId || "—";
        lines.push(
          `| **${s.user}** | ${s.started} | ${s.active ? "**ACTIVE**" : (s.ended ?? "—")} | ${s.durationFormatted} | ${s.downloadHuman} (${s.downloadBytes.toLocaleString("en-US")} B) | ${s.uploadHuman} (${s.uploadBytes.toLocaleString("en-US")} B) | **${s.totalHuman}** (${s.totalBytes.toLocaleString("en-US")} B) | ${callerCol} | ${s.address || "—"} | ${s.active ? "active" : (s.terminateCause ?? "—")} |`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## 6. Structured JSON Data");
  lines.push("```json");
  lines.push(JSON.stringify(report));
  lines.push("```");

  return lines.join("\n");
}

/**
 * Best-effort reader for cached GeoIP/ASN metadata and historical fallback rows
 * from the local `~/.mikrotik-mcp/openvpn-history.db` when running under Bun.
 */
async function readLocalOpenVpnEnrichment(
  device: string,
): Promise<{ geoByIp: Map<string, OpenVpnGeoInfo>; historyRows: LocalHistoryFallbackRow[] }> {
  const geoByIp = new Map<string, OpenVpnGeoInfo>();
  const historyRows: LocalHistoryFallbackRow[] = [];
  if (!("Bun" in globalThis)) return { geoByIp, historyRows };
  try {
    const dbPath = join(dirname(getConfig().dashboard.dbPath), "openvpn-history.db");
    if (!existsSync(dbPath)) return { geoByIp, historyRows };
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const geoRows = db
        .query<
          { ip: string; country: string; countryCode: string; asn: string; organization: string },
          []
        >(
          "SELECT ip, MAX(country) as country, MAX(countryCode) as countryCode, MAX(asn) as asn, MAX(organization) as organization FROM ovpn_history WHERE ip <> '' AND (country <> '' OR asn <> '' OR organization <> '') GROUP BY ip LIMIT 5000",
        )
        .all();
      for (const r of geoRows) {
        geoByIp.set(r.ip, {
          ...(r.country ? { country: r.country } : {}),
          ...(r.countryCode ? { countryCode: r.countryCode } : {}),
          ...(r.asn ? { asn: r.asn } : {}),
          ...(r.organization ? { organization: r.organization } : {}),
        });
      }
      const rows = db
        .query<LocalHistoryFallbackRow, [string]>(
          "SELECT id, user, ip, tunnel, started, ended, uptime, country, countryCode, asn, organization FROM ovpn_history WHERE device = ? ORDER BY started DESC LIMIT 10000",
        )
        .all(device);
      historyRows.push(...rows);
    } finally {
      db.close();
    }
  } catch {
    /* local history enrichment is optional and must never fail the router query */
  }
  return { geoByIp, historyRows };
}

/**
 * Execute the OpenVPN usage and session analytics workflow on the target router
 * and return both the structured report and its formatted Markdown + JSON representation.
 */
export async function analyzeOpenVpnUsage(
  rawInput: AnalyzeOpenVpnUsageInput,
  ctx: ToolContext,
): Promise<{ report: OpenVpnUsageReport; text: string }> {
  const query = normalizeOpenVpnQuery(rawInput);
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "analyze_ovpn_usage", "READ");

  ctx.info(
    `Analyzing OpenVPN usage on ${device} (${
      query.allTime
        ? "all-time"
        : query.from || query.to
          ? `${query.from ?? "start"}..${query.to ?? "now"}`
          : `last ${query.days ?? DEFAULT_DAYS} day(s)`
    })`,
  );

  const command = buildOpenVpnAnalyticsCommand(query);
  const [rawOutput, localEnrichment] = await Promise.all([
    executeMikrotikCommand(command, { ...ctx, device }, { maxMs: SESSION_CMD_TIMEOUT_MS }),
    readLocalOpenVpnEnrichment(device),
  ]);

  const payload = parseRouterOpenVpnPayload(rawOutput);
  const report = computeOpenVpnUsageReport(device, payload, query, {
    geoByIp: localEnrichment.geoByIp,
    localHistoryRows: payload.hasUserManager ? undefined : localEnrichment.historyRows,
  });

  return {
    report,
    text: formatOpenVpnUsageReport(report),
  };
}
