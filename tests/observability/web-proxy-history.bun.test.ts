/// <reference types="bun" />
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openProxyHistory,
  PROXY_RANGES,
  proxyReading,
  proxyReport,
} from "../../src/observability/web-proxy-history";

function reading(ts: number, value: number) {
  return {
    ts,
    uptime: ts / 1000,
    received: value,
    sent: value * 2,
    requests: value,
    clients: 2,
    servers: 1,
  };
}
test("reads RouterOS monitor units and distinguishes missing counters from idle readings", () => {
  const raw =
    "uptime: 10m\nreceived-from-servers: 2KiB\nsent-to-clients: 0B\nrequests: 0\nclient-connections: 3";
  expect(proxyReading(raw, 1000)).toEqual({
    ts: 1000,
    uptime: 600,
    received: 2048,
    sent: 0,
    requests: 0,
    clients: 3,
    servers: null,
  });
  expect(proxyReading("status: stopped", 1000)).toBeNull();
});
test("clips measured deltas to the window and keeps gaps, restarts and counter resets out of totals", () => {
  const rows = [
    reading(0, 0),
    reading(15000, 150),
    reading(30000, 0),
    reading(45000, 150),
    reading(120000, 600),
    { ...reading(135000, 750), uptime: 1 },
    { ...reading(150000, 750), uptime: 16 },
  ];
  const report = proxyReport(rows, 5000, 155000);
  expect(report).toMatchObject({ coveredMs: 40000, received: 250, sent: 500, requests: 250 });
  expect(report.points[0]).toMatchObject({ rx: 80, tx: 160 });
  expect(report.points[20]).toMatchObject({ rx: null, tx: null });
  expect(report.points.at(-3)).toMatchObject({ rx: 0, tx: 0 });
});
test("retains historical samples across restarts and isolates routers in every time range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-"));
  const path = join(dir, "history.db");
  const now = Date.now();
  const history = await openProxyHistory(path);
  try {
    for (const [offset, delta] of [
      [0, 1],
      [1800000, 2],
      [7200000, 4],
      [2 * 86400000, 8],
      [8 * 86400000, 16],
    ]) {
      history.record("a", reading(now - offset - 15000, 0));
      history.record("a", reading(now - offset, delta));
    }
    history.record("b", reading(now, 999));
    history.prune();
    history.close();
    const reopened = await openProxyHistory(path);
    try {
      const expected = { "15m": 1, "1h": 3, "24h": 7, "7d": 15 };
      for (const range of Object.keys(PROXY_RANGES) as (keyof typeof PROXY_RANGES)[]) {
        const report = reopened.report("a", range, now);
        expect(report.received).toBe(expected[range]);
        expect(report.points).toHaveLength(60);
        expect(report.latest?.received).toBe(1);
      }
      expect(reopened.report("b", "7d", now)).toMatchObject({
        coveredMs: 0,
        latest: { received: 999 },
      });
      expect(reopened.report("c", "7d", now)).toMatchObject({ coveredMs: 0, latest: null });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
