import { describe, expect, it } from "vite-plus/test";
import { activityModel, sameActivitySeries } from "../../ui/observability/activity-model";

describe("activity chart data", () => {
  const series = [
    { t: 1000, ok: 14, error: 0 },
    { t: 2000, ok: 9, error: 2 },
  ];

  it("does not treat equivalent polling responses as animation updates", () => {
    expect(sameActivitySeries(series, series)).toBe(true);
    expect(
      sameActivitySeries(
        series,
        series.map((row) => ({ ...row })),
      ),
    ).toBe(true);
    expect(sameActivitySeries([], [])).toBe(true);
  });

  it("detects changed values, timestamps, ordering and interval counts", () => {
    for (const change of [{ ok: 20 }, { error: 3 }, { t: 3000 }]) {
      expect(sameActivitySeries(series, [{ ...series[0], ...change }, series[1]])).toBe(false);
    }
    expect(sameActivitySeries(series, [...series].reverse())).toBe(false);
    expect(sameActivitySeries(series, series.slice(1))).toBe(false);
  });

  it("keeps series independent and sorts without changing source data", () => {
    const reversed = [...series].reverse();
    expect(activityModel(reversed)).toEqual({ rows: series, ok: 23, error: 2, omitted: 0 });
    expect(reversed[0].t).toBe(2000);
  });

  it("distinguishes no data from zero activity and errors-only intervals", () => {
    expect(activityModel([])).toEqual({ rows: [], ok: 0, error: 0, omitted: 0 });
    expect(activityModel([{ t: 1000, ok: 0, error: 0 }]).rows).toHaveLength(1);
    expect(activityModel([{ t: 1000, ok: 0, error: 4 }]).error).toBe(4);
  });

  it("discloses invalid counts or timestamps without converting them to zeros", () => {
    const bad = [
      { t: Number.NaN },
      { t: Infinity },
      { t: 9e15 },
      { ok: -1 },
      { ok: 0.5 },
      { error: Number.NaN },
      { error: Infinity },
    ];
    const model = activityModel([...series, ...bad.map((value) => ({ ...series[0], ...value }))]);
    expect(model).toEqual({ rows: series, ok: 23, error: 2, omitted: bad.length });
  });
});
