/**
 * Alert history — which rules fired and resolved, and how delivery went.
 *
 * Shares `events.db` with the observability store rather than opening a second
 * file: the retention story, the backup story and the "where is my data" story
 * all stay singular.
 *
 * `bun:sqlite` is imported **dynamically**, matching `observability/store.ts`.
 * The Vitest import graph aliases `"bun"` to an inert stub and must never load
 * the real driver, so this module exports types statically and the driver is
 * only reached inside `openAlertStore()`.
 */
import type { AlertNotification, DeliveryResult } from "./channels";

/** One fired-or-resolved alert, as persisted. */
export interface AlertRecord {
  id: string;
  ruleId: string;
  kind: "fire" | "resolve";
  severity: string;
  title: string;
  body: string;
  device?: string;
  ts: number;
  /** Per-channel outcome, already redacted — never carries a webhook URL. */
  deliveries: { channel: string; ok: boolean; status?: number; error?: string; attempts: number }[];
}

export interface AlertStore {
  insert(record: AlertRecord): void;
  /** Most recent first, newest `limit` within the window. */
  list(opts?: { sinceMs?: number; ruleId?: string; limit?: number }): AlertRecord[];
  prune(maxRecords: number): void;
  close(): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alerts (
     id TEXT PRIMARY KEY,
     ts INTEGER NOT NULL,
     rule_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     severity TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     device TEXT,
     deliveries TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts)",
  "CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id)",
];

interface Row {
  id: string;
  ts: number;
  rule_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  device: string | null;
  deliveries: string;
}

function toRecord(r: Row): AlertRecord {
  let deliveries: AlertRecord["deliveries"] = [];
  try {
    deliveries = JSON.parse(r.deliveries) as AlertRecord["deliveries"];
  } catch {
    // A corrupt row should cost its delivery detail, not the whole history.
  }
  return {
    id: r.id,
    ts: r.ts,
    ruleId: r.rule_id,
    kind: r.kind as AlertRecord["kind"],
    severity: r.severity,
    title: r.title,
    body: r.body,
    device: r.device ?? undefined,
    deliveries,
  };
}

/**
 * Build a persisted record from a notification and its delivery outcomes.
 *
 * Deliberately drops everything except channel name and outcome — a
 * `DeliveryResult` never carries the URL, and this keeps it that way by
 * construction rather than by remembering to strip it.
 */
export function toAlertRecord(
  n: AlertNotification,
  results: DeliveryResult[],
  id: string,
): AlertRecord {
  return {
    id,
    ruleId: n.ruleId,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    device: n.device,
    ts: n.at,
    deliveries: results.map((r) => ({
      channel: r.channel,
      ok: r.ok,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
    })),
  };
}

/** Open (and migrate) the alert history table inside `events.db`. */
export async function openAlertStore(path: string): Promise<AlertStore> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  for (const stmt of SCHEMA) db.run(stmt);

  return {
    insert(record) {
      db.query(
        `INSERT OR REPLACE INTO alerts
           (id, ts, rule_id, kind, severity, title, body, device, deliveries)
         VALUES ($id,$ts,$rule,$kind,$sev,$title,$body,$device,$deliveries)`,
      ).run({
        $id: record.id,
        $ts: record.ts,
        $rule: record.ruleId,
        $kind: record.kind,
        $sev: record.severity,
        $title: record.title,
        $body: record.body,
        $device: record.device ?? null,
        $deliveries: JSON.stringify(record.deliveries),
      });
    },

    list(opts = {}) {
      const since = opts.sinceMs ?? 0;
      const limit = Math.min(opts.limit ?? 200, 1000);
      const rows = opts.ruleId
        ? db
            .query(`SELECT * FROM alerts WHERE ts >= $s AND rule_id = $r ORDER BY ts DESC LIMIT $l`)
            .all({ $s: since, $r: opts.ruleId, $l: limit })
        : db
            .query(`SELECT * FROM alerts WHERE ts >= $s ORDER BY ts DESC LIMIT $l`)
            .all({ $s: since, $l: limit });
      return (rows as Row[]).map(toRecord);
    },

    prune(maxRecords) {
      db.run(
        `DELETE FROM alerts WHERE id NOT IN (
           SELECT id FROM alerts ORDER BY ts DESC LIMIT ?
         )`,
        [maxRecords],
      );
    },

    close() {
      db.close();
    },
  };
}
