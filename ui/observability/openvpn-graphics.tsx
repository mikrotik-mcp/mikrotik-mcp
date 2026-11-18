/**
 * Graphics for the OpenVPN pages, after the Usr-OpenVPN boards: the user radar
 * beside the live header, the daily-starts bar chart and the share treemap on
 * the history page. Plain SVG and flex boxes coloured by tokens. Radar nodes
 * settle into place and hovering one dims the rest; bars grow in from the
 * left. Nothing moves with reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { EASE, tipProps } from "./kit";
import type { TipCard } from "./kit";

const REDUCE = "(prefers-reduced-motion: reduce)";

export type OvpnRadarStatus = "ok" | "warn";

const STATUS_COLOR: Record<OvpnRadarStatus | "faint", string> = {
  ok: "var(--sig)",
  warn: "var(--warning)",
  faint: "var(--text-faint)",
};

/** Angle in degrees and distance from the hub. The first five are the board's. */
const SLOTS: [number, number][] = [
  [-70, 118],
  [-20, 128],
  [50, 120],
  [140, 125],
  [210, 120],
  [95, 118],
  [-125, 120],
  [10, 80],
];

const RADAR_W = 420;
const RADAR_H = 300;

const short = (label: string) => (label.length > 14 ? `${label.slice(0, 13)}…` : label);

/** Hub-and-spoke map: OVPN in the middle, one node per connected user. */
export function OpenVpnRadar({
  nodes,
}: {
  nodes: { label: string; sessions: number; status: OvpnRadarStatus }[];
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = nodes.map((n) => n.label).join(",");
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate(".ovpn-radar-node", {
        opacity: [0, 1],
        scale: [0.6, 1],
        duration: 520,
        delay: stagger(70),
        ease: "outBack(1.4)",
      });
      animate(".ovpn-radar-spoke", { opacity: [0, 1], duration: 400, ease: "outQuad" });
    });
    return () => scope.current?.revert();
  }, [key]);

  const extra = nodes.length > SLOTS.length ? nodes.length - SLOTS.length + 1 : 0;
  const shown: {
    label: string;
    title: string;
    status: OvpnRadarStatus | "faint";
    card: TipCard;
  }[] = (extra ? nodes.slice(0, SLOTS.length - 1) : nodes).map((n) => ({
    label: n.sessions > 1 ? `${short(n.label)} ×${n.sessions}` : short(n.label),
    title: n.sessions > 1 ? `${n.label} · ${n.sessions} sessions` : n.label,
    status: n.status,
    card: {
      title: n.label,
      led: n.status === "warn" ? "warn" : "ok",
      rows: [
        { label: "Sessions", value: n.sessions.toLocaleString() },
        {
          label: "Traffic counters",
          value: n.status === "warn" ? "Not reported" : "Reported",
          color: STATUS_COLOR[n.status],
        },
      ],
    },
  }));
  if (extra) {
    const rest = nodes.slice(SLOTS.length - 1);
    shown.push({
      label: `+${extra} more`,
      title: `${extra} more users`,
      status: "faint",
      card: {
        title: `${extra} more users`,
        rows: [
          {
            label: "Sessions",
            value: rest.reduce((sum, n) => sum + n.sessions, 0).toLocaleString(),
          },
        ],
      },
    });
  }
  const cx = RADAR_W / 2;
  const cy = RADAR_H / 2;
  const placed = shown.map((n, i) => {
    const [deg, dist] = SLOTS[i];
    const a = (deg * Math.PI) / 180;
    return {
      ...n,
      x: Math.round((cx + dist * Math.cos(a)) * 10) / 10,
      y: Math.round((cy + dist * Math.sin(a)) * 10) / 10,
    };
  });
  return (
    <svg
      ref={root}
      className="ovpn-radar kit-tips"
      viewBox={`0 0 ${RADAR_W} ${RADAR_H}`}
      width="100%"
      height={RADAR_H}
      role="img"
      aria-label={`Connected OpenVPN users: ${shown.map((n) => n.title).join(", ") || "none"}`}
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
          className="ovpn-radar-spoke"
          x1={cx}
          y1={cy}
          x2={n.x}
          y2={n.y}
          stroke={STATUS_COLOR[n.status]}
          strokeOpacity={0.55}
          strokeWidth={1.5}
          strokeDasharray={n.status === "faint" ? "4 4" : undefined}
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
        OVPN
      </text>
      {placed.map((n) => (
        <g
          key={n.label}
          className="ovpn-radar-node"
          style={{ transformOrigin: `${n.x}px ${n.y}px` }}
          {...tipProps(n.card)}
        >
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

const BAR_W = 1080;
const BAR_H = 200;
const BAR_GAP = 3;

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Daily starts as bars, three dashed guides, seven date labels under it. */
export function OpenVpnBars({ days }: { days: { day: string; count: number }[] }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const scope = useRef<Scope | null>(null);
  const key = days.map((d) => `${d.day}:${d.count}`).join(",");
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate(".ovpn-bar", {
        scaleY: [0, 1],
        duration: 420,
        delay: stagger(6),
        ease: EASE.enter,
      });
    });
    return () => scope.current?.revert();
  }, [key]);

  const n = days.length;
  const max = Math.max(1, ...days.map((d) => d.count));
  const bw = n ? (BAR_W - BAR_GAP * (n - 1)) / n : 0;
  const labelCount = Math.min(7, n);
  const labels =
    labelCount < 2
      ? days.map((d) => d.day)
      : Array.from(
          { length: labelCount },
          (_, i) => days[Math.round((i * (n - 1)) / (labelCount - 1))].day,
        );
  return (
    <div ref={root}>
      <svg
        viewBox={`0 0 ${BAR_W} ${BAR_H}`}
        width="100%"
        height={BAR_H}
        preserveAspectRatio="none"
        className="kit-tips"
        role="img"
        aria-label={`Daily connection starts, ${days[0]?.day ?? ""} to ${days[n - 1]?.day ?? ""}, up to ${max} a day`}
      >
        {[1, 2, 3].map((i) => (
          <line
            key={i}
            x1={0}
            x2={BAR_W}
            y1={(BAR_H * i) / 4}
            y2={(BAR_H * i) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {days.map((d, i) => {
          const h = (d.count / max) * (BAR_H - 14);
          const x = i * (bw + BAR_GAP);
          return (
            <rect
              key={d.day}
              className="ovpn-bar"
              x={x}
              y={BAR_H - h}
              width={bw}
              height={h}
              rx={3}
              fill="var(--brand)"
              opacity={0.85}
              style={{ transformOrigin: `${x}px ${BAR_H}px` }}
              {...tipProps((): TipCard => {
                const prev = i > 0 ? d.count - days[i - 1]!.count : null;
                return {
                  title: dayLabel(d.day),
                  sub: d.day,
                  rows: [
                    {
                      label: "Connections started",
                      value: d.count.toLocaleString(),
                      color: "var(--brand)",
                    },
                    { label: "Busiest day", value: max.toLocaleString() },
                  ],
                  ...(prev != null
                    ? {
                        foot: {
                          label: "vs the day before",
                          value: `${prev >= 0 ? "+" : ""}${prev.toLocaleString()}`,
                          tone: prev >= 0 ? ("up" as const) : ("down" as const),
                        },
                      }
                    : {}),
                };
              })}
            />
          );
        })}
      </svg>
      <div className="ovpn-bar-labels">
        {labels.map((day, i) => (
          <span key={`${day}-${i}`}>{dayLabel(day)}</span>
        ))}
      </div>
    </div>
  );
}

export interface TreemapTile {
  name: string;
  detail: string;
  value: number;
}

/**
 * The board's two-row treemap: the three largest groups on top, the rest
 * below. Each tile's width is its share of the row.
 */
export function OpenVpnTreemap({
  tiles,
  total,
  percent,
}: {
  tiles: TreemapTile[];
  total: number;
  percent: (value: number, total: number) => number;
}): ReactNode {
  const rows = [tiles.slice(0, 3), tiles.slice(3)].filter((row) => row.length);
  const tone = (tile: TreemapTile, index: number) =>
    tile.name === "Other" && tile.detail === "Beyond the top 20"
      ? "other"
      : index < 2
        ? "sig"
        : index === 2
          ? "acc"
          : "rest";
  return (
    <div className="ovpn-treemap kit-tips" role="list" aria-label="Share of connections">
      {rows.map((row, r) => (
        <div key={r} className="ovpn-treemap-row" data-row={r}>
          {row.map((tile, i) => {
            const index = r * 3 + i;
            const share = percent(tile.value, total);
            return (
              <div
                key={`${tile.name}-${index}`}
                role="listitem"
                className="ovpn-treemap-tile"
                data-tone={tone(tile, index)}
                style={{ flexGrow: Math.max(1, tile.value) }}
                {...tipProps({
                  title: tile.name,
                  sub: tile.detail && tile.detail !== tile.name ? tile.detail : undefined,
                  rows: [
                    { label: "Connections", value: tile.value.toLocaleString() },
                    { label: "Share", value: `${share}%` },
                    { label: "All connections", value: total.toLocaleString() },
                  ],
                })}
              >
                <span className="ovpn-treemap-name">{tile.name}</span>
                <span className="ovpn-treemap-n">
                  {tile.value.toLocaleString()} · {share}%
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
