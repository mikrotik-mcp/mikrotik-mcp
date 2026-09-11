/// <reference types="bun" />
/** Bun-only SQLite smoke check. In-memory database, no router/config access or filesystem writes. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { InvestigationStore } from "../../src/investigations/store";
import type { Investigation } from "../../src/investigations/model";

const db = new Database(":memory:");
try {
  const first = new InvestigationStore(db);
  const value: Investigation = {
    id: "case-test",
    createdAt: 1,
    finishedAt: 2,
    device: "edge",
    devices: ["edge"],
    client: "192.0.2.10",
    target: "example.com",
    service: "Test",
    clientOutcome: "unverified",
    evidence: [],
    nextTests: [],
  };
  first.save(value);
  assert.throws(() => first.save(value), "Duplicate case IDs must not overwrite history");
  const reopened = new InvestigationStore(db);
  assert.deepEqual(reopened.get(value.id), value);
  assert.equal(reopened.list("other").length, 0);
  assert.equal(reopened.list("edge").length, 1);
  assert.equal(reopened.get("missing"), undefined);
  console.warn("Investigation SQLite smoke checks passed");
} finally {
  db.close();
}
