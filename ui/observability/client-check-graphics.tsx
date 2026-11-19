/**
 * Client Check graphics from the "Dia-Client-Check" Signal board: the live
 * device link and the per-run latency trace. A light pulse runs along the link
 * while the device is connected; traces draw in from the left. Nothing moves
 * with reduced motion.
 */
import { smoothPath } from "./kit/curve";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, svg } from "animejs";
import type { Scope } from "animejs";
import { DUR, EASE, LineHover } from "./kit";
import type { TipCard } from "./kit";

const REDUCE = "(prefers-reduced-motion: reduce)";

export type LinkTone = "good" | "brand" | "warn" | "muted";

const COLOR: Record<LinkTone, string> = {
  good: "var(--sig)",
  brand: "var(--brand)",
  warn: "var(--warning)",
  muted: "var(--text-faint)",
};
const SOFT: Record<LinkTone, string> = {
  good: "var(--sig-soft)",
  brand: "var(--acc-soft)",
  warn: "var(--warn-soft)",
  muted: "var(--glass-2)",
};

/** The mark inside the seal: a tick when connected, otherwise a short sign. */
function Seal({ tone, mark }: { tone: LinkTone; mark: "check" | "wait" | "alert" | "stop" }) {
  const color = COLOR[tone];
  const line = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" } as const;
  return (
    <>
      <circle cx="260" cy="56" r="16" fill={SOFT[tone]} stroke={color} />
      {mark === "check" && <path d="M253 56 l5 5 9-10" {...line} strokeLinejoin="round" />}
      {mark === "wait" &&
        [253, 260, 267].map((x) => <circle key={x} cx={x} cy="56" r="1.6" fill={color} />)}
      {mark === "alert" && <path d="M260 49v8M260 62v.5" {...line} />}
      {mark === "stop" && <path d="M253 56h14" {...line} />}
    </>
  );
}

export function LinkScene({
  tone,
  mark,
  live,
}: {
  tone: LinkTone;
  mark: "check" | "wait" | "alert" | "stop";
  /** Runs a pulse along the link. */
  live: boolean;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current || !live) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate("[data-pulse]", {
        cx: [120, 400],
        opacity: [0, 1, 1, 0],
        duration: 2200,
        loop: true,
        loopDelay: 600,
        ease: "inOutSine",
      });
    });
    return () => scope.current?.revert();
  }, [live]);
  const color = COLOR[tone];
  return (
    <svg
      ref={root}
      viewBox="0 0 520 120"
      width="100%"
      height="120"
      role="img"
      aria-label="Device linked to MCP host"
    >
      <line
        x1="120"
        y1="56"
        x2="400"
        y2="56"
        stroke={color}
        strokeOpacity=".5"
        strokeWidth="2"
        strokeDasharray={tone === "good" ? undefined : "5 5"}
      />
      {[170, 230, 290, 350].map((x) => (
        <circle
          key={x}
          cx={x}
          cy="56"
          r="3"
          fill={color}
          opacity={(0.4 + (x - 170) / 400).toFixed(2)}
        />
      ))}
      {live && <circle data-pulse cx="120" cy="56" r="4" fill={color} opacity="0" />}
      <Seal tone={tone} mark={mark} />
      {[
        [80, "YOUR DEVICE"],
        [440, "MCP HOST"],
      ].map(([x, label]) => (
        <g key={label}>
          <rect
            x={Number(x) - 32}
            y="26"
            width="64"
            height="60"
            rx="14"
            fill="var(--glass-2)"
            stroke="var(--line-2)"
          />
          <text
            x={x}
            y="110"
            textAnchor="middle"
            fontSize="10"
            letterSpacing=".14em"
            fill="var(--muted-foreground)"
          >
            {label}
          </text>
        </g>
      ))}
      <rect
        x="70"
        y="38"
        width="20"
        height="34"
        rx="4"
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth="1.6"
      />
      <circle cx="80" cy="66" r="1.5" fill="var(--text-secondary)" />
      <rect
        x="426"
        y="38"
        width="28"
        height="14"
        rx="3"
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth="1.6"
      />
      <rect
        x="426"
        y="56"
        width="28"
        height="14"
        rx="3"
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth="1.6"
      />
    </svg>
  );
}

const W = 520;
const H = 120;

function tracePoints(values: number[], maximum: number): [number, number][] {
  const n = values.length;
  return values.map((v, i) => {
    const x = n > 1 ? (i * W) / (n - 1) : 0;
    const y = H - 8 - (Math.max(0, v) / maximum) * (H - 20);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
}

function tracePath(values: number[], maximum: number): string {
  return smoothPath(tracePoints(values, maximum));
}

const ms = (v: number): string => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;

/** Idle and loaded HTTP latency for one run, on a scale shared with its pair. */
export function LatencyTrace({
  label,
  idleMs,
  loadedMs,
  maximum,
}: {
  label: string;
  idleMs: number[];
  loadedMs: number[];
  maximum: number;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = `${idleMs.join(",")}|${loadedMs.join(",")}|${maximum}`;
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const paths = root.current?.querySelectorAll<SVGPathElement>("path[data-draw]");
      if (paths?.length)
        animate(svg.createDrawable(paths), {
          draw: ["0 0", "0 1"],
          duration: DUR.draw,
          ease: EASE.enter,
        });
    });
    return () => scope.current?.revert();
  }, [key]);
  const scale = maximum < 10 ? maximum.toFixed(1) : Math.round(maximum).toString();
  // The hover follows the longer series; the card reads both at that sample.
  const main = idleMs.length >= loadedMs.length ? idleMs : loadedMs;
  const points = tracePoints(main, maximum);
  const card = (i: number): TipCard => {
    const idle = idleMs[i];
    const loaded = loadedMs[i];
    return {
      title: `Sample ${i + 1} of ${main.length}`,
      sub: label,
      rows: [
        ...(idle != null ? [{ label: "Idle", value: ms(idle), color: "var(--sig)" }] : []),
        ...(loaded != null ? [{ label: "Loaded", value: ms(loaded), color: "var(--brand)" }] : []),
      ],
      ...(idle != null && loaded != null
        ? {
            foot: {
              label: "Loaded vs idle",
              value: `${loaded >= idle ? "+" : "−"}${ms(Math.abs(loaded - idle))}`,
              tone: loaded > idle ? ("down" as const) : ("up" as const),
            },
          }
        : {}),
    };
  };
  return (
    <figure ref={root} className="cc-trace glass">
      <figcaption>{label} · HTTP latency samples</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: idle and loaded HTTP latency, shared scale 0 to ${scale} ms`}
      >
        {[30, 60, 90].map((y) => (
          <line key={y} x1="0" x2={W} y1={y} y2={y} stroke="var(--line)" strokeDasharray="2 5" />
        ))}
        {loadedMs.length > 0 && (
          <path
            data-draw
            d={tracePath(loadedMs, maximum)}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {idleMs.length > 0 && (
          <path
            data-draw
            d={tracePath(idleMs, maximum)}
            fill="none"
            stroke="var(--sig)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {points.length > 0 && (
          <LineHover
            width={W}
            height={H}
            points={points}
            card={card}
            label={`${label} latency samples. Use the arrow keys to read each sample.`}
            band={Math.max(8, W / main.length)}
            color={main === idleMs ? "var(--sig)" : "var(--brand)"}
          />
        )}
      </svg>
      <span className="monitor-legend">
        <span>
          <i className="bg-sig" />
          Idle · {idleMs.length} samples
        </span>
        <span>
          <i className="bg-brand" />
          Loaded · {loadedMs.length} samples
        </span>
        <span className="ml-auto">shared scale 0–{scale} ms</span>
      </span>
    </figure>
  );
}
