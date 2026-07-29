/**
 * Event persistence backed by Bun's native SQLite (`bun:sqlite`).
 *
 * `bun:sqlite` is imported **dynamically** inside {@link openSqliteStore} so the
 * static import graph stays Node-loadable: the registry imports the recorder,
 * which imports *types* from here only — the Bun runtime module is pulled in
 * solely when the dashboard is actually enabled at serve time.
 *
 * The schema is intentionally flat (one row per tool call) and the SQL is
 * minimal — insert, filtered select, get-by-id, prune. All analytics live in the
 * pure `stats.ts` so they need no database and stay unit-testable.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { Risk, ToolEvent } from "./event";

/** Filters accepted by {@link EventStore.query}. */
export interface EventFilter {
  limit?: number;
  offset?: number;
  tool?: string;
  risk?: Risk;
  device?: string;
  /** `ok` or `error`. */
  status?: "ok" | "error";
  /** Free-text match across tool/title/input/output/error. */
  q?: string;
  /** Lower bound on `ts` (epoch ms), inclusive. */
  since?: number;
  /** Upper bound on `ts` (epoch ms), inclusive. */
  until?: number;
}

/** Storage interface (a SQLite implementation today; swappable for tests). */
export interface EventStore {
  insert(e: ToolEvent): void;
  query(filter: EventFilter): ToolEvent[];
  get(id: string): ToolEvent | null;
  /** Total rows currently stored. */
  total(): number;
  /** Delete specific events by id. Returns the number of rows actually removed. */
  delete(ids: string[]): number;
  /** Delete every stored event. Returns the number of rows removed. */
  clear(): number;
  /** Trim to at most `maxEvents` rows, dropping the oldest. Returns rows removed. */
  prune(maxEvents: number): number;
  close(): void;
}

interface Row {
  id: string;
  ts: number;
  tool: string;
  title: string;
  risk: string;
  device: string | null;
  transport: string | null;
  device_transport: string | null;
  rest_fallback: string | null;
  duration_ms: number;
  is_error: number;
  error: string | null;
  input: string;
  output: string;
  output_bytes: number;
  has_structured: number;
  truncated: number;
  reason: string | null;
}

function rowToEvent(r: Row): ToolEvent {
  return {
    id: r.id,
    ts: r.ts,
    tool: r.tool,
    title: r.title,
    risk: r.risk as Risk,
    device: r.device ?? undefined,
    transport: r.transport ?? undefined,
    deviceTransport: (r.device_transport ?? undefined) as ToolEvent["deviceTransport"],
    restFallback: r.rest_fallback ?? undefined,
    durationMs: r.duration_ms,
    isError: r.is_error === 1,
    error: r.error ?? undefined,
    input: r.input,
    output: r.output,
    outputBytes: r.output_bytes,
    hasStructured: r.has_structured === 1,
    truncated: r.truncated === 1,
    reason: r.reason ?? undefined,
  };
}

/** DDL split into individual statements (run one at a time). */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     ts INTEGER NOT NULL,
     tool TEXT NOT NULL,
     title TEXT NOT NULL,
     risk TEXT NOT NULL,
     device TEXT,
     transport TEXT,
     duration_ms REAL NOT NULL,
     is_error INTEGER NOT NULL,
     error TEXT,
     input TEXT NOT NULL,
     output TEXT NOT NULL,
     output_bytes INTEGER NOT NULL,
     has_structured INTEGER NOT NULL,
     truncated INTEGER NOT NULL,
     reason TEXT,
     device_transport TEXT,
     rest_fallback TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool)",
  "CREATE INDEX IF NOT EXISTS idx_events_error ON events(is_error)",
];

/** Column additions for existing databases (idempotent — new DBs already have them). */
const MIGRATIONS = [
  "ALTER TABLE events ADD COLUMN reason TEXT",
  "ALTER TABLE events ADD COLUMN device_transport TEXT",
  "ALTER TABLE events ADD COLUMN rest_fallback TEXT",
];

class SqliteEventStore implements EventStore {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
    for (const m of MIGRATIONS) {
      try {
        db.run(m);
      } catch {
        /* column already exists */
      }
    }
  }

  insert(e: ToolEvent): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO events
         (id, ts, tool, title, risk, device, transport, device_transport, rest_fallback,
          duration_ms, is_error, error,
          input, output, output_bytes, has_structured, truncated, reason)
         VALUES ($id,$ts,$tool,$title,$risk,$device,$transport,$devtransport,$restfallback,
                 $dur,$err,$errmsg,
          $input,$output,$obytes,$structured,$trunc,$reason)`,
      )
      .run({
        $id: e.id,
        $ts: e.ts,
        $tool: e.tool,
        $title: e.title,
        $risk: e.risk,
        $device: e.device ?? null,
        $transport: e.transport ?? null,
        $devtransport: e.deviceTransport ?? null,
        $restfallback: e.restFallback ?? null,
        $dur: e.durationMs,
        $err: e.isError ? 1 : 0,
        $errmsg: e.error ?? null,
        $input: e.input,
        $output: e.output,
        $obytes: e.outputBytes,
        $structured: e.hasStructured ? 1 : 0,
        $trunc: e.truncated ? 1 : 0,
        $reason: e.reason ?? null,
      });
  }

  query(filter: EventFilter): ToolEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.tool) {
      where.push("tool = $tool");
      params.$tool = filter.tool;
    }
    if (filter.risk) {
      where.push("risk = $risk");
      params.$risk = filter.risk;
    }
    if (filter.device) {
      where.push("device = $device");
      params.$device = filter.device;
    }
    if (filter.status) {
      where.push("is_error = $iserr");
      params.$iserr = filter.status === "error" ? 1 : 0;
    }
    if (filter.since != null) {
      where.push("ts >= $since");
      params.$since = filter.since;
    }
    if (filter.until != null) {
      where.push("ts <= $until");
      params.$until = filter.until;
    }
    if (filter.q) {
      where.push(
        "(tool LIKE $q OR title LIKE $q OR input LIKE $q OR output LIKE $q OR error LIKE $q OR reason LIKE $q)",
      );
      params.$q = `%${filter.q}%`;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 5000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .query(`SELECT * FROM events ${clause} ORDER BY ts DESC LIMIT $limit OFFSET $offset`)
      .all({ ...params, $limit: limit, $offset: offset }) as Row[];
    return rows.map(rowToEvent);
  }

  get(id: string): ToolEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = $id").get({ $id: id }) as Row | null;
    return row ? rowToEvent(row) : null;
  }

  total(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return r.n;
  }

  delete(ids: string[]): number {
    if (ids.length === 0) return 0;
    let removed = 0;
    // Chunk the id list so a large selection stays well under SQLite's
    // bound-parameter limit (~999) per statement.
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `$id${j}`).join(",");
      const params: Record<string, string> = {};
      chunk.forEach((id, j) => {
        params[`$id${j}`] = id;
      });
      const res = this.db.query(`DELETE FROM events WHERE id IN (${placeholders})`).run(params);
      removed += Number(res.changes ?? 0);
    }
    return removed;
  }

  clear(): number {
    const n = this.total();
    this.db.run("DELETE FROM events");
    return n;
  }

  prune(maxEvents: number): number {
    const n = this.total();
    if (n <= maxEvents) return 0;
    const drop = n - maxEvents;
    this.db
      .query("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts ASC LIMIT $drop)")
      .run({ $drop: drop });
    return drop;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) a SQLite-backed event store at `path` (`:memory:` for an
 * ephemeral store). Dynamically imports `bun:sqlite` so this module is safe to
 * reference from Node-loaded code paths that never call it.
 */
export async function openSqliteStore(path: string): Promise<EventStore> {
  // Ensure the parent directory exists (e.g. ~/.mikrotik-mcp) for file-backed
  // stores; skip for the special in-memory database.
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteEventStore(db);
}
