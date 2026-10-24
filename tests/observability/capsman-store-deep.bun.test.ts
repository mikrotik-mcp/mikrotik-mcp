/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCapsmanStore } from "../../src/observability/capsman-store";

/** Radio gauges are grouped by device and remain available after reopening. */
test("CAPsMAN sample series, retention, and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capsman-store-"));
  const path = join(dir, "nested", "capsman.db");
  let store = await openCapsmanStore(path);
  try {
    store.recordRadioSamples("a", 10, []);
    store.recordRadioSamples("a", 10, [
      { radioId: "r1", cap: "cap1", band: "5ghz", channel: 36, clients: 2 },
    ]);
    store.recordRadioSamples("a", 20, [
      { radioId: "r1", cap: "cap1", band: "5ghz", clients: 5 },
      { radioId: "r2", cap: "cap2", band: "2ghz", clients: 1 },
    ]);
    store.recordRadioSamples("b", 20, [{ radioId: "r1", cap: "other", band: "5ghz", clients: 99 }]);
    expect(store.radioSeries("a", 0)).toEqual([
      {
        radioId: "r1",
        cap: "cap1",
        band: "5ghz",
        peak: 5,
        avg: 4,
        points: [
          { ts: 10, clients: 2, channel: 36 },
          { ts: 20, clients: 5, channel: null },
        ],
      },
      {
        radioId: "r2",
        cap: "cap2",
        band: "2ghz",
        peak: 1,
        avg: 1,
        points: [{ ts: 20, clients: 1, channel: null }],
      },
    ]);
    store.close();
    store = await openCapsmanStore(path);
    expect(store.radioSeries("a", 20)[0]?.points).toHaveLength(1);
    expect(store.pruneSamples(20)).toBe(1);
    expect(store.pruneSamples(20)).toBe(0);
    expect(store.radioSeries("b", 0)[0]?.peak).toBe(99);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A failed database open must be visible to the caller. */
test("open rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capsman-store-error-"));
  try {
    await rejects(openCapsmanStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
