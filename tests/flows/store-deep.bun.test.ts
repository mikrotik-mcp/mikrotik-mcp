/// <reference types="bun" />
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFlowStore } from "../../src/flows/store";
import type { FlowRecord } from "../../src/flows/decode";

test("real rows aggregate by minute, filter exact tuples, and survive reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-deep-"));
  const path = join(dir, "nested", "flows.db");
  let store: Awaited<ReturnType<typeof openFlowStore>> | undefined;
  const record: FlowRecord = {
    start: 60_100,
    end: 60_200,
    exporter: "router-a",
    src: "192.0.2.1",
    dst: "203.0.113.2",
    srcPort: 51000,
    dstPort: 443,
    protocol: 6,
    bytes: 100,
    packets: 2,
    tcpFlags: 2,
    version: 9,
    inputIf: 3,
    outputIf: 4,
  };
  try {
    store = await openFlowStore(path);
    store.insert([]);
    store.insert([
      record,
      { ...record, start: 60_300, end: 60_400, bytes: 40, packets: 1 },
      { ...record, start: 120_100, end: 120_200, dstPort: 53, bytes: 20, packets: 1 },
    ]);
    expect(store.stats()).toMatchObject({
      rawRows: 3,
      rollupRows: 2,
      oldestRaw: 60_100,
      newestRaw: 120_100,
    });
    expect(store.rollups(60_000, 120_000)).toEqual([
      expect.objectContaining({ minute: 60_000, bytes: 140, packets: 3, flows: 2 }),
    ]);
    expect(
      store.query({
        from: 60_000,
        to: 120_000,
        exporter: "router-a",
        address: "203.0.113.2",
        tuple: {
          src: record.src,
          dst: record.dst,
          srcPort: record.srcPort,
          dstPort: 443,
          protocol: 6,
        },
        limit: 1,
      }),
    ).toEqual([expect.objectContaining({ bytes: 40, inputIf: 3, outputIf: 4 })]);
    expect(store.query({ from: 60_000, to: 120_000, exporter: "router-b" })).toEqual([]);
    store.close();
    store = await openFlowStore(path);
    expect(store.stats().rawRows).toBe(3);
    expect(store.rollups(0, 180_000)).toHaveLength(2);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cap eviction and retention remove the correct tiers and report losses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-retention-"));
  const events: { rows: number; reason: string }[] = [];
  const store = await openFlowStore(join(dir, "flows.db"), {
    maxRows: 2,
    retentionHours: 1,
    rollupDays: 1,
    onEvict: (rows, reason) => events.push({ rows, reason }),
  });
  const base: FlowRecord = {
    start: 0,
    end: 1,
    src: "a",
    dst: "b",
    srcPort: 1,
    dstPort: 2,
    protocol: 6,
    bytes: 10,
    packets: 1,
    version: 9,
  };
  try {
    store.insert([
      base,
      { ...base, start: 60_000, end: 60_001 },
      { ...base, start: 120_000, end: 120_001 },
    ]);
    expect(store.stats()).toMatchObject({
      rawRows: 2,
      rollupRows: 3,
      evicted: 1,
      oldestRaw: 60_000,
    });
    expect(events[0]).toMatchObject({ rows: 1, reason: expect.stringContaining("cap") });
    expect(store.prune(90_000_000)).toEqual({ rawDeleted: 2, rollupDeleted: 3 });
    expect(store.stats()).toMatchObject({ rawRows: 0, rollupRows: 0, evicted: 3 });
    expect(events[1]).toMatchObject({ rows: 5, reason: expect.stringContaining("retention") });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
