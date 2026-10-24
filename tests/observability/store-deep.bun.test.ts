/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "../../src/observability/store";
import type { ToolEvent } from "../../src/observability/event";

/** Verify dashboard history remains queryable and deletions survive a restart. */
test("event CRUD, filters, pruning, and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "event-store-"));
  const path = join(dir, "nested", "events.db");
  let store = await openSqliteStore(path);
  const event = (id: string, ts: number, overrides: Partial<ToolEvent> = {}): ToolEvent => ({
    id,
    ts,
    tool: "list_interfaces",
    title: "Interfaces",
    risk: "READ",
    device: "a",
    durationMs: 3,
    isError: false,
    input: "{}",
    output: "ok",
    outputBytes: 2,
    hasStructured: false,
    truncated: false,
    ...overrides,
  });
  try {
    store.insert(event("one", 10));
    store.insert(
      event("two", 20, {
        tool: "set_route",
        risk: "WRITE",
        device: "b",
        isError: true,
        error: "denied",
        reason: "change",
        logs: [{ offsetMs: 1, level: "error", message: "failed" }],
        logsTruncated: true,
        bodyCaptured: false,
      }),
    );
    store.insert(event("three", 30, { output: "needle" }));
    expect(store.total()).toBe(3);
    expect(
      store
        .query({
          tool: "set_route",
          risk: "WRITE",
          device: "b",
          status: "error",
          q: "denied",
          since: 20,
          until: 20,
        })
        .map((e) => e.id),
    ).toEqual(["two"]);
    expect(
      store.query({ status: "ok", q: "needle", offset: 0, limit: 1 }).map((e) => e.id),
    ).toEqual(["three"]);
    expect(store.get("two")).toMatchObject({
      error: "denied",
      logsTruncated: true,
      bodyCaptured: false,
    });
    expect(store.get("missing")).toBeNull();
    expect(store.prune(2)).toBe(1);
    expect(store.get("one")).toBeNull();
    expect(store.delete([])).toBe(0);
    expect(store.delete(["two", "missing"])).toBe(1);
    store.close();
    store = await openSqliteStore(path);
    expect(store.query({}).map((e) => e.id)).toEqual(["three"]);
    expect(store.clear()).toBe(1);
    expect(store.clear()).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A database-open failure must reach the caller after best-effort directory creation. */
test("open rejects a directory used as the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "event-store-error-"));
  try {
    await rejects(openSqliteStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
