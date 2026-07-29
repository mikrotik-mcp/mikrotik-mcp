/**
 * Rollout history — persistence for staged fleet rollouts.
 *
 * Shares `snapshots.db` (no new database file), because a rollout's per-device
 * `snapshotId` is the thing that makes it recoverable: keeping the history in
 * the same file as the snapshots it references stops the two from drifting
 * apart or being pruned independently.
 *
 * `bun:sqlite` is imported **dynamically** inside {@link openRolloutStore} so
 * this module stays safe to reference from the Node/Vitest import graph, which
 * aliases `"bun"` and must never load the real driver.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { DeviceState, GateResult, RolloutOutcome, RolloutState, Wave } from "./model";

export interface RolloutRecord {
  id: string;
  /** When the rollout started (epoch ms). */
  ts: number;
  updated: number;
  /** Human label, usually what the change is ("ntp servers"). */
  label?: string;
  /** The commands this rollout applies, for the history view. */
  commands: string[];
  waves: Wave[];
  devices: DeviceState[];
  gates: GateResult[];
  phase: string;
  outcome?: RolloutOutcome;
  notes: string[];
}

/** One step of a rollout's timeline (append-only). */
export interface RolloutEventRow {
  rolloutId: string;
  seq: number;
  ts: number;
  /** apply | gate | soak | revert | hold. */
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}

export interface RolloutStore {
  save(record: RolloutRecord): void;
  get(id: string): RolloutRecord | null;
  list(limit?: number): RolloutRecord[];
  appendEvent(event: Omit<RolloutEventRow, "seq">): number;
  events(rolloutId: string): RolloutEventRow[];
  remove(id: string): boolean;
  close(): void;
}

/** Snapshot the live model state into a persistable record. */
export function toRecord(
  rollout: RolloutState,
  ts: number,
  opts: { label?: string; commands?: string[] } = {},
): RolloutRecord {
  return {
    id: rollout.id,
    ts,
    updated: ts,
    label: opts.label,
    commands: opts.commands ?? [],
    waves: rollout.waves,
    devices: rollout.devices,
    gates: rollout.gates,
    phase: rollout.phase,
    outcome: rollout.outcome,
    notes: rollout.notes,
  };
}

interface Row {
  id: string;
  ts: number;
  updated: number;
  label: string | null;
  commands: string;
  waves: string;
  devices: string;
  gates: string;
  phase: string;
  outcome: string | null;
  notes: string;
}

interface EventRow {
  rollout_id: string;
  seq: number;
  ts: number;
  kind: string;
  device: string | null;
  ok: number;
  detail: string | null;
}

function rowToRecord(r: Row): RolloutRecord {
  return {
    id: r.id,
    ts: r.ts,
    updated: r.updated,
    label: r.label ?? undefined,
    commands: JSON.parse(r.commands) as string[],
    waves: JSON.parse(r.waves) as Wave[],
    devices: JSON.parse(r.devices) as DeviceState[],
    gates: JSON.parse(r.gates) as GateResult[],
    phase: r.phase,
    outcome: (r.outcome ?? undefined) as RolloutOutcome | undefined,
    notes: JSON.parse(r.notes) as string[],
  };
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS rollouts (
     id       TEXT PRIMARY KEY,
     ts       INTEGER NOT NULL,
     updated  INTEGER NOT NULL,
     label    TEXT,
     commands TEXT NOT NULL,
     waves    TEXT NOT NULL,
     devices  TEXT NOT NULL,
     gates    TEXT NOT NULL,
     phase    TEXT NOT NULL,
     outcome  TEXT,
     notes    TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_rollouts_ts ON rollouts(ts)",
  `CREATE TABLE IF NOT EXISTS rollout_events (
     rollout_id TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     ts         INTEGER NOT NULL,
     kind       TEXT NOT NULL,
     device     TEXT,
     ok         INTEGER NOT NULL,
     detail     TEXT,
     PRIMARY KEY (rollout_id, seq)
   )`,
];

class SqliteRolloutStore implements RolloutStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  save(record: RolloutRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO rollouts
         (id, ts, updated, label, commands, waves, devices, gates, phase, outcome, notes)
         VALUES ($id,$ts,$updated,$label,$commands,$waves,$devices,$gates,$phase,$outcome,$notes)`,
      )
      .run({
        $id: record.id,
        $ts: record.ts,
        $updated: record.updated,
        $label: record.label ?? null,
        $commands: JSON.stringify(record.commands),
        $waves: JSON.stringify(record.waves),
        $devices: JSON.stringify(record.devices),
        $gates: JSON.stringify(record.gates),
        $phase: record.phase,
        $outcome: record.outcome ?? null,
        $notes: JSON.stringify(record.notes),
      });
  }

  get(id: string): RolloutRecord | null {
    const row = this.db.query("SELECT * FROM rollouts WHERE id = $id").get({ $id: id }) as
      | Row
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(limit = 50): RolloutRecord[] {
    const rows = this.db
      .query("SELECT * FROM rollouts ORDER BY ts DESC LIMIT $limit")
      .all({ $limit: limit }) as Row[];
    return rows.map(rowToRecord);
  }

  appendEvent(event: Omit<RolloutEventRow, "seq">): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max FROM rollout_events WHERE rollout_id = $id")
      .get({ $id: event.rolloutId }) as { max: number };
    const seq = row.max + 1;
    this.db
      .query(
        `INSERT INTO rollout_events (rollout_id, seq, ts, kind, device, ok, detail)
         VALUES ($id,$seq,$ts,$kind,$device,$ok,$detail)`,
      )
      .run({
        $id: event.rolloutId,
        $seq: seq,
        $ts: event.ts,
        $kind: event.kind,
        $device: event.device ?? null,
        $ok: event.ok ? 1 : 0,
        $detail: event.detail ?? null,
      });
    return seq;
  }

  events(rolloutId: string): RolloutEventRow[] {
    const rows = this.db
      .query("SELECT * FROM rollout_events WHERE rollout_id = $id ORDER BY seq ASC")
      .all({ $id: rolloutId }) as EventRow[];
    return rows.map((r) => ({
      rolloutId: r.rollout_id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      device: r.device ?? undefined,
      ok: r.ok === 1,
      detail: r.detail ?? undefined,
    }));
  }

  remove(id: string): boolean {
    this.db.query("DELETE FROM rollout_events WHERE rollout_id = $id").run({ $id: id });
    const before = (this.db.query("SELECT COUNT(*) AS n FROM rollouts").get() as { n: number }).n;
    this.db.query("DELETE FROM rollouts WHERE id = $id").run({ $id: id });
    const after = (this.db.query("SELECT COUNT(*) AS n FROM rollouts").get() as { n: number }).n;
    return after < before;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the rollout history at `path` (`:memory:` for an ephemeral
 * store). Defaults to the snapshots database so a rollout and the snapshots it
 * can be restored from live in one file.
 */
export async function openRolloutStore(path: string): Promise<RolloutStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteRolloutStore(db);
}
