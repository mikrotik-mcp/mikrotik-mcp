/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowseSchema, RecallSchema, RememberSchema } from "../../src/memory/knowledge";
import { openMemoryStore } from "../../src/memory/store";

test("legacy SQLite rows migrate to indexed facts with a readable backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-deep-migration-"));
  const path = join(dir, "nested", "memory.db");
  let store: Awaited<ReturnType<typeof openMemoryStore>> | undefined;
  try {
    mkdirSync(join(dir, "nested"));
    const db = new Database(path, { create: true });
    db.run(
      "CREATE TABLE entities (name TEXT PRIMARY KEY, entity_type TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_name TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE, content TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(entity_name,content))",
    );
    db.run("INSERT INTO entities VALUES ('edge','router',100,100)");
    db.run(
      "INSERT INTO observations(entity_name,content,created_at) VALUES ('edge','Legacy observation',100)",
    );
    db.close();
    store = await openMemoryStore(path);
    expect(store.openNodes(["edge"]).entities[0].observations).toEqual(["Legacy observation"]);
    expect(store.facts(BrowseSchema.parse({ query: "Legacy" })).items[0]).toMatchObject({
      content: "Legacy observation",
      source: "legacy",
      revision: 1,
      updatedAt: 100,
    });
    expect(store.scope("edge").scope).toBe("device");
    store.close();
    store = undefined;
    const backup = readdirSync(join(dir, "nested")).find(
      (name) => name.includes(".pre-knowledge-") && name.endsWith(".bak"),
    );
    expect(backup).toBeDefined();
    const old = new Database(join(dir, "nested", backup!), { readonly: true });
    try {
      expect(old.query("SELECT content FROM observations").get()).toEqual({
        content: "Legacy observation",
      });
      expect(
        (old.query("PRAGMA table_info(observations)").all() as { name: string }[]).some(
          (c) => c.name === "revision",
        ),
      ).toBe(false);
    } finally {
      old.close();
    }
    store = await openMemoryStore(path);
    expect(store.facts(BrowseSchema.parse({ query: "Legacy" })).total).toBe(1);
    expect(readdirSync(join(dir, "nested")).filter((name) => name.endsWith(".bak"))).toHaveLength(
      1,
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entities, relations, FTS, activity and deletes persist with foreign-key cascades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-deep-crud-"));
  const path = join(dir, "memory.db");
  let store: Awaited<ReturnType<typeof openMemoryStore>> | undefined;
  try {
    store = await openMemoryStore(path);
    expect(
      store.createEntities([
        { name: "edge", entityType: "router", observations: ["Fiber uplink"] },
        { name: "exit", entityType: "router" },
      ]),
    ).toHaveLength(2);
    expect(store.createEntities([{ name: "edge", entityType: "router" }])).toEqual([]);
    expect(
      store.addObservations([
        { entityName: "edge", contents: ["Fiber uplink", "VPN route"] },
        { entityName: "missing", contents: ["Ignored"] },
      ]),
    ).toEqual([{ entityName: "edge", added: ["VPN route"] }]);
    expect(
      store.createRelations([
        { from: "edge", to: "exit", relationType: "routes_via" },
        { from: "edge", to: "missing", relationType: "routes_via" },
      ]),
    ).toHaveLength(1);
    expect(store.searchNodes("VPN").entities.map((e) => e.name)).toEqual(["edge"]);
    expect(store.openNodes(["edge"]).relations).toHaveLength(1);
    expect(store.listEntities("e").total).toBe(2);
    expect(store.stats()).toMatchObject({ entities: 2, relations: 1, observations: 2 });
    store.logActivity("tool_call", "query");
    expect(store.activity(50, 0, true).every((event) => event.action !== "tool_call")).toBe(true);
    store.close();
    store = await openMemoryStore(path);
    expect(store.readGraph().entities).toHaveLength(2);
    expect(store.deleteObservations([{ entityName: "edge", observations: ["VPN route"] }])).toBe(1);
    expect(store.deleteRelations([{ from: "edge", to: "exit", relationType: "routes_via" }])).toBe(
      1,
    );
    store.createRelations([{ from: "edge", to: "exit", relationType: "routes_via" }]);
    expect(store.deleteEntities(["exit"])).toBe(1);
    expect(store.readGraph().relations).toEqual([]);
    expect(store.stats()).toMatchObject({ entities: 1, observations: 1, relations: 0 });
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keyed revisions roll back on stale edits and FTS follows content changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-deep-revision-"));
  const store = await openMemoryStore(join(dir, "memory.db"));
  try {
    store.createEntities([{ name: "edge", entityType: "router" }]);
    expect(() =>
      store.remember(RememberSchema.parse({ entityName: "missing", content: "Unavailable" })),
    ).toThrow("Entity not found");
    const first = store.remember(
      RememberSchema.parse({ entityName: "edge", key: "wan", content: "Fiber alpha" }),
    );
    const second = store.remember(
      RememberSchema.parse({ entityName: "edge", key: "wan", content: "Fiber beta" }),
    );
    expect(second.id).toBe(first.id);
    expect(() =>
      store.revise({ id: first.id, expectedRevision: first.revision, content: "Stale" }),
    ).toThrow("changed since");
    expect(store.history(first.id)).toHaveLength(1);
    expect(store.facts(BrowseSchema.parse({ query: "alpha" })).total).toBe(0);
    expect(store.facts(BrowseSchema.parse({ query: "beta" })).total).toBe(1);
    expect(
      store.recall(RecallSchema.parse({ entityName: "edge", query: "beta" })).items[0].content,
    ).toBe("Fiber beta");
    expect(store.health().active).toBe(1);
    expect(() => store.history(999999)).toThrow("Memory not found");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
