import { beforeEach, expect, test, vi } from "vite-plus/test";
import { rolloutRoutes } from "../../src/observability/rollout-routes";

const state = vi.hoisted(() => ({
  rows: [] as { id: string; ts: number; label: string }[],
  entry: undefined as
    | undefined
    | {
        state: { id: string; phase: string; currentWave: number; devices: object; gates: object };
        ts: number;
        commands: string[];
        label: string;
      },
  error: "",
}));
const saved = vi.hoisted(() => vi.fn());
const published = vi.hoisted(() => vi.fn());
vi.mock("../../src/rollout/session", () => ({
  rolloutStore: async () => {
    if (state.error) throw new Error(state.error);
    return {
      list: (limit: number) => state.rows.slice(0, limit),
      get: (id: string) => state.rows.find((row) => row.id === id),
      events: (id: string) => [{ rolloutId: id, kind: "started" }],
    };
  },
  listRollouts: () => (state.entry ? [state.entry] : []),
  getRollout: (id: string) => (state.entry?.state.id === id ? state.entry : undefined),
  persistRollout: saved,
  dropRollout: vi.fn(),
}));
vi.mock("../../src/rollout/store", () => ({
  toRecord: (value: { id: string }, ts: number, meta: { label: string }) => ({
    id: value.id,
    ts,
    label: meta.label,
  }),
}));
vi.mock("../../src/rollout/model", () => ({
  requestHold: (value: object) => ({ ...value, phase: "held" }),
  requestAbort: (value: object) => ({ ...value, phase: "aborted" }),
  resume: (value: object) => ({ ...value, phase: "running" }),
  summarize: (value: { phase: string }) => ({ phase: value.phase }),
}));
vi.mock("../../src/observability/rollout-hub", () => ({
  liveRolloutUpdates: () => 4,
  publishRollout: published,
}));
vi.mock("../../src/rollout/runner", () => ({ createDeviceExecutor: vi.fn(), runRollout: vi.fn() }));

async function request(path: string, method = "GET") {
  const url = new URL(`http://localhost${path}`);
  return rolloutRoutes(new Request(url, { method }), url);
}
beforeEach(() => {
  state.rows = [];
  state.entry = undefined;
  state.error = "";
  vi.clearAllMocks();
});

test("history is sorted and limited, with the active row overriding persisted history", async () => {
  state.rows = [
    { id: "active", ts: 1, label: "old" },
    { id: "other", ts: 3, label: "other" },
  ];
  state.entry = {
    state: { id: "active", phase: "running", currentWave: 0, devices: {}, gates: {} },
    ts: 5,
    commands: [],
    label: "live",
  };
  const response = await request("/api/rollout?limit=1");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    rollouts: [{ id: "active", label: "live" }],
    live: 4,
  });
});
test("history remains available when persistence fails", async () => {
  state.error = "disk unavailable";
  expect(await (await request("/api/rollout"))?.json()).toMatchObject({
    rollouts: [],
    error: "disk unavailable",
  });
});
test("detail reads stored events and distinguishes missing and invalid routes", async () => {
  state.rows = [{ id: "old", ts: 1, label: "old" }];
  expect(await (await request("/api/rollout/old"))?.json()).toMatchObject({
    rollout: { id: "old" },
    events: [{ kind: "started" }],
  });
  expect((await request("/api/rollout/missing"))?.status).toBe(404);
  expect((await request("/api/rollout/a/b/c"))?.status).toBe(404);
  expect((await request("/api/rollout/old", "POST"))?.status).toBe(405);
  expect(await request("/api/other")).toBeNull();
});
test("hold persists and publishes the state; unknown actions and inactive IDs are rejected", async () => {
  state.entry = {
    state: { id: "fleet", phase: "running", currentWave: 1, devices: {}, gates: {} },
    ts: 1,
    commands: [],
    label: "fleet",
  };
  expect((await request("/api/rollout/missing/hold", "POST"))?.status).toBe(404);
  expect((await request("/api/rollout/fleet/nope", "POST"))?.status).toBe(404);
  const response = await request("/api/rollout/fleet/hold", "POST");
  expect(await response?.json()).toEqual({ held: true, summary: { phase: "held" } });
  expect(saved).toHaveBeenCalledWith(state.entry);
  expect(published).toHaveBeenCalledWith(
    expect.objectContaining({ rolloutId: "fleet", action: "hold", phase: "held" }),
  );
});
