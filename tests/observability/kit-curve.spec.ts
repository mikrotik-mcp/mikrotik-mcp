import { expect, test } from "vite-plus/test";
import { smoothPath } from "../../ui/observability/kit/curve";

/** Every number in a path, as [x, y] pairs in the order they are written. */
const pairs = (d: string): [number, number][] =>
  [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

test("no points make no path, and one or two points make straight segments", () => {
  expect(smoothPath([])).toBe("");
  expect(smoothPath([[0, 5]])).toBe("M0.0,5.0");
  expect(
    smoothPath([
      [0, 5],
      [10, 9],
    ]),
  ).toBe("M0.0,5.0 L10.0,9.0");
});

test("the curve goes through every point, in order", () => {
  const points: [number, number][] = [
    [0, 40],
    [10, 10],
    [20, 30],
    [30, 5],
    [40, 25],
  ];
  const d = smoothPath(points);
  expect(d.startsWith("M0.0,40.0 C")).toBe(true);
  // Each segment is two control points and then the data point.
  const ends = pairs(d).filter((_, i) => i === 0 || i % 3 === 0);
  expect(ends).toEqual(points);
});

test("the curve never leaves the range of the two points it joins", () => {
  // Sharp peaks and a flat floor: a plain spline would dip under the floor.
  const points: [number, number][] = [
    [0, 100],
    [10, 100],
    [20, 0],
    [30, 100],
    [40, 100],
    [50, 60],
  ];
  const all = pairs(smoothPath(points));
  for (let i = 0; i < points.length - 1; i++) {
    const low = Math.min(points[i]![1], points[i + 1]![1]);
    const high = Math.max(points[i]![1], points[i + 1]![1]);
    for (const [, y] of all.slice(1 + i * 3, 3 + i * 3)) {
      expect(y).toBeGreaterThanOrEqual(low);
      expect(y).toBeLessThanOrEqual(high);
    }
  }
});

test("a peak is flat at its top, so the drawing does not overshoot the data", () => {
  const all = pairs(
    smoothPath([
      [0, 50],
      [10, 10],
      [20, 50],
    ]),
  );
  // The control points on both sides of the middle point sit at its height.
  expect(all[2]![1]).toBe(10);
  expect(all[4]![1]).toBe(10);
});
