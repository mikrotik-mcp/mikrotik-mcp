/**
 * Radial layout for the topology radar. Pure geometry — no React, no DOM — so it
 * can be exercised offline by `tests/topology-layout.spec.ts`.
 *
 * Devices take an even split of the circle around the hub. Each neighbour starts
 * on its parent device's bearing and is then relaxed: repelled by every other
 * neighbour, and sprung back toward that bearing. Ten iterations is plenty —
 * this is a fan-out, not a physics demo — and there is deliberately no
 * randomness, so the map is stable across renders rather than jittering.
 */

export interface Pt {
  x: number;
  y: number;
}

/** The subset of `TopoNode` the layout needs. */
export interface LayoutNode {
  id: string;
}

/** Sentinel id for the hub; a leading space cannot collide with a RouterOS identity. */
export const HUB_ID = " hub";

export const W = 760;
export const H = 580;
export const CX = W / 2;
export const CY = H / 2;

/** Wrap an angle into (-π, π] so a crossing at ±π doesn't fling nodes apart. */
function wrap(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function layout(
  devices: LayoutNode[],
  neighbors: LayoutNode[],
  parentOf: Map<string, string>,
): { pos: Map<string, Pt>; rInner: number; rOuter: number } {
  const pos = new Map<string, Pt>();
  const ang = new Map<string, number>();
  pos.set(HUB_ID, { x: CX, y: CY });

  const rInner = devices.length <= 1 ? 110 : Math.min(150, 112 + devices.length * 7);
  const rOuter = rInner + (devices.length <= 1 ? 140 : 110);

  devices.forEach((d, i) => {
    // A lone device would otherwise land on the hub, so it takes 12 o'clock.
    const a =
      devices.length === 1 ? -Math.PI / 2 : (i / devices.length) * Math.PI * 2 - Math.PI / 2;
    ang.set(d.id, a);
    pos.set(d.id, { x: CX + rInner * Math.cos(a), y: CY + rInner * Math.sin(a) });
  });

  // Seed each neighbour on its parent's bearing, fanned alternately above/below.
  const seen = new Map<string, number>();
  const angles = new Map<string, number>();
  for (const nb of neighbors) {
    const p = parentOf.get(nb.id) ?? "";
    const base = ang.get(p) ?? -Math.PI / 2;
    const k = seen.get(p) ?? 0;
    seen.set(p, k + 1);
    angles.set(nb.id, base + Math.ceil(k / 2) * (k % 2 === 0 ? 1 : -1) * 0.49);
  }

  const REPEL = 2600;
  for (let iter = 0; iter < 10; iter++) {
    for (const a of neighbors) {
      let push = 0;
      for (const b of neighbors) {
        if (a.id === b.id) continue;
        const d = wrap((angles.get(a.id) ?? 0) - (angles.get(b.id) ?? 0));
        const dist = Math.abs(d) * rOuter;
        if (dist < 1) {
          // Exactly coincident: break the tie deterministically by id.
          push += a.id < b.id ? 0.02 : -0.02;
        } else if (dist < 120) {
          push += (Math.sign(d) * REPEL) / (dist * dist * rOuter);
        }
      }
      const base = ang.get(parentOf.get(a.id) ?? "") ?? -Math.PI / 2;
      const toParent = wrap(base - (angles.get(a.id) ?? 0));
      angles.set(a.id, (angles.get(a.id) ?? 0) + push + toParent * 0.06);
    }
  }
  for (const nb of neighbors) {
    const a = angles.get(nb.id) ?? 0;
    pos.set(nb.id, { x: CX + rOuter * Math.cos(a), y: CY + rOuter * Math.sin(a) });
  }
  return { pos, rInner, rOuter };
}

/** Dash pattern painting `pct` of a circle of radius `r` (start it at 12 o'clock). */
export function arcDash(r: number, pct: number | undefined): string {
  const len = 2 * Math.PI * r;
  const on = (Math.min(100, Math.max(0, pct ?? 0)) / 100) * len;
  return `${on} ${len - on}`;
}

/**
 * The radar sweep: a wedge with its apex at the hub, spanning `2 * halfDeg`
 * about the +x axis and closed by an arc of radius `r`.
 *
 * Both arc endpoints must lie exactly `r` from the apex. Placing them at a fixed
 * vertical offset instead (`CY ± 46`) puts them at `√(r² + offset²)`, which an
 * `A r r` arc cannot reach — SVG then scales the radii up per spec and draws a
 * bulge rather than a wedge.
 */
export function sweepPath(r: number, halfDeg = 7): string {
  const t = (halfDeg * Math.PI) / 180;
  const dx = r * Math.cos(t);
  const dy = r * Math.sin(t);
  const x1 = CX + dx;
  const y1 = CY - dy;
  const x2 = CX + dx;
  const y2 = CY + dy;
  // sweep-flag 1 = clockwise in SVG's y-down space, taking the short way through
  // (CX + r, CY); large-arc 0 because the wedge spans well under half a turn.
  return `M ${CX} ${CY} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`;
}
