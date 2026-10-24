import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { driftRoutes } from "../../src/observability/drift-routes";

const state = vi.hoisted(() => ({
  snapshots: new Map<string, Record<string, unknown>>(),
  baseline: null as null | { snapshotId: string; setAt: number },
}));
const command = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../../src/drift/alert", () => ({ noteDriftResult: vi.fn() }));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({
    get: (id: string) => state.snapshots.get(id) ?? null,
    getBaseline: () => state.baseline,
    latest: () => [...state.snapshots.values()].at(-1) ?? null,
    listBaselines: () => (state.baseline ? [{ device: "lab", ...state.baseline }] : []),
    setBaseline: (_device: string, snapshotId: string) => {
      state.baseline = { snapshotId, setAt: 1 };
    },
    removeBaseline: () => {
      const existed = !!state.baseline;
      state.baseline = null;
      return existed;
    },
    list: () => [...state.snapshots.values()],
  }),
}));

const original = getConfig();
const snapshot = {
  id: "snap-1",
  device: "lab",
  body: "/ip ssh\nset strong-crypto=yes",
  sha: "hash-a",
  ts: 1,
  lines: 2,
  bytes: 32,
  rosVersion: "7.20",
};
async function request(path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  const response = await driftRoutes(req, new URL(req.url));
  if (!response && path.startsWith("/api/drift"))
    throw new Error(`Unexpected unhandled drift route: ${path}`);
  return response;
}
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "lab",
    }),
  );
  state.baseline = null;
  state.snapshots.clear();
  command.mockReset().mockResolvedValue(snapshot.body);
});
afterEach(() => setConfig(original));

test("status and baseline listing distinguish missing, deleted and in-sync baselines", async () => {
  expect(
    ((await (await request("/api/drift/status"))!.json()) as { devices: { status: string }[] })
      .devices[0].status,
  ).toBe("no-baseline");
  state.baseline = { snapshotId: "missing", setAt: 1 };
  expect(
    ((await (await request("/api/drift/status"))!.json()) as { devices: { status: string }[] })
      .devices[0].status,
  ).toBe("unknown");
  state.snapshots.set("snap-1", snapshot);
  state.baseline = { snapshotId: "snap-1", setAt: 1 };
  expect(
    ((await (await request("/api/drift/status"))!.json()) as { devices: { status: string }[] })
      .devices[0].status,
  ).toBe("in-sync");
  expect(
    ((await (await request("/api/drift/baselines"))!.json()) as { baselines: unknown[] }).baselines,
  ).toHaveLength(1);
  expect(command).not.toHaveBeenCalled();
});

test("baseline mutation requires an existing snapshot and history remains queryable", async () => {
  expect((await request("/api/drift/baseline", { method: "POST", body: "{}" }))?.status).toBe(400);
  expect(
    (
      await request("/api/drift/baseline", {
        method: "POST",
        body: JSON.stringify({ device: "lab", snapshotId: "missing" }),
      })
    )?.status,
  ).toBe(404);
  state.snapshots.set("snap-1", snapshot);
  expect(
    (
      await request("/api/drift/baseline", {
        method: "POST",
        body: JSON.stringify({ device: "lab", snapshotId: "snap-1" }),
      })
    )?.status,
  ).toBe(200);
  expect((await request("/api/drift/baseline/lab"))?.status).toBe(200);
  expect(
    ((await (await request("/api/drift/history/lab"))!.json()) as { snapshots: unknown[] })
      .snapshots,
  ).toHaveLength(1);
  expect(
    (
      (await (await request("/api/drift/baseline/lab", { method: "DELETE" }))!.json()) as {
        ok: boolean;
      }
    ).ok,
  ).toBe(true);
  expect(command).not.toHaveBeenCalled();
});

test("live check validates target and baseline before the read-only export", async () => {
  expect((await request("/api/drift/check/unknown"))?.status).toBe(404);
  expect((await request("/api/drift/check/lab"))?.status).toBe(404);
  state.baseline = { snapshotId: "snap-1", setAt: 1 };
  expect((await request("/api/drift/check/lab"))?.status).toBe(404);
  expect(command).not.toHaveBeenCalled();
});

test("live check reports drift, while an empty export is a gateway error", async () => {
  state.snapshots.set("snap-1", snapshot);
  state.baseline = { snapshotId: "snap-1", setAt: 1 };
  command
    .mockResolvedValueOnce("/ip ssh\nset strong-crypto=no")
    .mockResolvedValueOnce("jul/04/2025 10:30:05 ssh changed by admin");
  const report = await request("/api/drift/check/lab");
  expect(((await report!.json()) as { identical: boolean; sections: unknown[] }).identical).toBe(
    false,
  );
  expect(command.mock.calls[0][0]).toBe("/export terse");
  command.mockResolvedValueOnce("");
  expect((await request("/api/drift/check/lab"))?.status).toBe(502);
});
