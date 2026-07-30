/**
 * The cron parser and the finding diff.
 *
 * The reordering case is the one that matters: if a config reshuffle reads as a
 * fresh set of findings, every nightly run pages someone with forty "new"
 * problems and the feature is muted by week two. Several cases exist purely to
 * pin that identity is content-derived, not positional.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  describeCron,
  describeDiff,
  diffFindings,
  isValidCron,
  nextRun,
  parseCron,
  severityCounts,
  shouldNotify,
  worstSeverity,
} from "../../src/schedule/model";
import type { AuditFinding } from "../../src/schedule/model";

/** Local-time helper — the scheduler works in local time on purpose. */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function iso(ms: number | null): string {
  if (ms === null) return "never";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("cron parsing", () => {
  test("parses a simple daily schedule", () => {
    const cron = parseCron("0 3 * * *");
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([3]);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.domRestricted).toBe(false);
  });

  test("parses a step field", () => {
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
  });

  test("parses ranges and lists", () => {
    expect(parseCron("0 9-17 * * *").hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parseCron("0 3 * * 1,3,5").daysOfWeek).toEqual([1, 3, 5]);
    expect(parseCron("0 0,12 * * *").hours).toEqual([0, 12]);
  });

  test("parses a stepped range", () => {
    expect(parseCron("0 8-18/2 * * *").hours).toEqual([8, 10, 12, 14, 16, 18]);
  });

  test("rejects the wrong number of fields", () => {
    expect(() => parseCron("0 3 * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCron("0 3 * * * *")).toThrow(/exactly 5 fields/);
  });

  test("rejects out-of-range values", () => {
    expect(() => parseCron("60 3 * * *")).toThrow(/minute/);
    expect(() => parseCron("0 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("0 3 0 * *")).toThrow(/day-of-month/);
    expect(() => parseCron("0 3 * 13 *")).toThrow(/month/);
    expect(() => parseCron("0 3 * * 7")).toThrow(/day-of-week/);
  });

  test("rejects nonsense rather than guessing", () => {
    expect(isValidCron("@daily")).toBe(false);
    expect(isValidCron("0 3 * * MON")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("0 5-3 * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  test("accepts the schedules the blueprint uses", () => {
    expect(isValidCron("0 3 * * *")).toBe(true);
    expect(isValidCron("0 8 * * 1")).toBe(true);
  });
});

describe("nextRun", () => {
  test("finds the next daily occurrence", () => {
    expect(iso(nextRun("0 3 * * *", at(2026, 7, 30, 1, 0)))).toBe("2026-07-30 03:00");
  });

  test("rolls to tomorrow when today's time has passed", () => {
    expect(iso(nextRun("0 3 * * *", at(2026, 7, 30, 4, 0)))).toBe("2026-07-31 03:00");
  });

  test("is strictly after `from` — never returns the same minute", () => {
    const exact = at(2026, 7, 30, 3, 0);
    expect(nextRun("0 3 * * *", exact)).toBeGreaterThan(exact);
  });

  test("handles a step schedule", () => {
    expect(iso(nextRun("*/15 * * * *", at(2026, 7, 30, 10, 7)))).toBe("2026-07-30 10:15");
    expect(iso(nextRun("*/15 * * * *", at(2026, 7, 30, 10, 46)))).toBe("2026-07-30 11:00");
  });

  test("finds the next matching weekday", () => {
    // 2026-07-30 is a Thursday; the next Monday is 2026-08-03.
    expect(iso(nextRun("0 8 * * 1", at(2026, 7, 30, 9, 0)))).toBe("2026-08-03 08:00");
  });

  test("day-of-month and day-of-week are ORed, as POSIX cron does", () => {
    // "the 1st, and every Monday" — not "Mondays that fall on the 1st".
    const from = at(2026, 7, 30, 12, 0); // Thursday
    expect(iso(nextRun("0 0 1 * 1", from))).toBe("2026-08-01 00:00"); // the 1st (a Saturday)
  });

  test("crosses a month boundary", () => {
    expect(iso(nextRun("0 3 1 * *", at(2026, 7, 30, 12, 0)))).toBe("2026-08-01 03:00");
  });

  test("crosses a year boundary", () => {
    expect(iso(nextRun("0 0 1 1 *", at(2026, 7, 30, 12, 0)))).toBe("2027-01-01 00:00");
  });

  test("returns null for a schedule that can never fire", () => {
    // 30 February.
    expect(nextRun("0 0 30 2 *", at(2026, 1, 1))).toBeNull();
  });

  test("works across a DST boundary without skipping a day", () => {
    // Whatever the local DST rules are, a nightly job must produce a run on each
    // of the following days — never zero, never two for one date.
    let cursor = at(2026, 3, 1, 12, 0);
    const days = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const next = nextRun("0 3 * * *", cursor);
      expect(next).not.toBeNull();
      cursor = next ?? cursor;
      days.add(iso(cursor).slice(0, 10));
    }
    expect(days.size).toBe(60);
  });

  test("an hourly schedule advances by an hour", () => {
    expect(iso(nextRun("30 * * * *", at(2026, 7, 30, 10, 45)))).toBe("2026-07-30 11:30");
  });
});

describe("describeCron", () => {
  test("renders the common schedules in plain English", () => {
    expect(describeCron("0 3 * * *")).toContain("03:00");
    expect(describeCron("0 3 * * *")).toContain("every day");
    expect(describeCron("0 8 * * 1")).toContain("Monday");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("30 * * * *")).toContain("hourly");
  });

  test("names months and multiple weekdays", () => {
    expect(describeCron("0 3 * * 1,5")).toContain("Monday and Friday");
    expect(describeCron("0 3 1 1 *")).toContain("January");
  });

  test("an invalid expression says so instead of throwing", () => {
    expect(describeCron("@daily")).toContain("invalid schedule");
  });
});

// ── The diff ────────────────────────────────────────────────────────────────

function finding(id: string, severity = "high", over: Partial<AuditFinding> = {}): AuditFinding {
  return { id, severity, title: `finding ${id}`, ...over };
}

describe("finding diff", () => {
  test("a reordered but identical set is ALL unchanged", () => {
    // The case the whole feature rests on. Identity is the content-derived id,
    // so shuffling the config cannot manufacture a page-full of "new" problems.
    const before = [finding("a"), finding("b"), finding("c")];
    const after = [finding("c"), finding("a"), finding("b")];
    const diff = diffFindings(before, after);

    expect(diff.unchanged).toHaveLength(3);
    expect(diff.added).toEqual([]);
    expect(diff.resolved).toEqual([]);
    expect(diff.worsened).toEqual([]);
  });

  test("a finding that appeared is new", () => {
    const diff = diffFindings([finding("a")], [finding("a"), finding("b")]);
    expect(diff.added.map((f) => f.id)).toEqual(["b"]);
    expect(diff.unchanged.map((f) => f.id)).toEqual(["a"]);
  });

  test("a finding that vanished is resolved", () => {
    const diff = diffFindings([finding("a"), finding("b")], [finding("a")]);
    expect(diff.resolved.map((f) => f.id)).toEqual(["b"]);
  });

  test("a severity increase is worsened, with both severities", () => {
    const diff = diffFindings([finding("a", "medium")], [finding("a", "critical")]);
    expect(diff.worsened).toHaveLength(1);
    expect(diff.worsened[0]).toMatchObject({ from: "medium", to: "critical" });
    expect(diff.unchanged).toEqual([]);
  });

  test("a severity decrease is improved, not unchanged and not worsened", () => {
    const diff = diffFindings([finding("a", "critical")], [finding("a", "low")]);
    expect(diff.improved).toHaveLength(1);
    expect(diff.worsened).toEqual([]);
  });

  test("a finding whose TEXT changed but whose id did not is the same finding", () => {
    const diff = diffFindings(
      [finding("a", "high", { title: "old wording" })],
      [finding("a", "high", { title: "new wording" })],
    );
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.added).toEqual([]);
  });

  test("an empty previous run makes everything new — a first run is all news", () => {
    const diff = diffFindings([], [finding("a"), finding("b")]);
    expect(diff.added).toHaveLength(2);
  });

  test("an empty next run resolves everything", () => {
    const diff = diffFindings([finding("a"), finding("b")], []);
    expect(diff.resolved).toHaveLength(2);
  });

  test("two empty runs produce nothing at all", () => {
    const diff = diffFindings([], []);
    expect(describeDiff(diff)).toContain("no change");
  });

  test("an unknown severity is treated as the LEAST severe, never as critical", () => {
    // An auditor emitting a severity this model does not know must not be able
    // to fake a regression to critical. It sorts last, so a move from it to
    // `low` reads as a (mild) worsening, and a move from `critical` to it reads
    // as an improvement — both of which are the conservative direction.
    expect(diffFindings([finding("a", "weird")], [finding("a", "low")]).worsened).toHaveLength(1);
    expect(diffFindings([finding("a", "critical")], [finding("a", "weird")]).improved).toHaveLength(
      1,
    );
  });
});

describe("notification policy", () => {
  const diff = diffFindings(
    [finding("a", "low"), finding("gone")],
    [finding("a", "critical"), finding("new-one")],
  );

  test("fires for the categories a job asked for", () => {
    expect(shouldNotify(diff, ["new"])).toBe(true);
    expect(shouldNotify(diff, ["worsened"])).toBe(true);
    expect(shouldNotify(diff, ["resolved"])).toBe(true);
  });

  test("unchanged findings are NEVER notifiable", () => {
    // A finding that has been open for a month is not news; reporting it is how
    // an alerting system gets muted.
    const steady = diffFindings([finding("a")], [finding("a")]);
    expect(shouldNotify(steady, ["new", "worsened", "resolved", "improved"])).toBe(false);
    expect(steady.unchanged).toHaveLength(1);
  });

  test("a job that only wants regressions ignores a resolution", () => {
    const onlyResolved = diffFindings([finding("a")], []);
    expect(shouldNotify(onlyResolved, ["new", "worsened"])).toBe(false);
    expect(shouldNotify(onlyResolved, ["resolved"])).toBe(true);
  });

  test("describeDiff summarises what changed", () => {
    expect(describeDiff(diff)).toContain("1 new");
    expect(describeDiff(diff)).toContain("1 worsened");
    expect(describeDiff(diff)).toContain("1 resolved");
  });
});

describe("posture helpers", () => {
  test("worstSeverity picks the worst present", () => {
    expect(worstSeverity([finding("a", "low"), finding("b", "critical")])).toBe("critical");
    expect(worstSeverity([])).toBeUndefined();
  });

  test("severityCounts is the timeline's y-axis", () => {
    const counts = severityCounts([
      finding("a", "high"),
      finding("b", "high"),
      finding("c", "low"),
    ]);
    expect(counts).toEqual({ high: 2, low: 1 });
  });
});
