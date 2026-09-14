import type { Bucket } from "./types";

/** Keep identical polling responses from restarting chart transitions. */
export function sameActivitySeries(a: readonly Bucket[], b: readonly Bucket[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((row, i) => row.t === b[i].t && row.ok === b[i].ok && row.error === b[i].error))
  );
}

export function activityModel(series: readonly Bucket[]) {
  const rows = series
    .filter(
      (row) =>
        Number.isFinite(row.t) &&
        Math.abs(row.t) <= 8.64e15 &&
        Number.isSafeInteger(row.ok) &&
        row.ok >= 0 &&
        Number.isSafeInteger(row.error) &&
        row.error >= 0,
    )
    .sort((a, b) => a.t - b.t);
  return {
    rows,
    omitted: series.length - rows.length,
    ok: rows.reduce((sum, row) => sum + row.ok, 0),
    error: rows.reduce((sum, row) => sum + row.error, 0),
  };
}
