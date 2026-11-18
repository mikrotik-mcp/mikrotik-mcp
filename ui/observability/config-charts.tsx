/**
 * Small parts for the Router configuration and Backup & recovery pages:
 * a score ring with its own text size (the boards' `ring2`), and the boards'
 * unified diff block. The ring sweeps to its value with anime.js; nothing
 * moves with reduced motion.
 */
import "./config-charts.css";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { ArrowRight, Check } from "lucide-react";
import { TONE_COLOR } from "./signal-charts";
import type { ChartTone } from "./signal-charts";

const REDUCE = "(prefers-reduced-motion: reduce)";

/** A ring with a score or a count in the middle, not a percentage. */
export function ScoreRing({
  value,
  size = 64,
  stroke = 6,
  tone = "good",
  fontSize = 14,
  label,
  children,
}: {
  /** 0 to 100: how much of the ring is drawn. */
  value: number;
  size?: number;
  stroke?: number;
  tone?: ChartTone;
  fontSize?: number;
  /** Read out by screen readers. */
  label: string;
  /** The text in the middle. Defaults to the value. */
  children?: ReactNode;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const arc = (pct / 100) * circ;

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia?.(REDUCE).matches) return;
    scope.current = createScope({ root: el }).add(() => {
      animate("[data-arc]", {
        strokeDasharray: [`0 ${circ.toFixed(1)}`, `${arc.toFixed(1)} ${circ.toFixed(1)}`],
        duration: 700,
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, [arc, circ]);

  return (
    <svg
      ref={root}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className="shrink-0"
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
        strokeDasharray={`${arc.toFixed(1)} ${circ.toFixed(1)}`}
        transform={`rotate(-90 ${c} ${c})`}
        strokeLinecap="round"
      />
      <text
        x={c}
        y={c + fontSize * 0.35}
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight="600"
        fill="var(--foreground)"
      >
        {children ?? Math.round(pct)}
      </text>
    </svg>
  );
}

/**
 * The boards' small bar chart: one bar per value, three dashed guides, labels
 * underneath. Bars grow up from the baseline on load.
 */
export function BarChart({
  values,
  labels,
  titles,
  width = 400,
  height = 120,
  label,
}: {
  values: number[];
  labels?: string[];
  /** Hover text per bar. */
  titles?: string[];
  width?: number;
  height?: number;
  label: string;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const scope = useRef<Scope | null>(null);
  const gap = 4;
  const n = values.length;
  const max = Math.max(...values, 0) || 1;
  const bw = n > 0 ? (width - gap * (n - 1)) / n : 0;
  const key = values.join(",");

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia?.(REDUCE).matches) return;
    scope.current = createScope({ root: el }).add(() => {
      animate("[data-bar]", {
        scaleY: [0, 1],
        duration: 520,
        delay: stagger(40),
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, [key]);

  return (
    <div ref={root}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {[1, 2, 3].map((i) => (
          <line
            key={i}
            x1="0"
            x2={width}
            y1={(height * i) / 4}
            y2={(height * i) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {values.map((v, i) => {
          const bh = (v / max) * (height - 14);
          const x = i * (bw + gap);
          return (
            <rect
              key={i}
              data-bar
              x={x}
              y={height - bh}
              width={bw}
              height={bh}
              rx="3"
              fill="var(--brand)"
              opacity=".85"
              style={{ transformOrigin: `${x}px ${height}px`, transformBox: "view-box" }}
            >
              {titles?.[i] && <title>{titles[i]}</title>}
            </rect>
          );
        })}
      </svg>
      {labels && (
        <div className="cfg-bar-labels">
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

const NL = String.fromCharCode(10);

function lines(text: string): string[] {
  return text.split(NL).map((l) => (l.endsWith(String.fromCharCode(13)) ? l.slice(0, -1) : l));
}

/**
 * A unified diff in the boards' `.pre`: added lines teal, removed pink, hunk
 * headers blue, file headers muted.
 */
export function DiffPre({
  text,
  className,
  maxHeight,
}: {
  text: string;
  className?: string;
  maxHeight?: number;
}): ReactNode {
  return (
    <pre
      className={`monitor-pre cfg-diff${className ? ` ${className}` : ""}`}
      style={maxHeight ? { maxHeight } : undefined}
      tabIndex={0}
      aria-label="Configuration diff"
    >
      {lines(text || "No differences.").map((l, i) => {
        const cls =
          l.startsWith("+++") || l.startsWith("---")
            ? "m"
            : l.startsWith("+")
              ? "a"
              : l.startsWith("-")
                ? "r"
                : l.startsWith("@@")
                  ? "k"
                  : undefined;
        return (
          <span key={i} className={cls}>
            {l}
            {NL}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * The boards' numbered workflow steps: done steps show a check, the active one
 * is outlined in teal, later ones are muted.
 */
export function StepTrail({
  labels,
  active,
  done = active,
}: {
  labels: string[];
  /** The current step, 0-based. Pass labels.length when every step is done. */
  active: number;
  /** Steps before this index show a check. Defaults to `active`. */
  done?: number;
}): ReactNode {
  return (
    <ol className="cfg-steps" aria-label="Workflow steps">
      {labels.map((label, i) => (
        <li key={label} className="contents">
          <div
            className="glass cfg-step"
            aria-current={i === active ? "step" : undefined}
            data-reached={i <= active || undefined}
          >
            <span className={`cfg-step-n ${i <= active ? "text-success" : "text-faint"}`}>
              {i < done ? <Check aria-hidden="true" /> : `0${i + 1}`}
            </span>
            <b>{label}</b>
          </div>
          {i < labels.length - 1 && (
            <span className="cfg-step-arrow" aria-hidden="true">
              <ArrowRight />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
