/**
 * Attack persistence — incidents, their evidence, and every response taken.
 *
 * The response log is the part that has to be durable. A block applied at 3am
 * that nobody can later explain, or reverse, is worse than no block: the
 * operator finds a firewall entry with no story attached and either leaves it
 * forever or removes something that was load-bearing.
 *
 * Shares `events.db` (no new file) and imports `bun:sqlite` **dynamically**, so
 * the Node/Vitest import graph never loads the driver.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_DASHBOARD_DB } from "../config";
import { logger } from "../logger";
import type { Confidence, Incident, Stage } from "./correlate";
import type { DetectorId, Evidence, Severity } from "./detectors";
import type { ResponseAction } from "./respond";

export interface StoredResponse {
  id: number;
  incidentId: string;
  action: ResponseAction;
  source: string;
  devices: string[];
  /** Empty string for a permanent entry. */
  timeout: string;
  list: string;
  reason: string;
  ts: number;
  /** When it lapses, if it was timed. */
  expiresAt?: number;
  /** False when the device refused it — kept, because a failed block is news. */
  ok: boolean;
  error?: string;
  /** Set when it has since been lifted. */
  revokedAt?: number;
}

export interface AttackStore {
  saveIncident(incident: Incident): void;
  getIncident(id: string): Incident | null;
  listIncidents(options?: { since?: number; limit?: number }): Incident[];

  recordResponse(response: Omit<StoredResponse, "id">): number;
  listResponses(options?: { active?: boolean; limit?: number }): StoredResponse[];
  responseFor(source: string): StoredResponse | null;
  revokeResponse(source: string, now: number): boolean;
  /** Successful, un-revoked, un-expired blocks on a device since `since`. */
  countRecentBlocks(devices: string[], since: number): number;

  /** Sources that authenticated successfully in the window — the baseline. */
  recordBaselineSource(device: string, source: string, ts: number): void;
  baselineFor(device: string, windowMs: number, now: number): { sources: string[]; ready: boolean };

  prune(now: number, retainDays: number): number;
  close(): void;
}

interface IncidentRow {
  id: string;
  source: string;
  devices: string;
  stage: string;
  confidence: string;
  severity: string;
  first_ts: number;
  last_ts: number;
  detectors: string;
  narrative: string;
  recommendations: string;
  evidence: string;
  spoofable_only: number;
  signal_count: number;
}

interface ResponseRow {
  id: number;
  incident_id: string;
  action: string;
  source: string;
  devices: string;
  timeout: string;
  list: string;
  reason: string;
  ts: number;
  expires_at: number | null;
  ok: number;
  error: string | null;
  revoked_at: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS attack_incidents (
     id              TEXT PRIMARY KEY,
     source          TEXT NOT NULL,
     devices         TEXT NOT NULL,
     stage           TEXT NOT NULL,
     confidence      TEXT NOT NULL,
     severity        TEXT NOT NULL,
     first_ts        INTEGER NOT NULL,
     last_ts         INTEGER NOT NULL,
     detectors       TEXT NOT NULL,
     narrative       TEXT NOT NULL,
     recommendations TEXT NOT NULL,
     evidence        TEXT NOT NULL,
     spoofable_only  INTEGER NOT NULL,
     signal_count    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attack_responses (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id TEXT NOT NULL,
     action      TEXT NOT NULL,
     source      TEXT NOT NULL,
     devices     TEXT NOT NULL,
     timeout     TEXT NOT NULL,
     list        TEXT NOT NULL,
     reason      TEXT NOT NULL,
     ts          INTEGER NOT NULL,
     expires_at  INTEGER,
     ok          INTEGER NOT NULL,
     error       TEXT,
     revoked_at  INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS attack_baseline (
     device TEXT NOT NULL,
     source TEXT NOT NULL,
     ts     INTEGER NOT NULL,
     PRIMARY KEY (device, source)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_attack_incidents_ts ON attack_incidents(last_ts)",
  "CREATE INDEX IF NOT EXISTS idx_attack_responses_src ON attack_responses(source, ts)",
];

function rowToIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    source: r.source,
    devices: JSON.parse(r.devices) as string[],
    stage: r.stage as Stage,
    confidence: r.confidence as Confidence,
    severity: r.severity as Severity,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    detectors: JSON.parse(r.detectors) as DetectorId[],
    narrative: r.narrative,
    recommendations: JSON.parse(r.recommendations) as string[],
    evidence: JSON.parse(r.evidence) as Evidence[],
    spoofableOnly: r.spoofable_only === 1,
    signalCount: r.signal_count,
  };
}

function rowToResponse(r: ResponseRow): StoredResponse {
  return {
    id: r.id,
    incidentId: r.incident_id,
    action: r.action as ResponseAction,
    source: r.source,
    devices: JSON.parse(r.devices) as string[],
    timeout: r.timeout,
    list: r.list,
    reason: r.reason,
    ts: r.ts,
    expiresAt: r.expires_at ?? undefined,
    ok: r.ok === 1,
    error: r.error ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
  };
}

class SqliteAttackStore implements AttackStore {
  constructor(private readonly db: Database) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA) db.run(stmt);
  }

  saveIncident(incident: Incident): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO attack_incidents
         (id, source, devices, stage, confidence, severity, first_ts, last_ts,
          detectors, narrative, recommendations, evidence, spoofable_only, signal_count)
         VALUES ($id,$source,$devices,$stage,$confidence,$severity,$first,$last,
                 $detectors,$narrative,$recs,$evidence,$spoofable,$signals)`,
      )
      .run({
        $id: incident.id,
        $source: incident.source,
        $devices: JSON.stringify(incident.devices),
        $stage: incident.stage,
        $confidence: incident.confidence,
        $severity: incident.severity,
        $first: incident.firstTs,
        $last: incident.lastTs,
        $detectors: JSON.stringify(incident.detectors),
        $narrative: incident.narrative,
        $recs: JSON.stringify(incident.recommendations),
        $evidence: JSON.stringify(incident.evidence),
        $spoofable: incident.spoofableOnly ? 1 : 0,
        $signals: incident.signalCount,
      });
  }

  getIncident(id: string): Incident | null {
    const row = this.db.query("SELECT * FROM attack_incidents WHERE id = $id").get({ $id: id }) as
      | IncidentRow
      | undefined;
    return row ? rowToIncident(row) : null;
  }

  listIncidents(options: { since?: number; limit?: number } = {}): Incident[] {
    const rows = this.db
      .query(
        `SELECT * FROM attack_incidents WHERE last_ts >= $since
         ORDER BY last_ts DESC LIMIT $limit`,
      )
      .all({ $since: options.since ?? 0, $limit: options.limit ?? 200 }) as IncidentRow[];
    return rows.map(rowToIncident);
  }

  recordResponse(response: Omit<StoredResponse, "id">): number {
    this.db
      .query(
        `INSERT INTO attack_responses
         (incident_id, action, source, devices, timeout, list, reason, ts, expires_at, ok, error, revoked_at)
         VALUES ($incident,$action,$source,$devices,$timeout,$list,$reason,$ts,$expires,$ok,$error,$revoked)`,
      )
      .run({
        $incident: response.incidentId,
        $action: response.action,
        $source: response.source,
        $devices: JSON.stringify(response.devices),
        $timeout: response.timeout,
        $list: response.list,
        $reason: response.reason,
        $ts: response.ts,
        $expires: response.expiresAt ?? null,
        $ok: response.ok ? 1 : 0,
        $error: response.error ?? null,
        $revoked: response.revokedAt ?? null,
      });
    return (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  listResponses(options: { active?: boolean; limit?: number } = {}): StoredResponse[] {
    const rows = this.db
      .query("SELECT * FROM attack_responses ORDER BY ts DESC LIMIT $limit")
      .all({ $limit: options.limit ?? 200 }) as ResponseRow[];
    const all = rows.map(rowToResponse);
    if (!options.active) return all;
    const now = Date.now();
    return all.filter(
      (r) => r.ok && r.revokedAt === undefined && (r.expiresAt === undefined || r.expiresAt > now),
    );
  }

  responseFor(source: string): StoredResponse | null {
    const row = this.db
      .query(
        `SELECT * FROM attack_responses WHERE source = $source AND revoked_at IS NULL AND ok = 1
         ORDER BY ts DESC LIMIT 1`,
      )
      .get({ $source: source }) as ResponseRow | undefined;
    return row ? rowToResponse(row) : null;
  }

  revokeResponse(source: string, now: number): boolean {
    const before = (
      this.db
        .query(
          "SELECT COUNT(*) AS n FROM attack_responses WHERE source = $source AND revoked_at IS NULL",
        )
        .get({ $source: source }) as { n: number }
    ).n;
    this.db
      .query(
        "UPDATE attack_responses SET revoked_at = $now WHERE source = $source AND revoked_at IS NULL",
      )
      .run({ $source: source, $now: now });
    return before > 0;
  }

  countRecentBlocks(devices: string[], since: number): number {
    // The cap is about load on a device, so a response that FAILED does not
    // count toward it — otherwise one unreachable router freezes the responder.
    const rows = this.db
      .query(
        "SELECT devices FROM attack_responses WHERE ts >= $since AND ok = 1 AND action != 'watch'",
      )
      .all({ $since: since }) as { devices: string }[];
    const wanted = new Set(devices);
    let count = 0;
    for (const row of rows) {
      const on = JSON.parse(row.devices) as string[];
      if (on.some((d) => wanted.has(d))) count++;
    }
    return count;
  }

  recordBaselineSource(device: string, source: string, ts: number): void {
    this.db
      .query(
        `INSERT INTO attack_baseline (device, source, ts) VALUES ($device,$source,$ts)
         ON CONFLICT(device, source) DO UPDATE SET ts = $ts`,
      )
      .run({ $device: device, $source: source, $ts: ts });
  }

  baselineFor(
    device: string,
    windowMs: number,
    now: number,
  ): { sources: string[]; ready: boolean } {
    const rows = this.db
      .query("SELECT source, ts FROM attack_baseline WHERE device = $device")
      .all({ $device: device }) as { source: string; ts: number }[];
    const sources = rows.map((r) => r.source);
    // Ready only once the baseline actually spans the window. Before that a
    // "first time I've seen this address" claim is just "first time I looked".
    const oldest = rows.length > 0 ? Math.min(...rows.map((r) => r.ts)) : now;
    return { sources, ready: rows.length > 0 && now - oldest >= windowMs };
  }

  prune(now: number, retainDays: number): number {
    const cutoff = now - retainDays * 86_400_000;
    const before = (
      this.db.query("SELECT COUNT(*) AS n FROM attack_incidents").get() as { n: number }
    ).n;
    this.db.query("DELETE FROM attack_incidents WHERE last_ts < $cutoff").run({ $cutoff: cutoff });
    // Responses are kept longer than incidents on purpose: an entry still in a
    // device's address list must remain explainable.
    this.db
      .query("DELETE FROM attack_responses WHERE ts < $cutoff AND revoked_at IS NOT NULL")
      .run({ $cutoff: cutoff - 30 * 86_400_000 });
    const after = (
      this.db.query("SELECT COUNT(*) AS n FROM attack_incidents").get() as { n: number }
    ).n;
    return before - after;
  }

  close(): void {
    this.db.close();
  }
}

export async function openAttackStore(path: string): Promise<AttackStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  return new SqliteAttackStore(new Database(path, { create: true }));
}

let storePromise: Promise<AttackStore> | null = null;

export function attackStore(): Promise<AttackStore> {
  storePromise ??= openAttackStore(DEFAULT_DASHBOARD_DB);
  return storePromise;
}

let writeFailureLogged = false;

/** Best-effort persistence — detection must not stop because history could not be written. */
export async function persistIncident(incident: Incident): Promise<void> {
  try {
    (await attackStore()).saveIncident(incident);
  } catch (e) {
    if (writeFailureLogged) return;
    writeFailureLogged = true;
    logger.error(
      `attack history unavailable; incidents will not persist: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
