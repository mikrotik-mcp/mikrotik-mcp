/**
 * The runner's execution discipline, against a fake executor.
 *
 * Every case here is a rule from `docs/tasks/09` §5 that exists because the
 * naive version has a specific failure: a non-READ tool running unattended, a
 * slow job queueing behind itself, a sleeping host waking up to six identical
 * audits, or fifty devices opening SSH sessions in the same millisecond.
 */
import { describe, expect, test, beforeEach } from "vite-plus/test";
import { armJob, nextRunOf, resetScheduler, runJob, tick } from "../../src/schedule/runner";
import type { AuditExecutor } from "../../src/schedule/runner";
import type { ScheduleJob } from "../../src/schedule/store";
import type { AuditFinding } from "../../src/schedule/model";

function job(over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "nightly-security",
    cron: "0 3 * * *",
    tool: "run_security_hardening_audit",
    devices: ["a", "b"],
    notifyOn: ["new", "worsened"],
    enabled: true,
    retainDays: 90,
    createdAt: 0,
    ...over,
  };
}

interface FakeOptions {
  risk?: ReturnType<AuditExecutor["riskOf"]>;
  findings?: Record<string, AuditFinding[]>;
  fails?: Record<string, string>;
  /** Devices whose audit never settles, to exercise the timeout. */
  hangs?: string[];
  onAudit?: (device: string) => void;
}

function fake(opts: FakeOptions = {}): { executor: AuditExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: AuditExecutor = {
    riskOf: () => opts.risk ?? "READ",
    resolveDevices: (spec) => (spec === "all" ? ["a", "b", "c"] : spec),
    audit: (tool, device) => {
      calls.push(`${tool}@${device}`);
      opts.onAudit?.(device);
      if (opts.hangs?.includes(device)) return new Promise<AuditFinding[]>(() => {});
      const error = opts.fails?.[device];
      if (error) return Promise.reject(new Error(error));
      return Promise.resolve(opts.findings?.[device] ?? []);
    },
  };
  return { executor, calls };
}

/** No jitter and an instant sleep — the tests are about ordering, not waiting. */
const FAST = { jitterMs: 0, sleep: () => Promise.resolve() };

beforeEach(() => {
  resetScheduler();
});

describe("READ-only enforcement", () => {
  test("a WRITE tool is refused, and nothing runs", async () => {
    const { executor, calls } = fake({ risk: "WRITE" });
    const result = await runJob(job({ tool: "apply_plan" }), executor, FAST);

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("only READ tools may be scheduled");
    expect(calls).toEqual([]);
  });

  test("DESTRUCTIVE and DANGEROUS are refused too", async () => {
    for (const risk of ["DESTRUCTIVE", "DANGEROUS", "WRITE_IDEMPOTENT"] as const) {
      const { executor } = fake({ risk });
      const result = await runJob(job(), executor, FAST);
      expect(result.outcome).toBe("failed");
    }
  });

  test("a tool that is not in the catalog is refused, not assumed safe", async () => {
    const { executor } = fake({ risk: "UNKNOWN" });
    const result = await runJob(job({ tool: "typo_audit" }), executor, FAST);
    expect(result.error).toContain("not in the catalog");
  });

  test("a READ tool runs", async () => {
    const { executor, calls } = fake();
    const result = await runJob(job(), executor, FAST);
    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});

describe("devices", () => {
  test("`all` is resolved through the executor", async () => {
    const { executor, calls } = fake();
    await runJob(job({ devices: "all" }), executor, FAST);
    expect(calls.map((c) => c.split("@")[1])).toEqual(["a", "b", "c"]);
  });

  test("one unreachable device does not invalidate the others", async () => {
    const { executor } = fake({ fails: { a: "no route to host" } });
    const result = await runJob(job(), executor, FAST);

    expect(result.perDevice.find((d) => d.device === "a")).toMatchObject({
      outcome: "failed",
      error: "no route to host",
    });
    expect(result.perDevice.find((d) => d.device === "b")?.outcome).toBe("ok");
    // Partial failure is still an overall ok — 49 of 50 devices were audited.
    expect(result.outcome).toBe("ok");
  });

  test("every device failing is an overall failure", async () => {
    const { executor } = fake({ fails: { a: "down", b: "down" } });
    expect((await runJob(job(), executor, FAST)).outcome).toBe("failed");
  });

  test("concurrency is bounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const { executor } = fake({
      onAudit: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Released synchronously after the audit resolves; the pool shape is
        // what is under test, not the timing.
        queueMicrotask(() => inFlight--);
      },
    });
    await runJob(job({ devices: ["a", "b", "c", "d", "e", "f"] }), executor, {
      ...FAST,
      concurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("timeout", () => {
  test("a device whose audit never settles is marked timed out", async () => {
    const { executor } = fake({ hangs: ["a"] });
    const result = await runJob(job({ devices: ["a"] }), executor, { ...FAST, timeoutMs: 5 });

    expect(result.perDevice[0]).toMatchObject({ device: "a", outcome: "timeout" });
    expect(result.perDevice[0].error).toContain("timed out");
  });

  test("a timeout on one device still lets the others finish", async () => {
    const { executor } = fake({ hangs: ["a"] });
    const result = await runJob(job({ devices: ["a", "b"] }), executor, {
      ...FAST,
      timeoutMs: 5,
      concurrency: 2,
    });
    expect(result.perDevice.find((d) => d.device === "b")?.outcome).toBe("ok");
  });
});

describe("skip if still running", () => {
  test("an overlapping occurrence is skipped, never queued behind itself", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const executor: AuditExecutor = {
      riskOf: () => "READ",
      resolveDevices: (s) => (s === "all" ? ["a"] : s),
      audit: async () => {
        await gate;
        return [];
      },
    };

    const first = runJob(job({ devices: ["a"] }), executor, FAST);
    // While the first is in flight, a second occurrence arrives.
    const second = await runJob(job({ devices: ["a"] }), executor, FAST);
    expect(second.outcome).toBe("skipped");
    expect(second.perDevice).toEqual([]);

    release?.();
    expect((await first).outcome).toBe("ok");

    // Once it has finished, the next occurrence runs normally.
    const third = await runJob(job({ devices: ["a"] }), executor, FAST);
    expect(third.outcome).toBe("ok");
  });
});

describe("tick and the no-backfill rule", () => {
  const CLOCK = new Date(2026, 6, 30, 2, 0, 0).getTime(); // 02:00 local

  test("first sight of a job ARMS it rather than running it", async () => {
    // A server restart must not fire every nightly audit at once.
    const { executor, calls } = fake();
    const results = await tick([job()], executor, { ...FAST, now: () => CLOCK });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
    expect(nextRunOf("nightly-security")).toBeGreaterThan(CLOCK);
  });

  test("a job runs once its time arrives", async () => {
    const { executor, calls } = fake();
    const j = job();
    armJob(j, CLOCK);
    const after = new Date(2026, 6, 30, 3, 0, 30).getTime();
    const results = await tick([j], executor, { ...FAST, now: () => after });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("a host asleep through six occurrences runs ONCE at wake", async () => {
    const { executor } = fake();
    const j = job({ cron: "0 * * * *", devices: ["a"] }); // hourly
    armJob(j, CLOCK);

    // Wake six hours later.
    const wake = new Date(2026, 6, 30, 9, 30).getTime();
    const results = await tick([j], executor, { ...FAST, now: () => wake });

    expect(results).toHaveLength(1);
    // …and the next fire is computed from NOW, not from the backlog.
    expect(nextRunOf(j.id)).toBeGreaterThan(wake);
  });

  test("a disabled job never runs", async () => {
    const { executor, calls } = fake();
    const j = job({ enabled: false });
    armJob(j, CLOCK);
    await tick([j], executor, { ...FAST, now: () => new Date(2026, 6, 30, 3, 1).getTime() });
    expect(calls).toEqual([]);
  });

  test("a job whose cron can never fire is dropped from the schedule", () => {
    expect(armJob(job({ cron: "0 0 30 2 *" }), CLOCK)).toBeNull();
    expect(nextRunOf("nightly-security")).toBeUndefined();
  });
});
