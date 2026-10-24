/// <reference types="bun" />
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScheduleStore } from "../../src/schedule/store";
import type { ScheduleJob } from "../../src/schedule/store";

/** Run history must survive reopening, retain its baseline, and obey each job's retention. */
test("schedule jobs and runs persist, filter, prune, and cascade on removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-store-"));
  const path = join(dir, "nested", "history.db");
  let store = await openScheduleStore(path);
  const job: ScheduleJob = {
    id: "audit",
    cron: "0 * * * *",
    tool: "read_health",
    devices: ["a"],
    notifyOn: [],
    args: { detail: true },
    enabled: true,
    retainDays: 1,
    createdAt: 1,
  };
  const run = {
    jobId: job.id,
    startedAt: 1,
    finishedAt: 2,
    outcome: "ok" as const,
    device: "a",
    findings: [],
    added: 1,
    worsened: 0,
    resolved: 0,
  };
  try {
    expect(store.getJob("missing")).toBeNull();
    store.saveJob(job);
    store.saveJob({ ...job, cron: "30 * * * *", enabled: false });
    expect(store.listJobs()).toEqual([{ ...job, cron: "30 * * * *", enabled: false }]);
    const first = store.recordRun(run);
    store.recordRun({ ...run, startedAt: 2, outcome: "failed", error: "offline" });
    store.recordRun({ ...run, startedAt: 3, device: "b" });
    expect(store.runs("audit", 1)[0]?.startedAt).toBe(3);
    expect(store.lastSuccessful("audit", "a")?.id).toBe(first);
    expect(store.lastSuccessful("audit", "missing")).toBeNull();
    store.close();
    store = await openScheduleStore(path);
    expect(store.runs()).toHaveLength(3);
    expect(store.runs("audit")[1]?.error).toBe("offline");
    expect(store.prune(86_400_003)).toBe(2);
    expect(store.runs("audit")).toHaveLength(1);
    expect(store.removeJob("audit")).toBe(true);
    expect(store.runs("audit")).toEqual([]);
    expect(store.removeJob("audit")).toBe(false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** SQLite open failures must reach the caller. */
test("schedule store rejects a directory as database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-store-error-"));
  try {
    await rejects(openScheduleStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
