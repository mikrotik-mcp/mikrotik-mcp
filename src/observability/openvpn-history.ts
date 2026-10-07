import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { OpenVpnSession, OpenVpnSnapshot } from "../core/openvpn-sessions-model";

export const OPENVPN_HISTORY_INTERVAL = 15_000;
export interface HistorySession {
  id: string;
  device: string;
  user: string;
  identity: string;
  ip: string;
  tunnel: string;
  started: number;
  firstSeen: number;
  lastSeen: number;
  ended: number | null;
  uptime: number | null;
  uncertain: number;
  country: string;
  countryCode: string;
  asn: string;
  organization: string;
}
export interface HistoryFilter {
  device: string;
  user: string;
  from: number;
  to: number;
  offset: number;
}
export interface HistoryGroup {
  label: string;
  detail: string;
  count: number;
}
export interface OpenVpnHistoryReport {
  generatedAt: number;
  coverage: { first: number; last: number; gaps: number; failures: number } | null;
  users: string[];
  allTime: number;
  totals: {
    connections: number;
    users: number;
    ips: number;
    countries: number;
    networks: number;
    seconds: number;
  };
  timeline: { day: string; count: number }[];
  ips: HistoryGroup[];
  networks: HistoryGroup[];
  countries: HistoryGroup[];
  sessions: HistorySession[];
  offset: number;
  limit: number;
}

/** Uptime-derived start time survives process restarts; tolerate SSH transit/second rounding. */
export function sameObservedSession(previous: HistorySession, session: OpenVpnSession, at: number) {
  if (previous.ended !== null) return false;
  if (session.uptimeSeconds === null || previous.uptime === null)
    return at - previous.lastSeen <= OPENVPN_HISTORY_INTERVAL * 3;
  return (
    session.uptimeSeconds >= previous.uptime &&
    Math.abs(at - session.uptimeSeconds * 1000 - previous.started) <= 20_000
  );
}

/** Local-only history. No credentials, disconnect tickets or raw router output are stored. */
export class OpenVpnHistoryStore {
  private cache = new Map<string, { expires: number; report: OpenVpnHistoryReport }>();
  constructor(private db: Database) {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    db.run(`CREATE TABLE IF NOT EXISTS ovpn_history (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, user TEXT NOT NULL, identity TEXT NOT NULL,
      ip TEXT NOT NULL, tunnel TEXT NOT NULL, started INTEGER NOT NULL, firstSeen INTEGER NOT NULL,
      lastSeen INTEGER NOT NULL, ended INTEGER, uptime INTEGER, uncertain INTEGER NOT NULL,
      country TEXT NOT NULL, countryCode TEXT NOT NULL, asn TEXT NOT NULL, organization TEXT NOT NULL,
      geoStatus TEXT NOT NULL)`);
    db.run(
      "CREATE INDEX IF NOT EXISTS ovpn_history_geo ON ovpn_history(ip,lastSeen) WHERE geoStatus='pending'",
    );
    db.run("CREATE INDEX IF NOT EXISTS ovpn_history_user ON ovpn_history(device,user,started)");
    db.run("CREATE INDEX IF NOT EXISTS ovpn_history_time ON ovpn_history(device,started)");
    db.run("CREATE INDEX IF NOT EXISTS ovpn_history_ip ON ovpn_history(ip)");
    db.run(
      "CREATE INDEX IF NOT EXISTS ovpn_history_active ON ovpn_history(device) WHERE ended IS NULL",
    );
    db.run(`CREATE TABLE IF NOT EXISTS ovpn_coverage (
      device TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL,
      gaps INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0)`);
  }

  ingest(snapshot: OpenVpnSnapshot) {
    const { device, observedAt: at, sessions } = snapshot;
    this.db.transaction(() => {
      const coverage = this.db
        .query<{ last: number }, [string]>("SELECT last FROM ovpn_coverage WHERE device=?")
        .get(device);
      if (coverage && at <= coverage.last) return; // Cached/out-of-order reads cannot end newer sessions.
      const gap = !!coverage && at - coverage.last > OPENVPN_HISTORY_INTERVAL * 3;
      const previous = this.db
        .query<HistorySession, [string]>(
          "SELECT * FROM ovpn_history WHERE device=? AND ended IS NULL",
        )
        .all(device);
      const active = new Map(previous.map((row) => [row.identity, row]));
      for (const session of sessions) {
        const identity = JSON.stringify([
          session.id,
          session.sessionId,
          session.name,
          session.callerId,
          session.address,
        ]);
        const old = active.get(identity);
        const geo = session.sourceGeo;
        if (old && sameObservedSession(old, session, at)) {
          this.db
            .query(`UPDATE ovpn_history SET lastSeen=?,
            started=CASE WHEN uptime IS NULL AND ? IS NOT NULL THEN ? ELSE started END,
            uptime=COALESCE(?,uptime),uncertain=MAX(uncertain,?),
            country=CASE WHEN ?='' THEN country ELSE ? END,
            countryCode=CASE WHEN ?='' THEN countryCode ELSE ? END,
            asn=CASE WHEN ?='' THEN asn ELSE ? END,
            organization=CASE WHEN ?='' THEN organization ELSE ? END,
            geoStatus=CASE WHEN countryCode='' THEN ? ELSE geoStatus END WHERE id=?`)
            .run(
              at,
              session.uptimeSeconds,
              at - (session.uptimeSeconds ?? 0) * 1000,
              session.uptimeSeconds,
              Number(gap || session.uptimeSeconds === null),
              geo?.country ?? "",
              geo?.country ?? "",
              geo?.countryCode ?? "",
              geo?.countryCode ?? "",
              geo?.asn ?? "",
              geo?.asn ?? "",
              geo?.asnOrganization ?? "",
              geo?.asnOrganization ?? "",
              geo?.status ?? "pending",
              old.id,
            );
          active.delete(identity);
        } else {
          this.db
            .query("INSERT INTO ovpn_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              randomUUID(),
              device,
              session.name,
              identity,
              session.callerId,
              session.address,
              at - (session.uptimeSeconds ?? 0) * 1000,
              at,
              at,
              null,
              session.uptimeSeconds,
              Number(gap || session.uptimeSeconds === null),
              geo?.country ?? "",
              geo?.countryCode ?? "",
              geo?.asn ?? "",
              geo?.asnOrganization ?? "",
              geo?.status ?? "pending",
            );
        }
      }
      // This is an upper bound on disconnect time, not an invented exact accounting event.
      for (const row of active.values())
        this.db
          .query("UPDATE ovpn_history SET ended=?,uncertain=MAX(uncertain,?) WHERE id=?")
          .run(at, Number(gap), row.id);
      this.db
        .query(`INSERT INTO ovpn_coverage(device,first,last) VALUES (?,?,?)
        ON CONFLICT(device) DO UPDATE SET last=excluded.last,gaps=gaps+?`)
        .run(device, at, at, Number(gap));
    })();
    // Keep reports warm for 30s even during collection; never recompute per poll or UI viewer.
  }

  failure(device: string) {
    this.db.query("UPDATE ovpn_coverage SET failures=failures+1 WHERE device=?").run(device);
  }

  /** Finish asynchronous GeoIP lookups even when a short session has already ended. */
  enrich(lookup: (ip: string) => OpenVpnSession["sourceGeo"]) {
    const pending = this.db
      .query<{ ip: string }, []>(
        "SELECT ip FROM ovpn_history WHERE geoStatus='pending' GROUP BY ip ORDER BY MAX(lastSeen) DESC LIMIT 100",
      )
      .all();
    for (const { ip } of pending) {
      const geo = lookup(ip);
      if (!geo || geo.status === "pending") continue;
      this.db
        .query(
          "UPDATE ovpn_history SET country=?,countryCode=?,asn=?,organization=?,geoStatus=? WHERE ip=? AND geoStatus='pending'",
        )
        .run(
          geo.country ?? "",
          geo.countryCode ?? "",
          geo.asn ?? "",
          geo.asnOrganization ?? "",
          geo.status,
          ip,
        );
    }
  }

  report(filter: HistoryFilter, now = Date.now()): OpenVpnHistoryReport {
    const key = JSON.stringify(filter);
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) return cached.report;
    const { device, user, from, to, offset } = filter;
    const where = "device=? AND (?='' OR user=?) AND started>=? AND started<=?";
    const args = [device, user, user, from, to];
    const totals = this.db
      .query<OpenVpnHistoryReport["totals"], (string | number)[]>(`SELECT
      COUNT(*) connections,COUNT(DISTINCT user) users,COUNT(DISTINCT NULLIF(ip,'')) ips,
      COUNT(DISTINCT NULLIF(countryCode,'')) countries,COUNT(DISTINCT NULLIF(asn,'')) networks,
      COALESCE(SUM(uptime),0) seconds FROM ovpn_history WHERE ${where}`)
      .get(...args)!;
    const groups = (label: string, detail: string) =>
      this.db
        .query<HistoryGroup, (string | number)[]>(
          `SELECT ${label} label,${detail} detail,COUNT(*) count FROM ovpn_history WHERE ${where}
       GROUP BY label ORDER BY count DESC,label LIMIT 20`,
        )
        .all(...args);
    const dayMs = 86400000;
    const lastDay = Math.floor(Math.min(to, now) / dayMs) * dayMs;
    const firstDay = Math.max(Math.floor(from / dayMs) * dayMs, lastDay - 89 * dayMs);
    const daily = new Map(
      this.db
        .query<{ day: string; count: number }, (string | number)[]>(
          `SELECT strftime('%Y-%m-%d',started/1000,'unixepoch') day,COUNT(*) count FROM ovpn_history WHERE ${where} AND started>=? GROUP BY day`,
        )
        .all(...args, firstDay)
        .map((row) => [row.day, row.count]),
    );
    const timeline: OpenVpnHistoryReport["timeline"] = [];
    for (let at = firstDay; at <= lastDay; at += dayMs) {
      const day = new Date(at).toISOString().slice(0, 10);
      timeline.push({ day, count: daily.get(day) ?? 0 });
    }
    const report: OpenVpnHistoryReport = {
      generatedAt: now,
      coverage: this.db
        .query<NonNullable<OpenVpnHistoryReport["coverage"]>, [string]>(
          "SELECT first,last,gaps,failures FROM ovpn_coverage WHERE device=?",
        )
        .get(device),
      users: this.db
        .query<{ user: string }, [string]>(
          "SELECT DISTINCT user FROM ovpn_history WHERE device=? ORDER BY user LIMIT 10000",
        )
        .all(device)
        .map((r) => r.user),
      allTime: this.db
        .query<{ n: number }, string[]>(
          "SELECT COUNT(*) n FROM ovpn_history WHERE device=? AND (?='' OR user=?)",
        )
        .get(device, user, user)!.n,
      totals,
      timeline,
      ips: groups("COALESCE(NULLIF(ip,''),'Unknown IP')", "MAX(organization)"),
      networks: groups("COALESCE(NULLIF(asn,''),'Unknown ASN')", "MAX(organization)"),
      countries: groups("COALESCE(NULLIF(country,''),'Unknown country')", "MAX(countryCode)"),
      sessions: this.db
        .query<HistorySession, (string | number)[]>(
          `SELECT * FROM ovpn_history WHERE ${where} ORDER BY started DESC,id LIMIT 50 OFFSET ?`,
        )
        .all(...args, offset),
      offset,
      limit: 50,
    };
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: now + 30_000, report });
    return report;
  }

  close() {
    this.cache.clear();
    this.db.close();
  }
}

export async function openOpenVpnHistory(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  try {
    return new OpenVpnHistoryStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
