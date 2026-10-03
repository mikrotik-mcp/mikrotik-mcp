import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  prepareRecovery,
  startRecovery,
  pollRecovery,
  destroyRecovery,
  getRecovery,
} from "../src/recovery-lab/service";
import { REQUIRED_CHECKS } from "../src/recovery-lab/model";
import type { RecoveryRun } from "../src/recovery-lab/model";
const mock = vi.hoisted(() => ({
  records: new Map<string, RecoveryRun>(),
  calls: [] as { method: string; path: string; body?: unknown }[],
  body: "/interface bridge\nadd name=lab",
  configured: true,
  failWrite: false,
  deny: false,
  wrong: false,
  failPoll: false,
}));
const caps = {
  protocol: "mikrotik-recovery/v1",
  runnerId: "isolated",
  isolated: true,
  productionNetworkAccess: false,
  disposable: true,
  enforcesTtl: true,
  versions: [
    { version: "7.20.1", imageSha256: "a".repeat(64), architecture: "x86_64" },
    { version: "7.19.1", imageSha256: "b".repeat(64), architecture: "x86_64" },
  ],
};
vi.mock("../src/core/runtime", () => ({
  resolveDeviceName: (d: string) => {
    if (!["lab", "other"].includes(d)) throw new Error("unknown");
    return d;
  },
}));
vi.mock("../src/core/scoped-access", () => ({
  assertDeviceAccess: () => {
    if (mock.deny) throw new Error("denied");
  },
}));
vi.mock("../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_k: string, id: string, d: string) => {
      const r = mock.records.get(id);
      return r?.device === d ? structuredClone(r) : undefined;
    },
    list: (_k: string, d: string) => [...mock.records.values()].filter((r) => r.device === d),
    put: (_k: string, r: RecoveryRun) => mock.records.set(r.id, structuredClone(r)),
    lock: () => {},
    unlock: () => {},
  }),
}));
vi.mock("../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({
    get: () => ({ id: "snap1", device: "lab", ts: 1, body: mock.body, rosVersion: "7.19.1" }),
    list: () => [],
    close: () => {},
  }),
}));
vi.mock("../src/recovery-lab/runner", () => ({
  runnerConfig: () =>
    mock.configured
      ? { base: "https://runner.example", binding: "bound", token: "secret" }
      : undefined,
  callRunner: async (method: string, path: string, body?: unknown) => {
    mock.calls.push({ method, path, body });
    if (path.endsWith("capabilities")) return caps;
    if ((method === "PUT" && mock.failWrite) || (method === "GET" && mock.failPoll))
      throw new Error("timeout");
    const r = [...mock.records.values()][0];
    return {
      protocol: "mikrotik-recovery/v1",
      id: r.id,
      runnerId: mock.wrong ? "wrong" : "isolated",
      version: r.version,
      requestSha256: r.requestSha256,
      isolated: true,
      productionNetworkAccess: false,
      state: method === "DELETE" ? "destroyed" : method === "PUT" ? "running" : "completed",
      cleanup: method === "DELETE" ? "destroyed" : "pending",
      checks: REQUIRED_CHECKS.map((name) => ({
        name,
        state: method === "PUT" ? "pending" : "pass",
        detail: "verified by runner",
      })),
    };
  },
}));
const ctx = { device: "lab", info: () => {}, error: () => {} };
beforeEach(() => {
  mock.records.clear();
  mock.calls = [];
  mock.body = "/interface bridge\nadd name=lab";
  mock.configured = true;
  mock.failWrite = false;
  mock.deny = false;
  mock.wrong = false;
  mock.failPoll = false;
});
test("preparation stays local and ownership is enforced", async () => {
  mock.configured = false;
  const r = await prepareRecovery({ snapshotId: "snap1", version: "7.20.1" }, ctx);
  expect(r.state).toBe("prepared");
  expect(mock.calls).toHaveLength(0);
  await expect(startRecovery(r.id, true, ctx)).rejects.toThrow(/unavailable/);
  await expect(
    prepareRecovery({ snapshotId: "snap1", version: "7.20.1" }, { ...ctx, device: "other" }),
  ).rejects.toThrow(/not found/);
  expect((await getRecovery({ ...ctx, device: "other" })).runs).toHaveLength(0);
});
test("requires confirmation, binds preview and completes only with all runner checks", async () => {
  const r = await prepareRecovery({ snapshotId: "snap1", version: "7.20.1", mode: "upgrade" }, ctx);
  await expect(startRecovery(r.id, false, ctx)).rejects.toThrow(/confirmation/);
  expect((await startRecovery(r.id, true, ctx)).state).toBe("running");
  expect((await pollRecovery(r.id, ctx)).state).toBe("passed");
  await expect(startRecovery(r.id, true, ctx)).rejects.toThrow(/replay/);
  const request = mock.calls.find((c) => c.method === "PUT")!.body;
  expect(JSON.stringify(request)).not.toContain("secret");
  expect(request).toMatchObject({
    mode: "upgrade",
    ttlSeconds: 900,
    network: { productionNetworkAccess: false },
  });
  await expect(destroyRecovery(r.id, false, ctx)).rejects.toThrow(/Confirm/);
  expect((await destroyRecovery(r.id, true, ctx)).state).toBe("destroyed");
});
test("an ambiguous submission is persisted before I/O and never retried", async () => {
  const r = await prepareRecovery({ snapshotId: "snap1", version: "7.20.1" }, ctx);
  mock.failWrite = true;
  expect((await startRecovery(r.id, true, ctx)).state).toBe("uncertain");
  await expect(startRecovery(r.id, true, ctx)).rejects.toThrow();
  expect(mock.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  expect((await pollRecovery(r.id, ctx)).state).toBe("passed");
});
test("changed snapshot and revoked access fail before any upload", async () => {
  const r = await prepareRecovery({ snapshotId: "snap1", version: "7.20.1" }, ctx);
  mock.body += "\nadd name=other";
  await expect(startRecovery(r.id, true, ctx)).rejects.toThrow(/changed/);
  expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  mock.deny = true;
  await expect(pollRecovery(r.id, ctx)).rejects.toThrow(/denied/);
});
test("wrong runner evidence cannot produce a pass", async () => {
  const r = await prepareRecovery({ snapshotId: "snap1", version: "7.20.1" }, ctx);
  mock.wrong = true;
  expect((await startRecovery(r.id, true, ctx)).state).toBe("uncertain");
  expect((await pollRecovery(r.id, ctx)).error).toMatch(/mismatched/);
});
