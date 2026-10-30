import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import type { Database } from "bun:sqlite";
import type { FlowRecord } from "../flows/decode";
import { ipv6 } from "../flows/decode";
import { isPublicIpLiteral } from "./geo";

export interface SiteVisit {
  client: string;
  destination: string;
  domain: string | null;
  source: "flow" | "dns+flow" | "proxy";
  firstSeen: number;
  lastSeen: number;
  bytes: number;
  connections: number;
  kind: string;
  owner: string;
  device: string;
}

export interface SiteIdentity {
  client: string;
  kind: string;
  owner: string;
  device: string;
  mac: string;
  observed: number;
}
export interface SitePolicy {
  enabled: boolean;
  owners: string[];
  until: number | null;
}
export interface SiteFilters {
  from: number;
  to: number;
  client: string;
  search: string;
  kind: string;
  owner: string;
}
export interface SiteSummary {
  observations: number;
  bytes: number;
  destinations: number;
  clients: number;
  groups: { label: string; observations: number; bytes: number }[];
}

export interface SiteActivityStore {
  answer(client: string, destination: string, domain: string, expires: number, seen: number): void;
  flows(records: FlowRecord[]): void;
  proxy(id: string, client: string, host: string, at: number): void;
  proxyDestination(client: string, destination: string, at: number, bytes: number): void;
  identify(rows: SiteIdentity[]): void;
  policy(): SitePolicy;
  setPolicy(policy: SitePolicy): void;
  allows(client: string, at: number): boolean;
  identities(from: number, to: number): SiteIdentity[];
  visits(filters: SiteFilters, offset: number, limit?: number): SiteVisit[];
  summary(filters: SiteFilters): SiteSummary;
  clients(from: number, to: number): string[];
  prune(now: number): void;
  close(): void;
}

export function validSiteHost(host: string): string | null {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (normalized.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized))
    return null;
  if (isIP(normalized)) return null;
  const labels = normalized.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
    )
  )
    return null;
  return normalized;
}

/** DNS response from an Ethernet/TZSP mirror. Only A/AAAA answers for the original question count. */
export function dnsAnswers(
  frame: Uint8Array,
  seen: number,
): {
  client: string;
  destination: string;
  domain: string;
  expires: number;
  seen: number;
}[] {
  const u16 = (at: number) => (frame[at] << 8) | frame[at + 1];
  const u32 = (at: number) =>
    (frame[at] * 2 ** 24 + frame[at + 1] * 2 ** 16 + frame[at + 2] * 256 + frame[at + 3]) >>> 0;
  if (frame.length < 42) return [];
  let l3 = 14;
  let eth = u16(12);
  if (eth === 0x8100) {
    l3 += 4;
    eth = u16(16);
  }
  let udp: number;
  let client: string;
  if (eth === 0x0800) {
    if (frame.length < l3 + 20 || frame[l3 + 9] !== 17 || u16(l3 + 6) & 0x3fff) return [];
    udp = l3 + (frame[l3] & 15) * 4;
    client = `${frame[l3 + 16]}.${frame[l3 + 17]}.${frame[l3 + 18]}.${frame[l3 + 19]}`;
  } else if (eth === 0x86dd) {
    if (frame.length < l3 + 40 || frame[l3 + 6] !== 17) return [];
    udp = l3 + 40;
    client = ipv6(frame, l3 + 24);
  } else return [];
  if (frame.length < udp + 20 || u16(udp) !== 53) return [];
  const end = Math.min(frame.length, udp + u16(udp + 4));
  const dns = udp + 8;
  if (
    end < dns + 12 ||
    !(u16(dns + 2) & 0x8000) ||
    u16(dns + 2) & 0x000f ||
    u16(dns + 4) !== 1 ||
    u16(dns + 6) > 32
  )
    return [];
  function name(at: number): { value: string; next: number } | null {
    const labels: string[] = [];
    let next = at;
    let jumped = false;
    const visited = new Set<number>();
    for (let i = 0; i < 64; i++) {
      if (at >= end || visited.has(at)) return null;
      visited.add(at);
      const len = frame[at++];
      if ((len & 0xc0) === 0xc0) {
        if (at >= end) return null;
        const pointer = dns + (((len & 0x3f) << 8) | frame[at++]);
        if (pointer >= end || pointer < dns) return null;
        if (!jumped) next = at;
        jumped = true;
        at = pointer;
        continue;
      }
      if (len & 0xc0) return null;
      if (!len) return { value: labels.join("."), next: jumped ? next : at };
      if (len > 63 || at + len > end) return null;
      labels.push(String.fromCharCode(...frame.subarray(at, at + len)));
      at += len;
    }
    return null;
  }
  const question = name(dns + 12);
  if (!question || question.next + 4 > end) return [];
  const domain = validSiteHost(question.value);
  if (!domain) return [];
  let at = question.next + 4;
  const answers: ReturnType<typeof dnsAnswers> = [];
  for (let i = 0; i < u16(dns + 6); i++) {
    const rr = name(at);
    if (!rr || rr.next + 10 > end) return [];
    at = rr.next;
    const kind = u16(at),
      klass = u16(at + 2),
      ttl = u32(at + 4),
      size = u16(at + 8);
    at += 10;
    if (at + size > end) return [];
    if (rr.value.toLowerCase().replace(/\.$/, "") === domain && klass === 1 && ttl > 0) {
      const destination =
        kind === 1 && size === 4
          ? `${frame[at]}.${frame[at + 1]}.${frame[at + 2]}.${frame[at + 3]}`
          : kind === 28 && size === 16
            ? ipv6(frame, at)
            : null;
      if (destination && isPublicIpLiteral(destination))
        answers.push({
          client,
          destination,
          domain,
          seen,
          expires: seen + Math.min(ttl, 86_400) * 1000,
        });
    }
    at += size;
  }
  return answers;
}

/** RouterOS web-proxy memory-log message: retain host only, never full URL or path. */
export function proxyVisit(message: string): { client: string; host: string } | null {
  const client = /(?:\b(?:from|src(?:-address)?)\s*[=:]?\s*)(\d{1,3}(?:\.\d{1,3}){3})\b/i.exec(
    message,
  )?.[1];
  const target = /\b(?:CONNECT\s+|https?:\/\/)([^\s/"?]+)/i.exec(message)?.[1];
  if (!client || isIP(client) !== 4 || !target) return null;
  const host = validSiteHost(target.replace(/:\d+$/, ""));
  return host ? { client, host } : null;
}

class SqliteSiteActivityStore implements SiteActivityStore {
  private currentPolicy: SitePolicy = { enabled: true, owners: [], until: null };
  constructor(private db: Database) {
    db.run("PRAGMA journal_mode=WAL");
    db.run(
      `CREATE TABLE IF NOT EXISTS site_dns (client TEXT, destination TEXT, domain TEXT, seen INTEGER, expires INTEGER, PRIMARY KEY(client,destination,domain,seen))`,
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS site_dns_lookup ON site_dns(client,destination,seen,expires)",
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS site_activity (client TEXT, destination TEXT, domain TEXT NOT NULL, source TEXT, bucket INTEGER, first_seen INTEGER, last_seen INTEGER, bytes INTEGER, connections INTEGER, PRIMARY KEY(client,destination,domain,source,bucket))`,
    );
    db.run("CREATE INDEX IF NOT EXISTS site_activity_time ON site_activity(last_seen)");
    db.run("CREATE INDEX IF NOT EXISTS site_activity_client ON site_activity(client,last_seen)");
    db.run(
      "CREATE TABLE IF NOT EXISTS site_proxy_ids (id TEXT PRIMARY KEY, seen INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS site_identity (client TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, device TEXT NOT NULL, mac TEXT NOT NULL, observed INTEGER NOT NULL, PRIMARY KEY(client,device,observed))",
    );
    db.run("CREATE INDEX IF NOT EXISTS site_identity_lookup ON site_identity(client,observed)");
    db.run(
      "CREATE TABLE IF NOT EXISTS site_policy (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, owners TEXT NOT NULL, until INTEGER)",
    );
    const saved = db.query("SELECT enabled,owners,until FROM site_policy WHERE id=1").get() as {
      enabled: number;
      owners: string;
      until: number | null;
    } | null;
    if (saved)
      this.currentPolicy = {
        enabled: !!saved.enabled,
        owners: JSON.parse(saved.owners) as string[],
        until: saved.until,
      };
  }
  answer(client: string, destination: string, domain: string, expires: number, seen: number): void {
    if (
      !isIP(client) ||
      !this.allows(client, seen) ||
      !isPublicIpLiteral(destination) ||
      !validSiteHost(domain) ||
      expires <= seen
    )
      return;
    this.db
      .query("INSERT OR IGNORE INTO site_dns VALUES (?,?,?,?,?)")
      .run(client, destination, domain, seen, expires);
  }
  flows(records: FlowRecord[]): void {
    const match = this.db.query(
      "SELECT DISTINCT domain FROM site_dns WHERE client=? AND destination=? AND seen<=? AND expires>=? LIMIT 2",
    );
    const upsert = this.db.query(`INSERT INTO site_activity VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(client,destination,domain,source,bucket) DO UPDATE SET
      first_seen=MIN(first_seen,excluded.first_seen), last_seen=MAX(last_seen,excluded.last_seen),
      bytes=bytes+excluded.bytes, connections=connections+1`);
    this.db.transaction(() => {
      for (const r of records) {
        if (
          !isPublicIpLiteral(r.dst) ||
          !isIP(r.src) ||
          !this.allows(r.src, r.start) ||
          ![80, 443].includes(r.dstPort) ||
          ![6, 17].includes(r.protocol)
        )
          continue;
        const domains = match.all(r.src, r.dst, r.start, r.start) as { domain: string }[];
        const domain = domains.length === 1 ? domains[0].domain : "";
        upsert.run(
          r.src,
          r.dst,
          domain,
          domain ? "dns+flow" : "flow",
          Math.floor(r.start / 300_000) * 300_000,
          r.start,
          r.end,
          Math.max(0, r.bytes),
        );
      }
    })();
  }
  proxy(id: string, client: string, host: string, at: number): void {
    if (!id || !isIP(client) || !this.allows(client, at) || !validSiteHost(host)) return;
    this.db.transaction(() => {
      const inserted = this.db
        .query("INSERT OR IGNORE INTO site_proxy_ids VALUES (?,?)")
        .run(id, at);
      if (!inserted.changes) return;
      this.db
        .query(`INSERT INTO site_activity VALUES (?,?,?,?,?,?,?,?,1)
        ON CONFLICT(client,destination,domain,source,bucket) DO UPDATE SET
        last_seen=MAX(last_seen,excluded.last_seen),connections=connections+1`)
        .run(client, "", host, "proxy", Math.floor(at / 300_000) * 300_000, at, at, 0);
    })();
  }
  proxyDestination(client: string, destination: string, at: number, bytes: number): void {
    if (!isIP(client) || !this.allows(client, at) || !isPublicIpLiteral(destination)) return;
    this.db
      .query(`INSERT INTO site_activity VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(client,destination,domain,source,bucket) DO UPDATE SET
      last_seen=MAX(last_seen,excluded.last_seen),bytes=MAX(bytes,excluded.bytes)`)
      .run(
        client,
        destination,
        "",
        "proxy",
        Math.floor(at / 300_000) * 300_000,
        at,
        at,
        Math.max(0, bytes),
      );
  }
  identify(rows: SiteIdentity[]): void {
    const insert = this.db.query("INSERT OR REPLACE INTO site_identity VALUES (?,?,?,?,?,?)");
    this.db.transaction(() => {
      for (const row of rows)
        if (isIP(row.client) && row.owner && row.observed > 0)
          insert.run(row.client, row.kind, row.owner, row.device, row.mac, row.observed);
    })();
  }
  policy(): SitePolicy {
    return { ...this.currentPolicy, owners: [...this.currentPolicy.owners] };
  }
  setPolicy(policy: SitePolicy): void {
    this.db
      .query("INSERT OR REPLACE INTO site_policy VALUES (1,?,?,?)")
      .run(policy.enabled ? 1 : 0, JSON.stringify(policy.owners), policy.until);
    this.currentPolicy = { ...policy, owners: [...policy.owners] };
  }
  allows(client: string, at: number): boolean {
    const policy = this.currentPolicy;
    if (!policy.enabled || (policy.until !== null && at >= policy.until)) return false;
    if (!policy.owners.length) return true;
    const identity = this.db
      .query(
        "SELECT owner FROM site_identity WHERE client=? AND observed<=? AND observed>=? ORDER BY observed DESC LIMIT 1",
      )
      .get(client, at, at - 600_000) as { owner: string } | null;
    return !!identity && policy.owners.includes(identity.owner);
  }
  identities(from: number, to: number): SiteIdentity[] {
    return this.db
      .query<SiteIdentity, [number, number]>(
        "SELECT client,kind,owner,device,mac,MAX(observed) observed FROM site_identity WHERE observed>=? AND observed<=? GROUP BY client,kind,owner,device,mac ORDER BY owner LIMIT 1000",
      )
      .all(from - 600_000, to);
  }
  private static readonly ENRICHED = `WITH enriched AS (
    SELECT a.*, CASE WHEN a.source='proxy' THEN 'proxy' ELSE COALESCE(i.kind,'unknown') END kind,
      CASE WHEN a.source='proxy' THEN a.client ELSE COALESCE(i.owner,'') END owner,
      COALESCE(i.device,'') device
    FROM site_activity a LEFT JOIN site_identity i ON i.rowid=(
      SELECT rowid FROM site_identity WHERE client=a.client AND observed<=a.last_seen
        AND observed>=a.first_seen-600000 ORDER BY observed DESC LIMIT 1)
    WHERE a.last_seen>=? AND a.first_seen<? AND (?='' OR a.client=?)
      AND (?='' OR a.domain LIKE ? OR a.destination LIKE ?))`;
  private filterArgs(f: SiteFilters): (string | number)[] {
    return [
      f.from,
      f.to,
      f.client,
      f.client,
      f.search,
      `%${f.search}%`,
      `%${f.search}%`,
      f.kind,
      f.kind,
      f.owner,
      f.owner,
    ];
  }
  visits(filters: SiteFilters, offset: number, limit = 100): SiteVisit[] {
    const rows = this.db
      .query(`${SqliteSiteActivityStore.ENRICHED}
      SELECT client,destination,domain,source,kind,owner,device,MIN(first_seen) firstSeen,MAX(last_seen) lastSeen,SUM(bytes) bytes,SUM(connections) connections
      FROM enriched WHERE (?='' OR kind=?) AND (?='' OR owner=?)
      GROUP BY client,destination,domain,source,kind,owner,device ORDER BY lastSeen DESC LIMIT ? OFFSET ?`)
      .all(...this.filterArgs(filters), limit, offset) as (SiteVisit & { domain: string })[];
    return rows.map((r) => ({ ...r, domain: r.domain || null }));
  }
  summary(filters: SiteFilters): SiteSummary {
    const where = "FROM enriched WHERE (?='' OR kind=?) AND (?='' OR owner=?)";
    const args = this.filterArgs(filters);
    const totals = this.db
      .query(`${SqliteSiteActivityStore.ENRICHED}
      SELECT COALESCE(SUM(connections),0) observations,COALESCE(SUM(bytes),0) bytes,
      COUNT(DISTINCT COALESCE(NULLIF(domain,''),destination)) destinations,COUNT(DISTINCT client) clients ${where}`)
      .get(...args) as Omit<SiteSummary, "groups">;
    const groups = this.db
      .query(`${SqliteSiteActivityStore.ENRICHED}
      SELECT COALESCE(NULLIF(domain,''),destination) label,SUM(connections) observations,SUM(bytes) bytes ${where}
      GROUP BY label ORDER BY observations DESC LIMIT 30`)
      .all(...args) as SiteSummary["groups"];
    return { ...totals, groups };
  }
  clients(from: number, to: number): string[] {
    return (
      this.db
        .query(
          "SELECT DISTINCT client FROM site_activity WHERE last_seen>=? AND first_seen<? ORDER BY client LIMIT 500",
        )
        .all(from, to) as { client: string }[]
    ).map((r) => r.client);
  }
  prune(now: number): void {
    this.db.query("DELETE FROM site_dns WHERE expires<?").run(now);
    const cutoff = now - 30 * 86_400_000;
    this.db.query("DELETE FROM site_activity WHERE last_seen<?").run(cutoff);
    this.db.query("DELETE FROM site_activity WHERE first_seen>?").run(now + 300_000);
    this.db.query("DELETE FROM site_proxy_ids WHERE seen<?").run(cutoff);
    this.db.query("DELETE FROM site_identity WHERE observed<?").run(cutoff - 600_000);
  }
  close(): void {
    this.db.close();
  }
}

export async function openSiteActivityStore(path: string): Promise<SiteActivityStore> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  try {
    return new SqliteSiteActivityStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
