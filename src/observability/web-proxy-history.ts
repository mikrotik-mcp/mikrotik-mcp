import { logger } from "../logger";
import { chmodSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { parseAccountingUptimeSeconds } from "../core/openvpn-analytics";
import { parseSize, parseKeyValues } from "../core/routeros-parse";
import { getConfig } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { getSafeModeManager } from "../ssh/safe-mode";

const INTERVAL = 15_000;
const MAX_GAP = INTERVAL * 3;
const WEEK = 7 * 86400000;
export const PROXY_RANGES = { "15m": 900000, "1h": 3600000, "24h": 86400000, "7d": WEEK };
export type ProxyRange = keyof typeof PROXY_RANGES;

export interface ProxyReading {
  ts: number;
  received: number;
  sent: number;
  requests: number;
  uptime: number;
  clients: number | null;
  servers: number | null;
}

export function proxyReading(output: string, ts: number): ProxyReading | null {
  const kv = parseKeyValues(output);
  const integer = (name: string) => (/^\d+$/.test(kv[name] ?? "") ? Number(kv[name]) : null);
  const received = parseSize(kv["received-from-servers"]);
  const sent = parseSize(kv["sent-to-clients"]);
  const requests = integer("requests");
  const uptime = parseAccountingUptimeSeconds(kv.uptime);
  if (received == null || sent == null || requests == null || uptime == null) return null;
  return {
    ts,
    received,
    sent,
    requests,
    uptime,
    clients: integer("client-connections"),
    servers: integer("server-connections"),
  };
}

// Distribute measured counter deltas over the part of each chart bucket they cover.
// Never bridge a counter reset, proxy restart, or a long sampling outage.
export function proxyReport(rows: ProxyReading[], from: number, to: number) {
  const width = (to - from) / 60;
  const buckets = Array.from({ length: 60 }, (_, i) => ({
    ts: from + (i + 0.5) * width,
    received: 0,
    sent: 0,
    ms: 0,
  }));
  let received = 0,
    sent = 0,
    requests = 0,
    coveredMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!,
      next = rows[i]!,
      elapsed = next.ts - prev.ts;
    if (
      elapsed <= 0 ||
      elapsed > MAX_GAP ||
      next.uptime < prev.uptime ||
      next.received < prev.received ||
      next.sent < prev.sent ||
      next.requests < prev.requests
    )
      continue;
    const start = Math.max(from, prev.ts),
      end = Math.min(to, next.ts);
    if (end <= start) continue;
    const rx = next.received - prev.received,
      tx = next.sent - prev.sent;
    const fraction = (end - start) / elapsed;
    received += rx * fraction;
    sent += tx * fraction;
    requests += (next.requests - prev.requests) * fraction;
    coveredMs += end - start;
    for (
      let j = Math.floor((start - from) / width);
      j < Math.ceil((end - from) / width) && j < buckets.length;
      j++
    ) {
      const bucket = buckets[j]!;
      const ms = Math.min(end, from + (j + 1) * width) - Math.max(start, from + j * width);
      bucket.ms += ms;
      bucket.received += (rx * ms) / elapsed;
      bucket.sent += (tx * ms) / elapsed;
    }
  }
  return {
    from,
    to,
    coveredMs,
    received: Math.round(received),
    sent: Math.round(sent),
    requests: Math.round(requests),
    points: buckets.map((b) => ({
      ts: b.ts,
      rx: b.ms ? (8000 * b.received) / b.ms : null,
      tx: b.ms ? (8000 * b.sent) / b.ms : null,
    })),
  };
}

export class ProxyHistory {
  constructor(private db: Database) {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    db.run(
      "CREATE TABLE IF NOT EXISTS proxy_samples(device TEXT NOT NULL, ts INTEGER NOT NULL, received INTEGER, sent INTEGER, requests INTEGER, uptime INTEGER, clients INTEGER, servers INTEGER, PRIMARY KEY(device,ts)) WITHOUT ROWID",
    );
  }
  record(device: string, r: ProxyReading) {
    this.db.run("INSERT OR REPLACE INTO proxy_samples VALUES(?,?,?,?,?,?,?,?)", [
      device,
      r.ts,
      r.received,
      r.sent,
      r.requests,
      r.uptime,
      r.clients,
      r.servers,
    ]);
  }
  report(device: string, range: ProxyRange, now = Date.now()) {
    const from = now - PROXY_RANGES[range];
    const rows = this.db
      .query<ProxyReading, [string, number, number]>(
        "SELECT ts,received,sent,requests,uptime,clients,servers FROM proxy_samples WHERE device=? AND ts BETWEEN ? AND ? ORDER BY ts",
      )
      .all(device, from - MAX_GAP, now);
    return { ...proxyReport(rows, from, now), latest: rows.at(-1) ?? null };
  }
  prune() {
    this.db.run("DELETE FROM proxy_samples WHERE ts < ?", [Date.now() - WEEK - MAX_GAP]);
  }
  close() {
    this.db.close();
  }
}

export async function openProxyHistory(path: string) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  try {
    chmodSync(path, 0o600);
    return new ProxyHistory(db);
  } catch (e) {
    db.close();
    throw e;
  }
}

export function startProxySampler(history: ProxyHistory) {
  let stopped = false;
  let lastPrune = 0;
  const retry = new Map<string, number>();
  const inFlight = new Set<string>();

  async function sample(device: string) {
    inFlight.add(device);
    try {
      assertDeviceAccess([device], "monitor_web_proxy", "READ");
      const ctx = createContext(undefined, device);
      ctx.risk = "READ";
      const raw = await executeMikrotikCommand("/ip proxy monitor once", ctx);
      if (stopped) return;
      const reading = proxyReading(raw, Date.now());
      if (reading) {
        history.record(device, reading);
        retry.delete(device);
      } else retry.set(device, Date.now() + 60000);
    } catch {
      retry.set(device, Date.now() + 60000);
    } finally {
      inFlight.delete(device);
    }
  }

  function tick() {
    const now = Date.now();
    for (const [device, config] of Object.entries(getConfig().devices)) {
      if (
        !config.disabled &&
        !inFlight.has(device) &&
        (retry.get(device) ?? 0) <= now &&
        !getSafeModeManager(device).isActive
      ) {
        void sample(device);
      }
    }
    if (now - lastPrune > 3600000) {
      lastPrune = now;
      try {
        history.prune();
      } catch (error) {
        logger.warn(`Could not prune web proxy history: ${String(error)}`);
      }
    }
  }
  tick();
  const timer = setInterval(tick, INTERVAL);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
