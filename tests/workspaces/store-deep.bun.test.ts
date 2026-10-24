/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../../src/workspaces/store";

/** Workspace claims and compare-and-swap must reject stale or concurrent writers. */
test("workspace CRUD, scoped reads, claim, replace, and migration exclusion", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-store-"));
  const path = join(dir, "workspaces.db");
  let db = new Database(path);
  let store = new WorkspaceStore(db);
  const first = { id: "first", device: "a", createdAt: 1, status: "preview", runs: [] };
  try {
    expect(store.get("migration", "missing")).toBeUndefined();
    store.save("migration", first);
    store.save("migration", { ...first, id: "second", createdAt: 2 });
    expect(store.list("migration", "a").map((r) => r.id)).toEqual(["second", "first"]);
    expect(store.get("migration", "first", "b")).toBeUndefined();
    store.claim("migration", { ...first, status: "applying" }, "preview");
    expect(() => store.claim("migration", { ...first, status: "done" }, "preview")).toThrow(
      /already claimed/,
    );
    expect(() =>
      store.claim("migration", { ...first, id: "second", status: "applying" }, "preview"),
    ).toThrow();
    store.replace("migration", { ...first, status: "applying" }, { ...first, status: "uncertain" });
    expect(() => store.replace("migration", first, { ...first, status: "done" })).toThrow(
      /changed concurrently/,
    );
    store.save("client-check", { ...first, id: "check" });
    store.delete("client-check", "check", "b");
    expect(store.get("client-check", "check")).toBeDefined();
    db.close();
    db = new Database(path);
    store = new WorkspaceStore(db);
    expect(store.get("migration", "first")?.status).toBe("uncertain");
    store.delete("client-check", "check", "a");
    expect(store.get("client-check", "check")).toBeUndefined();
    store.delete("migration", "first", "a");
    store.claim("migration", { ...first, id: "second", status: "applying" }, "preview");
    expect(store.get("migration", "second")?.status).toBe("applying");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
