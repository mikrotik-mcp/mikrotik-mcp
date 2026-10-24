/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsStore } from "../../src/operations/store";
import type { WorkspaceRecord } from "../../src/operations/store";

/** Operations must preserve device ownership and exclusive locks across connections. */
test("operations CRUD, pruning, and lock ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "operations-store-"));
  const path = join(dir, "operations.db");
  const db = new Database(path);
  const store = new OperationsStore(db);
  const first = { id: "one", device: "a", updatedAt: 1, status: "preview" };
  let closed = false;
  try {
    expect(store.get("migration", "one", "a")).toBeUndefined();
    store.put("migration", first);
    const done = { ...first, updatedAt: 3, status: "done" };
    store.put("migration", done);
    store.put("migration", { id: "two", device: "a", updatedAt: 2 });
    store.put("support", { id: "other", device: "b", updatedAt: 1 });
    const wrongDevice = { ...first, device: "b", status: "wrong-device" };
    store.put("migration", wrongDevice);
    expect(store.get<typeof first>("migration", "one", "a")?.status).toBe("done");
    expect(store.get("migration", "one", "b")).toBeUndefined();
    expect(store.list("migration", "a", 1)).toHaveLength(1);
    expect(store.list<WorkspaceRecord>("migration", "a").map((r) => r.id)).toEqual(["one", "two"]);
    store.delete("migration", "one", "b");
    expect(store.get("migration", "one", "a")).toBeDefined();
    store.prune("migration", "a", 3);
    expect(store.get("migration", "two", "a")).toBeUndefined();
    store.lock("a", "owner");
    expect(() => store.lock("a", "other")).toThrow(/Another workspace operation/);
    store.unlock("a", "other");
    expect(() => store.lock("a", "other")).toThrow();
    store.unlock("a", "owner");
    store.lock("a", "other");
    db.close();
    closed = true;
    const reopened = new Database(path);
    try {
      const restored = new OperationsStore(reopened);
      expect(restored.get("migration", "one", "a")).toBeDefined();
      expect(() => restored.lock("a", "third")).toThrow();
      restored.unlock("a", "other");
      restored.delete("migration", "one", "a");
      expect(restored.get("migration", "one", "a")).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
