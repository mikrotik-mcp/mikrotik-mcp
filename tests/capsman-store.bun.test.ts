/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCapsmanStore } from "../src/observability/capsman-store";

const sample = { radioId: "wifi1", cap: "ap-1", band: "5ghz", clients: 2 };

test("CAPsMAN writes wait briefly for a real writer lock and recover without losing history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mikrotik-capsman-lock-"));
  const path = join(directory, "capsman.db");
  const store = await openCapsmanStore(path);
  const other = new Database(path);
  try {
    store.recordRadioSamples("edge", 1, [sample]);
    other.run("BEGIN IMMEDIATE");
    const started = performance.now();
    expect(() => store.pruneSamples(2)).toThrow("database is locked");
    const elapsed = performance.now() - started;
    // The wait belongs to this store's connection, not the competing writer.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1500);
    expect(() => store.recordRadioSamples("edge", 2, [sample])).toThrow("database is locked");
    other.run("ROLLBACK");
    expect(store.radioSeries("edge", 0)[0].points).toEqual([{ ts: 1, clients: 2, channel: null }]);
    store.recordRadioSamples("edge", 2, [sample]);
    expect(store.pruneSamples(2)).toBe(1);
    expect(store.radioSeries("edge", 0)[0].points).toEqual([{ ts: 2, clients: 2, channel: null }]);
  } finally {
    other.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("retention drains expired samples in bounded batches and preserves current radio history", async () => {
  const store = await openCapsmanStore(":memory:");
  try {
    store.recordRadioSamples(
      "edge",
      1,
      Array.from({ length: 5001 }, () => sample),
    );
    store.recordRadioSamples("edge", 2, [sample]);
    expect(store.pruneSamples(2)).toBe(5000);
    expect(store.pruneSamples(2)).toBe(1);
    expect(store.pruneSamples(2)).toBe(0);
    expect(store.radioSeries("edge", 0)[0].points).toEqual([{ ts: 2, clients: 2, channel: null }]);
  } finally {
    store.close();
  }
});
