/// <reference types="bun" />
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { HomeStore } from "../../src/home/store";
import type { PolicyPlan } from "../../src/home/model";
const db = new Database(":memory:");
try {
  const store = new HomeStore(db);
  const plan: PolicyPlan = {
    id: "one",
    device: "home",
    input: { mac: "AA:BB:CC:DD:EE:FF", action: "pause", minutes: 30, startInMinutes: 0 },
    ip: "192.0.2.10",
    createdAt: Date.now(),
    previewExpiresAt: Date.now() + 60_000,
    fingerprint: "test",
    commands: [],
    undo: [],
    warnings: [],
    status: "preview",
  };
  store.savePlan(plan);
  store.claim({ ...plan, status: "applying" });
  assert.throws(() => store.claim({ ...plan, status: "applying" }));
  store.savePlan({ ...plan, id: "two" });
  assert.throws(() => store.claim({ ...plan, id: "two", status: "applying" }));
  for (let i = 0; i < 220; i++)
    store.savePlan({ ...plan, id: `preview-${i}`, createdAt: Date.now() + i });
  assert.equal(
    store.unresolved("home").length,
    1,
    "Old active policies cannot be hidden behind the history limit",
  );
  const reopened = new HomeStore(db);
  assert.ok(
    reopened.plans("home").some((p) => p.id === "one"),
    "Undo stays visible despite preview churn",
  );
  assert.equal(reopened.plan("one", "home")?.status, "applying");
  assert.equal(reopened.plan("one", "other"), undefined);
  assert.equal(reopened.unresolved("other").length, 0);
  store.savePlan({ ...plan, id: "expired", previewExpiresAt: 1 });
  assert.throws(() => store.claim({ ...plan, id: "expired", status: "applying" }));
  console.warn(
    "Home SQLite smoke passed: persistence, device isolation, atomic claims and active-client uniqueness.",
  );
} finally {
  db.close();
}
