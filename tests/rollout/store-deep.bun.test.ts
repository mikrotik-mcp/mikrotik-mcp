/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRolloutStore } from "../../src/rollout/store";
import type { RolloutRecord } from "../../src/rollout/store";

/** Rollout state and events must replay after a process restart. */
test("rollout CRUD, ordering, and event deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-store-"));
  const path = join(dir, "nested", "rollouts.db");
  let store = await openRolloutStore(path);
  const record: RolloutRecord = {
    id: "one",
    ts: 1,
    updated: 1,
    commands: ["/system clock print"],
    waves: [{ index: 0, devices: ["a"], isCanary: true }],
    devices: [{ device: "a", wave: 0, stage: "pending" }],
    gates: [],
    phase: "apply",
    notes: [],
  };
  try {
    expect(store.get("missing")).toBeNull();
    store.save(record);
    store.save({ ...record, phase: "done", outcome: "completed", notes: ["ok"], label: "rollout" });
    store.save({ ...record, id: "two", ts: 2 });
    expect(store.list(1).map((r) => r.id)).toEqual(["two"]);
    expect(store.appendEvent({ rolloutId: "one", ts: 1, kind: "apply", ok: true })).toBe(1);
    expect(
      store.appendEvent({
        rolloutId: "one",
        ts: 2,
        kind: "gate",
        device: "a",
        ok: false,
        detail: "unreachable",
      }),
    ).toBe(2);
    expect(store.appendEvent({ rolloutId: "two", ts: 2, kind: "apply", ok: true })).toBe(1);
    store.close();
    store = await openRolloutStore(path);
    expect(store.get("one")?.outcome).toBe("completed");
    expect(store.events("one").map((event) => event.seq)).toEqual([1, 2]);
    expect(store.events("one")[1]).toMatchObject({ ok: false, device: "a", detail: "unreachable" });
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
test("rollout store rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-store-error-"));
  try {
    await rejects(openRolloutStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
