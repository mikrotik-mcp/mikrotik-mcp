/**
 * The schedulable-auditor set and the job definition schema.
 *
 * The load-bearing case is the first one: every adapter's tool must exist in the
 * catalog AND be annotated READ. The runner refuses non-READ tools at fire time,
 * but if someone re-annotates one of these auditors later, the failure would
 * otherwise only show up at 03:00 as a job that silently stopped running.
 */
import { describe, expect, test } from "vite-plus/test";
import { moduleCatalog } from "../../src/tools/index";
import { riskOf } from "../../src/observability/event";
import { auditAdapter, schedulableTools } from "../../src/schedule/audits";
import { JobSchema } from "../../src/schedule/model";

const byName = new Map(moduleCatalog.flatMap((m) => m.tools.map((t) => [t.name, t] as const)));

describe("schedulable auditors", () => {
  test("every adapter names a tool that exists in the catalog", () => {
    for (const adapter of schedulableTools()) {
      expect(byName.has(adapter.tool), `${adapter.tool} is not in the catalog`).toBe(true);
    }
  });

  test("every schedulable tool is annotated READ", () => {
    for (const adapter of schedulableTools()) {
      const tool = byName.get(adapter.tool);
      expect(riskOf(tool?.annotations), `${adapter.tool} must stay READ`).toBe("READ");
    }
  });

  test("adapters are addressable by tool name and unknown tools return nothing", () => {
    expect(auditAdapter("run_security_hardening_audit")).toBeDefined();
    expect(auditAdapter("apply_plan")).toBeUndefined();
  });

  test("each adapter carries a summary for the tool description", () => {
    for (const adapter of schedulableTools()) {
      expect(adapter.summary.length).toBeGreaterThan(10);
    }
  });
});

describe("JobSchema", () => {
  const base = { id: "nightly-security", cron: "0 3 * * *", tool: "firewall_audit" };

  test("fills the defaults an operator should not have to think about", () => {
    const job = JobSchema.parse(base);
    expect(job.devices).toBe("all");
    expect(job.notifyOn).toEqual(["new", "worsened"]);
    expect(job.enabled).toBe(true);
    expect(job.retainDays).toBe(90);
  });

  test("rejects an invalid cron at DEFINITION time, not at first fire", () => {
    // The whole point: a typo must fail loudly now, not become a job that
    // silently never runs and is noticed weeks later.
    expect(JobSchema.safeParse({ ...base, cron: "0 3 * *" }).success).toBe(false);
    expect(JobSchema.safeParse({ ...base, cron: "every night" }).success).toBe(false);
    expect(JobSchema.safeParse({ ...base, cron: "*/15 * * * *" }).success).toBe(true);
  });

  test("rejects an id that would not be safe as a key", () => {
    expect(JobSchema.safeParse({ ...base, id: "" }).success).toBe(false);
    expect(JobSchema.safeParse({ ...base, id: "nightly security" }).success).toBe(false);
    expect(JobSchema.safeParse({ ...base, id: "-leading" }).success).toBe(false);
  });

  test("an explicit device list must not be empty", () => {
    // `devices: []` would run against nothing and report a clean posture, which
    // is the most dangerous possible way for this feature to fail.
    expect(JobSchema.safeParse({ ...base, devices: [] }).success).toBe(false);
    expect(JobSchema.safeParse({ ...base, devices: ["edge"] }).success).toBe(true);
  });
});
