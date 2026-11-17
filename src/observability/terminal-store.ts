/**
 * Dashboard terminal persistence: command history and favourite commands.
 *
 * `bun:sqlite` is imported dynamically (as in {@link ./store}), so the static
 * import graph stays loadable by the Node test runner.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

export interface TerminalHistoryEntry {
  id: number;
  ts: number;
  device: string;
  command: string;
  /** Possibly truncated to {@link MAX_OUTPUT_CHARS}. */
  output: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface TerminalFavorite {
  id: number;
  ts: number;
  label: string;
  command: string;
}

/** Stored output per command. A long `/export` is cut, the command is not. */
export const MAX_OUTPUT_CHARS = 200_000;
/** Oldest history rows are removed past this count. */
export const MAX_HISTORY_ROWS = 5000;

interface HistoryRow extends Omit<TerminalHistoryEntry, "ok" | "error"> {
  ok: number;
  error: string | null;
}

export class TerminalStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS terminal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      device TEXT NOT NULL,
      command TEXT NOT NULL,
      output TEXT NOT NULL,
      ok INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      error TEXT
    )`);
    db.run("CREATE INDEX IF NOT EXISTS terminal_history_device ON terminal_history(device, id)");
    db.run(`CREATE TABLE IF NOT EXISTS terminal_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      label TEXT NOT NULL,
      command TEXT NOT NULL UNIQUE
    )`);
  }

  addHistory(entry: Omit<TerminalHistoryEntry, "id">): number {
    const result = this.db
      .query(
        "INSERT INTO terminal_history (ts, device, command, output, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.ts,
        entry.device,
        entry.command,
        entry.output.slice(0, MAX_OUTPUT_CHARS),
        entry.ok ? 1 : 0,
        Math.round(entry.ms),
        entry.error ?? null,
      );
    this.db.run(
      "DELETE FROM terminal_history WHERE id <= (SELECT MAX(id) FROM terminal_history) - ?",
      [MAX_HISTORY_ROWS],
    );
    return Number(result.lastInsertRowid);
  }

  /** Newest first. `q` matches the command text; `device` filters to one router. */
  listHistory(
    filter: { device?: string; q?: string; limit?: number } = {},
  ): TerminalHistoryEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.device) {
      where.push("device = ?");
      args.push(filter.device);
    }
    if (filter.q) {
      where.push("instr(lower(command), lower(?)) > 0");
      args.push(filter.q);
    }
    args.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const rows = this.db
      .query(
        `SELECT id, ts, device, command, output, ok, ms, error FROM terminal_history
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args) as HistoryRow[];
    return rows.map((row) => ({
      ...row,
      ok: row.ok === 1,
      error: row.error ?? undefined,
    }));
  }

  /** Remove one entry, one device's entries, or everything. Returns the count. */
  deleteHistory(target: { id?: number; device?: string }): number {
    if (target.id !== undefined)
      return this.db.run("DELETE FROM terminal_history WHERE id = ?", [target.id]).changes;
    if (target.device)
      return this.db.run("DELETE FROM terminal_history WHERE device = ?", [target.device]).changes;
    return this.db.run("DELETE FROM terminal_history").changes;
  }

  listFavorites(): TerminalFavorite[] {
    return this.db
      .query("SELECT id, ts, label, command FROM terminal_favorites ORDER BY label, id")
      .all() as TerminalFavorite[];
  }

  /** Add a favourite, or rename it when the command is already one. */
  saveFavorite(command: string, label: string): TerminalFavorite {
    this.db.run(
      `INSERT INTO terminal_favorites (ts, label, command) VALUES (?, ?, ?)
       ON CONFLICT(command) DO UPDATE SET label = excluded.label`,
      [Date.now(), label, command],
    );
    return this.db
      .query("SELECT id, ts, label, command FROM terminal_favorites WHERE command = ?")
      .get(command) as TerminalFavorite;
  }

  deleteFavorite(id: number): number {
    return this.db.run("DELETE FROM terminal_favorites WHERE id = ?", [id]).changes;
  }

  close(): void {
    this.db.close();
  }
}

export async function openTerminalStore(path: string): Promise<TerminalStore> {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* best-effort; opening the DB surfaces a real failure */
    }
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  try {
    return new TerminalStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
