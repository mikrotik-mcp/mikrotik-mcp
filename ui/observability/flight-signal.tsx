/**
 * The Flight Recorder chart from the "Signal" board: CPU as a line that
 * breaks over gaps, one dot per management observation along the bottom,
 * failed stretches shaded pink, and a dashed amber line where an incident
 * was frozen. Draws in from the left (anime.js, off with reduced motion).
 */
import { smoothPath } from "./kit/curve";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LineHover } from "./kit";
import type { TipCard } from "./kit";
import { useLineDraw } from "./monitoring-ui";
import type { FlightSample } from "../../src/flight-recorder/model";

const H = 210;
/** Samples further apart than this break the CPU line. */
const MAX_JOIN = 300000;

export function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function cpuY(cpu: number): number {
  return 20 + (H - 60) * (1 - Math.min(100, Math.max(0, cpu)) / 100);
}

export function FlightSignal({
  samples,
  frozenAt,
  drawKey,
}: {
  samples: FlightSample[];
  /** When the incident was frozen; draws the amber marker. */
  frozenAt?: number;
  /** Redraw the line when this changes (the selected window), not on every poll. */
  drawKey: unknown;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLineDraw(root, drawKey);

  const start = samples[0]?.at ?? 0;
  const end = samples.at(-1)?.at ?? start;
  const span = Math.max(1, end - start);
  const x = (at: number) => ((at - start) / span) * w;

  // CPU line, broken where a sample has no CPU or the gap is too long.
  const lines: string[] = [];
  let run: [number, number][] = [];
  samples.forEach((s, i) => {
    const prev = samples[i - 1];
    if (s.cpu === undefined || (prev && s.at - prev.at > MAX_JOIN)) {
      if (run.length > 1) lines.push(smoothPath(run));
      run = [];
    }
    if (s.cpu !== undefined) run.push([x(s.at), cpuY(s.cpu)]);
  });
  if (run.length > 1) lines.push(smoothPath(run));

  // Shade each stretch without a healthy management answer.
  const shade: { from: number; to: number }[] = [];
  samples.forEach((s, i) => {
    if (s.reachable === true) return;
    const last = shade.at(-1);
    if (last && samples[i - 1]?.reachable !== true && i > 0) last.to = s.at;
    else shade.push({ from: s.at, to: s.at });
  });
  const step = samples.length > 1 ? w / (samples.length - 1) : 8;

  const ticks = samples.length ? Array.from({ length: 7 }, (_, i) => start + (span * i) / 6) : [];
  const fx = frozenAt !== undefined && frozenAt >= start && frozenAt <= end ? x(frozenAt) : null;

  // One hover stop per sample: on the CPU line, or on its observation dot.
  const stops = samples.map((s): [number, number] => [
    x(s.at),
    s.cpu !== undefined ? cpuY(s.cpu) : H - 16,
  ]);
  const card = (i: number): TipCard => {
    const s = samples[i]!;
    const up = s.interfaces.filter((f) => f.running).length;
    const prev = samples[i - 1];
    const delta = s.cpu !== undefined && prev?.cpu !== undefined ? s.cpu - prev.cpu : null;
    return {
      title: hhmm(s.at),
      sub: `Sample ${i + 1} of ${samples.length}`,
      led: s.reachable === true ? "ok" : s.reachable === false ? "bad" : "off",
      rows: [
        {
          label: "Management",
          value:
            s.reachable === true ? "Answered" : s.reachable === false ? "No answer" : "Not checked",
          color:
            s.reachable === true
              ? "var(--sig)"
              : s.reachable === false
                ? "var(--destructive)"
                : "var(--text-faint)",
        },
        {
          label: "CPU",
          value: s.cpu !== undefined ? `${s.cpu}%` : "Not read",
          color: "var(--brand)",
        },
        ...(s.memory !== undefined ? [{ label: "Memory", value: `${s.memory}%` }] : []),
        ...(s.interfaces.length
          ? [{ label: "Interfaces running", value: `${up} of ${s.interfaces.length}` }]
          : []),
        ...(s.gaps.length ? [{ label: "Missing", value: s.gaps.join(", ") }] : []),
      ],
      ...(delta !== null
        ? {
            foot: {
              label: "CPU vs the sample before",
              value: `${delta >= 0 ? "+" : ""}${delta} pts`,
              tone: delta > 0 ? ("up" as const) : ("down" as const),
            },
          }
        : {}),
    };
  };
  return (
    <div ref={root} className="flight-chart">
      <svg
        viewBox={`0 0 ${w} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${samples.length} management observations and available CPU samples`}
      >
        {[1, 2, 3].map((i) => {
          const y = 20 + ((H - 60) * i) / 4;
          return (
            <line key={i} x1={0} x2={w} y1={y} y2={y} stroke="var(--line)" strokeDasharray="2 5" />
          );
        })}
        {shade.map((g) => (
          <rect
            key={g.from}
            x={Math.max(0, x(g.from) - step / 2)}
            y={10}
            width={Math.max(step, x(g.to) - x(g.from) + step)}
            height={H - 40}
            fill="var(--bad-soft)"
          />
        ))}
        {fx !== null && (
          <>
            <line
              x1={fx}
              x2={fx}
              y1={6}
              y2={H - 30}
              stroke="var(--warning)"
              strokeDasharray="3 3"
            />
            <text x={fx + 6} y={18} fontSize={11} fill="var(--warning)">
              frozen {hhmm(frozenAt!)}
            </text>
          </>
        )}
        {lines.map((d) => (
          <path key={d} d={d} data-draw="" fill="none" stroke="var(--brand)" strokeWidth={2} />
        ))}
        {samples.map((s) =>
          s.reachable === true ? (
            <circle key={s.at} cx={x(s.at)} cy={H - 16} r={3} fill="var(--sig)" opacity={0.85} />
          ) : s.reachable === false ? (
            <circle key={s.at} cx={x(s.at)} cy={H - 16} r={3.5} fill="var(--destructive)" />
          ) : (
            <circle
              key={s.at}
              cx={x(s.at)}
              cy={H - 16}
              r={3}
              fill="none"
              stroke="var(--text-faint)"
            />
          ),
        )}
        {stops.length > 0 && (
          <LineHover
            width={w}
            height={H}
            points={stops}
            card={card}
            label="CPU and management answers over time. Use the arrow keys to read each sample."
            band={Math.max(8, Math.min(32, step))}
            color="var(--brand)"
          />
        )}
      </svg>
      <div className="flight-axis">
        {ticks.map((t) => (
          <span key={t}>{hhmm(t)}</span>
        ))}
      </div>
    </div>
  );
}
