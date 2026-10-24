import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { armJob, tick } from "../src/schedule/runner";
import {
  listJobs,
  liveExecutor,
  resetRiskIndex,
  runnerOptions,
  startScheduler,
  stopScheduler,
} from "../src/schedule/session";

const mock = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  failStore: false,
  audits: [] as string[],
  errors: [] as string[],
  infos: [] as string[],
  enabled: true,
}));

vi.mock("../src/core/runtime", () => ({
  onConfigChanged: () => {},
  getConfig: () => ({
    schedules: {
      enabled: mock.enabled,
      jobs: mock.jobs,
      concurrency: 2,
      timeoutMs: 800,
      jitterMs: 9,
      tickSeconds: 30,
    },
  }),
  listDevices: () => ({ names: ["one", "two"] }),
}));
vi.mock("../src/tools/index", () => ({
  moduleCatalog: [{ tools: [{ name: "known", annotations: { readOnlyHint: true } }] }],
}));
vi.mock("../src/core/context", () => ({
  createContext: (_: unknown, device: string) => ({ device }),
}));
vi.mock("../src/schedule/audits", () => ({
  auditAdapter: (name: string) =>
    name === "known"
      ? {
          run: async (ctx: { device: string }) => {
            mock.audits.push(ctx.device);
            return [{ id: ctx.device }];
          },
        }
      : undefined,
}));
vi.mock("../src/schedule/store", () => ({
  scheduleStore: async () => {
    if (mock.failStore) throw new Error("disk offline");
    return {
      listJobs: () => mock.saved,
      saveJob: (job: Record<string, unknown>) => mock.saved.push(job),
    };
  },
}));
vi.mock("../src/schedule/runner", () => ({ armJob: vi.fn(), tick: vi.fn(async () => []) }));
vi.mock("../src/logger", () => ({
  logger: {
    error: (message: string) => mock.errors.push(message),
    info: (message: string) => mock.infos.push(message),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  mock.jobs = [];
  mock.saved = [];
  mock.audits = [];
  mock.errors = [];
  mock.infos = [];
  mock.failStore = false;
  mock.enabled = true;
  resetRiskIndex();
  vi.clearAllMocks();
});
afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("scheduler live wiring", () => {
  it("fails closed for unknown risk and rejects unsupported audit adapters", async () => {
    const executor = liveExecutor();
    expect(executor.riskOf("missing-tool")).toBe("UNKNOWN");
    expect(executor.resolveDevices("all")).toEqual(["one", "two"]);
    expect(executor.resolveDevices(["two"])).toEqual(["two"]);
    await expect(executor.audit("unknown", "one")).rejects.toThrow(/no audit adapter/);
    expect(await executor.audit("known", "two")).toEqual([{ id: "two" }]);
    expect(mock.audits).toEqual(["two"]);
    expect(runnerOptions()).toEqual({ concurrency: 2, timeoutMs: 800, jitterMs: 9 });
  });

  it("seeds valid absent jobs once and arms only enabled jobs", async () => {
    const existing = { id: "existing", enabled: false };
    mock.saved.push(existing);
    mock.jobs = [
      { id: "existing", cron: "* * * * *", tool: "known", enabled: true },
      { id: "new", cron: "* * * * *", tool: "known" },
      { id: "invalid", cron: "bad", tool: "known" },
    ];
    await startScheduler();
    expect(mock.saved).toHaveLength(2);
    expect(mock.saved[0]).toBe(existing);
    expect(mock.saved[1]).toMatchObject({ id: "new", enabled: true, retainDays: 90 });
    expect(armJob).toHaveBeenCalledTimes(1);
    expect(armJob).toHaveBeenCalledWith(mock.saved[1], expect.any(Number));
    expect(mock.errors.join(" ")).toContain("invalid definition");
    await startScheduler();
    expect(armJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("reports store failures and leaves the scheduler stopped when seeding fails", async () => {
    mock.failStore = true;
    expect(await listJobs()).toEqual([]);
    expect(mock.errors.join(" ")).toContain("disk offline");
    mock.jobs = [{ id: "new", cron: "* * * * *", tool: "known" }];
    await expect(startScheduler()).rejects.toThrow("disk offline");
    expect(vi.getTimerCount()).toBe(0);
  });
});
