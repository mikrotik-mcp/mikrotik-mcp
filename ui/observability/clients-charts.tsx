/**
 * Charts for the Clients page, after the Usr-Clients boards: the line chart
 * (live traffic, usage history), the row sparkline and the "Busiest right now"
 * bars. Plain SVG coloured by tokens. Lines draw in from the left when the
 * chart first shows a client, not on every live sample, and stay still under
 * reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, svg } from "animejs";
import type { Scope } from "animejs";

const REDUCE = "(prefers-reduced-motion: reduce)";
const W = 520;

export interface LineSeries {
  values: number[];
  color: string;
}

/**
 * The boards' `line_chart`: one or two lines over a shared scale, the first
 * shaded. `xs` places each point from 0 to 1 across the width; leave it out
 * for evenly spaced points. `drawKey` replays the draw-in when it changes.
 */
export function LineChart({
  series,
  xs,
  height,
  grid = true,
  labels,
  label,
  drawKey,
}: {
  series: LineSeries[];
  xs?: number[];
  height: number;
  grid?: boolean;
  labels?: string[];
  label: string;
  drawKey?: unknown;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const lines = root.current?.querySelectorAll<SVGPathElement>("path[data-line]");
      if (!lines?.length) return;
      animate(svg.createDrawable(lines), { draw: ["0 0", "0 1"], duration: 700, ease: "outQuart" });
    });
    return () => scope.current?.revert();
  }, [drawKey]);

  const h = height;
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.filter(Number.isFinite)));
  const x = (i: number): number => (xs?.[i] ?? (n > 1 ? i / (n - 1) : 1)) * W;
  const y = (v: number): number => h - 8 - ((Number.isFinite(v) ? v : 0) / max) * (h - 20);
  const pathOf = (values: number[]): string =>
    `M${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}`;

  return (
    <div className="clients-chart">
      <svg
        ref={root}
        viewBox={`0 0 ${W} ${h}`}
        width="100%"
        height={h}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="block w-full"
      >
        {grid &&
          [1, 2, 3].map((i) => (
            <line
              key={i}
              x1="0"
              x2={W}
              y1={(h * i) / 4}
              y2={(h * i) / 4}
              stroke="var(--line)"
              strokeDasharray="2 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {n > 1 &&
          series.map((s, si) => {
            const d = pathOf(s.values);
            return (
              <g key={si}>
                {si === 0 && <path d={`${d} L${W},${h} L0,${h} Z`} fill="var(--sig-fill)" />}
                <path
                  data-line
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
      </svg>
      {labels != null && (
        <div className="clients-chart-labels">
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The 64×18 trend beside a row's live rates. It updates every second, so it doesn't animate. */
export function RowSpark({
  values,
  className,
}: {
  values: number[];
  className?: string;
}): ReactNode {
  const w = 64;
  const h = 18;
  const cls = className ? `clients-spark ${className}` : "clients-spark";
  if (values.length < 2)
    return (
      <svg className={cls} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" />
    );
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map(
    (v, i) =>
      `${((i * w) / (values.length - 1)).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`,
  );
  const d = `M${pts.join(" L")}`;
  return (
    <svg className={cls} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--sig-fill)" />
      <path d={d} fill="none" stroke="var(--sig)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export interface TalkerBar {
  key: string;
  label: string;
  pct: number;
  value: string;
  tone: "good" | "warn";
}

/** "Busiest right now": a name, a bar and a value per client. Bars ease to new widths in CSS. */
export function TalkerBars({ items }: { items: TalkerBar[] }): ReactNode {
  return (
    <div className="clients-talkers">
      {items.map((it) => (
        <div key={it.key} className="clients-talker">
          <span className="clients-mono clients-trunc text-fg-secondary">{it.label}</span>
          <span className="monitor-bar">
            <span data-tone={it.tone} style={{ width: `${Math.max(0, Math.min(100, it.pct))}%` }} />
          </span>
          <span className="clients-mono clients-num text-right text-foreground">{it.value}</span>
        </div>
      ))}
    </div>
  );
}
