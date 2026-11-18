/**
 * Graphics for the Security pages, after the approved Sec-* boards:
 *
 * - `KillChain`: how far the week's incidents got, four stages on one line.
 * - `PressureBars`: incidents per day, stacked by confidence.
 * - `ScoreRing`: a vulnerability's risk score in a ring.
 * - `ExposurePath`: who can reach a service, drawn as an arrow.
 *
 * Plain SVG coloured by tokens. Motion follows the canvas note (nodes settle,
 * charts draw in from the left, rings sweep) and stops under reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { animate, createScope, stagger, svg } from "animejs";
import type { Scope } from "animejs";
import { Server } from "lucide-react";
import { DUR, EASE, tipProps } from "./kit";
import type { TipCard } from "./kit";
import { TONE_COLOR } from "./signal-charts";
import type { ChartTone } from "./signal-charts";

const REDUCE = "(prefers-reduced-motion: reduce)";

/** Runs `play` inside an anime.js scope on `root` each time `key` changes. */
function useMotion(
  root: RefObject<SVGSVGElement | HTMLDivElement | null>,
  key: string,
  play: (el: Element) => void,
): void {
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion || !root.current) return;
      play(root.current);
    });
    return () => scope.current?.revert();
  }, [root, key, play]);
}

/** The kill chain: the lit path draws in, then the stages settle one by one. */
function playKillChain(): void {
  animate(svg.createDrawable("[data-draw]"), {
    draw: ["0 0", "0 1"],
    duration: DUR.draw,
    ease: EASE.enter,
  });
  animate("[data-node]", {
    opacity: [0, 1],
    scale: [0.6, 1],
    duration: 420,
    delay: stagger(90),
    ease: "outBack(1.4)",
  });
}

/** Bars grow up from the axis, left to right. */
function playBars(): void {
  animate("[data-bar]", {
    scaleY: [0, 1],
    duration: 520,
    delay: stagger(40),
    ease: EASE.enter,
  });
}

/** The ring sweeps from empty to its own dash. */
function playSweep(el: Element): void {
  for (const arc of el.querySelectorAll<SVGCircleElement>("circle[data-arc]")) {
    const [len, circ] = (arc.getAttribute("stroke-dasharray") ?? "0 0").split(" ");
    animate(arc, {
      strokeDasharray: [`0 ${circ}`, `${len} ${circ}`],
      duration: DUR.draw,
      ease: EASE.enter,
    });
  }
}

export interface StageCount {
  name: string;
  count: number;
}

const STAGE_COLOR = ["var(--brand)", "var(--warning)", "var(--destructive)", "var(--text-faint)"];

/**
 * Four stages along a signal path. A circle grows with the incidents that
 * reached its stage; an empty stage is a dashed outline.
 */
export function KillChain({
  stages,
  caption,
}: {
  stages: StageCount[];
  caption: string;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const xs = [60, 160, 260, 360];
  useMotion(root, stages.map((s) => s.count).join(","), playKillChain);
  // The lit path runs from the first stage to the furthest one with incidents.
  const last = stages.reduce((n, s, i) => (s.count > 0 ? i : n), -1);
  return (
    <svg
      ref={root}
      className="kit-tips"
      viewBox="0 0 420 300"
      width="100%"
      height="300"
      role="img"
      aria-label={`Incidents by attack stage: ${stages.map((s) => `${s.name} ${s.count}`).join(", ")}`}
    >
      <defs>
        <linearGradient id="sec-kc" x1="0" x2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset=".55" stopColor="var(--warning)" />
          <stop offset="1" stopColor="var(--destructive)" />
        </linearGradient>
      </defs>
      <line
        x1="40"
        y1="150"
        x2="380"
        y2="150"
        stroke="var(--line-2)"
        strokeWidth="2"
        strokeDasharray="2 6"
      />
      {last > 0 && (
        <path
          data-draw
          d={`M60 150 L${xs[last]} 150`}
          stroke="url(#sec-kc)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      )}
      {stages.map((s, i) => {
        // Past eight incidents the circle stops growing, so it never hits its neighbour.
        const r = 10 + Math.min(s.count, 8) * 3.2;
        const color = STAGE_COLOR[i] ?? STAGE_COLOR[3];
        return (
          <g
            key={s.name}
            data-node
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            {...tipProps((): TipCard => ({
              title: s.name,
              sub: caption.toLowerCase(),
              rows: [{ label: "Incidents", value: s.count, color }],
              foot:
                i > 0
                  ? { label: `Reached ${stages[i - 1]!.name}`, value: stages[i - 1]!.count }
                  : undefined,
            }))}
          >
            {s.count > 0 && <circle cx={xs[i]} cy="150" r={r + 10} fill={color} opacity=".10" />}
            <circle
              cx={xs[i]}
              cy="150"
              r={r}
              fill="var(--surface-2)"
              stroke={color}
              strokeWidth="2"
              strokeDasharray={s.count > 0 ? undefined : "3 4"}
            />
            <text
              x={xs[i]}
              y="155"
              textAnchor="middle"
              fontSize="15"
              fontWeight="600"
              fill="var(--foreground)"
            >
              {s.count}
            </text>
            <text
              x={xs[i]}
              y={150 + r + 30}
              textAnchor="middle"
              fontSize="11"
              fill="var(--muted-foreground)"
              fontFamily="var(--font-mt)"
            >
              {s.name}
            </text>
          </g>
        );
      })}
      <text x="20" y="40" fontSize="11" fill="var(--text-faint)" letterSpacing=".08em">
        {caption}
      </text>
      <text x="20" y="276" fontSize="11" fill="var(--text-faint)">
        Each circle counts incidents that reached that stage.
      </text>
    </svg>
  );
}

export interface PressureDay {
  label: string;
  confirmed: number;
  high: number;
  other: number;
}

/** Incidents per day, stacked bottom up: medium/low, high, confirmed. */
export function PressureBars({ days }: { days: PressureDay[] }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useMotion(root, days.map((d) => `${d.confirmed}.${d.high}.${d.other}`).join(","), playBars);
  const w = 680;
  const h = 200;
  const gap = 18;
  const n = Math.max(days.length, 1);
  const max = Math.max(1, ...days.map((d) => d.confirmed + d.high + d.other));
  const bw = (w - gap * (n - 1)) / n;
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const bars: ReactNode[] = [];
  days.forEach((d, i) => {
    const x = r1(i * (bw + gap));
    let y = h;
    const segs: ReactNode[] = [];
    const parts: [number, string, string][] = [
      [d.other, "var(--brand)", "medium / low"],
      [d.high, "var(--warning)", "high"],
      [d.confirmed, "var(--destructive)", "confirmed"],
    ];
    for (const [v, fill, name] of parts) {
      if (!v) continue;
      const bh = (v / max) * (h - 14);
      y -= bh;
      segs.push(
        <rect
          key={`${d.label}-${name}`}
          data-bar
          x={x}
          y={r1(y)}
          width={r1(bw)}
          height={r1(Math.max(bh - 2, 0.5))}
          rx="3"
          fill={fill}
          opacity=".9"
          style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
        />,
      );
    }
    const total = d.confirmed + d.high + d.other;
    const prev = i > 0 ? days[i - 1] : undefined;
    const prevTotal = prev ? prev.confirmed + prev.high + prev.other : 0;
    bars.push(
      <g
        key={d.label}
        {...tipProps((): TipCard => ({
          title: d.label,
          sub: `${total} incident${total === 1 ? "" : "s"}`,
          rows: [
            { label: "Confirmed", value: d.confirmed, color: "var(--destructive)" },
            { label: "High", value: d.high, color: "var(--warning)" },
            { label: "Medium / low", value: d.other, color: "var(--brand)" },
          ],
          foot: prev
            ? {
                label: `vs ${prev.label}`,
                value: `${total - prevTotal >= 0 ? "+" : ""}${total - prevTotal}`,
                tone: total > prevTotal ? "up" : total < prevTotal ? "down" : undefined,
              }
            : undefined,
        }))}
      >
        <rect x={x} y={0} width={r1(bw)} height={h} fill="transparent" />
        {segs}
      </g>,
    );
  });
  return (
    <div ref={root}>
      <svg
        className="kit-tips"
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        preserveAspectRatio="none"
        role="img"
        aria-label="Incidents per day"
      >
        {[1, 2, 3].map((i) => (
          <line
            key={i}
            x1="0"
            x2={w}
            y1={r1((h * i) / 4)}
            y2={r1((h * i) / 4)}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {bars}
      </svg>
      <div className="sec-bars-x">
        {days.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </div>
  );
}

/** A risk score from 0 to 100 in a ring, the number in the middle. */
export function ScoreRing({
  score,
  tone,
  size = 72,
  stroke = 6,
}: {
  score: number;
  tone: ChartTone;
  size?: number;
  stroke?: number;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const pct = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const len = ((pct / 100) * circ).toFixed(1);
  useMotion(root, String(pct), playSweep);
  return (
    <svg
      ref={root}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`Risk score ${Math.round(pct)}`}
      {...tipProps((): TipCard => ({
        title: "Risk score",
        rows: [{ label: "Score", value: `${Math.round(pct)} of 100`, color: TONE_COLOR[tone] }],
      }))}
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
        strokeDasharray={`${len} ${circ.toFixed(1)}`}
        transform={`rotate(-90 ${c} ${c})`}
        strokeLinecap="round"
      />
      <text
        x={c}
        y={c + 6}
        textAnchor="middle"
        fontSize="18"
        fontWeight="600"
        fill="var(--text-emphasis)"
      >
        {Math.round(pct)}
      </text>
    </svg>
  );
}

/** "ANY ──▶ winbox:8291": who may reach a service. Solid when open, dashed when limited. */
export function ExposurePath({
  from,
  service,
  tone,
}: {
  from: string;
  service: string;
  tone: ChartTone;
}): ReactNode {
  const color = TONE_COLOR[tone];
  const dashed = tone === "good" || tone === "muted";
  return (
    <div className="sec-path">
      <span className="monitor-chip sec-path-chip">{from}</span>
      <svg viewBox="0 0 120 12" width="120" height="12" aria-hidden="true">
        <line
          x1="0"
          y1="6"
          x2="110"
          y2="6"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? "4 4" : undefined}
        />
        <path d="M108 1l8 5-8 5" fill="none" stroke={color} strokeWidth="2" />
      </svg>
      <span className="monitor-chip sec-path-chip">
        <Server aria-hidden="true" />
        {service}
      </span>
    </div>
  );
}
