/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSnapshotStore } from "../../src/snapshots/store";
import type { Snapshot } from "../../src/snapshots/store";

/** Configuration bodies and baseline pointers must persist across process restarts. */
test("snapshot CRUD, metadata listing, baselines, and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-store-"));
  const path = join(dir, "nested", "snapshots.db");
  let store = await openSnapshotStore(path);
  const snapshot = (id: string, ts: number, device = "a"): Snapshot => ({
    id,
    device,
    ts,
    body: "/ip address print",
    bytes: 17,
    lines: 1,
    sha: `sha-${id}`,
    label: "before",
    rosVersion: "7.1",
  });
  try {
    expect(store.get("missing")).toBeNull();
    expect(store.latest("a")).toBeNull();
    store.insert(snapshot("s1", 10));
    store.insert(snapshot("s2", 20));
    store.insert(snapshot("s3", 30, "b"));
    expect(store.count("a")).toBe(2);
    expect(store.latest("a")?.id).toBe("s2");
    expect(store.list("a").map((s) => [s.id, s.body])).toEqual([
      ["s2", ""],
      ["s1", ""],
    ]);
    expect(store.list("a", 1, true)).toEqual([snapshot("s2", 20)]);
    expect(store.get("s1")).toEqual(snapshot("s1", 10));
    expect(store.getBaseline("a")).toBeNull();
    store.setBaseline("a", "s1", "operator", "gold", "approved");
    expect(store.getBaseline("a")).toMatchObject({
      snapshotId: "s1",
      setBy: "operator",
      label: "gold",
      notes: "approved",
    });
    store.setBaseline("a", "s2");
    expect(store.listBaselines()).toHaveLength(1);
    store.close();
    store = await openSnapshotStore(path);
    expect(store.getBaseline("a")?.snapshotId).toBe("s2");
    expect(store.get("s3")?.device).toBe("b");
    expect(store.delete([])).toBe(0);
    expect(store.delete(["s1", "absent"])).toBe(1);
    expect(store.removeBaseline("a")).toBe(true);
    expect(store.removeBaseline("a")).toBe(false);
    expect(store.count("a")).toBe(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** SQLite open failures should propagate to callers. */
test("open rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-store-error-"));
  try {
    await rejects(openSnapshotStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
