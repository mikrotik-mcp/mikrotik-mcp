import { beforeEach, expect, test, vi } from "vite-plus/test";
import { scheduleRoutes } from "../../src/observability/schedule-routes";
import type { ScheduleJob, ScheduleRun } from "../../src/schedule/store";

const fixture = vi.hoisted(() => ({
  jobs: new Map<string, ScheduleJob>(),
  runs: [] as ScheduleRun[],
  risk: "READ",
  unavailable: false,
}));
vi.mock("../../src/schedule/store", () => ({
  scheduleStore: async () => {
    if (fixture.unavailable) throw new Error("store unavailable");
    return {
      listJobs: () => [...fixture.jobs.values()],
      getJob: (id: string) => fixture.jobs.get(id) ?? null,
      saveJob: (job: ScheduleJob) => fixture.jobs.set(job.id, job),
      removeJob: (id: string) => fixture.jobs.delete(id),
      runs: (id?: string) => fixture.runs.filter((run) => !id || run.jobId === id),
    };
  },
}));
vi.mock("../../src/schedule/audits", () => ({
  schedulableTools: () => [{ tool: "safe_tool", summary: "Fixture audit" }],
  auditAdapter: (name: string) => (name === "safe_tool" ? {} : null),
}));
vi.mock("../../src/schedule/runner", () => ({
  armJob: vi.fn(),
  forgetJob: vi.fn(),
  nextRunOf: () => null,
  runJob: vi.fn(),
}));
vi.mock("../../src/schedule/session", () => ({
  primeRiskIndex: async () => {},
  liveExecutor: () => ({ riskOf: () => fixture.risk }),
  runnerOptions: () => ({}),
}));

async function request(path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  const response = await scheduleRoutes(req, new URL(req.url));
  if (!response && path.startsWith("/api/schedules"))
    throw new Error(`Unexpected unhandled schedule route: ${path}`);
  return response;
}
function body(data: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}
const job = { id: "daily", cron: "0 2 * * *", tool: "safe_tool", devices: "all", enabled: true };

beforeEach(() => {
  fixture.jobs.clear();
  fixture.runs = [];
  fixture.risk = "READ";
  fixture.unavailable = false;
});

test("unrelated route is ignored and store outage is visible", async () => {
  expect(await request("/api/unrelated")).toBeNull();
  fixture.unavailable = true;
  const res = await request("/api/schedules");
  expect(res?.status).toBe(503);
  expect(await res!.json()).toMatchObject({ error: "store unavailable", jobs: [] });
});

test("create rejects malformed JSON, invalid cron, unknown and non-read auditors", async () => {
  expect((await request("/api/schedules", { method: "POST", body: "not-json" }))?.status).toBe(400);
  expect((await request("/api/schedules", body({ ...job, cron: "not cron" })))?.status).toBe(400);
  expect((await request("/api/schedules", body({ ...job, tool: "write_tool" })))?.status).toBe(400);
  fixture.risk = "WRITE";
  const res = await request("/api/schedules", body(job));
  expect(res?.status).toBe(400);
  expect(((await res!.json()) as { error: string }).error).toContain("only READ");
  expect(fixture.jobs.size).toBe(0);
});

test("create/list/detail/delete preserve job identity and remove its history", async () => {
  const created = await request("/api/schedules", body(job));
  expect(created?.status).toBe(200);
  expect(((await created!.json()) as { replaced: boolean }).replaced).toBe(false);
  const listed = await request("/api/schedules");
  expect(
    ((await listed!.json()) as { jobs: { id: string }[] }).jobs.map((item) => item.id),
  ).toEqual(["daily"]);
  expect((await request("/api/schedules/daily"))?.status).toBe(200);
  expect((await request("/api/schedules/missing"))?.status).toBe(404);
  const replaced = await request("/api/schedules", body({ ...job, enabled: false }));
  expect(((await replaced!.json()) as { replaced: boolean }).replaced).toBe(true);
  const removed = await request("/api/schedules/daily", { method: "DELETE" });
  expect(await removed!.json()).toMatchObject({ removed: "daily", runsDiscarded: 0 });
  expect(fixture.jobs.size).toBe(0);
});

test("timeline and regression feed distinguish per-device findings", async () => {
  await request("/api/schedules", body(job));
  const now = Date.now();
  fixture.runs = [
    {
      id: 2,
      jobId: "daily",
      device: "home",
      startedAt: now - 1000,
      finishedAt: now - 500,
      outcome: "ok",
      findings: [{ id: "ssh-open", severity: "high", title: "SSH open" }],
      added: 1,
      worsened: 0,
      resolved: 0,
    },
    {
      id: 1,
      jobId: "daily",
      device: "home",
      startedAt: now - 86400000,
      finishedAt: now - 86399500,
      outcome: "ok",
      findings: [],
      added: 0,
      worsened: 0,
      resolved: 0,
    },
  ];
  const timeline = await request("/api/schedules/timeline?job=daily&device=home&days=2");
  expect(
    ((await timeline!.json()) as { points: { total: number }[] }).points.map(
      (point) => point.total,
    ),
  ).toEqual([0, 1]);
  const regressions = await request("/api/schedules/regressions?job=daily");
  expect(
    ((await regressions!.json()) as { regressions: { added: unknown[] }[] }).regressions[0].added,
  ).toHaveLength(1);
  const detail = await request("/api/schedules/daily");
  expect(
    ((await detail!.json()) as { job: { posture: { worst: string } } }).job.posture.worst,
  ).toBe("high");
});
