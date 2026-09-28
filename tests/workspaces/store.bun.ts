/// <reference types="bun" />
// Run: bun run tests/workspaces/store.bun.ts (no files, network or devices).
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../src/workspaces/store";
const db = new Database(":memory:"),
  store = new WorkspaceStore(db);
try {
  const original = { id: "session", device: "home", createdAt: 1, status: "open", runs: [] };
  store.save("client-check", original);
  const closed = { ...original, status: "closed" };
  store.replace("client-check", original, closed);
  assert.throws(() => store.replace("client-check", original, { ...original, status: "open" }));
  assert.equal(store.get("client-check", "session", "other"), undefined);
  assert.equal(store.get("support", "session"), undefined);
  const first = { id: "first", device: "home", createdAt: 2, status: "preview" },
    second = { ...first, id: "second" };
  store.save("migration", first);
  store.save("migration", second);
  store.claim("migration", { ...first, status: "applying" }, "preview");
  assert.throws(() => store.claim("migration", { ...second, status: "applying" }, "preview"));
  store.save("migration", { ...first, status: "uncertain" });
  assert.throws(() => store.claim("migration", { ...second, status: "applying" }, "preview"));
  assert.throws(() => store.claim("migration", { ...first, status: "applying" }, "preview"));
  store.delete("client-check", "session", "other");
  assert.ok(store.get("client-check", "session"));
  store.delete("client-check", "session", "home");
  assert.equal(store.get("client-check", "session"), undefined);
  process.stdout.write(
    "Workspace SQLite isolation, compare-and-swap and migration locks passed.\n",
  );
} finally {
  db.close();
}
