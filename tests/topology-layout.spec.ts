/**
 * The topology radar's layout is pure geometry with two things worth pinning:
 * it must be deterministic (a jittering map is unusable), and the angular
 * relaxation must actually separate neighbours that start on the same bearing
 * — including the pathological case where two are exactly coincident, which the
 * repulsion term divides by.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  arcDash,
  CX,
  CY,
  HUB_ID,
  INNER_Y,
  layout,
  OUTER_Y,
  sweepPath,
} from "../ui/observability/topology-layout";

const dev = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `dev${i}` }));
const nbr = (n: number, parent: string) => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `nb${i}` })),
  parents: new Map(Array.from({ length: n }, (_, i) => [`nb${i}`, parent])),
});

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("topology layout", () => {
  test("puts the hub at the centre", () => {
    const { pos } = layout(dev(3), [], new Map());
    expect(pos.get(HUB_ID)).toEqual({ x: CX, y: CY });
  });

  test("a lone device sits off the hub, not on it", () => {
    const { pos } = layout(dev(1), [], new Map());
    const d = pos.get("dev0")!;
    expect(dist(d, { x: CX, y: CY })).toBeGreaterThan(50);
  });

  test("devices are spread evenly around the ring", () => {
    const { pos, rInner } = layout(dev(4), [], new Map());
    const ry = rInner * INNER_Y;
    for (let i = 0; i < 4; i++) {
      const p = pos.get(`dev${i}`)!;
      // Every device lies on the inner ellipse.
      expect(((p.x - CX) / rInner) ** 2 + ((p.y - CY) / ry) ** 2).toBeCloseTo(1, 5);
    }
    // A 4-way split puts them at 12, 3, 6 and 9 o'clock: opposite pairs on opposite sides.
    expect(dist(pos.get("dev0")!, pos.get("dev2")!)).toBeCloseTo(ry * 2, 4);
    expect(dist(pos.get("dev1")!, pos.get("dev3")!)).toBeCloseTo(rInner * 2, 4);
  });

  test("neighbours lie on the outer ellipse", () => {
    const { nodes, parents } = nbr(5, "dev1");
    const { pos, rOuter } = layout(dev(3), nodes, parents);
    for (let i = 0; i < 5; i++) {
      const p = pos.get(`nb${i}`)!;
      const r = ((p.x - CX) / rOuter) ** 2 + ((p.y - CY) / (rOuter * OUTER_Y)) ** 2;
      expect(r).toBeCloseTo(1, 5);
    }
  });

  test("is deterministic — identical inputs give identical output", () => {
    const { nodes, parents } = nbr(9, "dev0");
    const a = layout(dev(2), nodes, parents);
    const b = layout(dev(2), nodes, parents);
    for (const [id, p] of a.pos) expect(b.pos.get(id)).toEqual(p);
  });

  /** Every neighbour of one device starts on the same bearing; relaxation fans them. */
  test("separates neighbours that share a parent", () => {
    const { nodes, parents } = nbr(8, "dev0");
    const { pos } = layout(dev(3), nodes, parents);
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        expect(dist(pos.get(`nb${i}`)!, pos.get(`nb${j}`)!)).toBeGreaterThan(8);
      }
    }
  });

  test("produces finite coordinates even when neighbours coincide exactly", () => {
    // Two neighbours, same parent, seeded at k=0 → identical starting angle for
    // the first pair; the tie-break must keep the repulsion term finite.
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const parents = new Map([
      ["a", "dev0"],
      ["b", "dev0"],
      ["c", "dev0"],
    ]);
    const { pos } = layout(dev(1), nodes, parents);
    for (const id of ["a", "b", "c"]) {
      const p = pos.get(id)!;
      expect(Number.isFinite(p.x), `${id}.x`).toBe(true);
      expect(Number.isFinite(p.y), `${id}.y`).toBe(true);
    }
  });

  test("orphan neighbours (no parent device) still get a position", () => {
    const { pos } = layout([], [{ id: "lonely" }], new Map());
    const p = pos.get("lonely")!;
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  describe("arcDash", () => {
    const len = (r: number): number => 2 * Math.PI * r;

    test("0% paints nothing, 100% paints the whole circle", () => {
      expect(arcDash(10, 0).startsWith("0 ")).toBe(true);
      const [on] = arcDash(10, 100).split(" ").map(Number);
      expect(on).toBeCloseTo(len(10), 5);
    });

    test("clamps out-of-range and undefined metrics", () => {
      expect(arcDash(10, -20)).toBe(arcDash(10, 0));
      expect(arcDash(10, 150)).toBe(arcDash(10, 100));
      expect(arcDash(10, undefined)).toBe(arcDash(10, 0));
    });

    test("half is half", () => {
      const [on] = arcDash(20, 50).split(" ").map(Number);
      expect(on).toBeCloseTo(len(20) / 2, 5);
    });
  });

  /**
   * The radar sweep regressed once already: its arc endpoints were placed at a
   * fixed vertical offset from the hub rather than on the circle, so `A r r`
   * could not reach them and SVG silently scaled the radii, drawing a bulge.
   */
  describe("sweepPath", () => {
    const PATH =
      /^M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) A [\d.-]+ [\d.-]+ 0 0 1 ([\d.-]+) ([\d.-]+) Z$/;

    /** Pull the apex and both arc endpoints out of the path data. */
    const points = (d: string): { apex: number[]; p1: number[]; p2: number[] } => {
      const m = d.match(PATH);
      if (!m) throw new Error(`unexpected path: ${d}`);
      const n = m.slice(1).map(Number);
      return { apex: [n[0]!, n[1]!], p1: [n[2]!, n[3]!], p2: [n[4]!, n[5]!] };
    };

    test("starts at the hub", () => {
      expect(points(sweepPath(300)).apex).toEqual([CX, CY]);
    });

    test("both arc endpoints lie exactly r from the hub", () => {
      const r = 317;
      const { p1, p2 } = points(sweepPath(r));
      expect(Math.hypot(p1[0]! - CX, p1[1]! - CY)).toBeCloseTo(r, 6);
      expect(Math.hypot(p2[0]! - CX, p2[1]! - CY)).toBeCloseTo(r, 6);
    });

    test("the wedge is symmetric about the +x axis", () => {
      const { p1, p2 } = points(sweepPath(250));
      expect(p1[0]).toBeCloseTo(p2[0]!, 6);
      expect(CY - p1[1]!).toBeCloseTo(p2[1]! - CY, 6);
    });

    test("half-angle controls the span", () => {
      const r = 200;
      const narrow = points(sweepPath(r, 3));
      const wide = points(sweepPath(r, 20));
      const span = (p: { p1: number[]; p2: number[] }): number => p.p2[1]! - p.p1[1]!;
      expect(span(wide)).toBeGreaterThan(span(narrow));
      // A 20° half-angle means the chord is 2·r·sin(20°).
      expect(span(wide)).toBeCloseTo(2 * r * Math.sin((20 * Math.PI) / 180), 6);
    });
  });
});
