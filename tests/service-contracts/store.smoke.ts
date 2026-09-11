/// <reference types="bun" />
/** Real SQLite persistence without network access or production files. */
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { ContractStore } from "../../src/service-contracts/store";
import { contractInput } from "../../src/service-contracts/model";

const db = new Database(":memory:");
try {
  const store = new ContractStore(db);
  const c = {
    ...contractInput.parse({ name: "Test", checks: [{ target: "test" }] }),
    id: "contract",
    device: "edge",
    createdAt: 1,
  };
  store.save(c);
  assert.throws(() => store.save(c));
  store.record({
    id: "run",
    contractId: c.id,
    device: "edge",
    startedAt: 2,
    finishedAt: 3,
    vantage: "mcp-host",
    status: "unknown",
    checks: [],
  });
  const reopened = new ContractStore(db);
  assert.deepEqual(reopened.get(c.id), c);
  assert.equal(reopened.list("edge").length, 1);
  assert.equal(reopened.list("other").length, 0);
  assert.equal(reopened.history(c.id)[0].status, "unknown");
  assert.equal(reopened.history("other").length, 0);
  console.warn("Service contract SQLite smoke checks passed");
} finally {
  db.close();
}
