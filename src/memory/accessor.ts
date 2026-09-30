/**
 * Shared lazy-singleton accessor for the knowledge-graph memory store.
 *
 * All consumers — MCP tools, dashboard routes, and the auto-recorder — go
 * through these functions so there is exactly **one** SQLite connection to the
 * memory database per process. This avoids WAL write-contention that three
 * independent lazy singletons would cause.
 */
import { getConfig } from "../core/runtime";
import { openMemoryStore } from "./store";
import type { MemoryStore } from "./store";

let storePromise: Promise<MemoryStore> | null = null;

/** Fast synchronous check — no DB opened. */
export function isMemoryEnabled(): boolean {
  try {
    return getConfig().memory.enabled;
  } catch {
    return false;
  }
}

/** Lazy-open the memory store. Rejects when memory is disabled. */
export function getMemoryStore(): Promise<MemoryStore> {
  const cfg = getConfig();
  if (!cfg.memory.enabled)
    return Promise.reject(new Error("Knowledge-graph memory is disabled in config"));
  if (!storePromise) {
    const pending = openMemoryStore(cfg.memory.dbPath);
    storePromise = pending;
    void pending.catch(() => {
      if (storePromise === pending) storePromise = null;
    });
  }
  return storePromise;
}

/**
 * Force the lazy store to re-open on next access. Called by the dashboard when
 * the DB path is changed at runtime.
 */
export function resetMemoryStore(): void {
  if (storePromise) {
    storePromise.then((s) => s.close()).catch(() => {});
    storePromise = null;
  }
}

/** Close the store cleanly (for shutdown). */
export function closeMemoryStore(): void {
  if (storePromise) {
    storePromise.then((s) => s.close()).catch(() => {});
    storePromise = null;
  }
}

/**
 * Re-point the singleton to a new DB path (for dashboard config changes).
 * Returns the new store promise so the caller can verify the open succeeded.
 */
export async function reopenMemoryStore(dbPath: string): Promise<MemoryStore> {
  const next = await openMemoryStore(dbPath);
  installMemoryStore(next);
  return next;
}

/** Publish a validated store only after its configuration has been persisted. */
export function installMemoryStore(store: MemoryStore): void {
  closeMemoryStore();
  storePromise = Promise.resolve(store);
}
