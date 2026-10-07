import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, looksLikeError } from "../core/routeros";
import { parseRouterosDate } from "../core/routeros-parse";
import { getConfig, onConfigChanged } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { loadUmReportCache, umReportCachePath } from "./um-report-cache";

const CACHE_MS = 30_000;
const RESCAN_MS = 15 * 60_000;
const COLLECTION_MS = 180_000;
const FIELDS = { sessions: [".id", "user", "started"] };
const SESSION_IDS =
  ":put [:serialize to=json value=[/user-manager session find] options=json.no-string-conversion]";
type Session = { user: string; started: string | null };

/** Store only identity and start time; never retain addresses or other session details. */
function sessionRows(rows: unknown): Map<string, Session> {
  if (!Array.isArray(rows)) throw new Error("Invalid session page");
  const result = new Map<string, Session>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Invalid session row");
    const { ".id": id, user, started } = row as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^\*[0-9a-f]+$/i.test(id) ||
      typeof user !== "string" ||
      result.has(id)
    )
      throw new Error("Invalid session identity");
    result.set(id, { user, started: umConnectionDate(started) });
  }
  return result;
}

function latestDates(sessions: Map<string, Session>): Map<string, string> {
  const values = new Map<string, string>();
  for (const { user, started } of sessions.values()) {
    if (user && started && started > (values.get(user) ?? "")) values.set(user, started);
  }
  return values;
}

/** Normalize wall-clock dates without pretending the router timezone is UTC. */
export function umConnectionDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/(\d{2}:\d{2}:\d{2})\.\d{1,9}$/, "$1");
  if (!/^(?:\d{4}-\d{2}-\d{2}|[a-z]{3}\/\d{1,2}\/\d{4})[ T]\d{2}:\d{2}:\d{2}$/i.test(text))
    return null;
  const ts = parseRouterosDate(text);
  if (ts == null || ts <= 0) return null;
  const normalized = new Date(ts).toISOString().slice(0, 19).replace("T", " ");
  // Date.UTC normalizes impossible dates; reject those rather than inventing a login.
  if (/^\d{4}-/.test(text) && normalized !== text.replace("T", " ")) return null;
  if (!/^\d{4}-/.test(text)) {
    const [, month, day, year, time] = /^([a-z]{3})\/(\d{1,2})\/(\d{4})[ T](.*)$/i.exec(text)!;
    const canonicalMonth = new Date(ts)
      .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
      .toLowerCase();
    if (
      canonicalMonth !== month.toLowerCase() ||
      normalized !== `${year}-${normalized.slice(5, 7)}-${day.padStart(2, "0")} ${time}`
    )
      return null;
  }
  return normalized;
}

export interface UmLastConnections {
  status: "pending" | "ready" | "stale" | "unavailable";
  collectedAt?: number;
  values: Map<string, string>;
}
interface Entry {
  config: ReturnType<typeof getConfig>;
  values: Map<string, string>;
  collectedAt?: number;
  retryAt: number;
  pending?: Promise<void>;
  failed: boolean;
  sessions: Map<string, Session>;
  scannedAt: number;
  restored: boolean;
}
const cache = new Map<string, Entry>();
onConfigChanged(() => cache.clear());

/** A non-blocking, coalesced read independent of the five-second counter poll. */
export function getUmLastConnections(device: string): UmLastConnections {
  try {
    assertDeviceAccess([device], "list_user_manager_sessions", "READ");
  } catch {
    return { status: "unavailable", values: new Map() };
  }
  const config = getConfig();
  let entry = cache.get(device);
  if (!entry || entry.config !== config) {
    entry = {
      config,
      values: new Map(),
      sessions: new Map(),
      scannedAt: 0,
      restored: false,
      retryAt: 0,
      failed: false,
    };
    cache.set(device, entry);
  }
  const target = entry;
  if (!target.pending && Date.now() >= target.retryAt) {
    target.pending = (async () => {
      if (!target.restored) {
        target.restored = true;
        const snapshot = await loadUmReportCache(umReportCachePath(device), device, FIELDS);
        if (getConfig() !== config) return;
        if (snapshot?.sources.sessions.available) {
          try {
            target.sessions = sessionRows(snapshot.sources.sessions.rows);
            target.values = latestDates(target.sessions);
            target.collectedAt = snapshot.collectedAt;
            target.scannedAt = snapshot.collectedAt;
          } catch {
            // Invalid cached identities must not prevent a fresh router read.
          }
        }
      }
      const deadline = Date.now() + COLLECTION_MS;
      const ctx = createContext(undefined, device);
      const run = async (command: string) => {
        if (getConfig() !== config) throw new Error("Configuration changed");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Last connection read deadline exceeded");
        const raw = await executeMikrotikCommand(command, ctx, {
          maxMs: Math.min(60_000, remaining),
        });
        if (looksLikeError(raw) || raw.length > 2 * 1024 * 1024)
          throw new Error("Invalid last connection response");
        return raw;
      };
      const ids: unknown = JSON.parse(await run(SESSION_IDS));
      if (
        !Array.isArray(ids) ||
        ids.length > 100_000 ||
        !ids.every((id) => typeof id === "string" && /^\*[0-9a-f]+$/i.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error("Invalid session identities");
      // Starts are immutable during a session. Re-read unknown/new records every
      // poll; periodically rebuild to handle restored databases and reused IDs.
      const full = !target.scannedAt || Date.now() - target.scannedAt >= RESCAN_MS;
      const sessions = new Map<string, Session>();
      const missing: string[] = [];
      for (const id of ids) {
        const known = full ? undefined : target.sessions.get(id);
        if (known?.started) sessions.set(id, known);
        else missing.push(id);
      }
      for (let offset = 0; offset < missing.length; offset += 2000) {
        const batch = missing.slice(offset, offset + 2000);
        const query = new Cmd("/user-manager session print")
          .raw("as-value")
          .set("from", batch.join(","))
          .build();
        const page = sessionRows(
          JSON.parse(
            await run(
              `:put [:serialize to=json value=[${query}] options=json.no-string-conversion]`,
            ),
          ),
        );
        if (page.size !== batch.length || !batch.every((id) => page.has(id)))
          throw new Error("Incomplete session page");
        for (const [id, session] of page) sessions.set(id, session);
      }
      if (getConfig() !== config) return;
      target.sessions = sessions;
      target.values = latestDates(sessions);
      target.collectedAt = Date.now();
      if (full) target.scannedAt = target.collectedAt;
      target.failed = false;
    })()
      .catch(() => {
        target.failed = true;
      })
      .finally(() => {
        target.retryAt = Date.now() + CACHE_MS;
        target.pending = undefined;
      });
  }
  return {
    values: target.values,
    collectedAt: target.collectedAt,
    status:
      target.collectedAt == null
        ? target.pending
          ? "pending"
          : "unavailable"
        : target.failed || Date.now() - target.collectedAt >= CACHE_MS
          ? "stale"
          : "ready",
  };
}
