/** Run with Bun: real SQLite durability/isolation, without accessing the configured database. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { OperationsStore } from "../src/operations/store";

const directory = mkdtempSync(join(tmpdir(), "mcp-operations-test-"));
const path = join(directory, "test.db");
try {
  let db = new Database(path, { create: true });
  let store = new OperationsStore(db);
  store.put("test", { id: "one", device: "lab", updatedAt: 1 });
  store.put("test", { id: "one", device: "other", updatedAt: 2 });
  assert.equal(store.get("test", "one", "other"), undefined);
  store.lock("lab", "owner");
  assert.throws(() => store.lock("lab", "other"));
  store.unlock("lab", "other");
  assert.throws(() => store.lock("lab", "third"));
  db.close();
  db = new Database(path);
  store = new OperationsStore(db);
  assert.equal(store.get("test", "one", "lab")?.updatedAt, 1);
  assert.throws(() => store.lock("lab", "after-restart"));
  store.unlock("lab", "owner");
  store.lock("lab", "after-restart");
  store.prune("test", "other", 5);
  assert.equal(store.list("test", "lab").length, 1);
  store.prune("test", "lab", 5);
  assert.equal(store.list("test", "lab").length, 0);
  db.close();
  console.warn("Operations SQLite durability, isolation and locks: passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
