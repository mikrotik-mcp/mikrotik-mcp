/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTxnStore } from "../../src/txn/store";
import type { TxnRecord } from "../../src/txn/store";

/** Transaction snapshots and their ordered timeline must remain durable together. */
test("transaction CRUD and per-transaction event sequences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "txn-store-"));
  const path = join(dir, "nested", "txns.db");
  let store = await openTxnStore(path);
  const record: TxnRecord = {
    id: "one",
    ts: 1,
    updated: 1,
    devices: ["a", "b"],
    commitOrder: ["b", "a"],
    phase: "prepare",
    participants: [{ device: "a", stage: "prepared" }],
    results: [],
    warnings: [],
  };
  try {
    expect(store.get("missing")).toBeNull();
    store.save(record);
    store.save({ ...record, phase: "done", state: "COMMITTED", updated: 3, label: "done" });
    store.save({ ...record, id: "two", ts: 2 });
    expect(store.list(1).map((r) => r.id)).toEqual(["two"]);
    expect(store.appendEvent({ txnId: "one", ts: 1, kind: "prepare", ok: true })).toBe(1);
    expect(
      store.appendEvent({
        txnId: "one",
        ts: 2,
        kind: "verify",
        device: "a",
        ok: false,
        detail: "failed",
      }),
    ).toBe(2);
    expect(store.appendEvent({ txnId: "two", ts: 2, kind: "prepare", ok: true })).toBe(1);
    store.close();
    store = await openTxnStore(path);
    expect(store.get("one")?.state).toBe("COMMITTED");
    expect(store.events("one").map((event) => event.seq)).toEqual([1, 2]);
    expect(store.events("one")[1]).toMatchObject({ ok: false, detail: "failed", device: "a" });
    expect(store.events("missing")).toEqual([]);
    expect(store.remove("one")).toBe(true);
    expect(store.events("one")).toEqual([]);
    expect(store.remove("one")).toBe(false);
    expect(store.get("two")).not.toBeNull();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Invalid database targets surface an error. */
test("transaction store rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "txn-store-error-"));
  try {
    await rejects(openTxnStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
