/**
 * The two charts on the RADIUS & UM reports board: the traffic line chart and
 * the starts-by-hour bars. Plain SVG drawn to the board's geometry; each point
 * or bar carries a native tooltip with its values.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, stagger } from "animejs";
import { useLineDraw } from "./monitoring-ui";

const REDUCE = "(prefers-reduced-motion: reduce)";

/** Three dashed guide lines at a quarter, half and three quarters. */
function Guides({ w, h }: { w: number; h: number }): ReactNode {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <line
          key={i}
          x1={0}
          x2={w}
          y1={(h * i) / 4}
          y2={(h * i) / 4}
          stroke="var(--line)"
          strokeDasharray="2 5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

function Labels({ labels }: { labels: string[] }): ReactNode {
  return (
    <div className="um-axis" aria-hidden="true">
      {labels.map((l, i) => (
        <span key={`${l}-${i}`}>{l}</span>
      ))}
    </div>
  );
}

/**
 * Download (teal, filled) and upload (amber) as lines over the period. `titles`
 * gives each point's tooltip.
 */
export function TrafficChart({
  down,
  up,
  labels,
  titles,
  label,
  drawKey,
}: {
  down: number[];
  up: number[];
  labels: string[];
  titles: string[];
  label: string;
  drawKey: unknown;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLineDraw(ref, drawKey);
  const w = 680;
  const h = 262;
  const n = down.length;
  const max = Math.max(1, ...down, ...up);
  const x = (i: number): number => (n > 1 ? (i * w) / (n - 1) : w / 2);
  const y = (v: number): number => h - 8 - (v / max) * (h - 20);
  const line = (values: number[]): string =>
    values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const downPath = line(down);
  return (
    <div ref={ref} data-slot="chart" className="um-chart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img">
        <title>{label}</title>
        <Guides w={w} h={h} />
        {n > 0 && <path d={`${downPath} L${w},${h} L0,${h} Z`} fill="var(--sig-fill)" />}
        {n > 0 && (
          <path
            data-draw
            d={downPath}
            fill="none"
            stroke="var(--sig)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {n > 0 && (
          <path
            data-draw
            d={line(up)}
            fill="none"
            stroke="var(--warning)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {titles.map((t, i) => (
          <rect
            key={i}
            x={n > 1 ? x(i) - w / (n - 1) / 2 : 0}
            y={0}
            width={n > 1 ? w / (n - 1) : w}
            height={h}
            fill="transparent"
          >
            <title>{t}</title>
          </rect>
        ))}
      </svg>
      <Labels labels={labels} />
    </div>
  );
}

/** Session starts per hour of the day, as rounded bars that rise in on load. */
export function HourBars({
  values,
  titles,
  label,
  drawKey,
}: {
  values: number[];
  titles: string[];
  label: string;
  drawKey: unknown;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const scope = createScope({ root: ref, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate("rect[data-bar]", {
        scaleY: [0, 1],
        duration: 420,
        delay: stagger(14),
        ease: "outQuart",
      });
    });
    return () => scope.revert();
  }, [drawKey]);
  const w = 440;
  const h = 150;
  const gap = 3;
  const n = values.length;
  const max = Math.max(1, ...values);
  const bw = n ? (w - gap * (n - 1)) / n : 0;
  return (
    <div ref={ref} data-slot="chart" className="um-chart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img">
        <title>{label}</title>
        <Guides w={w} h={h} />
        {values.map((v, i) => {
          const bh = (v / max) * (h - 14);
          return (
            <rect
              key={i}
              data-bar
              x={i * (bw + gap)}
              y={h - bh}
              width={bw}
              height={bh}
              rx={3}
              fill="var(--chart-1)"
              opacity={0.85}
              style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
            >
              <title>{titles[i]}</title>
            </rect>
          );
        })}
      </svg>
      <Labels labels={["00", "06", "12", "18", "23"]} />
    </div>
  );
}
