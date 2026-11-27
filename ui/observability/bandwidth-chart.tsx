/**
 * Throughput per run for one saved test, after the Tunnel Bandwidth board:
 * source TX (teal) and source RX (blue) as lines, each run a dot. A failed or
 * interrupted run is a pink dashed mark and a break in the lines, never zero.
 */
import { smoothPath } from "./kit/curve";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LineHover } from "./kit";
import type { TipCard } from "./kit";
import { useLineDraw } from "./monitoring-ui";

export interface ThroughputPoint {
  at: number;
  /** Mbps, or null when the run measured nothing. */
  tx: number | null;
  rx: number | null;
  /** Failed or interrupted: drawn as a gap marker. */
  failed: boolean;
}

const HEIGHT = 190;
const PAD = 8;

/** 412 → 500, 38 → 50, 0 → 1: a round top for the axis. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** Follow the container's width so dots stay round. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ThroughputChart({
  points,
  from,
  to,
  labels,
  drawKey,
  sampleLabel = "Run",
}: {
  points: ThroughputPoint[];
  /** The window the x axis spans, in ms. */
  from: number;
  to: number;
  labels: string[];
  /** Redraw the lines when this changes (a new test or window). */
  drawKey: unknown;
  sampleLabel?: "Run" | "Sample";
}): ReactNode {
  const [box, width] = useWidth(640);
  useLineDraw(box, drawKey);
  const values = points.flatMap((p) => [p.tx, p.rx]).filter((v): v is number => v !== null);
  const ymax = niceCeiling(Math.max(0, ...values));
  const span = Math.max(1, to - from);
  const x = (at: number) =>
    points.length === 1 && from === to
      ? width / 2
      : Math.round(((at - from) / span) * width * 10) / 10;
  const y = (v: number) => Math.round((PAD + (HEIGHT - 2 * PAD) * (1 - v / ymax)) * 10) / 10;

  const grid = [0, 1, 2, 3, 4].map((i) => PAD + ((HEIGHT - 2 * PAD) * i) / 4);
  const series = (["tx", "rx"] as const).map((key) => {
    const runs: [number, number][][] = [];
    let current: [number, number][] = [];
    for (const p of points) {
      const v = p[key];
      if (v === null) {
        if (current.length) runs.push(current);
        current = [];
      } else current.push([x(p.at), y(v)]);
    }
    if (current.length) runs.push(current);
    return { key, runs, color: key === "tx" ? "var(--sig)" : "var(--brand)" };
  });
  // One hover stop per run, on the TX dot (or RX, or the baseline for a failed run).
  const stops = points.map((p): [number, number] => [
    x(p.at),
    p.tx !== null ? y(p.tx) : p.rx !== null ? y(p.rx) : HEIGHT - PAD,
  ]);
  const mbps = (v: number | null) =>
    v === null ? "No result" : `${v.toLocaleString("en-US")} Mbps`;
  const card = (i: number): TipCard => {
    const p = points[i]!;
    const prev = points
      .slice(0, i)
      .reverse()
      .find((q) => q.tx !== null);
    const delta = p.tx !== null && prev?.tx != null ? Math.round((p.tx - prev.tx) * 10) / 10 : null;
    return {
      title: new Date(p.at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      sub: `${sampleLabel} ${i + 1} of ${points.length}`,
      led: p.failed ? "bad" : "ok",
      rows: [
        { label: "Source TX", value: mbps(p.tx), color: "var(--sig)" },
        { label: "Source RX", value: mbps(p.rx), color: "var(--brand)" },
        ...(p.failed ? [{ label: "Run", value: "Failed or interrupted" }] : []),
      ],
      ...(delta !== null
        ? {
            foot: {
              label: `TX vs previous ${sampleLabel.toLowerCase()}`,
              value: `${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")} Mbps`,
              tone: delta >= 0 ? ("up" as const) : ("down" as const),
            },
          }
        : {}),
    };
  };

  return (
    <div>
      <div ref={box} className="relative">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-label={`Throughput per ${sampleLabel.toLowerCase()}`}
          className="block overflow-visible"
        >
          {grid.map((gy) => (
            <line
              key={gy}
              x1={0}
              x2={width}
              y1={gy}
              y2={gy}
              stroke="var(--line)"
              strokeDasharray="2 5"
            />
          ))}
          {points
            .filter((p) => p.failed)
            .map((p) => (
              <g key={`gap-${p.at}`}>
                <line
                  x1={x(p.at)}
                  x2={x(p.at)}
                  y1={PAD}
                  y2={HEIGHT - PAD}
                  stroke="var(--destructive)"
                  strokeDasharray="3 4"
                />
                <circle
                  cx={x(p.at)}
                  cy={HEIGHT - PAD}
                  r={4.5}
                  fill="var(--destructive)"
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              </g>
            ))}
          {series.map((s) =>
            s.runs.map((run, i) => (
              <g key={`${s.key}-${i}`}>
                <path
                  data-draw
                  d={smoothPath(run)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                {run.map(([px, py]) => (
                  <circle key={`${px}-${py}`} cx={px} cy={py} r={2.5} fill={s.color} />
                ))}
              </g>
            )),
          )}
          {stops.length > 0 && (
            <LineHover
              width={width}
              height={HEIGHT}
              points={stops}
              card={card}
              label={`Throughput per ${sampleLabel.toLowerCase()}. Use arrow keys to explore.`}
              band={Math.max(12, Math.min(40, width / Math.max(1, points.length)))}
            />
          )}
        </svg>
        <span className="absolute top-[-4px] left-1 font-mono text-[10px] text-faint">
          {ymax.toLocaleString()} Mbps
        </span>
        <span className="absolute bottom-2.5 left-1 font-mono text-[10px] text-faint">0</span>
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        {labels.map((label, i) => (
          <span key={`${label}-${i}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}
