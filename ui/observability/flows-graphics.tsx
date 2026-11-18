/**
 * Graphics for the Flows page, after the Mon-Flows board: the exporter radar
 * beside the header and the bytes-over-time line chart. Plain SVG coloured by
 * tokens. Radar nodes settle into place on load and hovering one dims the
 * rest; chart lines draw in from the left. Nothing moves with reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { useLineDraw } from "./monitoring-ui";

const REDUCE = "(prefers-reduced-motion: reduce)";

export type RadarStatus = "ok" | "warn" | "bad" | "faint";

const STATUS_COLOR: Record<RadarStatus, string> = {
  ok: "var(--sig)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  faint: "var(--text-faint)",
};

/**
 * Where each node sits around the hub: angle in degrees and distance. The
 * first three are the board's; the rest fill the gaps.
 */
const SLOTS: [number, number][] = [
  [-160, 120],
  [-20, 120],
  [90, 95],
  [-90, 105],
  [160, 120],
  [20, 120],
  [130, 100],
  [50, 100],
];

const RADAR_W = 420;
const RADAR_H = 300;

/** Hub-and-spoke map: the collector port in the middle, one node per exporter. */
export function FlowRadar({
  hub,
  nodes,
}: {
  hub: string;
  nodes: { label: string; status: RadarStatus }[];
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = nodes.map((n) => n.label).join(",");
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate(".flows-radar-node", {
        opacity: [0, 1],
        scale: [0.6, 1],
        duration: 520,
        delay: stagger(70),
        ease: "outBack(1.4)",
      });
      animate(".flows-radar-spoke", { opacity: [0, 1], duration: 400, ease: "outQuad" });
    });
    return () => scope.current?.revert();
  }, [key]);

  const cx = RADAR_W / 2;
  const cy = RADAR_H / 2;
  const placed = nodes.map((n, i) => {
    const [deg, dist] = SLOTS[i % SLOTS.length];
    const r = i < SLOTS.length ? dist : 70;
    const a = (deg * Math.PI) / 180;
    return {
      ...n,
      x: Math.round((cx + r * Math.cos(a)) * 10) / 10,
      y: Math.round((cy + r * Math.sin(a)) * 10) / 10,
    };
  });
  return (
    <svg
      ref={root}
      className="flows-radar"
      viewBox={`0 0 ${RADAR_W} ${RADAR_H}`}
      width="100%"
      height={RADAR_H}
      role="img"
      aria-label={`Exporters sending to UDP ${hub}: ${
        nodes.map((n) => `${n.label} ${n.status === "ok" ? "sending" : "silent"}`).join(", ") ||
        "none"
      }`}
    >
      {[70, 115, 145].map((r) => (
        <circle
          key={r}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeDasharray="1 5"
        />
      ))}
      {placed.map((n) => (
        <line
          key={`spoke-${n.label}`}
          className="flows-radar-spoke"
          x1={cx}
          y1={cy}
          x2={n.x}
          y2={n.y}
          stroke={STATUS_COLOR[n.status]}
          strokeOpacity={0.55}
          strokeWidth={1.5}
          strokeDasharray={n.status === "bad" || n.status === "faint" ? "4 4" : undefined}
        />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={26}
        fill="var(--glass-2)"
        stroke="var(--sig)"
        strokeOpacity={0.6}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="var(--foreground)"
        letterSpacing=".08em"
      >
        {hub}
      </text>
      {placed.map((n) => (
        <g
          key={n.label}
          className="flows-radar-node"
          style={{ transformOrigin: `${n.x}px ${n.y}px` }}
        >
          <title>{n.label}</title>
          <circle
            cx={n.x}
            cy={n.y}
            r={15}
            fill="var(--surface-2)"
            stroke={STATUS_COLOR[n.status]}
            strokeWidth={1.5}
          />
          <circle cx={n.x} cy={n.y} r={4} fill={STATUS_COLOR[n.status]} />
          <text
            x={n.x}
            y={n.y + 30}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
            fontFamily="var(--font-mono)"
          >
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const LINE_COLORS = ["var(--sig)", "var(--brand)"];

/**
 * The board's line chart: dashed quarter lines, one line per series (the
 * first one shaded), and time labels under it. `hits` adds an invisible
 * column per point with a tooltip.
 */
export function FlowLines({
  series,
  labels,
  hits,
  drawKey,
  label,
  width = 1100,
  height = 170,
}: {
  series: number[][];
  labels: string[];
  /** One tooltip per point. */
  hits?: string[];
  drawKey: string;
  label: string;
  width?: number;
  height?: number;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLineDraw(ref, drawKey);
  const n = Math.max(2, ...series.map((s) => s.length));
  const max = Math.max(1, ...series.flat());
  const x = (i: number): number => Math.round(((i * width) / (n - 1)) * 10) / 10;
  const y = (v: number): number => Math.round((height - 8 - (v / max) * (height - 20)) * 10) / 10;
  const paths = series.map((s) => {
    const values = s.length === 1 ? [s[0], s[0]] : s;
    return `M${values.map((v, i) => `${x(i)},${y(v)}`).join(" L")}`;
  });
  const step = width / (n - 1);
  return (
    <div ref={ref}>
      <svg
        className="flows-chart"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {[1, 2, 3].map((q) => (
          <line
            key={q}
            x1="0"
            x2={width}
            y1={(height * q) / 4}
            y2={(height * q) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {paths.map((d, i) => (
          <g key={i}>
            {i === 0 && (
              <path d={`${d} L${width},${height} L0,${height} Z`} fill="var(--sig-fill)" />
            )}
            <path
              d={d}
              data-draw=""
              fill="none"
              stroke={LINE_COLORS[i % LINE_COLORS.length]}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}
        {hits?.map((t, i) => (
          <rect
            key={i}
            x={Math.max(0, i * step - step / 2)}
            y="0"
            width={Math.min(width, i * step + step / 2) - Math.max(0, i * step - step / 2)}
            height={height}
            fill="transparent"
          >
            <title>{t}</title>
          </rect>
        ))}
      </svg>
      <div className="flows-chart-axis">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  );
}
