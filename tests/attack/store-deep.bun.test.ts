/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAttackStore } from "../../src/attack/store";
import type { Incident } from "../../src/attack/correlate";

/** Incidents and response decisions must be durable and independently queryable. */
test("attack history, revocation, baseline, and retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attack-store-"));
  const path = join(dir, "nested", "attack.db");
  let store = await openAttackStore(path);
  const now = Date.now();
  const old = now - 40 * 86_400_000;
  const incident: Incident = {
    id: "i1",
    source: "192.0.2.1",
    devices: ["a"],
    stage: "recon",
    confidence: "high",
    severity: "high",
    firstTs: old,
    lastTs: old,
    detectors: [],
    narrative: "scan",
    recommendations: [],
    evidence: [],
    spoofableOnly: false,
    signalCount: 2,
  };
  const response = {
    incidentId: "i1",
    action: "block" as const,
    source: incident.source,
    devices: ["a"],
    timeout: "",
    list: "blocked",
    reason: "scan",
    ts: old,
    ok: true,
  };
  try {
    expect(store.getIncident("missing")).toBeNull();
    store.saveIncident(incident);
    store.saveIncident({ ...incident, narrative: "updated", lastTs: now });
    expect(store.getIncident("i1")?.narrative).toBe("updated");
    expect(store.listIncidents({ since: now, limit: 1 })).toHaveLength(1);
    const id = store.recordResponse(response);
    store.recordResponse({
      ...response,
      source: "192.0.2.2",
      ok: false,
      error: "offline",
      ts: now,
    });
    store.recordResponse({ ...response, source: "192.0.2.3", action: "watch", ts: now });
    expect(store.listResponses()).toHaveLength(3);
    expect(store.responseFor(incident.source)?.id).toBe(id);
    expect(store.responseFor("192.0.2.2")).toBeNull();
    expect(store.countRecentBlocks(["a"], old)).toBe(1);
    expect(store.countRecentBlocks(["b"], old)).toBe(0);
    expect(store.revokeResponse(incident.source, now)).toBe(true);
    expect(store.revokeResponse(incident.source, now)).toBe(false);
    expect(store.responseFor(incident.source)).toBeNull();
    expect(store.listResponses({ active: true })).toHaveLength(1);
    expect(store.baselineFor("a", 100, now)).toEqual({ sources: [], ready: false });
    store.recordBaselineSource("a", "192.0.2.10", now - 200);
    expect(store.baselineFor("a", 100, now)).toEqual({ sources: ["192.0.2.10"], ready: true });
    store.recordBaselineSource("a", "192.0.2.10", now);
    expect(store.baselineFor("a", 100, now).ready).toBe(false);
    store.close();
    store = await openAttackStore(path);
    expect(store.getIncident("i1")?.narrative).toBe("updated");
    expect(store.listResponses()).toHaveLength(3);
    expect(store.prune(now, 1)).toBe(0);
    store.saveIncident({ ...incident, id: "old", lastTs: old });
    expect(store.prune(now, 1)).toBe(1);
    expect(store.getIncident("old")).toBeNull();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Opening an invalid SQLite target surfaces the error. */
test("open rejects a directory path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attack-store-error-"));
  try {
    await rejects(openAttackStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
