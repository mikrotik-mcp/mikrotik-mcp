/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteStore } from "../src/observability/store";
import { buildEvent } from "../src/observability/event";

test("call evidence survives restart and upgrades an existing event database without losing legacy IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-call-history-"));
  const path = join(directory, "events.db");
  let store = await openSqliteStore(path);
  const legacy = buildEvent(
    {
      tool: "list_interfaces",
      title: "Interfaces",
      risk: "READ",
      device: "lab",
      ts: 1,
      durationMs: 2,
      isError: false,
      args: {},
      output: "ok",
      hasStructured: false,
    },
    "legacy-1",
    { captureBody: true, maxBodyBytes: 1000 },
  );
  try {
    store.insert(legacy);
    store.close();
    const db = new Database(path);
    db.run("ALTER TABLE events DROP COLUMN diagnostics");
    db.close();
    store = await openSqliteStore(path);
    expect(store.get("legacy-1")?.output).toBe("ok");
    expect(store.get("legacy-1")?.logs).toBeUndefined();
    const id = crypto.randomUUID();
    const event = {
      ...legacy,
      id,
      ts: 2,
      logs: [{ offsetMs: 1, level: "info" as const, message: "read complete" }],
      logsTruncated: true,
    };
    store.insert(event);
    store.close();
    store = await openSqliteStore(path);
    expect(store.get(id)).toEqual(event);
    expect(store.query({ q: id }).map((row) => row.id)).toEqual([id]);
    expect(store.prune(1)).toBe(1);
    expect(store.get("legacy-1")).toBeNull();
    expect(store.delete([id])).toBe(1);
    expect(store.get(id)).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
