/**
 * Small chart parts from the Signal boards: `Sparkline`, `Ring` and `Donut`.
 * Plain SVG coloured by tokens, so both themes work. Motion follows the canvas
 * note: sparklines draw in from the left, rings and donuts sweep to their
 * value. Nothing moves when the user asks for reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { animate, createScope, svg } from "animejs";
import type { Scope } from "animejs";

const REDUCE = "(prefers-reduced-motion: reduce)";

export type ChartTone = "good" | "warn" | "bad" | "brand" | "muted";

/** The token behind each tone. `good` is the signal teal. */
export const TONE_COLOR: Record<ChartTone, string> = {
  good: "var(--sig)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  brand: "var(--brand)",
  muted: "var(--text-faint)",
};

/** SVG path points for `values`, scaled into a w × h box with a 2px margin. */
export function sparkPoints(values: number[], w: number, h: number): [number, number][] {
  const finite = values.map((v) => (Number.isFinite(v) ? v : 0));
  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const range = max - min || 1;
  const step = finite.length > 1 ? w / (finite.length - 1) : 0;
  return finite.map((v, i) => [
    Math.round(i * step * 10) / 10,
    Math.round((h - 2 - ((v - min) / range) * (h - 4)) * 10) / 10,
  ]);
}

/**
 * A tiny trend line, e.g. inside a KPI card or the header's Live capsule.
 * Needs two or more values; with fewer it renders nothing.
 */
export function Sparkline({
  values,
  width = 64,
  height = 22,
  tone = "good",
  fill = false,
  className = "monitor-spark",
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: ChartTone;
  /** Shade the area under the line. */
  fill?: boolean;
  className?: string;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = values.join(",");
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const line = root.current?.querySelector<SVGPathElement>("path[data-line]");
      if (line)
        animate(svg.createDrawable(line), {
          draw: ["0 0", "0 1"],
          duration: 600,
          ease: "outQuart",
        });
    });
    return () => scope.current?.revert();
  }, [key]);

  if (values.length < 2) return null;
  const points = sparkPoints(values, width, height);
  const d = `M${points.map(([x, y]) => `${x},${y}`).join(" L")}`;
  const color = TONE_COLOR[tone];
  return (
    <svg
      ref={root}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      {fill && (
        <path d={`${d} L${width},${height} L0,${height} Z`} fill="var(--sig-fill)" stroke="none" />
      )}
      <path
        data-line
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Sweeps every `circle[data-arc]` in `root` from an empty dash to its own. */
function useSweep(root: RefObject<SVGSVGElement | null>, key: string): void {
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const arcs = root.current?.querySelectorAll<SVGCircleElement>("circle[data-arc]") ?? [];
      arcs.forEach((arc, i) => {
        const [len, circ] = (arc.getAttribute("stroke-dasharray") ?? "0 0").split(" ");
        animate(arc, {
          strokeDasharray: [`0 ${circ}`, `${len} ${circ}`],
          duration: 700,
          delay: i * 60,
          ease: "outQuart",
        });
      });
    });
    return () => scope.current?.revert();
  }, [root, key]);
}

/** A progress ring with the percentage in the middle, e.g. a quota or a pass rate. */
export function Ring({
  value,
  size = 64,
  stroke = 6,
  tone = "good",
  label,
  children,
}: {
  /** 0 to 100. */
  value: number;
  size?: number;
  stroke?: number;
  tone?: ChartTone;
  /** What the ring measures; read out with the value. */
  label: string;
  /** Replaces the default "42%" in the middle. */
  children?: ReactNode;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  useSweep(root, String(pct));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg
      ref={root}
      className="signal-ring"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${label} ${Math.round(pct)}%`}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      <circle
        data-arc
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={TONE_COLOR[tone]}
        strokeWidth={stroke}
        strokeDasharray={`${((pct / 100) * circ).toFixed(1)} ${circ.toFixed(1)}`}
        transform={`rotate(-90 ${c} ${c})`}
        strokeLinecap="round"
      />
      <text
        x={c}
        y={c + 4}
        textAnchor="middle"
        fontSize="13"
        fontWeight="600"
        fill="var(--foreground)"
      >
        {children ?? `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

export interface DonutPart {
  value: number;
  tone: ChartTone;
  label: string;
}

/** A breakdown ring with a total in the middle, e.g. the Overview risk mix. */
export function Donut({
  parts,
  size = 150,
  stroke = 16,
  center,
  sub,
  label = "Breakdown",
}: {
  parts: DonutPart[];
  size?: number;
  stroke?: number;
  /** The big number in the middle. */
  center?: ReactNode;
  /** The small word under it, e.g. "calls". */
  sub?: ReactNode;
  label?: string;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  useSweep(root, parts.map((p) => p.value).join(","));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
  const shown = parts.filter((p) => p.value > 0);
  // Where each arc starts along the circle: the lengths of the arcs before it.
  const lengths = shown.map((p) => (p.value / total) * circ);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, n) => sum + n, 0));
  const arcs = shown.map((p, i) => {
    const len = lengths[i];
    return (
      <circle
        key={p.label}
        data-arc
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={TONE_COLOR[p.tone]}
        strokeWidth={stroke}
        strokeDasharray={`${Math.max(len - 3, 0.5).toFixed(1)} ${circ.toFixed(1)}`}
        strokeDashoffset={(-starts[i]).toFixed(1)}
        transform={`rotate(-90 ${c} ${c})`}
        strokeLinecap="round"
      >
        <title>{`${p.label}: ${p.value}`}</title>
      </circle>
    );
  });
  return (
    <svg
      ref={root}
      className="signal-donut"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      {arcs}
      {center != null && (
        <text
          x={c}
          y={c + 4}
          textAnchor="middle"
          fontSize="22"
          fontWeight="600"
          fill="var(--text-emphasis)"
        >
          {center}
        </text>
      )}
      {sub != null && (
        <text x={c} y={c + 22} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">
          {sub}
        </text>
      )}
    </svg>
  );
}
