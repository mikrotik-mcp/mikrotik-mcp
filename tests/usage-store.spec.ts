/**
 * Offline tests for the pure usage-history helpers. These need no database:
 * `dailyUsageFromSamples` and `dayOf` are pure, and the module only loads
 * `bun:sqlite` lazily inside `openUsageStore`, so importing it here is safe.
 */
import { describe, expect, test } from "vite-plus/test";
import { dailyUsageFromSamples, dayOf } from "../src/observability/usage-store";

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z

describe("dayOf", () => {
  test("formats an epoch-ms instant as a UTC YYYY-MM-DD", () => {
    expect(dayOf(D1)).toBe("2026-01-01");
    expect(dayOf(D1 + 12 * 3_600_000)).toBe("2026-01-01");
    expect(dayOf(D1 + DAY)).toBe("2026-01-02");
  });
});

describe("dailyUsageFromSamples", () => {
  test("a source switch creates a baseline instead of a fake usage spike", () => {
    expect(
      dailyUsageFromSamples([
        { ts: D1, rx: 100, tx: 10 },
        { ts: D1 + 1000, rx: 9_000_000, tx: 2000, source: "kid-control" },
        { ts: D1 + 2000, rx: 9_000_100, tx: 2020, source: "kid-control" },
        { ts: D1 + 3000, rx: 999, tx: 500, source: "queue" },
      ]),
    ).toEqual([{ day: "2026-01-01", rx: 100, tx: 20 }]);
  });

  test("attributes the delta between snapshots to the later sample's day", () => {
    const out = dailyUsageFromSamples([
      { ts: D1, rx: 100, tx: 10 },
      { ts: D1 + DAY, rx: 300, tx: 50 }, // +200 / +40 on day 2
      { ts: D1 + 2 * DAY, rx: 350, tx: 60 }, // +50 / +10 on day 3
    ]);
    expect(out).toEqual([
      { day: "2026-01-02", rx: 200, tx: 40 },
      { day: "2026-01-03", rx: 50, tx: 10 },
    ]);
  });

  test("treats a counter reset (lower value) as the new value being the delta", () => {
    const out = dailyUsageFromSamples([
      { ts: D1, rx: 1000, tx: 500 },
      { ts: D1 + DAY, rx: 30, tx: 5 }, // queue recreated → counter reset
    ]);
    expect(out).toEqual([{ day: "2026-01-02", rx: 30, tx: 5 }]);
  });

  test("sums multiple intervals that fall on the same day", () => {
    const out = dailyUsageFromSamples([
      { ts: D1, rx: 0, tx: 0 },
      { ts: D1 + 3_600_000, rx: 100, tx: 10 }, // +100 / +10 (still day 1)
      { ts: D1 + 7_200_000, rx: 250, tx: 30 }, // +150 / +20 (still day 1)
    ]);
    expect(out).toEqual([{ day: "2026-01-01", rx: 250, tx: 30 }]);
  });

  test("returns nothing for fewer than two samples", () => {
    expect(dailyUsageFromSamples([])).toEqual([]);
    expect(dailyUsageFromSamples([{ ts: D1, rx: 5, tx: 5 }])).toEqual([]);
  });
});
