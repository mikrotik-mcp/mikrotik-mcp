/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageStore } from "../../src/observability/usage-store";

/** Counter resets and VPN accounting must survive restart without cross-device leakage. */
test("usage samples, session upsert, retention, and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-"));
  const path = join(dir, "nested", "usage.db");
  let store = await openUsageStore(path);
  const day = "2026-01-02";
  const t = Date.parse(`${day}T00:00:00Z`);
  try {
    store.recordClientSamples("a", t, []);
    store.recordClientSamples("a", t, [{ ip: "192.0.2.1", rx: 100, tx: 50 }]);
    store.recordClientSamples("a", t + 1000, [{ ip: "192.0.2.1", rx: 130, tx: 70 }]);
    store.recordClientSamples("a", t + 2000, [{ ip: "192.0.2.1", rx: 5, tx: 2 }]);
    store.recordClientSamples("b", t + 2000, [{ ip: "192.0.2.1", rx: 999, tx: 999 }]);
    expect(store.clientDailyUsage("a", "192.0.2.1", t)).toEqual([{ day, rx: 35, tx: 22 }]);
    expect(store.clientDailyUsage("b", "192.0.2.1", t)).toEqual([]);
    const session = { sessionId: "s1", user: "alice", started: t, rx: 10, tx: 20 };
    expect(store.upsertSessions("a", [])).toBe(0);
    expect(store.upsertSessions("a", [session, { ...session, sessionId: "s2", rx: 4 }])).toBe(2);
    expect(store.upsertSessions("a", [{ ...session, rx: 30 }])).toBe(1);
    expect(store.umUsers("a")).toEqual(["alice"]);
    expect(store.umUserDailyUsage("a", "alice", t)).toEqual([{ day, rx: 34, tx: 40 }]);
    expect(store.heatmap("a", "alice", t)).toEqual([{ day, count: 2 }]);
    expect(store.heatmap("a", null, t)).toEqual([{ day, count: 2 }]);
    store.close();
    store = await openUsageStore(path);
    expect(store.umUsers("a")).toEqual(["alice"]);
    expect(store.pruneSamples(t + 2000)).toBe(2);
    expect(store.clientDailyUsage("a", "192.0.2.1", t)).toEqual([]);
    expect(store.pruneSamples(t + 2000)).toBe(0);
    expect(store.umUserDailyUsage("a", "alice", t)).toHaveLength(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Invalid SQLite targets should reject without touching a configured database. */
test("open rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-error-"));
  try {
    await rejects(openUsageStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
