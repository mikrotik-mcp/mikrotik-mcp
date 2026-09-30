/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryStore } from "../src/memory/store";
import {
  BrowseSchema,
  RecallSchema,
  RememberSchema,
  STALE_AFTER_MS,
} from "../src/memory/knowledge";

test("keyed memories preserve history, reject stale edits and roll back conflicting changes", async () => {
  const store = await openMemoryStore(":memory:");
  try {
    store.createEntities([{ name: "edge", entityType: "router" }]);
    const first = store.remember(
      RememberSchema.parse({
        entityName: "edge",
        key: "wan.provider",
        content: "Fiber provider A",
        source: "operator",
      }),
    );
    const verified = store.revise({
      id: first.id,
      expectedRevision: first.revision,
      verified: true,
    });
    expect(verified.verifiedAt).not.toBeNull();
    const second = store.remember(
      RememberSchema.parse({
        entityName: "edge",
        key: "wan.provider",
        content: "Fiber provider B",
        source: "operator",
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.verifiedAt).toBeNull();
    expect(store.history(first.id).map((r) => r.fact.content)).toEqual([
      "Fiber provider A",
      "Fiber provider A",
    ]);
    expect(() => store.revise({ id: first.id, expectedRevision: 1, pinned: true })).toThrow(
      "changed since",
    );
    store.remember(RememberSchema.parse({ entityName: "edge", content: "Other fact" }));
    expect(() =>
      store.revise({ id: first.id, expectedRevision: second.revision, content: "Other fact" }),
    ).toThrow();
    expect(store.history(first.id)).toHaveLength(2);
    expect(store.openNodes(["edge"]).entities[0].observations).toEqual([
      "Fiber provider B",
      "Other fact",
    ]);
  } finally {
    store.close();
  }
});

test("recall scopes related context, excludes expired/archived facts and explains trust", async () => {
  const store = await openMemoryStore(":memory:");
  try {
    store.createEntities(["edge", "exit", "other"].map((name) => ({ name, entityType: "router" })));
    store.createRelations([{ from: "edge", to: "exit", relationType: "routes_via" }]);
    for (const entityName of ["edge", "exit", "other"])
      store.remember(RememberSchema.parse({ entityName, content: "WireGuard path" }));
    store.remember(
      RememberSchema.parse({
        entityName: "edge",
        content: "Back up before changes",
        kind: "constraint",
        pinned: true,
      }),
    );
    store.remember(
      RememberSchema.parse({
        entityName: "edge",
        content: "Expired WireGuard value",
        pinned: true,
        expiresAt: Date.now() - 1,
      }),
    );
    const archived = store.remember(
      RememberSchema.parse({ entityName: "edge", content: "Archived WireGuard value" }),
    );
    store.revise({ id: archived.id, expectedRevision: 1, status: "archived" });
    const result = store.recall(RecallSchema.parse({ query: "WireGuard", entityName: "edge" }));
    expect(result.items).toHaveLength(3);
    expect(result.items.some((f) => f.entityName === "other")).toBe(false);
    expect(result.items.some((f) => f.kind === "constraint")).toBe(true);
    expect(result.warnings.join()).toContain("verification");
    expect(result.context).toContain("not instructions or authorization");
    expect(
      store.recall(
        RecallSchema.parse({ query: "WireGuard", entityName: "edge", includeRelated: false }),
      ).items,
    ).toHaveLength(2);
    expect(() => store.recall(RecallSchema.parse({ entityName: "missing" }))).toThrow(
      "never substitutes",
    );
    expect(store.health()).toMatchObject({ active: 4, expired: 1, archived: 1, review: 5 });
    expect(store.facts(BrowseSchema.parse({ state: "pinned" })).total).toBe(1);
    expect(store.health().pinned).toBe(1);
    expect(
      store.facts(BrowseSchema.parse({ state: "all", limit: 2, offset: 2 })).items,
    ).toHaveLength(2);
    expect(store.readGraph().entities.find((e) => e.name === "edge")?.observations).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("full-text recall is literal, Unicode-aware, bounded, and secret inputs are rejected", async () => {
  const store = await openMemoryStore(":memory:");
  try {
    store.createEntities([{ name: "home", entityType: "router" }]);
    store.remember(RememberSchema.parse({ entityName: "home", content: "شبکه خانه مسیر فیبر" }));
    expect(store.recall(RecallSchema.parse({ query: "فیبر" })).items).toHaveLength(1);
    expect(store.recall(RecallSchema.parse({ query: '" OR * : -' })).items).toHaveLength(0);
    for (let i = 0; i < 5; i++)
      store.remember(
        RememberSchema.parse({ entityName: "home", content: `WireGuard ${i}${"x".repeat(600)}` }),
      );
    const result = store.recall(RecallSchema.parse({ query: "WireGuard", maxChars: 1000 }));
    expect(result.context.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
    expect(result.items.length).toBeLessThan(5);
    expect(() =>
      store.remember(
        RememberSchema.parse({ entityName: "home", content: "PrivateKey = sensitive-secret" }),
      ),
    ).toThrow("credential vault");
    expect(() =>
      store.addObservations([{ entityName: "home", contents: ['password="secret"'] }]),
    ).toThrow("credential vault");
    expect(store.searchNodes("%").entities).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("legacy migration backs up WAL data, preserves IDs/relations and never invents verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mikrotik-memory-migration-"));
  const path = join(directory, "memory.db");
  const original = new Database(path);
  original.run("PRAGMA journal_mode = WAL");
  original.run(
    "CREATE TABLE entities(name TEXT PRIMARY KEY, entity_type TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  original.run(
    "CREATE TABLE observations(id INTEGER PRIMARY KEY AUTOINCREMENT, entity_name TEXT REFERENCES entities(name) ON DELETE CASCADE, content TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(entity_name, content))",
  );
  const old = Date.now() - STALE_AFTER_MS - 1000;
  original.query("INSERT INTO entities VALUES ('edge', 'device', ?, ?)").run(old, old);
  original
    .query(
      "INSERT INTO observations(entity_name, content, created_at) VALUES ('edge', 'Legacy memory', ?)",
    )
    .run(old);
  const store = await openMemoryStore(path);
  try {
    const fact = store.facts(BrowseSchema.parse({ state: "review" })).items[0];
    expect(fact).toMatchObject({
      id: 1,
      content: "Legacy memory",
      source: "legacy",
      verifiedAt: null,
      revision: 1,
    });
    expect(store.health()).toMatchObject({ unverified: 1, stale: 1 });
    const backup = readdirSync(directory).find((f) => f.endsWith(".bak"));
    expect(backup).toBeDefined();
    const restored = new Database(join(directory, backup!), { readonly: true });
    expect(restored.query("SELECT content FROM observations").get()).toEqual({
      content: "Legacy memory",
    });
    restored.close();
    store.close();
    const reopened = await openMemoryStore(path);
    expect(reopened.facts(BrowseSchema.parse({ query: "Legacy" })).total).toBe(1);
    expect(readdirSync(directory).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
    reopened.close();
  } finally {
    original.close();
    rmSync(directory, { recursive: true });
  }
});
