import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBandwidthStore } from "../../src/bandwidth/store";
import type { BandwidthStore } from "../../src/bandwidth/store";
import { BandwidthJobSchema } from "../../src/bandwidth/model";
import { launchBandwidth, tickBandwidth } from "../../src/bandwidth/service";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
import type { BandwidthRun } from "../../src/bandwidth/types";

const stores: BandwidthStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function open(path = ":memory:") {
  const store = await openBandwidthStore(path);
  stores.push(store);
  return store;
}
const job = {
  ...BandwidthJobSchema.parse({
    id: "wg",
    name: "WireGuard",
    source: "a",
    destination: "b",
    sourceInterface: "wg0",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
  }),
  nextRunAt: 100,
  enabled: true,
};
const run = (id: string): BandwidthRun => ({
  id,
  job,
  startedAt: 100,
  finishedAt: null,
  status: "running",
  trigger: "manual",
  txBps: null,
  rxBps: null,
  lostPackets: null,
  message: "",
});
const cfg = () =>
  MikrotikConfigSchema.parse({
    devices: {
      a: { host: "192.0.2.1" },
      b: { host: "192.0.2.2" },
      c: { host: "192.0.2.3" },
      d: { host: "192.0.2.4" },
    },
    defaultDevice: "a",
  });

test("leases are atomic across connections, share either router and bound global concurrency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bandwidth-"));
  dirs.push(dir);
  const a = await open(join(dir, "test.db"));
  const b = await open(join(dir, "test.db"));
  expect(a.claim(run("first"), "a", "b", 100)).toBe(true);
  expect(b.claim(run("conflict"), "b", "c", 100)).toBe(false);
  expect(b.claim(run("second"), "c", "d", 100)).toBe(true);
  expect(a.claim(run("full"), "e", "f", 100)).toBe(false);
  a.finish({ ...run("first"), status: "ok", finishedAt: 200, txBps: 3, rxBps: 4 });
  expect(b.claim(run("freed"), "a", "b", 200)).toBe(true);
});
test("restart preserves schedules, history and completion order; deleting definition keeps evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bandwidth-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  const first = await open(path);
  first.save(job);
  first.claim(run("slow"), "a", "b", 100);
  first.claim(run("fast"), "c", "d", 100);
  first.finish({ ...run("fast"), status: "failed", finishedAt: 150, message: "fixed failure" });
  first.finish({ ...run("slow"), status: "ok", finishedAt: 200, txBps: 0 });
  first.finish({ ...run("slow"), status: "ok", finishedAt: 201 });
  const second = await open(path);
  expect(second.storeId).toBe(first.storeId);
  expect(second.job(job.id)).toEqual(job);
  expect(second.notifications(0, 1)).toMatchObject({ hasMore: true, nextCursor: 1 });
  expect(second.notifications(0, 100).events.map((e) => e.run.id)).toEqual(["fast", "slow"]);
  second.remove(job.id);
  expect(second.job(job.id)).toBeNull();
  expect(second.runs()).toHaveLength(2);
});
test("recovery waits out finite execution window then publishes exactly one interrupted outcome", async () => {
  const store = await open();
  store.claim(run("crash"), "a", "b", 100);
  store.recover(200);
  expect(store.runs()[0].status).toBe("running");
  store.recover(300101);
  expect(store.runs()[0].status).toBe("interrupted");
  store.recover(400000);
  expect(store.notifications(0, 100).events).toHaveLength(1);
  expect(store.claim(run("later"), "a", "b", 400001)).toBe(true);
});
test("schedules coalesce downtime, claim once and remain blocked while manual work uses either router", async () => {
  setConfig(cfg());
  const store = await open();
  store.save(job);
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const executor = {
    preflight: async () => ({ ready: true, checks: [], warning: "" }),
    measure: async () => {
      await wait;
      return { status: "ok" as const, txBps: 1, rxBps: 2, lostPackets: null, message: "done" };
    },
  };
  const pending = tickBandwidth(store, executor, 1000);
  expect(pending).toHaveLength(1);
  expect(store.job(job.id)?.nextRunAt).toBe(1000 + job.intervalSeconds * 1000);
  expect(tickBandwidth(store, executor, 1000)).toHaveLength(0);
  expect(() => launchBandwidth(store, job, "manual", executor, 1000)).toThrow("busy");
  release();
  await Promise.all(pending);
  expect(store.runs()[0].status).toBe("ok");
});
test("preflight failures and raw transport secrets never enter measurement/history; locks release after settling", async () => {
  setConfig(cfg());
  const store = await open();
  let measured = false;
  const executor = {
    preflight: async () => ({
      ready: false,
      checks: [{ name: "route", ok: false, message: "Route mismatch" }],
      warning: "",
    }),
    measure: async () => {
      measured = true;
      throw new Error("password=SECRET");
    },
  };
  await launchBandwidth(store, job, "manual", executor).done;
  expect(measured).toBe(false);
  expect(store.runs()[0].message).toBe("Route mismatch");
  await launchBandwidth(store, job, "manual", {
    ...executor,
    preflight: async () => ({ ready: true, checks: [], warning: "" }),
  }).done;
  expect(store.runs()[0].status).toBe("failed");
  expect(JSON.stringify(store.runs())).not.toContain("SECRET");
  expect(store.notifications(0, 100).events).toHaveLength(2);
});
