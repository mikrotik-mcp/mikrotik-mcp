/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeStore } from "../../src/home/store";
import type { HomeClient, PolicyPlan } from "../../src/home/model";

/** Home policy claims must be atomic and scoped to the owning device. */
test("home clients, plan claims, active uniqueness, and expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-store-"));
  const path = join(dir, "home.db");
  let db = new Database(path);
  let store = new HomeStore(db);
  const client: HomeClient = {
    mac: "02:00:00:00:00:01",
    ip: "192.0.2.1",
    hostname: "host",
    name: "Desk",
    person: "Ali",
    firstSeen: 1,
    lastSeen: 2,
    acknowledged: false,
    present: true,
  };
  const plan: PolicyPlan = {
    id: "p1",
    device: "a",
    input: { mac: client.mac, action: "pause", minutes: 30, startInMinutes: 0 },
    ip: client.ip,
    createdAt: 1,
    previewExpiresAt: Date.now() + 60_000,
    fingerprint: "f",
    commands: [],
    undo: [],
    warnings: [],
    status: "preview",
  };
  try {
    expect(store.clients("a")).toEqual([]);
    store.saveClient("a", client);
    store.saveClient("a", { ...client, name: "Updated" });
    store.saveClient("b", client);
    expect(store.clients("a")[0]?.name).toBe("Updated");
    expect(store.clients("b")).toHaveLength(1);
    expect(store.plan("p1", "b")).toBeUndefined();
    store.savePlan(plan);
    store.claim({ ...plan, status: "applying" });
    expect(store.unresolved("a").map((p) => p.id)).toEqual(["p1"]);
    expect(store.plans("a")).toHaveLength(1);
    expect(() => store.claim({ ...plan, status: "active" })).toThrow(/already claimed/);
    store.savePlan({ ...plan, id: "p2" });
    expect(() => store.claim({ ...plan, id: "p2", status: "applying" })).toThrow();
    store.savePlan({
      ...plan,
      id: "expired",
      input: { ...plan.input, mac: "02:00:00:00:00:02" },
      previewExpiresAt: 1,
    });
    expect(() => store.claim({ ...plan, id: "expired", status: "applying" })).toThrow(/expired/);
    db.close();
    db = new Database(path);
    store = new HomeStore(db);
    expect(store.plan("p1", "a")?.status).toBe("applying");
    expect(store.plans("b")).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
