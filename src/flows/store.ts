/**
 * Flow persistence — raw records plus 1-minute rollups, in SQLite.
 *
 * Same shape as `src/snapshots/store.ts`: `bun:sqlite` is imported
 * **dynamically** inside {@link openFlowStore} so this module is safe to
 * reference from the Node/Vitest import graph, which aliases `"bun"` and must
 * never load the real driver.
 *
 * Two tiers, because flow volume on a busy link is unbounded:
 *
 *   • **raw flows** — every decoded record, kept for `retentionHours` (24 h by
 *     default). This is what answers "what exactly happened at 14:03".
 *   • **1-minute rollups** — (minute, src, dst, port, proto) → bytes/packets,
 *     kept far longer (30 days). Two orders of magnitude smaller, and enough for
 *     every trend view.
 *
 * Eviction is by oldest-first against a hard row cap, and it is LOGGED — silent
 * data loss on a monitoring feature is worse than no feature, because the empty
 * chart looks like "no traffic" rather than "we threw it away".
 *
 * Payload is never stored: Traffic Flow carries none. That is exactly why it is
 * cheap and privacy-preserving next to the packet sniffer.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { FlowRecord } from "./decode";

export interface FlowQuery {
  /** Window start (epoch ms), inclusive. */
  from: number;
  /** Window end (epoch ms), exclusive. */
  to: number;
  /** Restrict to one exporter. */
  exporter?: string;
  /** Match either endpoint. */
  address?: string;
  limit?: number;
}

/** One aggregated minute for a (src, dst, port, protocol) tuple. */
export interface FlowRollup {
  minute: number;
  src: string;
  dst: string;
  dstPort: number;
  protocol: number;
  bytes: number;
  packets: number;
  flows: number;
}

export interface FlowStoreStats {
  rawRows: number;
  rollupRows: number;
  oldestRaw: number | null;
  newestRaw: number | null;
  /** Rows evicted since this store was opened. */
  evicted: number;
}

export interface FlowStore {
  /** Persist a batch of decoded flows and fold them into the minute rollups. */
  insert(records: FlowRecord[]): void;
  /** Raw flows overlapping a window, newest first. */
  query(q: FlowQuery): FlowRecord[];
  /** Rollups overlapping a window. */
  rollups(from: number, to: number): FlowRollup[];
  /** Drop raw flows past `retentionHours` and rollups past `rollupDays`. */
  prune(now: number): { rawDeleted: number; rollupDeleted: number };
  stats(): FlowStoreStats;
  close(): void;
}

export interface FlowStoreOptions {
  /** How long raw flow records are kept. */
  retentionHours?: number;
  /** How long 1-minute rollups are kept. */
  rollupDays?: number;
  /** Hard cap on raw rows; oldest are evicted first when exceeded. */
  maxRows?: number;
  /** Called when rows are evicted, so the collector can log it. */
  onEvict?: (rows: number, reason: string) => void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS flows (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     start     INTEGER NOT NULL,
     end       INTEGER NOT NULL,
     exporter  TEXT,
     src       TEXT NOT NULL,
     dst       TEXT NOT NULL,
     src_port  INTEGER NOT NULL,
     dst_port  INTEGER NOT NULL,
     protocol  INTEGER NOT NULL,
     bytes     INTEGER NOT NULL,
     packets   INTEGER NOT NULL,
     tcp_flags INTEGER,
     version   INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_flows_time ON flows(start)",
  "CREATE INDEX IF NOT EXISTS idx_flows_src ON flows(src)",
  "CREATE INDEX IF NOT EXISTS idx_flows_dst ON flows(dst)",
  `CREATE TABLE IF NOT EXISTS flow_rollups (
     minute    INTEGER NOT NULL,
     src       TEXT NOT NULL,
     dst       TEXT NOT NULL,
     dst_port  INTEGER NOT NULL,
     protocol  INTEGER NOT NULL,
     bytes     INTEGER NOT NULL,
     packets   INTEGER NOT NULL,
     flows     INTEGER NOT NULL,
     PRIMARY KEY (minute, src, dst, dst_port, protocol)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_rollups_minute ON flow_rollups(minute)",
];

interface FlowRow {
  start: number;
  end: number;
  exporter: string | null;
  src: string;
  dst: string;
  src_port: number;
  dst_port: number;
  protocol: number;
  bytes: number;
  packets: number;
  tcp_flags: number | null;
  version: number;
}

function rowToRecord(r: FlowRow): FlowRecord {
  return {
    start: r.start,
    end: r.end,
    exporter: r.exporter ?? undefined,
    src: r.src,
    dst: r.dst,
    srcPort: r.src_port,
    dstPort: r.dst_port,
    protocol: r.protocol,
    bytes: r.bytes,
    packets: r.packets,
    tcpFlags: r.tcp_flags ?? undefined,
    version: r.version,
  };
}

const MINUTE = 60_000;

class SqliteFlowStore implements FlowStore {
  private readonly db: Database;
  private readonly retentionHours: number;
  private readonly rollupDays: number;
  private readonly maxRows: number;
  private readonly onEvict?: (rows: number, reason: string) => void;
  private evicted = 0;

  constructor(db: Database, opts: FlowStoreOptions) {
    this.db = db;
    this.retentionHours = opts.retentionHours ?? 24;
    this.rollupDays = opts.rollupDays ?? 30;
    this.maxRows = opts.maxRows ?? 2_000_000;
    this.onEvict = opts.onEvict;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  }

  insert(records: FlowRecord[]): void {
    if (records.length === 0) return;
    const insertFlow = this.db.query(
      `INSERT INTO flows (start, end, exporter, src, dst, src_port, dst_port, protocol, bytes, packets, tcp_flags, version)
       VALUES ($start,$end,$exporter,$src,$dst,$srcPort,$dstPort,$protocol,$bytes,$packets,$tcpFlags,$version)`,
    );
    // Rollups are an upsert per (minute, tuple): the same conversation reported
    // by several exports in one minute must ADD, not replace.
    const upsertRollup = this.db.query(
      `INSERT INTO flow_rollups (minute, src, dst, dst_port, protocol, bytes, packets, flows)
       VALUES ($minute,$src,$dst,$dstPort,$protocol,$bytes,$packets,1)
       ON CONFLICT(minute, src, dst, dst_port, protocol) DO UPDATE SET
         bytes = bytes + excluded.bytes,
         packets = packets + excluded.packets,
         flows = flows + 1`,
    );

    this.db.transaction(() => {
      for (const r of records) {
        insertFlow.run({
          $start: r.start,
          $end: r.end,
          $exporter: r.exporter ?? null,
          $src: r.src,
          $dst: r.dst,
          $srcPort: r.srcPort,
          $dstPort: r.dstPort,
          $protocol: r.protocol,
          $bytes: r.bytes,
          $packets: r.packets,
          $tcpFlags: r.tcpFlags ?? null,
          $version: r.version,
        });
        upsertRollup.run({
          $minute: Math.floor(r.start / MINUTE) * MINUTE,
          $src: r.src,
          $dst: r.dst,
          $dstPort: r.dstPort,
          $protocol: r.protocol,
          $bytes: r.bytes,
          $packets: r.packets,
        });
      }
    })();

    this.enforceCap();
  }

  /** Evict oldest raw rows when the hard cap is exceeded. Never silent. */
  private enforceCap(): void {
    const { n } = this.db.query("SELECT COUNT(*) AS n FROM flows").get() as { n: number };
    if (n <= this.maxRows) return;
    const excess = n - this.maxRows;
    this.db
      .query("DELETE FROM flows WHERE id IN (SELECT id FROM flows ORDER BY start ASC LIMIT $n)")
      .run({ $n: excess });
    this.evicted += excess;
    this.onEvict?.(excess, `raw row cap ${this.maxRows} exceeded`);
  }

  query(q: FlowQuery): FlowRecord[] {
    const clauses = ["end >= $from", "start < $to"];
    const params: Record<string, string | number> = { $from: q.from, $to: q.to };
    if (q.exporter) {
      clauses.push("exporter = $exporter");
      params.$exporter = q.exporter;
    }
    if (q.address) {
      clauses.push("(src = $address OR dst = $address)");
      params.$address = q.address;
    }
    params.$limit = q.limit ?? 100_000;
    const rows = this.db
      .query(`SELECT * FROM flows WHERE ${clauses.join(" AND ")} ORDER BY start DESC LIMIT $limit`)
      .all(params) as FlowRow[];
    return rows.map(rowToRecord);
  }

  rollups(from: number, to: number): FlowRollup[] {
    const rows = this.db
      .query(
        "SELECT * FROM flow_rollups WHERE minute >= $from AND minute < $to ORDER BY minute ASC",
      )
      .all({ $from: from, $to: to }) as {
      minute: number;
      src: string;
      dst: string;
      dst_port: number;
      protocol: number;
      bytes: number;
      packets: number;
      flows: number;
    }[];
    return rows.map((r) => ({
      minute: r.minute,
      src: r.src,
      dst: r.dst,
      dstPort: r.dst_port,
      protocol: r.protocol,
      bytes: r.bytes,
      packets: r.packets,
      flows: r.flows,
    }));
  }

  prune(now: number): { rawDeleted: number; rollupDeleted: number } {
    const rawCutoff = now - this.retentionHours * 3_600_000;
    const rollupCutoff = now - this.rollupDays * 86_400_000;
    const before = this.count();
    this.db.query("DELETE FROM flows WHERE start < $cutoff").run({ $cutoff: rawCutoff });
    const afterRaw = this.count();
    const rollupsBefore = this.rollupCount();
    this.db.query("DELETE FROM flow_rollups WHERE minute < $cutoff").run({ $cutoff: rollupCutoff });
    const rawDeleted = before - afterRaw;
    const rollupDeleted = rollupsBefore - this.rollupCount();
    if (rawDeleted > 0 || rollupDeleted > 0) {
      this.evicted += rawDeleted;
      this.onEvict?.(
        rawDeleted + rollupDeleted,
        `retention: raw > ${this.retentionHours}h, rollups > ${this.rollupDays}d`,
      );
    }
    return { rawDeleted, rollupDeleted };
  }

  private count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM flows").get() as { n: number }).n;
  }

  private rollupCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM flow_rollups").get() as { n: number }).n;
  }

  stats(): FlowStoreStats {
    const range = this.db.query("SELECT MIN(start) AS lo, MAX(start) AS hi FROM flows").get() as {
      lo: number | null;
      hi: number | null;
    };
    return {
      rawRows: this.count(),
      rollupRows: this.rollupCount(),
      oldestRaw: range.lo,
      newestRaw: range.hi,
      evicted: this.evicted,
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the flow store at `path` (`:memory:` for an ephemeral one).
 * Dynamically imports `bun:sqlite`, so importing this module never loads the
 * driver.
 */
export async function openFlowStore(path: string, opts: FlowStoreOptions = {}): Promise<FlowStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; opening the DB will surface a real failure
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  return new SqliteFlowStore(db, opts);
}
