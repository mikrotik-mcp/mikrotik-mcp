/**
 * Persistence for configuration snapshots, backed by Bun's native SQLite.
 *
 * Mirrors `src/observability/store.ts`: `bun:sqlite` is imported **dynamically**
 * inside {@link openSnapshotStore} so this module stays safe to reference from
 * the Node-loaded import graph (the catalog test pulls in the snapshot tool,
 * which statically references — but never calls at import time — this factory).
 * Only *types* from `bun:sqlite` are imported statically, and those are erased
 * at compile time.
 *
 * Unlike the observability event store, snapshots are NOT gated on `--dashboard`
 * — they are a first-class tool feature and persist to their own database
 * (`~/.mikrotik-mcp/snapshots.db` by default) regardless of dashboard state.
 */
import { noteSnapshot } from "./git-mirror";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

/** One stored point-in-time configuration export for a device. */
export interface Snapshot {
  /** `snap_<ts>_<sha8>` — globally unique, time-sortable. */
  id: string;
  /** Configured device name this snapshot was captured from. */
  device: string;
  /** Capture time (epoch ms). */
  ts: number;
  /** Optional human label ("pre-firewall-change", "nightly", …). */
  label?: string;
  /** RouterOS version parsed from the export header, when known. */
  rosVersion?: string;
  /** The raw `/export` body as returned by the device. */
  body: string;
  /** Byte length of {@link body}. */
  bytes: number;
  /** Line count of {@link body}. */
  lines: number;
  /** Fingerprint of the *normalised* body (volatile header stripped). */
  sha: string;
}

/** A golden-config baseline pointer for a device. */
export interface Baseline {
  device: string;
  /** The snapshot id designated as the golden config. */
  snapshotId: string;
  /** When the baseline was set (epoch ms). */
  setAt: number;
  /** Who/what set the baseline (e.g. "agent", "dashboard"). */
  setBy: string;
  label?: string;
  notes?: string;
}

/** Storage interface (a SQLite implementation today; a fake in tests). */
export interface SnapshotStore {
  insert(s: Snapshot): void;
  get(id: string): Snapshot | null;
  /** Most recent snapshot for a device, or null when none exist. */
  latest(device: string): Snapshot | null;
  /** Snapshots for a device, newest first. `withBody` defaults to false (metadata only). */
  list(device: string, limit?: number, withBody?: boolean): Snapshot[];
  /** Total snapshots stored for a device. */
  count(device: string): number;
  /** Delete specific snapshots by id. Returns the number of rows removed. */
  delete(ids: string[]): number;

  // ── Baselines (golden config) ───────────────────────────────────────────
  /** Designate a snapshot as the golden baseline for a device (upsert). */
  setBaseline(
    device: string,
    snapshotId: string,
    setBy?: string,
    label?: string,
    notes?: string,
  ): void;
  /** Get the golden baseline for a device, or null if none is set. */
  getBaseline(device: string): Baseline | null;
  /** Remove the golden baseline for a device. Returns true if one was removed. */
  removeBaseline(device: string): boolean;
  /** List all golden baselines across all devices. */
  listBaselines(): Baseline[];

  close(): void;
}

interface Row {
  id: string;
  device: string;
  ts: number;
  label: string | null;
  ros_version: string | null;
  body: string;
  bytes: number;
  lines: number;
  sha: string;
}

interface BaselineRow {
  device: string;
  snapshot_id: string;
  set_at: number;
  set_by: string;
  label: string | null;
  notes: string | null;
}

function rowToBaseline(r: BaselineRow): Baseline {
  return {
    device: r.device,
    snapshotId: r.snapshot_id,
    setAt: r.set_at,
    setBy: r.set_by,
    label: r.label ?? undefined,
    notes: r.notes ?? undefined,
  };
}

function rowToSnapshot(r: Row, body: string): Snapshot {
  return {
    id: r.id,
    device: r.device,
    ts: r.ts,
    label: r.label ?? undefined,
    rosVersion: r.ros_version ?? undefined,
    body,
    bytes: r.bytes,
    lines: r.lines,
    sha: r.sha,
  };
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY,
     device TEXT NOT NULL,
     ts INTEGER NOT NULL,
     label TEXT,
     ros_version TEXT,
     body TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     lines INTEGER NOT NULL,
     sha TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_snapshots_device_ts ON snapshots(device, ts)",
  `CREATE TABLE IF NOT EXISTS baselines (
     device       TEXT PRIMARY KEY,
     snapshot_id  TEXT NOT NULL,
     set_at       INTEGER NOT NULL,
     set_by       TEXT NOT NULL DEFAULT 'agent',
     label        TEXT,
     notes        TEXT
   )`,
];

class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  insert(s: Snapshot): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO snapshots
         (id, device, ts, label, ros_version, body, bytes, lines, sha)
         VALUES ($id,$device,$ts,$label,$ver,$body,$bytes,$lines,$sha)`,
      )
      .run({
        $id: s.id,
        $device: s.device,
        $ts: s.ts,
        $label: s.label ?? null,
        $ver: s.rosVersion ?? null,
        $body: s.body,
        $bytes: s.bytes,
        $lines: s.lines,
        $sha: s.sha,
      });
    // After the row is stored: the Git mirror, when it is on.
    noteSnapshot(s);
  }

  get(id: string): Snapshot | null {
    const row = this.db
      .query("SELECT * FROM snapshots WHERE id = $id")
      .get({ $id: id }) as Row | null;
    return row ? rowToSnapshot(row, row.body) : null;
  }

  latest(device: string): Snapshot | null {
    const row = this.db
      .query("SELECT * FROM snapshots WHERE device = $d ORDER BY ts DESC LIMIT 1")
      .get({ $d: device }) as Row | null;
    return row ? rowToSnapshot(row, row.body) : null;
  }

  list(device: string, limit = 50, withBody = false): Snapshot[] {
    // Metadata listings skip the (potentially large) body column entirely.
    const cols = withBody ? "*" : "id, device, ts, label, ros_version, bytes, lines, sha";
    const n = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .query(`SELECT ${cols} FROM snapshots WHERE device = $d ORDER BY ts DESC LIMIT $n`)
      .all({ $d: device, $n: n }) as Row[];
    return rows.map((r) => rowToSnapshot(r, withBody ? r.body : ""));
  }

  count(device: string): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM snapshots WHERE device = $d")
      .get({ $d: device }) as { n: number };
    return r.n;
  }

  delete(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, j) => `$id${j}`).join(",");
    const params: Record<string, string> = {};
    ids.forEach((id, j) => {
      params[`$id${j}`] = id;
    });
    const res = this.db.query(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(params);
    return Number(res.changes ?? 0);
  }

  // ── Baselines ──────────────────────────────────────────────────────────

  setBaseline(
    device: string,
    snapshotId: string,
    setBy = "agent",
    label?: string,
    notes?: string,
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO baselines (device, snapshot_id, set_at, set_by, label, notes)
         VALUES ($device, $snapId, $setAt, $setBy, $label, $notes)`,
      )
      .run({
        $device: device,
        $snapId: snapshotId,
        $setAt: Date.now(),
        $setBy: setBy,
        $label: label ?? null,
        $notes: notes ?? null,
      });
  }

  getBaseline(device: string): Baseline | null {
    const row = this.db
      .query("SELECT * FROM baselines WHERE device = $d")
      .get({ $d: device }) as BaselineRow | null;
    return row ? rowToBaseline(row) : null;
  }

  removeBaseline(device: string): boolean {
    const res = this.db.query("DELETE FROM baselines WHERE device = $d").run({ $d: device });
    return (res.changes ?? 0) > 0;
  }

  listBaselines(): Baseline[] {
    const rows = this.db
      .query("SELECT * FROM baselines ORDER BY set_at DESC")
      .all() as BaselineRow[];
    return rows.map(rowToBaseline);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) a SQLite-backed snapshot store at `path` (`:memory:` for an
 * ephemeral store). Dynamically imports `bun:sqlite` so this module is safe to
 * reference from Node-loaded code paths that never call it.
 */
export async function openSnapshotStore(path: string): Promise<SnapshotStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteSnapshotStore(db);
}
