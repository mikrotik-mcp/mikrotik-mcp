/**
 * The Snapshots page's "Last 7 days" graphic: one lane per router, a dot per
 * snapshot on a 7-day axis. When two snapshots are being compared, both get a
 * ring (from blue, to teal) and a dashed line joins them. Dots settle into
 * place on load; nothing moves with reduced motion.
 */
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { tipProps } from "./kit";
import type { TipCard } from "./kit";

const REDUCE = "(prefers-reduced-motion: reduce)";
const DAY = 86_400_000;
const W = 1060;
const LANE = 34;
const LX = 130;
const SPAN = W - LX - 20;

export interface TimelineSnap {
  id: string;
  device: string;
  ts: number;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function SnapshotTimeline({
  snaps,
  from,
  to,
  now: nowProp,
}: {
  snaps: TimelineSnap[];
  from?: string;
  to?: string;
  now?: number;
}): ReactNode {
  // The axis ends when the page opened; a refresh remounts the chart.
  const [now] = useState(() => nowProp ?? Date.now());
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  // The axis: seven days back from the start of today, to now.
  const start = startOfDay(now) - 7 * DAY;
  const x = (ts: number): number =>
    LX + Math.max(0, Math.min(1, (ts - start) / (now - start))) * SPAN;
  const recent = snaps.filter((s) => s.ts >= start);
  const devices = [...new Set(snaps.map((s) => s.device))];
  const lane = (device: string): number => 18 + devices.indexOf(device) * LANE;
  const h = 18 + devices.length * LANE;
  const pick = (id?: string): TimelineSnap | undefined => recent.find((s) => s.id === id);
  const a = pick(from);
  const b = pick(to);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia?.(REDUCE).matches) return;
    scope.current = createScope({ root: el }).add(() => {
      animate("[data-dot]", {
        opacity: [0, 1],
        scale: [0.4, 1],
        duration: 360,
        delay: stagger(30),
        ease: "outBack(1.6)",
      });
    });
    return () => scope.current?.revert();
  }, [snaps.length]);

  /** "3 h", "2 d 4 h": the time between two snapshots. */
  const gap = (ms: number): string => {
    const hours = Math.round(Math.abs(ms) / 3_600_000);
    if (hours < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 60_000))} min`;
    if (hours < 24) return `${hours} h`;
    return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
  };
  const card = (snap: TimelineSnap): TipCard => {
    const prev = recent
      .filter((o) => o.device === snap.device && o.ts < snap.ts)
      .reduce<TimelineSnap | undefined>(
        (best, o) => (!best || o.ts > best.ts ? o : best),
        undefined,
      );
    const role = snap.id === a?.id ? "From" : snap.id === b?.id ? "To" : null;
    return {
      title: snap.device,
      sub: new Date(snap.ts).toLocaleDateString([], { month: "short", day: "numeric" }),
      led: role ? "acc" : "ok",
      rows: [
        { label: "Taken", value: new Date(snap.ts).toLocaleString() },
        { label: "Snapshot", value: snap.id },
        ...(role
          ? [
              {
                label: "In compare",
                value: role,
                color: role === "From" ? "var(--brand)" : "var(--sig)",
              },
            ]
          : []),
      ],
      ...(prev
        ? { foot: { label: "After the snapshot before", value: gap(snap.ts - prev.ts) } }
        : {}),
    };
  };

  const ticks = Array.from({ length: 8 }, (_, j) => {
    const t = startOfDay(now) - (7 - j) * DAY;
    const label =
      j === 7 ? "today" : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
    return { x: LX + (j / 7) * SPAN, label };
  });

  return (
    <svg
      ref={root}
      viewBox={`0 0 ${W} ${h + 14}`}
      width="100%"
      height={h + 14}
      role="img"
      aria-label="Snapshots over the last week"
      preserveAspectRatio="xMinYMid meet"
      className="kit-tips"
    >
      {devices.map((d) => (
        <g key={d}>
          <text
            x="0"
            y={lane(d) + 4}
            fontSize="11"
            fontFamily="var(--font-mt)"
            fill="var(--text-secondary)"
          >
            {d}
          </text>
          <line
            x1={LX}
            x2={W - 10}
            y1={lane(d)}
            y2={lane(d)}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        </g>
      ))}
      {recent.map((s) => {
        const hi = s.id === a?.id || s.id === b?.id;
        const cx = x(s.ts);
        const cy = lane(s.device);
        return (
          <g key={s.id} {...tipProps(() => card(s))}>
            {hi && (
              <circle
                cx={cx}
                cy={cy}
                r="11"
                fill="none"
                stroke={s.id === a?.id ? "var(--brand)" : "var(--sig)"}
                strokeWidth="1.5"
              />
            )}
            <circle
              data-dot
              cx={cx}
              cy={cy}
              r={hi ? 6 : 4.5}
              fill="var(--sig)"
              style={{ transformOrigin: `${cx}px ${cy}px` }}
            />
          </g>
        );
      })}
      {a && b && (
        <path
          d={`M${x(a.ts) + 12},${lane(a.device)} C${(x(a.ts) + x(b.ts)) / 2},${lane(a.device) - 16} ${(x(a.ts) + x(b.ts)) / 2},${lane(b.device) - 16} ${x(b.ts) - 12},${lane(b.device)}`}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          {...tipProps((): TipCard => ({
            title: `${a.device} → ${b.device}`,
            sub: "compare",
            rows: [
              { label: "From", value: new Date(a.ts).toLocaleString(), color: "var(--brand)" },
              { label: "To", value: new Date(b.ts).toLocaleString(), color: "var(--sig)" },
            ],
            foot: { label: "Time between", value: gap(b.ts - a.ts) },
          }))}
        />
      )}
      {ticks.map((t) => (
        <text
          key={t.label}
          x={t.x}
          y={h + 8}
          fontSize="10"
          fill="var(--text-faint)"
          textAnchor="middle"
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}
