import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import type { ScheduleJob, ScheduleRun } from "../src/schedule/store";
import { scheduleTools } from "../src/tools/schedule";

const state = vi.hoisted(() => ({
  jobs: new Map<string, ScheduleJob>(),
  runs: [] as ScheduleRun[],
}));
const runJobMock = vi.hoisted(() => vi.fn());
vi.mock("../src/schedule/store", () => ({
  scheduleStore: async () => ({
    listJobs: () => [...state.jobs.values()],
    getJob: (id: string) => state.jobs.get(id) ?? null,
    saveJob: (job: ScheduleJob) => state.jobs.set(job.id, job),
    removeJob: (id: string) => state.jobs.delete(id),
    runs: (id: string) => state.runs.filter((run) => run.jobId === id),
  }),
}));
vi.mock("../src/schedule/audits", () => ({
  schedulableTools: () => [{ tool: "safe_tool", summary: "Fixture" }],
  auditAdapter: () => ({}),
}));
vi.mock("../src/schedule/runner", () => ({
  armJob: () => Date.now() + 60000,
  forgetJob: vi.fn(),
  nextRunOf: () => null,
  runJob: runJobMock,
}));
vi.mock("../src/schedule/session", () => ({
  primeRiskIndex: async () => {},
  liveExecutor: () => ({ riskOf: () => "READ" }),
  runnerOptions: () => ({}),
}));
const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown>) => {
  const tool = scheduleTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
};
const finding = (severity: "low" | "high", title: string) => ({ id: "issue", title, severity });
beforeEach(() => {
  state.jobs.clear();
  state.runs = [];
  runJobMock.mockReset();
  state.jobs.set("daily", {
    id: "daily",
    tool: "safe_tool",
    cron: "0 2 * * *",
    devices: ["lab"],
    enabled: true,
    notifyOn: ["new"],
    retainDays: 90,
    createdAt: Date.now(),
  });
});

test("manual run reports skip, error, failed device and changed findings", async () => {
  runJobMock.mockResolvedValueOnce({ outcome: "skipped" });
  expect(await run("run_schedule_now", { id: "daily" })).toContain("already running");
  runJobMock.mockResolvedValueOnce({ outcome: "failed", error: "probe failed" });
  expect(await run("run_schedule_now", { id: "daily" })).toContain("probe failed");
  runJobMock.mockResolvedValueOnce({
    outcome: "ok",
    notified: false,
    perDevice: [
      { device: "offline", outcome: "error", error: "timeout" },
      {
        device: "lab",
        outcome: "ok",
        diff: {
          added: [finding("high", "New")],
          worsened: [{ from: "low", to: "high", finding: finding("high", "Worse") }],
          resolved: [finding("low", "Fixed")],
          improved: [],
          unchanged: [],
        },
      },
    ],
  });
  const output = await run("run_schedule_now", { id: "daily" });
  expect(output).toContain("timeout");
  expect(output).toContain("new: [high] New");
  expect(output).toContain("worse: [low → high] Worse");
  expect(output).toContain("fixed: Fixed");
  expect(output).toContain("no alert was raised");
});

test("fleet timeline shows worsening and resolution between latest runs", async () => {
  const now = Date.now();
  state.runs = [
    {
      id: 3,
      jobId: "daily",
      device: "lab",
      startedAt: now,
      finishedAt: now,
      outcome: "ok",
      findings: [finding("high", "Worse"), { id: "new", title: "New", severity: "low" }],
      added: 1,
      worsened: 1,
      resolved: 1,
    },
    {
      id: 2,
      jobId: "daily",
      device: "lab",
      startedAt: now - 60000,
      finishedAt: now - 60000,
      outcome: "ok",
      findings: [finding("low", "Worse"), { id: "gone", title: "Fixed", severity: "low" }],
      added: 0,
      worsened: 0,
      resolved: 0,
    },
  ];
  const output = await run("get_audit_timeline", { job_id: "daily", limit: 20 });
  expect(output).toContain("Latest change on lab");
  expect(output).toContain("worse: [low → high] Worse");
  expect(output).toContain("fixed: Fixed");
});
