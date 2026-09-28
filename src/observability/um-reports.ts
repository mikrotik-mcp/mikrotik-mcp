import type { ToolContext } from "../core/context";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { DeviceConnectionError } from "../core/device-connection-error";
import { Cmd, commandUnsupported, looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRouterosDate, parseSize } from "../core/routeros-parse";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";

type Row = Record<string, string>;
const DAY = 86_400_000;
const CACHE_MS = 60_000;
const count = (v?: string): number => Math.max(0, Number(v) || 0);
const size = (v?: string): number => Math.max(0, parseSize(v) ?? 0);

// Whitelist the wire projection and response. Never send passwords, RADIUS
// attributes, shared secrets, payment details or private key material to the UI.
export const UM_REPORT_FIELDS = {
  users: [".id", "name", "group", "disabled", "shared-users", "caller-id", "comment"],
  sessions: [
    ".id",
    "user",
    "acct-session-id",
    "active",
    "started",
    "ended",
    "last-accounting-packet",
    "download",
    "upload",
    "uptime",
    "nas-identifier",
    "nas-ip-address",
    "nas-port-id",
    "nas-port-type",
    "calling-station-id",
    "user-address",
    "status",
    "terminate-cause",
  ],
  profiles: [
    ".id",
    "name",
    "name-for-users",
    "validity",
    "starts-when",
    "price",
    "override-shared-users",
  ],
  limitations: [
    ".id",
    "name",
    "download-limit",
    "upload-limit",
    "transfer-limit",
    "uptime-limit",
    "rate-limit-rx",
    "rate-limit-tx",
    "rate-limit-min-rx",
    "rate-limit-min-tx",
    "rate-limit-burst-rx",
    "rate-limit-burst-tx",
    "rate-limit-burst-threshold-rx",
    "rate-limit-burst-threshold-tx",
    "rate-limit-burst-time-rx",
    "rate-limit-burst-time-tx",
    "rate-limit-priority",
    "reset-counters-interval",
    "reset-counters-start-time",
  ],
  assignments: [".id", "user", "profile", "state", "end-time"],
  profileLimits: [".id", "profile", "limitation", "from-time", "till-time", "weekdays"],
  routers: [".id", "name", "address", "disabled", "coa-port", "protocol", "comment"],
  groups: [".id", "name", "outer-auths", "inner-auths"],
  totals: [
    ".id",
    "active-sessions",
    "active-sub-sessions",
    "actual-profile",
    "total-download",
    "total-upload",
    "total-uptime",
  ],
  settings: ["enabled", "use-profiles", "authentication-port", "accounting-port", "certificate"],
} as const;
type Source = keyof typeof UM_REPORT_FIELDS;
export interface UmSource {
  available: boolean;
  rows: Row[];
  error?: string;
}
export interface UmSnapshot {
  device: string;
  collectedAt: number;
  collectionMs: number;
  clock: { zone: string; offsetMs: number | null };
  sources: Record<Source, UmSource>;
}

/** Reject partial/invalid JSON instead of presenting a timeout as empty accounting. */
export function parseUmRows(raw: string, source: Source): Row[] {
  if (raw.length > 32 * 1024 * 1024) throw new Error("Report exceeds the 32 MiB read limit.");
  const parsed: unknown = JSON.parse(raw);
  if (parsed == null || typeof parsed !== "object") throw new Error("Invalid accounting response.");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length > 100_000) throw new Error("Report exceeds 100,000 records.");
  return rows
    .map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("Invalid accounting row.");
      const record = row as Record<string, unknown>;
      return Object.fromEntries(
        UM_REPORT_FIELDS[source].flatMap((key) => {
          const value = record[key];
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            return [[key, String(value)]];
          return Array.isArray(value)
            ? [
                [
                  key,
                  value
                    .filter((v) => ["string", "number", "boolean"].includes(typeof v))
                    .join(", "),
                ],
              ]
            : [];
        }),
      );
    })
    .filter((row) => Object.keys(row).length > 0);
}

const menus: Record<Exclude<Source, "totals" | "settings">, string> = {
  users: "user",
  sessions: "session",
  profiles: "profile",
  limitations: "limitation",
  assignments: "user-profile",
  profileLimits: "profile-limitation",
  routers: "router",
  groups: "user group",
};

async function readSource(ctx: ToolContext, source: Source): Promise<UmSource> {
  let receivedBytes = 0;
  try {
    if (source === "sessions") {
      // Capture IDs once so new sessions cannot shift page boundaries. Large
      // single-channel replies can end at an SSH window boundary under load.
      const rawIds = await executeMikrotikCommand(
        ":put [:serialize to=json value=[/user-manager session find] options=json.no-string-conversion]",
        ctx,
        { maxMs: 60_000 },
      );
      receivedBytes += rawIds.length;
      if (commandUnsupported(rawIds)) return { available: false, rows: [] };
      const ids: unknown = JSON.parse(rawIds);
      if (
        !Array.isArray(ids) ||
        ids.length > 100_000 ||
        !ids.every((id) => typeof id === "string" && /^\*[0-9a-f]+$/i.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error("Invalid session identity list.");
      const rows: Row[] = [];
      const deadline = Date.now() + 90_000;
      for (let offset = 0; offset < ids.length; offset += 2000) {
        if (Date.now() >= deadline) throw new Error("Accounting read deadline exceeded.");
        const batch = ids.slice(offset, offset + 2000);
        const command = new Cmd("/user-manager session print")
          .raw("as-value")
          .set("from", batch.join(","))
          .build();
        const raw = await executeMikrotikCommand(
          `:put [:serialize to=json value=[${command}] options=json.no-string-conversion]`,
          ctx,
          { maxMs: 60_000 },
        );
        receivedBytes += raw.length;
        if (receivedBytes > 32 * 1024 * 1024) throw new Error("Accounting exceeds the read limit.");
        const page = parseUmRows(raw.trim(), "sessions");
        const found = new Set(page.map((r) => r[".id"]));
        if (
          page.length !== batch.length ||
          found.size !== batch.length ||
          !batch.every((id) => found.has(id))
        )
          throw new Error("Accounting changed during collection or a page was incomplete.");
        rows.push(...page);
      }
      return { available: true, rows };
    }
    const query =
      source === "totals"
        ? "/user-manager user monitor [find] once as-value"
        : source === "settings"
          ? "/user-manager print as-value"
          : `/user-manager ${menus[source]} print as-value`;
    // Static query only; filters are applied locally, never interpolated into RouterOS.
    // Project credentials out on the router before serializing metadata.
    const command =
      source === "totals" || source === "settings"
        ? `:put [:serialize to=json value=[${query}] options=json.no-string-conversion]`
        : `:local result [:toarray ""]; :foreach row in=[${query}] do={ :local item [:toarray ""]; :foreach key in={${UM_REPORT_FIELDS[source].map((key) => `"${key}"`).join(";")}} do={ :if ([:typeof ($row->$key)] != "nil") do={ :set ($item->$key) ($row->$key) } }; :set result ($result, {$item}) }; :put [:serialize to=json value=$result options=json.no-string-conversion]`;
    const raw = await executeMikrotikCommand(command, ctx, { maxMs: 60_000 });
    receivedBytes = raw.length;
    if (commandUnsupported(raw)) return { available: false, rows: [] };
    if (looksLikeError(raw))
      throw new Error(
        "Router rejected the report read; check package, permissions and RouterOS version.",
      );
    return { available: true, rows: parseUmRows(raw.trim(), source) };
  } catch (error) {
    // A disconnected device is not a missing package or an empty report. Let
    // the shared HTTP handler report it, without caching an unavailable snapshot.
    if (error instanceof DeviceConnectionError) throw error;
    // Do not include raw transport output: it may contain connection credentials.
    return {
      available: false,
      rows: [],
      error:
        error instanceof SyntaxError
          ? `Incomplete or invalid JSON (${receivedBytes} characters received); this report was not counted. Retry the read.`
          : "Unable to read this source. Check connectivity, permissions and report size (32 MiB / 100,000 rows).",
    };
  }
}

async function collect(device: string): Promise<UmSnapshot> {
  const start = Date.now();
  const ctx = createContext(undefined, device);
  const sources = Object.fromEntries(
    Object.keys(UM_REPORT_FIELDS).map((key) => [key, { available: false, rows: [] }]),
  ) as unknown as UmSnapshot["sources"];
  sources.users = await readSource(ctx, "users");
  let clock: UmSnapshot["clock"] = {
    zone: "Router local time (offset unavailable)",
    offsetMs: null,
  };
  if (sources.users.available) {
    // Sequential reads also work when the connector routes through a Safe Mode session.
    for (const key of Object.keys(UM_REPORT_FIELDS) as Source[]) {
      if (key !== "users")
        sources[key] =
          key === "totals" && !sources.users.rows.length
            ? { available: true, rows: [] }
            : await readSource(ctx, key);
    }
    try {
      const fields = parseKeyValues(await executeMikrotikCommand("/system clock print", ctx));
      const offset = /^([+-]?)(\d{2}):(\d{2})$/.exec(fields["gmt-offset"] ?? "");
      if (offset)
        clock = {
          zone: fields["time-zone-name"] || `UTC${fields["gmt-offset"]}`,
          offsetMs:
            (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000,
        };
    } catch {
      /* Calendar grouping can still use the router's wall-clock dates. */
    }
  }
  return { device, collectedAt: Date.now(), collectionMs: Date.now() - start, clock, sources };
}

const cache = new Map<
  string,
  { config: ReturnType<typeof getConfig>; value?: UmSnapshot; pending?: Promise<UmSnapshot> }
>();
/** Shared, per-router single flight; even Refresh cannot overlap or hammer a large table. */
export async function getUmSnapshot(device?: string): Promise<UmSnapshot> {
  const name = resolveDeviceName(device); // Validate before looking in the cache.
  for (const tool of [
    "list_user_manager_users",
    "list_user_manager_sessions",
    "list_user_manager_profiles",
    "list_user_manager_limitations",
    "list_user_manager_routers",
    "list_user_manager_user_profiles",
    "get_user_manager_settings",
  ])
    assertDeviceAccess([name], tool, "READ");
  const config = getConfig();
  let entry = cache.get(name);
  if (!entry || entry.config !== config) {
    entry = { config };
    cache.set(name, entry);
  }
  if (entry.pending) return entry.pending;
  if (entry.value && Date.now() - entry.value.collectedAt < CACHE_MS) return entry.value;
  const target = entry;
  target.pending = collect(name)
    .then((value) => {
      target.value = value;
      return value;
    })
    .finally(() => {
      target.pending = undefined;
    });
  return target.pending;
}

export interface UmUserCounters {
  device: string;
  collectedAt: number;
  available: boolean;
  error?: string;
  rows: {
    id: string;
    name: string;
    active: number | null;
    seconds: number | null;
    download: number | null;
    upload: number | null;
  }[];
}
const userCounterCache = new Map<
  string,
  {
    config: ReturnType<typeof getConfig>;
    value?: UmUserCounters;
    pending?: Promise<UmUserCounters>;
  }
>();

/** Short, shared read for the Users table; never walks historical sessions. */
export async function getUmUserCounters(device?: string): Promise<UmUserCounters> {
  const name = resolveDeviceName(device);
  assertDeviceAccess([name], "list_user_manager_users", "READ");
  const config = getConfig();
  let entry = userCounterCache.get(name);
  if (!entry || entry.config !== config) {
    entry = { config };
    userCounterCache.set(name, entry);
  }
  if (entry.pending) return entry.pending;
  if (entry.value && Date.now() - entry.value.collectedAt < 2500) return entry.value;
  const target = entry;
  target.pending = (async (): Promise<UmUserCounters> => {
    const ctx = createContext(undefined, name);
    const users = await readSource(ctx, "users");
    const totals = users.available ? await readSource(ctx, "totals") : users;
    const available = users.available && totals.available;
    const byId = new Map(totals.rows.map((r) => [r[".id"], r]));
    const value: UmUserCounters = {
      device: name,
      collectedAt: Date.now(),
      available,
      error: available
        ? undefined
        : users.error || totals.error || "User Manager counters are unavailable on this device.",
      rows: available
        ? users.rows
            .filter((r) => r.name && r[".id"])
            .map((r) => {
              const total = byId.get(r[".id"]);
              return {
                id: r[".id"],
                name: r.name,
                active: total?.["active-sessions"] != null ? count(total["active-sessions"]) : null,
                seconds:
                  total?.["total-uptime"] != null ? umDurationSeconds(total["total-uptime"]) : null,
                download: total?.["total-download"] != null ? size(total["total-download"]) : null,
                upload: total?.["total-upload"] != null ? size(total["total-upload"]) : null,
              };
            })
        : [],
    };
    if (available) target.value = value;
    return value;
  })().finally(() => {
    target.pending = undefined;
  });
  return target.pending;
}

/** RouterOS JSON serializes long durations as epoch dates, not ISO durations. */
export function umDurationSeconds(value: string | undefined): number {
  if (!value || value === "0") return 0;
  if (/^\d{4}-\d\d-\d\d /.test(value)) return Math.max(0, (parseRouterosDate(value) ?? 0) / 1000);
  const clock = /^(?:(\d+)w)?(?:(\d+)d)?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (clock)
    return (
      Number(clock[1] || 0) * 604800 +
      Number(clock[2] || 0) * 86400 +
      Number(clock[3]) * 3600 +
      Number(clock[4]) * 60 +
      Number(clock[5])
    );
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
  return [...value.matchAll(/(\d+(?:\.\d+)?)(ms|[wdhms])/g)].reduce(
    (sum, m) => sum + Number(m[1]) * units[m[2]],
    0,
  );
}
const yes = (v?: string): boolean => v === "true" || v === "yes";
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface UmReportQuery {
  days: number;
  from: string;
  to: string;
  user: string;
  state: string;
  search: string;
  page: number;
}
export function parseUmReportQuery(params: URLSearchParams): UmReportQuery {
  const days = Number(params.get("days") ?? 30);
  const page = Number(params.get("page") ?? 1);
  const state = params.get("state") ?? "all";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const user = params.get("user") ?? "";
  const search = params.get("search") ?? "";
  const validDay = (s: string): boolean =>
    !s ||
    (/^\d{4}-\d{2}-\d{2}$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      dayKey(Date.parse(s)) === s);
  if (
    !Number.isInteger(days) ||
    days < 0 ||
    days > 3660 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !["all", "active", "closed"].includes(state) ||
    !validDay(from) ||
    !validDay(to) ||
    (from && to && from > to) ||
    user.length > 256 ||
    search.length > 256
  )
    throw new Error("Invalid report filter.");
  return { days, page, state, from, to, user, search };
}

export function buildUmReport(snapshot: UmSnapshot, query: UmReportQuery) {
  const { sources } = snapshot;
  const localNow = snapshot.collectedAt + (snapshot.clock.offsetMs ?? 0);
  const until = query.to || dayKey(localNow);
  const since =
    query.from || (query.days ? dayKey(Date.parse(until) - (query.days - 1) * DAY) : "");
  // Accounting IDs are re-used after NAS restarts. Stable row identity + start
  // time keeps those connections separate; never deduplicate on acct-session-id.
  const sessions = sources.sessions.rows.map((r) => ({
    id: r[".id"] || `${r.user}|${r.started}|${r["acct-session-id"]}`,
    user: r.user || "(unknown)",
    active: yes(r.active),
    started: r.started || "",
    ended: r.ended || "",
    updated: r["last-accounting-packet"] || "",
    download: size(r.download),
    upload: size(r.upload),
    seconds: umDurationSeconds(r.uptime),
    address: r["user-address"] || "",
    caller: r["calling-station-id"] || "",
    nas: r["nas-identifier"] || r["nas-ip-address"] || "(unknown)",
    nasAddress: r["nas-ip-address"] || "",
    port: r["nas-port-id"] || "",
    portType: r["nas-port-type"] || "",
    accountingId: r["acct-session-id"] || "",
    status: r.status || "",
    cause: r["terminate-cause"] || (yes(r.active) ? "Active" : "Not reported"),
    day: (() => {
      const t = parseRouterosDate(r.started);
      return t == null ? "" : dayKey(t);
    })(),
  }));
  const windowSessions = sessions.filter(
    (s) => s.day && (!since || s.day >= since) && s.day <= until,
  );
  const selected = windowSessions.filter((s) => !query.user || s.user === query.user);
  const totalsById = new Map(sources.totals.rows.map((r) => [r[".id"], r]));
  const identities = new Map(sources.users.rows.map((r) => [r.name, r]));
  const perUser = new Map<
    string,
    { sessions: number; download: number; upload: number; seconds: number; latest: string }
  >();
  for (const s of sessions) {
    if (!identities.has(s.user)) identities.set(s.user, { name: s.user });
    const u = perUser.get(s.user) ?? {
      sessions: 0,
      download: 0,
      upload: 0,
      seconds: 0,
      latest: "",
    };
    if (s.started > u.latest) u.latest = s.started;
    perUser.set(s.user, u);
  }
  for (const s of windowSessions) {
    const u = perUser.get(s.user)!;
    u.sessions++;
    u.download += s.download;
    u.upload += s.upload;
    u.seconds += s.seconds;
  }
  const users = [...identities]
    .map(([name, r]) => {
      const total = totalsById.get(r[".id"]);
      const own = perUser.get(name) ?? {
        sessions: 0,
        download: 0,
        upload: 0,
        seconds: 0,
        latest: "",
      };
      return {
        name,
        disabled: yes(r.disabled),
        group: r.group || "",
        comment: r.comment || "",
        configured: !!r[".id"],
        sharedUsers: r["shared-users"] || "",
        callerId: r["caller-id"] || "",
        profile: total?.["actual-profile"] || "",
        active: total?.["active-sessions"] != null ? count(total["active-sessions"]) : null,
        subSessions:
          total?.["active-sub-sessions"] != null ? count(total["active-sub-sessions"]) : null,
        totalDownload: total?.["total-download"] != null ? size(total["total-download"]) : null,
        totalUpload: total?.["total-upload"] != null ? size(total["total-upload"]) : null,
        totalSeconds:
          total?.["total-uptime"] != null ? umDurationSeconds(total["total-uptime"]) : null,
        ...own,
      };
    })
    .sort((a, b) => b.download + b.upload - a.download - a.upload || a.name.localeCompare(b.name));
  const daily = new Map<
    string,
    { day: string; download: number; upload: number; sessions: number; seconds: number }
  >();
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    sessions: 0,
  }));
  const causes = new Map<string, number>();
  const nas = new Map<
    string,
    { name: string; sessions: number; download: number; upload: number }
  >();
  for (const s of selected) {
    const d = daily.get(s.day) ?? { day: s.day, download: 0, upload: 0, sessions: 0, seconds: 0 };
    d.download += s.download;
    d.upload += s.upload;
    d.sessions++;
    d.seconds += s.seconds;
    daily.set(s.day, d);
    const time = parseRouterosDate(s.started);
    if (time != null) hours[new Date(time).getUTCHours()].sessions++;
    if (!s.active) causes.set(s.cause, (causes.get(s.cause) ?? 0) + 1);
    const n = nas.get(s.nas) ?? { name: s.nas, sessions: 0, download: 0, upload: 0 };
    n.sessions++;
    n.download += s.download;
    n.upload += s.upload;
    nas.set(s.nas, n);
  }
  const first = since || [...daily.keys()].sort()[0] || until;
  // Bound empty calendar generation; sparse historical data remains visible.
  if (Date.parse(until) - Date.parse(first) <= 3660 * DAY) {
    for (let t = Date.parse(first); t <= Date.parse(until); t += DAY) {
      const key = dayKey(t);
      if (!daily.has(key))
        daily.set(key, { day: key, download: 0, upload: 0, sessions: 0, seconds: 0 });
    }
  }
  let cumulativeDownload = 0;
  let cumulativeUpload = 0;
  const series = [...daily.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => {
      cumulativeDownload += d.download;
      cumulativeUpload += d.upload;
      return { ...d, cumulativeDownload, cumulativeUpload };
    });
  const search = query.search.toLowerCase();
  const filtered = selected
    .filter(
      (s) =>
        (query.state === "all" || (query.state === "active") === s.active) &&
        (!search ||
          [s.user, s.address, s.caller, s.nas, s.accountingId, s.cause].some((v) =>
            v.toLowerCase().includes(search),
          )),
    )
    .sort((a, b) => b.started.localeCompare(a.started) || b.id.localeCompare(a.id));
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const page = Math.min(query.page, pages);
  const focus = query.user ? users.filter((u) => u.name === query.user) : users;
  const monitored = query.user ? focus : focus.filter((u) => u.configured);
  const sourceStates = Object.fromEntries(
    Object.entries(sources).map(([key, value]) => [
      key,
      { available: value.available, count: value.rows.length, error: value.error },
    ]),
  );
  return {
    device: snapshot.device,
    collectedAt: snapshot.collectedAt,
    collectionMs: snapshot.collectionMs,
    refreshAfterMs: CACHE_MS,
    available: sources.users.available,
    sources: sourceStates,
    clock: snapshot.clock,
    coverage: {
      retained: sessions.length,
      undated: sessions.filter((s) => !s.day).length,
      first: sessions.reduce((a, s) => (s.day && (!a || s.day < a) ? s.day : a), ""),
      from: first,
      to: until,
    },
    summary: {
      sessions: selected.length,
      active:
        sources.totals.available && monitored.every((u) => u.active != null)
          ? monitored.reduce((n, u) => n + u.active!, 0)
          : null,
      download: cumulativeDownload,
      upload: cumulativeUpload,
      seconds: selected.reduce((n, s) => n + s.seconds, 0),
      users: new Set(selected.map((s) => s.user)).size,
      configuredUsers: sources.users.rows.length,
    },
    users,
    series,
    hours,
    causes: [...causes].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    nas: [...nas.values()].sort((a, b) => b.sessions - a.sessions),
    sessions: {
      rows: filtered.slice((page - 1) * 50, page * 50),
      total: filtered.length,
      page,
      pages,
    },
    inventory: {
      profiles: sources.profiles.rows,
      limitations: sources.limitations.rows,
      profileLimits: sources.profileLimits.rows,
      assignments: sources.assignments.rows.filter((r) => !query.user || r.user === query.user),
      routers: sources.routers.rows,
      groups: sources.groups.rows,
      settings: sources.settings.rows,
    },
  };
}
export type UmReport = ReturnType<typeof buildUmReport>;
