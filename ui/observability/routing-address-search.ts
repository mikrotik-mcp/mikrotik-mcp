import type { Row } from "../../src/service-routing/model";
import type { RoutingAddressPage } from "../../src/service-routing/read";

export type AddressFamily = "ipv4" | "ipv6";
export type AddressEntry = { row: Row; family: AddressFamily };
export type AddressMatch = AddressEntry & { match: "exact" | "partial" | "fuzzy"; score: number };
export type AddressIndex = {
  rows: Row[];
  total?: number;
  status: "idle" | "loading" | "ready" | "error";
  observedAt?: number;
  error?: string;
};
type Page = RoutingAddressPage & { device: string; family: string; offset: number };
type Loader = (
  device: string,
  family: AddressFamily,
  offset: number,
  signal: AbortSignal,
) => Promise<Page>;
const emptyIndex: AddressIndex = { rows: [], status: "idle" };
const TTL = 60_000;

/** Memory-only, shared by the inventory and inspector. Queries never trigger router reads. */
export function createAddressIndexCache(load: Loader) {
  type Slot = { value: AddressIndex; listeners: Set<() => void>; request?: AbortController };
  const slots = new Map<string, Slot>();
  function slot(device: string, family: AddressFamily) {
    const key = JSON.stringify([device, family]);
    let current = slots.get(key);
    if (!current) {
      // Bound retained routers, without evicting a currently visible inspector.
      for (const [oldKey, old] of slots) {
        if (slots.size < 8) break;
        if (!old.listeners.size) {
          old.request?.abort();
          slots.delete(oldKey);
        }
      }
      current = { value: emptyIndex, listeners: new Set() };
      slots.set(key, current);
    }
    return current;
  }
  function publish(current: Slot, value: AddressIndex) {
    current.value = value;
    current.listeners.forEach((listener) => listener());
  }
  async function read(device: string, family: AddressFamily, force = false) {
    const current = slot(device, family);
    if (
      !force &&
      (current.request ||
        (current.value.status === "ready" && Date.now() - (current.value.observedAt ?? 0) < TTL))
    )
      return;
    current.request?.abort();
    const request = new AbortController();
    current.request = request;
    publish(current, { rows: [], status: "loading" });
    const started = Date.now();
    let rows: Row[] = [],
      total: number | undefined;
    const ids = new Set<string>();
    try {
      let offset = 0;
      while (!request.signal.aborted) {
        if (Date.now() - started > 120_000 || rows.length >= 20_000)
          throw new Error(
            "Full read reached its safety limit. Results below are incomplete; narrow the router’s lists or retry.",
          );
        const result = await load(
          device,
          family,
          offset,
          AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        );
        if (request.signal.aborted) return;
        if (
          result.device !== device ||
          result.family !== family ||
          result.offset !== offset ||
          !Number.isSafeInteger(result.total) ||
          result.total < 0 ||
          !Array.isArray(result.rows) ||
          result.rows.length !== Math.min(200, Math.max(0, result.total - offset))
        )
          throw new Error(
            "Address page did not match this router or was incomplete. Refresh to retry.",
          );
        if (total !== undefined && total !== result.total)
          throw new Error(
            "Address lists changed while reading. Refresh to build a new search snapshot.",
          );
        total = result.total;
        for (const row of result.rows) {
          if (
            !row[".id"] ||
            ids.has(row[".id"]) ||
            typeof row.address !== "string" ||
            typeof row.list !== "string"
          )
            throw new Error(
              "Address lists changed or returned incomplete entries. Refresh to retry.",
            );
          ids.add(row[".id"]);
        }
        rows = rows.concat(result.rows);
        const done = rows.length === total;
        if (done ? result.nextOffset !== undefined : result.nextOffset !== rows.length)
          throw new Error("Address pagination is incomplete. Refresh to retry.");
        publish(current, {
          rows,
          total,
          status: done ? "ready" : "loading",
          observedAt: done ? Date.now() : undefined,
        });
        if (done) return;
        offset = rows.length;
      }
    } catch (error) {
      if (!request.signal.aborted)
        publish(current, {
          rows,
          total,
          status: "error",
          error: error instanceof Error ? error.message : "Address lists could not be read.",
        });
    } finally {
      if (current.request === request) current.request = undefined;
    }
  }
  return {
    get: (device: string, family: AddressFamily) => slot(device, family).value,
    read,
    subscribe(device: string, family: AddressFamily, listener: () => void) {
      const current = slot(device, family);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
        if (!current.listeners.size && current.request) {
          current.request.abort();
          current.request = undefined;
          // Cancelled partial reads must not masquerade as a complete cached result.
          current.value = emptyIndex;
        }
      };
    },
    clear() {
      slots.forEach((s) => s.request?.abort());
      slots.clear();
    },
  };
}

export function normalizeAddressQuery(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[۰-۹]/g, (n) => String(n.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (n) => String(n.charCodeAt(0) - 1632))
    .trim();
}

/** Bounded one-edit matching, including swapped letters, without unbounded regexes or dependencies. */
function nearWord(a: string, b: string): boolean {
  if (a.length < 4 || a.length > 64 || b.length > 64 || Math.abs(a.length - b.length) > 1)
    return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length)
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
    );
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Match every query word against address, comment or list; literal hits always precede fuzzy hits. */
export function searchAddressEntries(entries: AddressEntry[], query: string): AddressMatch[] {
  const normalized = normalizeAddressQuery(query).slice(0, 160);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries.map((entry) => ({ ...entry, match: "partial", score: 0 }));
  const found: AddressMatch[] = [];
  for (const entry of entries) {
    const fields = [entry.row.address, entry.row.comment, entry.row.list].map((s) =>
      normalizeAddressQuery(s || ""),
    );
    let score = 0,
      fuzzy = false,
      matches = true;
    for (const token of tokens) {
      if (fields.includes(token)) continue;
      if (fields.some((field) => field.includes(token))) {
        score += 2;
        continue;
      }
      const words = fields.flatMap((field) => [field, ...field.split(/[^\p{L}\p{N}:./]+/u)]);
      if (words.some((word) => nearWord(token, word))) {
        score += 100;
        fuzzy = true;
      } else {
        matches = false;
        break;
      }
    }
    if (matches)
      found.push({
        ...entry,
        score,
        match: fuzzy ? "fuzzy" : fields.includes(normalized) ? "exact" : "partial",
      });
  }
  return found.sort(
    (a, b) => Number(a.match === "fuzzy") - Number(b.match === "fuzzy") || a.score - b.score,
  );
}
