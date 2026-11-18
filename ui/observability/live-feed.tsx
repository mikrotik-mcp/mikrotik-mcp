/**
 * Live Feed pieces from the Live Feed boards: the "Live" heading with its LED,
 * the status line, the calls-per-minute strip, the phone filter toggle and the
 * phone call list. main.tsx keeps the feed state and the table.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { ListFilter } from "lucide-react";
import { num } from "./format";
import { formatMs, MonitorButton, MonitorPanel, RiskBadge, StatusDot } from "./monitoring-ui";
import type { ToolEvent } from "./types";
import "./live-feed.css";

const REDUCE = "(prefers-reduced-motion: reduce)";
const PHONE = "(max-width: 639px)";

function subscribePhone(onChange: () => void): () => void {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True at phone width (639px and under), where the phone board applies. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/** Renders `phone` at phone width and `children` everywhere else. */
export function PhoneSwitch({
  phone,
  children,
}: {
  phone: ReactNode;
  children: ReactNode;
}): ReactNode {
  return usePhone() ? phone : children;
}

/** "Live" with a pulsing LED; "Paused" or "Offline" when the stream is not live. */
export function LiveHeading({ offline, paused }: { offline: boolean; paused: boolean }): ReactNode {
  return (
    <span className="live-feed-heading">
      {offline ? "Offline" : paused ? "Paused" : "Live"}
      <StatusDot
        tone={offline ? "default" : paused ? "warn" : "good"}
        pulse={!offline && !paused}
      />
    </span>
  );
}

/** "1,284 calls in memory · 3 failed". */
export function FeedStatusLine({
  events,
  offline,
}: {
  events: ToolEvent[];
  offline: boolean;
}): ReactNode {
  const failed = events.reduce((n, e) => n + (e.isError ? 1 : 0), 0);
  // A fragment: the status line is a flex row, so its parts space out as on the board.
  return (
    <>
      <span className="font-mono text-[12px]/[21px]">{num(events.length)}</span>
      {` calls in memory${failed > 0 ? " · " : ""}`}
      {failed > 0 && <b>{num(failed)} failed</b>}
      {offline && <span>· reconnecting on its own; calls are still recorded</span>}
    </>
  );
}

const MINUTES = 30;
const MINUTE = 60_000;
const W = 1080;
const H = 56;
const GAP = 4;

/** The calls-per-minute strip: ok calls per minute for the last 30 minutes, failures stacked on top. */
export function CallsPerMinute({ events }: { events: ToolEvent[] }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const end = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  const start = end - MINUTES * MINUTE;
  const ok = Array.from({ length: MINUTES }, () => 0);
  const bad = Array.from({ length: MINUTES }, () => 0);
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    const i = Math.floor((e.ts - start) / MINUTE);
    if (e.isError) bad[i]++;
    else ok[i]++;
  }
  const max = Math.max(1, ...ok.map((v, i) => v + bad[i]));
  const bw = (W - GAP * (MINUTES - 1)) / MINUTES;
  const total = ok.reduce((a, b) => a + b, 0) + bad.reduce((a, b) => a + b, 0);

  const root = useRef<HTMLDivElement>(null);
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const bars = root.current?.querySelectorAll("rect[data-bar]");
      if (!bars?.length) return;
      animate(bars, {
        scaleY: [0, 1],
        duration: 600,
        delay: stagger(12),
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, []);

  return (
    <MonitorPanel
      className="live-feed-minutes"
      title="Calls per minute"
      extra={
        <span className="monitor-legend">
          <span>
            <i style={{ background: "var(--sig)" }} />
            ok
          </span>
          <span>
            <i style={{ background: "var(--destructive)" }} />
            failed
          </span>
          <span className="font-mono">last 30 min</span>
        </span>
      }
    >
      <div ref={root} className="pb-1.5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${num(total)} calls in the last 30 minutes`}
        >
          {[1, 2, 3].map((k) => (
            <line
              key={k}
              x1="0"
              x2={W}
              y1={(H * k) / 4}
              y2={(H * k) / 4}
              stroke="var(--line)"
              strokeDasharray="2 5"
            />
          ))}
          {ok.map((v, i) => {
            const x = i * (bw + GAP);
            const bh = (v / max) * (H - 14);
            const fails = bad[i];
            const fh = fails ? Math.max(5, (fails / max) * (H - 14)) : 0;
            return (
              <g key={i}>
                {bh > 0 && (
                  <rect
                    data-bar=""
                    x={x}
                    y={H - bh}
                    width={bw}
                    height={bh}
                    rx="3"
                    fill="var(--sig)"
                    opacity=".85"
                    style={{ transformOrigin: `0 ${H}px` }}
                  />
                )}
                {fh > 0 && (
                  <rect
                    data-bar=""
                    x={x}
                    y={H - bh - fh - 2}
                    width={bw}
                    height={fh}
                    rx="3"
                    fill="var(--destructive)"
                    style={{ transformOrigin: `0 ${H}px` }}
                  >
                    <title>{`${fails} failed`}</title>
                  </rect>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </MonitorPanel>
  );
}

/**
 * The tool, risk and device selects. On a phone they hide behind a Filters
 * button, as on the phone board; elsewhere they sit in the filter row.
 */
export function FeedFilterSelects({
  children,
  segmented,
}: {
  children: ReactNode;
  segmented: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="live-feed-selects" data-open={open || undefined}>
        {children}
      </span>
      <span className="live-feed-seg">{segmented}</span>
      <MonitorButton
        size="sm"
        className="live-feed-toggle"
        icon={<ListFilter />}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Filters
      </MonitorButton>
    </>
  );
}

/** The phone call list: tool and LED, then time · device · error; risk and duration on the right. */
export function FeedPhoneRows({
  rows,
  hhmm,
  onOpen,
}: {
  rows: ToolEvent[];
  hhmm: (ts: number) => string;
  onOpen: (e: ToolEvent) => void;
}): ReactNode {
  return (
    <div className="live-feed-phone-rows">
      {rows.map((e) => (
        <button
          key={e.id}
          type="button"
          className="monitor-row live-feed-phone-row"
          data-failed={e.isError || undefined}
          aria-label={`${e.tool}, ${e.isError ? "failed" : "ok"}, ${hhmm(e.ts)}`}
          onClick={() => onOpen(e)}
        >
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="flex min-w-0 items-center gap-2">
              <StatusDot tone={e.isError ? "bad" : "good"} />
              <span className="p truncate font-mono text-[12px]">{e.tool}</span>
            </span>
            <span className="text-muted-foreground truncate pl-[15px] text-[12px]">
              <span className="font-mono">{hhmm(e.ts)}</span> ·{" "}
              <span className="font-mono">{e.device ?? "—"}</span>
              {e.isError && (
                <>
                  {" "}
                  · <span className="text-destructive">{e.error ?? "Failed"}</span>
                </>
              )}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1">
            <RiskBadge risk={e.risk} short />
            <span className="text-muted-foreground text-[12px] tabular-nums">
              {formatMs(e.durationMs)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
