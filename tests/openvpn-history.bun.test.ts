/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenVpnHistoryStore } from "../src/observability/openvpn-history";
import type { OpenVpnSession } from "../src/core/openvpn-sessions-model";

const stores: OpenVpnHistoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const session: OpenVpnSession = {
  id: "*1",
  name: "ali",
  sessionId: "abc",
  address: "10.0.0.2",
  callerId: "1.1.1.1",
  uptime: "10s",
  uptimeSeconds: 10,
  radius: true,
  encoding: "AES",
  sourceGeo: {
    status: "resolved",
    country: "Australia",
    countryCode: "au",
    asn: "AS13335",
    asnOrganization: "Cloudflare",
  },
};
function setup() {
  const store = new OpenVpnHistoryStore(new Database(":memory:"));
  stores.push(store);
  return store;
}
function read(store: OpenVpnHistoryStore, user = "", from = 0, to = 999999999, now = 10000000) {
  return store.report({ device: "home", user, from, to, offset: 0 }, now);
}
function ingest(
  store: OpenVpnHistoryStore,
  at: number,
  sessions: OpenVpnSession[],
  device = "home",
) {
  store.ingest({ device, observedAt: at, sessions, canDisconnect: false });
}
test("deduplicates polls, closes only absent sessions, and preserves geo and per-user totals", () => {
  const store = setup();
  ingest(store, 100000, [session]);
  ingest(store, 115000, [{ ...session, uptimeSeconds: 25, sourceGeo: { status: "pending" } }]);
  ingest(store, 130000, []);
  ingest(store, 145000, [{ ...session, uptimeSeconds: 1 }]);
  ingest(store, 145000, [session], "other");
  const report = read(store);
  expect(report.totals.connections).toBe(2);
  expect(report.allTime).toBe(2);
  expect(report.networks[0].label).toBe("AS13335");
  expect(report.sessions[1].ended).toBe(130000);
  expect(report.sessions[1].lastSeen).toBe(115000);
  expect(read(store, "missing").totals.connections).toBe(0);
  expect(read(store, "ali", 144000, 144000).totals.connections).toBe(1);
});
test("outages never end sessions, late snapshots cannot replace current state, and gaps are visible", () => {
  const store = setup();
  ingest(store, 100000, [session]);
  store.failure("home");
  ingest(store, 200000, [{ ...session, uptimeSeconds: 110 }]);
  ingest(store, 150000, []);
  const report = read(store);
  expect(report.totals.connections).toBe(1);
  expect(report.sessions[0]).toMatchObject({ ended: null, lastSeen: 200000, uncertain: 1 });
  expect(report.coverage).toMatchObject({ gaps: 1, failures: 1 });
});
test("reused identifiers with reset uptime produce a new session; reports have bounded warm caches", () => {
  const store = setup();
  ingest(store, 100000, [session]);
  const before = read(store);
  ingest(store, 115000, [{ ...session, uptimeSeconds: 1 }]);
  expect(read(store)).toBe(before);
  const after = read(store, "", 0, 999999999, 10030001);
  expect(after.totals.connections).toBe(2);
  expect(after.sessions[1].ended).toBe(115000);
});
test("pages are bounded and user input cannot alter queries", () => {
  const store = setup();
  ingest(
    store,
    100000,
    Array.from({ length: 60 }, (_, i) => ({ ...session, id: `*${i}`, sessionId: String(i) })),
  );
  expect(read(store).sessions).toHaveLength(50);
  expect(read(store, "' OR 1=1 --").totals.connections).toBe(0);
});

test("persisted active sessions survive reopening without creating a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovpn-history-test-"));
  try {
    const path = join(dir, "history.db");
    const first = new OpenVpnHistoryStore(new Database(path));
    ingest(first, 100000, [session]);
    first.close();
    const second = new OpenVpnHistoryStore(new Database(path));
    try {
      ingest(second, 200000, [{ ...session, uptimeSeconds: 110 }]);
      expect(read(second).totals.connections).toBe(1);
      expect(read(second).sessions[0].uncertain).toBe(1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late enrichment completes ended sessions and unknown uptime does not erase a known duration", () => {
  const store = setup();
  ingest(store, 100000, [{ ...session, sourceGeo: { status: "pending" } }]);
  ingest(store, 115000, [{ ...session, uptimeSeconds: null, sourceGeo: { status: "pending" } }]);
  ingest(store, 130000, []);
  store.enrich(() => session.sourceGeo);
  const report = read(store);
  expect(report.sessions[0].uptime).toBe(10);
  expect(report.sessions[0].asn).toBe("AS13335");
  expect(report.sessions[0].uncertain).toBe(1);
});
