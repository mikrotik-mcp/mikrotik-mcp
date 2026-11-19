/**
 * An SVG path that runs through every point as a smooth curve.
 *
 * The curve is monotone: between two points it never goes above the higher one
 * or below the lower one. So a line of traffic never dips under zero, and a
 * peak in the drawing is a peak in the data. Points must be in order of x.
 */
export function smoothPath(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  if (n === 0) return "";
  const at = (i: number): string => `${points[i]![0].toFixed(1)},${points[i]![1].toFixed(1)}`;
  if (n < 3) return points.map((_, i) => `${i ? "L" : "M"}${at(i)}`).join(" ");

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1]![0] - points[i]![0]);
    slope.push(dx[i] ? (points[i + 1]![1] - points[i]![1]) / dx[i]! : 0);
  }
  // The slope of the curve at each point (Fritsch and Carlson): flat at a peak
  // or a dip, otherwise a mean of the two sides that keeps the curve monotone.
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const before = slope[i - 1]!;
    const after = slope[i]!;
    if (before * after <= 0) return 0;
    const a = dx[i - 1]!;
    const b = dx[i]!;
    return (3 * (a + b)) / ((2 * b + a) / before + (b + 2 * a) / after);
  });

  let d = `M${at(0)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = dx[i]! / 3;
    d +=
      ` C${(x0 + third).toFixed(1)},${(y0 + tangent[i]! * third).toFixed(1)}` +
      ` ${(x1 - third).toFixed(1)},${(y1 - tangent[i + 1]! * third).toFixed(1)} ${at(i + 1)}`;
  }
  return d;
}

/** The next round number at or above `value`: 1, 2 or 5 times a power of ten. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * unit).find((m) => m >= value)!;
}
