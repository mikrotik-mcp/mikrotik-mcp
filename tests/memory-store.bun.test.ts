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
  ScopeSchema,
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

test("shared and explicit group policy inherit safely, conflicts are visible and budgets never hide missing constraints", async () => {
  const store = await openMemoryStore(":memory:");
  try {
    store.createEntities(
      ["home", "exit", "other", "fleet-policy", "vpn-policy"].map((name) => ({
        name,
        entityType: "network",
      })),
    );
    const share = (entityName: string, scope: "shared" | "group", members: string[] = []) =>
      store.setScope(
        ScopeSchema.parse({
          entityName,
          scope,
          members,
          expectedRevision: 0,
          confirmSharing: true,
        }),
      );
    share("fleet-policy", "shared");
    const group = share("vpn-policy", "group", ["home", "exit"]);
    const add = (entityName: string, key: string, content: string, kind = "constraint") =>
      store.remember(RememberSchema.parse({ entityName, key, content, kind }));
    const common = add("fleet-policy", "backup", "Back up before configuration changes");
    const groupFact = add("vpn-policy", "path.mtu", "Measured path MTU 1400");
    const local = add("home", "path.mtu", "Measured path MTU 1380");
    add("other", "path.mtu", "Unrelated MTU 1200");
    store.createRelations([{ from: "home", to: "other", relationType: "near" }]);
    const recall = store.recall(
      RecallSchema.parse({ entityName: "home", query: "nothingmatches", includeRelated: false }),
    );
    expect(recall.items.map((f) => f.id).sort((a, b) => a - b)).toEqual(
      [common.id, groupFact.id, local.id].sort((a, b) => a - b),
    );
    expect(recall.applicableScopes.map((s) => s.entityName).sort()).toEqual([
      "fleet-policy",
      "home",
      "vpn-policy",
    ]);
    expect(recall.conflicts).toEqual([
      {
        key: "path.mtu",
        memories: [
          { id: groupFact.id, entityName: "vpn-policy", scope: "group" },
          { id: local.id, entityName: "home", scope: "device" },
        ],
      },
    ]);
    expect(recall.items.every((f) => f.applicability === "applicable")).toBe(true);
    expect(recall.constraintsOmitted).toBe(0);
    const related = store.recall(RecallSchema.parse({ entityName: "home", query: "MTU" }));
    expect(related.items.find((f) => f.entityName === "other")?.applicability).toBe("related");
    const other = store.recall(RecallSchema.parse({ entityName: "other", includeRelated: false }));
    expect(other.items.some((f) => f.entityName === "vpn-policy")).toBe(false);
    expect(other.items.some((f) => f.scope === "shared")).toBe(true);
    expect(other.conflicts).toEqual([]);
    const tiny = store.recall(RecallSchema.parse({ entityName: "home", maxChars: 500, limit: 1 }));
    expect(tiny.context.length).toBeLessThanOrEqual(500);
    expect(tiny.context).toContain("Conflicting");
    expect(tiny.constraintsOmitted).toBeGreaterThan(0);
    expect(tiny.warnings.join(" ")).toContain("Do not change");
    const symbols = store.recall(RecallSchema.parse({ entityName: "home", query: "!!!" }));
    expect(symbols.items).toHaveLength(3);
    store.setScope(
      ScopeSchema.parse({
        entityName: group.entityName,
        scope: "group",
        expectedRevision: group.revision,
        members: ["exit"],
        confirmSharing: true,
      }),
    );
    expect(
      store
        .recall(RecallSchema.parse({ entityName: "home", includeRelated: false }))
        .items.some((f) => f.scope === "group"),
    ).toBe(false);
    store.revise({ id: common.id, expectedRevision: common.revision, status: "archived" });
    expect(
      store
        .recall(RecallSchema.parse({ entityName: "exit" }))
        .items.some((f) => f.scope === "shared"),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("scope mutations require explicit sharing, exact members and optimistic revisions; legacy facts stay local", async () => {
  const store = await openMemoryStore(":memory:");
  try {
    store.createEntities(
      ["home", "exit", "policy"].map((name) => ({ name, entityType: "router" })),
    );
    expect(store.scope("home")).toEqual({
      entityName: "home",
      scope: "device",
      members: [],
      revision: 0,
    });
    const set = (data: object) =>
      store.setScope(
        ScopeSchema.parse({
          entityName: "policy",
          scope: "group",
          members: ["home"],
          expectedRevision: 0,
          confirmSharing: true,
          ...data,
        }),
      );
    expect(() => set({ confirmSharing: false })).toThrow("confirm sharing");
    expect(() => set({ members: ["missing"] })).toThrow("not found");
    expect(() => set({ members: ["policy"] })).toThrow("nested groups");
    expect(store.scope("policy").revision).toBe(0);
    const saved = set({});
    expect(() => set({ members: ["exit"] })).toThrow("changed since");
    expect(() => set({ entityName: "home", scope: "shared", members: [] })).toThrow(
      "remove this entity",
    );
    expect(store.scope("policy")).toEqual(saved);
    const removed = set({ scope: "device", members: [], expectedRevision: 1 });
    expect(removed.revision).toBe(2);
    expect(store.scope("policy").members).toEqual([]);
    expect(() => set({ expectedRevision: 0 })).toThrow("changed since");
    const reshared = set({ expectedRevision: 2 });
    expect(reshared.revision).toBe(3);
    store.deleteEntities(["home"]);
    expect(store.scope("policy").members).toEqual([]);
    expect(store.activity(10).some((a) => a.action === "set_scope")).toBe(true);
  } finally {
    store.close();
  }
});

test("upgrading an evidence-aware database creates a portable backup and preserves local scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mikrotik-shared-migration-"));
  const path = join(directory, "memory.db");
  try {
    const before = await openMemoryStore(path);
    before.createEntities([{ name: "home", entityType: "router" }]);
    before.remember(RememberSchema.parse({ entityName: "home", content: "Local MTU 1380" }));
    before.close();
    const previous = new Database(path);
    previous.run("DROP TABLE memory_group_members");
    previous.run("DROP TABLE memory_scopes");
    previous.close();
    const after = await openMemoryStore(path);
    expect(after.scope("home").scope).toBe("device");
    expect(after.facts(BrowseSchema.parse({ scope: "device" })).total).toBe(1);
    expect(after.facts(BrowseSchema.parse({ scope: "shared" })).total).toBe(0);
    after.close();
    const backupName = readdirSync(directory).find((name) => name.includes(".pre-shared-memory-"))!;
    expect(backupName).toBeDefined();
    const backup = new Database(join(directory, backupName), { readonly: true });
    expect(backup.query("SELECT content FROM observations").get()).toEqual({
      content: "Local MTU 1380",
    });
    expect(
      backup.query("SELECT 1 FROM sqlite_master WHERE name = 'memory_scopes'").get(),
    ).toBeNull();
    backup.close();
    const reopened = await openMemoryStore(path);
    reopened.close();
    expect(readdirSync(directory).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true });
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
