/**
 * Charts for the Overview board: the calls line and the router map around the
 * MCP server. Plain SVG coloured by tokens. The line draws in from the left and
 * the map's nodes settle into place; nothing moves with reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, stagger, svg } from "animejs";
import type { Scope } from "animejs";
import { useLineDraw } from "./monitoring-ui";

const REDUCE = "(prefers-reduced-motion: reduce)";

const W = 720;
const H = 190;

/**
 * Calls per bucket as a filled line, with a pink dot on every bucket that had
 * a failure. `labels` run under the chart, spread edge to edge.
 */
export function CallsLine({
  values,
  failed,
  labels,
}: {
  values: number[];
  /** Failed calls per bucket, same length as `values`. */
  failed: number[];
  /** `at` is the bucket's time, also the React key. */
  labels: { at: number; text: string }[];
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useLineDraw(root, values.join(","));
  const n = values.length;
  const max = Math.max(1, ...values);
  const points = values.map((v, i): [number, number] => [
    Math.round((n > 1 ? (i * W) / (n - 1) : 0) * 10) / 10,
    Math.round((H - 8 - (v / max) * (H - 20)) * 10) / 10,
  ]);
  const d = points.length ? `M${points.map(([x, y]) => `${x},${y}`).join(" L")}` : "";
  return (
    <div ref={root}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        // Inline like the board's chart: the baseline gap under it keeps the panel's height.
        className="inline"
        role="img"
        aria-label={`Calls per interval, peaking at ${max}`}
      >
        {[1, 2, 3].map((i) => (
          <line
            key={i}
            x1="0"
            x2={W}
            y1={(H * i) / 4}
            y2={(H * i) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {n > 1 && (
          <>
            <path d={`${d} L${W},${H} L0,${H} Z`} fill="var(--sig-fill)" />
            <path
              data-draw
              d={d}
              fill="none"
              stroke="var(--sig)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map(([x, y], i) =>
              failed[i] > 0 ? (
                <circle
                  key={x}
                  cx={x}
                  cy={y}
                  r="4.5"
                  fill="var(--destructive)"
                  stroke="var(--background)"
                  strokeWidth="2"
                >
                  <title>{`${failed[i]} failed`}</title>
                </circle>
              ) : null,
            )}
          </>
        )}
      </svg>
      <div className="text-faint mt-1.5 flex justify-between text-[11px] leading-[21px]">
        {labels.map((l) => (
          <span key={l.at}>{l.text}</span>
        ))}
      </div>
    </div>
  );
}

export type RadarTone = "good" | "warn" | "bad" | "unknown";

const RADAR_COLOR: Record<RadarTone, string> = {
  good: "var(--sig)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  unknown: "var(--text-faint)",
};

/**
 * The MCP server in the middle and one node per router around it. A dashed
 * spoke means the router is offline or not checked yet.
 */
export function RouterRadar({ nodes }: { nodes: { name: string; tone: RadarTone }[] }): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = nodes.map((n) => `${n.name}:${n.tone}`).join(",");
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const spokes = root.current?.querySelectorAll<SVGLineElement>("line[data-spoke]");
      if (spokes?.length)
        animate(svg.createDrawable(spokes), {
          draw: ["0 0", "0 1"],
          duration: 600,
          delay: stagger(60),
          ease: "outQuart",
        });
      animate("[data-dot]", {
        opacity: [0, 1],
        scale: [0.6, 1],
        duration: 520,
        delay: stagger(60, { start: 120 }),
        ease: "outBack(1.4)",
      });
    });
    return () => scope.current?.revert();
  }, [key]);

  const cx = 210;
  const cy = 150;
  const placed = nodes.map((node, i) => {
    const a = ((-90 + (i * 360) / Math.max(nodes.length, 1)) * Math.PI) / 180;
    return {
      ...node,
      x: Math.round((cx + 120 * Math.cos(a)) * 10) / 10,
      y: Math.round((cy + 115 * Math.sin(a)) * 10) / 10,
    };
  });
  return (
    <svg
      ref={root}
      className="overview-radar block"
      viewBox="0 0 420 300"
      width="100%"
      height="300"
      role="img"
      aria-label={`Routers around the MCP server: ${nodes.map((n) => `${n.name} ${n.tone === "unknown" ? "not checked" : n.tone}`).join(", ") || "none"}`}
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
          key={n.name}
          data-spoke
          x1={cx}
          y1={cy}
          x2={n.x}
          y2={n.y}
          stroke={RADAR_COLOR[n.tone]}
          strokeOpacity=".55"
          strokeWidth="1.5"
          strokeDasharray={n.tone === "bad" || n.tone === "unknown" ? "4 4" : undefined}
        />
      ))}
      <circle cx={cx} cy={cy} r="26" fill="var(--glass-2)" stroke="var(--sig)" strokeOpacity=".6" />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="var(--foreground)"
        letterSpacing=".08em"
      >
        MCP
      </text>
      {placed.map((n) => (
        <g key={n.name} data-node>
          <title>{n.name}</title>
          <g data-dot className="overview-radar-dot">
            <circle
              cx={n.x}
              cy={n.y}
              r="15"
              fill="var(--surface-2)"
              stroke={RADAR_COLOR[n.tone]}
              strokeWidth="1.5"
            />
            <circle cx={n.x} cy={n.y} r="4" fill={RADAR_COLOR[n.tone]} />
          </g>
          <text
            x={n.x}
            y={n.y + 30}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
            fontFamily="var(--font-mt)"
          >
            {n.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
