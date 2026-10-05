import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, looksLikeError } from "../core/routeros";
import { parseRouterosDate } from "../core/routeros-parse";
import { getConfig, onConfigChanged } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";

const CACHE_MS = 30_000;
// Aggregate on the router: no session IDs, addresses, traffic, or credentials
// leave the device. Datetime properties are compared before JSON serialization.
const SESSION_QUERY = new Cmd("/user-manager session print").raw("as-value").build();
const COMMAND = `:if ([/user-manager session print count-only] > 100000) do={ :error "Session limit exceeded" }; :local latest [:toarray ""]; :foreach row in=[${SESSION_QUERY}] do={ :local user ($row->"user"); :local started ($row->"started"); :if ([:len [:tostr $user]] > 0 && [:len [:tostr $started]] > 0) do={ :local previous ($latest->$user); :if ([:typeof $previous] = "nil") do={ :set ($latest->$user) $started } else={ :if ($started > $previous) do={ :set ($latest->$user) $started } } } }; :put [:serialize to=json value=$latest options=json.no-string-conversion]`;

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
    entry = { config, values: new Map(), retryAt: 0, failed: false };
    cache.set(device, entry);
  }
  const target = entry;
  if (!target.pending && Date.now() >= target.retryAt) {
    target.pending = (async () => {
      const raw = await executeMikrotikCommand(COMMAND, createContext(undefined, device), {
        maxMs: 15_000,
      });
      if (looksLikeError(raw) || raw.length > 2 * 1024 * 1024)
        throw new Error("Invalid last connection response");
      const result: unknown = JSON.parse(raw);
      if (!result || typeof result !== "object" || (Array.isArray(result) && result.length))
        throw new Error("Invalid last connection response");
      const values = new Map<string, string>();
      for (const [user, value] of Object.entries(result)) {
        const date = umConnectionDate(value);
        if (date) values.set(user, date);
      }
      if (getConfig() !== config) return;
      target.values = values;
      target.collectedAt = Date.now();
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
