/**
 * Dashboard sub-router for the Flows page.
 *
 * Reads the same flow store the tools use (`~/.mikrotik-mcp/flows.db`) and the
 * same pure aggregation, so a number on the page and a number from
 * `flow_top_talkers` can never disagree.
 *
 *   GET /api/flows/top            top talkers by dimension + protocol mix
 *   GET /api/flows/conversations  address-pair conversations
 *   GET /api/flows/timeline       stacked bytes over time, top-N + other
 *   GET /api/flows/health         collector counters (incl. templates pending)
 *
 * Every route takes `?window=5m|15m|1h|6h|24h`, defaulting to 1h.
 */
import { conversations, protocolMix, summarize, timeline, topTalkers } from "../flows/aggregate";
import type { TalkerDimension } from "../flows/aggregate";
import { getFlowCollector } from "../flows/collector";
import type { FlowRecord } from "../flows/decode";
import { flowStore } from "../tools/traffic-flow";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const WINDOWS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
};

/** Bucket size that keeps a timeline around 60 points whatever the window. */
function bucketFor(windowMs: number): number {
  return Math.max(60_000, Math.round(windowMs / 60 / 60_000) * 60_000);
}

function windowMs(url: URL): number {
  return WINDOWS[url.searchParams.get("window") ?? "1h"] ?? WINDOWS["1h"];
}

export async function flowRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/flows")) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const collector = getFlowCollector();

  // Health needs no store: it is exactly what you look at when the store is empty.
  if (p === "/api/flows/health") {
    let store: {
      rawRows: number;
      rollupRows: number;
      oldestRaw: number | null;
      newestRaw: number | null;
      evicted: number;
    } | null = null;
    try {
      store = (await flowStore()).stats();
    } catch {
      // The store may not be openable (no bun:sqlite, bad path) — the collector
      // counters still explain what is happening, which is the point of /health.
    }
    return json({ collector: collector.stats(), store });
  }

  // Anything the collector still holds in memory belongs in the answer: the page
  // refreshes every few seconds and a 2-second flush lag reads as "flat line".
  collector.drain();

  let records: FlowRecord[];
  const span = windowMs(url);
  const to = Date.now();
  const from = to - span;
  const address = url.searchParams.get("address") ?? undefined;
  try {
    records = (await flowStore()).query({ from, to, address, limit: 200_000 });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), records: [] }, 200);
  }

  if (p === "/api/flows/top") {
    const dimension = (url.searchParams.get("dimension") ?? "source") as TalkerDimension;
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return json({
      window: { from, to },
      totals: summarize(records),
      top: topTalkers(records, dimension, limit, true),
      protocols: protocolMix(records).slice(0, 8),
      applications: topTalkers(records, "application", 8, true),
    });
  }

  if (p === "/api/flows/conversations") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json({
      window: { from, to },
      conversations: conversations(records, limit),
    });
  }

  if (p === "/api/flows/timeline") {
    const dimension = (url.searchParams.get("dimension") ?? "source") as TalkerDimension;
    const topN = Number(url.searchParams.get("topN") ?? 5);
    const bucket = bucketFor(span);
    return json({
      window: { from, to },
      bucketMs: bucket,
      keys: topTalkers(records, dimension, topN).map((t) => t.key),
      buckets: timeline(records, from, to, bucket, dimension, topN),
    });
  }

  return json({ error: "not found" }, 404);
}
