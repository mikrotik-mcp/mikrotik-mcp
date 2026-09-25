/**
 * Reusable usage visualisations for the persisted history:
 *   • {@link UsageHistoryChart} — a per-day download/upload area chart over a
 *     window (3 months by default), used by both the Clients and User Manager
 *     pages. Missing days are filled with zero so the time axis stays continuous.
 *   • {@link Heatmap} — a GitHub-profile-style contribution calendar of per-day
 *     counts (User Manager VPN connections per user), 53 weeks ending today.
 *
 * Both fetch their own data from a passed `endpoint` and render hand-rolled SVG
 * (no chart dependency, so the bundle still inlines to one self-contained HTML).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { api } from "./api";
import { bytes } from "./format";

const SVG_NS = "http://www.w3.org/2000/svg";
const DAY_MS = 86_400_000;

interface DailyUsage {
  day: string;
  rx: number;
  tx: number;
}
interface UsagePayload {
  series: DailyUsage[];
  totalRx: number;
  totalTx: number;
}
interface DayCount {
  day: string;
  count: number;
}
interface HeatmapPayload {
  days: DayCount[];
  total: number;
  max: number;
}

/** UTC `YYYY-MM-DD` for an epoch-ms instant. */
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** UTC midnight ms for "today". */
function todayUtc(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
/** Friendly full date for a `YYYY-MM-DD` UTC day, e.g. "Mon, Jan 6 2026". */
function fmtFullDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── per-day download/upload area chart ───────────────────────────────────────
export function UsageHistoryChart({
  endpoint,
  days = 90,
}: {
  endpoint: string;
  days?: number;
}): ReactNode {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    setData(null);
    setLoading(true);
    const refresh = (): void => {
      void api<UsagePayload>(endpoint, abort.signal)
        .then((d) => {
          if (alive) {
            setData(d);
            setError(false);
          }
        })
        .catch(() => {
          if (alive) {
            setData(null);
            setError(true);
          }
        })
        .finally(() => {
          if (alive) {
            setLoading(false);
            timer = setTimeout(refresh, 30_000);
          }
        });
    };
    refresh();
    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);

  // Fill the full window with zeros so gaps don't compress the axis.
  const filled = useMemo(() => {
    const map = new Map((data?.series ?? []).map((d) => [d.day, d]));
    const end = todayUtc();
    const out: DailyUsage[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(end - i * DAY_MS);
      const hit = map.get(k);
      out.push(hit ?? { day: k, rx: 0, tx: 0 });
    }
    return out;
  }, [data, days]);

  if (loading)
    return <div className="px-1 py-4 text-[12.5px] text-muted-foreground">loading usage…</div>;
  if (error)
    return (
      <div role="status" className="px-1 py-4 text-[12.5px] text-destructive">
        Could not load usage history. Retrying automatically.
      </div>
    );
  const hasData = (data?.series.length ?? 0) > 0;
  if (!hasData) {
    return (
      <div className="px-1 py-4 text-[12.5px] text-muted-foreground">
        No measured history yet. Client history needs two samples from an existing per-device
        counter (normally one minute apart). This chart refreshes automatically. Past usage before
        recording began cannot be reconstructed; retention is about three months.
      </div>
    );
  }

  const W = 640;
  const H = 150;
  const pad = 8;
  const peak = Math.max(0, ...filled.flatMap((d) => [d.rx, d.tx]));
  const max = Math.max(1, peak);
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / Math.max(1, filled.length - 1);
  const y = (v: number): number => H - pad - (v / max) * (H - 2 * pad);
  const path = (pick: (d: DailyUsage) => number): string =>
    filled.map((d, i) => `${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");
  const area = (pick: (d: DailyUsage) => number): string => {
    const first = x(0).toFixed(1);
    const last = x(filled.length - 1).toFixed(1);
    return `${first},${(H - pad).toFixed(1)} ${path(pick)} ${last},${(H - pad).toFixed(1)}`;
  };

  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-3.5 text-xs tabular-nums">
        <span className="font-semibold text-chart-3">↓ {bytes(data?.totalRx ?? 0)} down</span>
        <span className="font-semibold text-chart-4">↑ {bytes(data?.totalTx ?? 0)} up</span>
        <span className="text-[11px] text-muted-foreground">
          · peak/day {bytes(peak)} · last {days} days · {data?.series.length ?? 0} recorded days
        </span>
      </div>
      <svg
        className="block h-40 w-full rounded-md border border-border bg-card"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        xmlns={SVG_NS}
        role="img"
        aria-label="Recorded daily download and upload usage"
      >
        <polygon className="fill-chart-3/20" points={area((d) => d.rx)} />
        <polygon className="fill-chart-4/15" points={area((d) => d.tx)} />
        <polyline
          className="fill-none stroke-chart-3 stroke-2 [vector-effect:non-scaling-stroke]"
          points={path((d) => d.rx)}
        />
        <polyline
          className="fill-none stroke-chart-4 stroke-2 [vector-effect:non-scaling-stroke]"
          points={path((d) => d.tx)}
        />
      </svg>
    </div>
  );
}

// ── GitHub-style contribution heatmap ────────────────────────────────────────
const WEEKS = 53;
const CELL = 12;
const GAP = 3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Contribution-level fill, indexed by level 0–4 (built from the shared tokens). */
const HEAT = [
  "var(--muted)",
  "color-mix(in srgb, var(--chart-3) 30%, var(--muted))",
  "color-mix(in srgb, var(--chart-3) 50%, var(--muted))",
  "color-mix(in srgb, var(--chart-3) 72%, transparent)",
  "var(--chart-3)",
];

interface Cell {
  day: string;
  count: number;
  col: number;
  row: number;
  ms: number;
}

interface Tip {
  left: number;
  top: number;
  day: string;
  count: number;
  lvl: number;
}

export function Heatmap({ endpoint, label }: { endpoint: string; label?: string }): ReactNode {
  const [data, setData] = useState<HeatmapPayload | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void api<HeatmapPayload>(endpoint)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setData({ days: [], total: 0, max: 0 });
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);

  const { cells, monthLabels } = useMemo(() => {
    const counts = new Map((data?.days ?? []).map((d) => [d.day, d.count]));
    const end = todayUtc();
    const endRow = new Date(end).getUTCDay();
    // First (leftmost) column starts on the Sunday (WEEKS-1) weeks before the
    // Sunday of the current week, so the grid ends on today's column.
    const firstSunday = end - (endRow + (WEEKS - 1) * 7) * DAY_MS;
    const cs: Cell[] = [];
    const labels: { col: number; text: string }[] = [];
    let lastMonth = -1;
    for (let i = 0; i < WEEKS * 7; i++) {
      const ms = firstSunday + i * DAY_MS;
      if (ms > end) break;
      const col = Math.floor(i / 7);
      const row = new Date(ms).getUTCDay();
      const day = dayKey(ms);
      cs.push({ day, count: counts.get(day) ?? 0, col, row, ms });
      if (row === 0) {
        const month = new Date(ms).getUTCMonth();
        if (month !== lastMonth) {
          labels.push({ col, text: MONTHS[month] });
          lastMonth = month;
        }
      }
    }
    return { cells: cs, monthLabels: labels };
  }, [data]);

  const max = Math.max(1, data?.max ?? 1);
  const level = (count: number): number => {
    if (count <= 0) return 0;
    return Math.min(4, Math.ceil((count / max) * 4));
  };

  const gridW = WEEKS * (CELL + GAP);
  const leftPad = 28;
  const topPad = 16;
  const H = topPad + 7 * (CELL + GAP);

  // Position the custom tooltip above the hovered cell, in coordinates local to
  // the wrapper (so it survives the grid being horizontally scrolled).
  const onEnter = (e: ReactMouseEvent<SVGRectElement>, c: Cell): void => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cell = e.currentTarget.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    setTip({
      left: cell.left - box.left + cell.width / 2,
      top: cell.top - box.top,
      day: c.day,
      count: c.count,
      lvl: level(c.count),
    });
  };

  return (
    <div className="relative" ref={wrapRef}>
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <span className="text-[12.5px] font-semibold">{label ?? "Connections"}</span>
        <span className="text-[11px] text-muted-foreground">
          {data ? `${data.total} total` : "…"}
        </span>
      </div>
      <div className="overflow-x-auto pb-1" onMouseLeave={() => setTip(null)}>
        <svg
          className="block"
          viewBox={`0 0 ${leftPad + gridW} ${H}`}
          width={leftPad + gridW}
          height={H}
          xmlns={SVG_NS}
          role="img"
        >
          {monthLabels.map((m) => (
            <text
              key={`${m.col}-${m.text}`}
              className="fill-muted-foreground text-[9px]"
              x={leftPad + m.col * (CELL + GAP)}
              y={11}
            >
              {m.text}
            </text>
          ))}
          {["Mon", "Wed", "Fri"].map((d, i) => (
            <text
              key={d}
              className="fill-muted-foreground text-[9px]"
              x={0}
              y={topPad + (i * 2 + 1) * (CELL + GAP) + CELL - 2}
            >
              {d}
            </text>
          ))}
          {cells.map((c) => (
            <rect
              key={c.day}
              className={`cursor-pointer stroke-1 [transition:stroke_0.1s_ease] ${
                tip?.day === c.day ? "stroke-foreground stroke-[1.5px]" : "stroke-border/60"
              }`}
              style={{ fill: HEAT[level(c.count)] }}
              x={leftPad + c.col * (CELL + GAP)}
              y={topPad + c.row * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
              onMouseEnter={(e) => onEnter(e, c)}
            />
          ))}
        </svg>
      </div>
      {tip && (
        <div
          className="pointer-events-none absolute z-30 min-w-[150px] -translate-x-1/2 translate-y-[calc(-100%-9px)] rounded-[10px] border border-chart-3/35 bg-popover px-2.5 py-2 shadow-xl"
          style={{ left: tip.left, top: tip.top }}
          role="tooltip"
        >
          <span className="absolute -bottom-1.5 left-1/2 size-[11px] -translate-x-1/2 rotate-45 border-r border-b border-chart-3/35 bg-popover" />
          <div className="flex items-center gap-1.5 text-[13px]">
            <span
              className="inline-block size-[12px] rounded-[2px]"
              style={{ background: HEAT[tip.lvl] }}
            />
            <b className="font-semibold">
              {tip.count === 0
                ? "No connections"
                : `${tip.count} connection${tip.count === 1 ? "" : "s"}`}
            </b>
          </div>
          <div className="mt-[3px] text-[11.5px] text-muted-foreground tabular-nums">
            {fmtFullDate(tip.day)}
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <span
            key={l}
            className="inline-block size-[11px] rounded-[2px]"
            style={{ background: HEAT[l] }}
          />
        ))}
        More
      </div>
    </div>
  );
}
