/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageStore } from "../src/observability/usage-store";

test("usage writes recover after a real SQLite writer lock without losing stored history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mikrotik-usage-lock-"));
  const path = join(directory, "usage.db");
  const store = await openUsageStore(path);
  const other = new Database(path);
  try {
    store.recordClientSamples("edge", 1, [{ ip: "192.0.2.1", rx: 1, tx: 2 }]);
    other.run("BEGIN IMMEDIATE");
    const started = performance.now();
    expect(() => store.pruneSamples(2)).toThrow("database is locked");
    expect(performance.now() - started).toBeLessThan(1500);
    expect(() => store.recordClientSamples("edge", 2, [{ ip: "192.0.2.1", rx: 3, tx: 4 }])).toThrow(
      "database is locked",
    );
    other.run("ROLLBACK");
    expect(other.query("SELECT COUNT(*) AS n FROM usage_samples").get()).toEqual({ n: 1 });
    store.recordClientSamples("edge", 2, [{ ip: "192.0.2.1", rx: 3, tx: 4 }]);
    expect(store.pruneSamples(2)).toBe(1);
    expect(other.query("SELECT ts FROM usage_samples").all()).toEqual([{ ts: 2 }]);
  } finally {
    other.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("retention drains expired snapshots in bounded batches and preserves VPN sessions", async () => {
  const store = await openUsageStore(":memory:");
  try {
    store.recordClientSamples(
      "edge",
      1,
      Array.from({ length: 5001 }, () => ({ ip: "192.0.2.1", rx: 1, tx: 2 })),
    );
    store.recordClientSamples("edge", 2, [{ ip: "192.0.2.1", rx: 3, tx: 4 }]);
    store.upsertSessions("edge", [{ sessionId: "one", user: "alice", started: 1, rx: 1, tx: 2 }]);
    expect(store.pruneSamples(2)).toBe(5000);
    expect(store.pruneSamples(2)).toBe(1);
    expect(store.pruneSamples(2)).toBe(0);
    expect(store.umUsers("edge")).toEqual(["alice"]);
    expect(store.pruneSamples(3)).toBe(1);
  } finally {
    store.close();
  }
});
