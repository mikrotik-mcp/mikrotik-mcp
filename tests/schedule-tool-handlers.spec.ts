import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { scheduleTools } from "../src/tools/schedule";
import type { ScheduleJob, ScheduleRun } from "../src/schedule/store";

const state = vi.hoisted(() => ({
  jobs: new Map<string, ScheduleJob>(),
  runs: [] as ScheduleRun[],
  risk: "READ",
}));
vi.mock("../src/schedule/store", () => ({
  scheduleStore: async () => ({
    listJobs: () => [...state.jobs.values()],
    getJob: (id: string) => state.jobs.get(id) ?? null,
    saveJob: (job: ScheduleJob) => state.jobs.set(job.id, job),
    removeJob: (id: string) => state.jobs.delete(id),
    runs: (id?: string) => state.runs.filter((run) => !id || run.jobId === id),
  }),
}));
vi.mock("../src/schedule/audits", () => ({
  schedulableTools: () => [{ tool: "safe_tool", summary: "Read-only fixture" }],
  auditAdapter: (name: string) => (name === "safe_tool" ? {} : null),
}));
vi.mock("../src/schedule/runner", () => ({
  armJob: () => Date.now() + 60000,
  forgetJob: vi.fn(),
  nextRunOf: () => null,
  runJob: vi.fn(),
}));
vi.mock("../src/schedule/session", () => ({
  primeRiskIndex: async () => {},
  liveExecutor: () => ({ riskOf: () => state.risk }),
  runnerOptions: () => ({}),
}));

const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
function tool(name: string) {
  const found = scheduleTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown schedule tool ${name}`);
  return found;
}
beforeEach(() => {
  state.jobs.clear();
  state.runs = [];
  state.risk = "READ";
});

test("empty listing explains available auditors and unknown job lookup", async () => {
  expect(await tool("list_schedules").handler({}, ctx)).toContain("safe_tool");
  expect(await tool("list_schedules").handler({ job_id: "missing" }, ctx)).toContain(
    "No scheduled audit called",
  );
});

test("definition refuses invalid cron, unsupported auditor, and write-risk tool", async () => {
  expect(
    await tool("add_schedule").handler({ id: "daily", cron: "broken", tool: "safe_tool" }, ctx),
  ).toContain("not a valid");
  expect(
    await tool("add_schedule").handler({ id: "daily", cron: "0 2 * * *", tool: "unknown" }, ctx),
  ).toContain("cannot be scheduled");
  state.risk = "WRITE";
  expect(
    await tool("add_schedule").handler({ id: "daily", cron: "0 2 * * *", tool: "safe_tool" }, ctx),
  ).toContain("Only READ tools");
  expect(state.jobs.size).toBe(0);
});

test("adding/replacing a valid schedule preserves persisted job and listing posture", async () => {
  const args = {
    id: "daily",
    cron: "0 2 * * *",
    tool: "safe_tool",
    devices: ["lab"],
    notify_on: ["new"],
  };
  expect(await tool("add_schedule").handler(args, ctx)).toContain("Scheduled 'daily'");
  expect(state.jobs.get("daily")).toMatchObject({
    tool: "safe_tool",
    devices: ["lab"],
    notifyOn: ["new"],
  });
  state.runs = [
    {
      id: 1,
      jobId: "daily",
      device: "lab",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      outcome: "ok",
      findings: [{ id: "issue", title: "Issue", severity: "high" }],
      added: 1,
      worsened: 0,
      resolved: 0,
    },
  ];
  expect(await tool("list_schedules").handler({}, ctx)).toContain("1 high");
  expect(await tool("add_schedule").handler(args, ctx)).toContain("Replaced 'daily'");
  expect(await tool("remove_schedule").handler({ id: "daily" }, ctx)).toContain(
    "1 run(s) of history",
  );
  expect(state.jobs.size).toBe(0);
});

test("timeline compares consecutive successful runs without contacting a router", async () => {
  await tool("add_schedule").handler({ id: "daily", cron: "0 2 * * *", tool: "safe_tool" }, ctx);
  expect(await tool("get_audit_timeline").handler({ job_id: "daily", limit: 20 }, ctx)).toContain(
    "has not run yet",
  );
  const now = Date.now();
  state.runs = [
    {
      id: 2,
      jobId: "daily",
      device: "lab",
      startedAt: now - 1000,
      finishedAt: now - 500,
      outcome: "ok",
      findings: [{ id: "issue", title: "Issue", severity: "high" }],
      added: 1,
      worsened: 0,
      resolved: 0,
    },
    {
      id: 1,
      jobId: "daily",
      device: "lab",
      startedAt: now - 86400000,
      finishedAt: now - 86399500,
      outcome: "ok",
      findings: [],
      added: 0,
      worsened: 0,
      resolved: 0,
    },
  ];
  const timeline = await tool("get_audit_timeline").handler(
    { job_id: "daily", device: "lab", limit: 20 },
    ctx,
  );
  expect(timeline).toContain("Latest change on lab");
  expect(timeline).toContain("new: [high] Issue");
  expect(await tool("run_schedule_now").handler({ id: "unknown" }, ctx)).toContain(
    "No scheduled audit called",
  );
});
