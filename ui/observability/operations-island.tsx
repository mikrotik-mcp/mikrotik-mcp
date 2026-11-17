import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { animate, createScope, svg } from "animejs";
import {
  islandAge,
  islandCompletedAt,
  islandDeviceState,
  islandRecentEvents,
  islandSignal,
  isFreshSample,
} from "./operations-island-model";
import { ms, num } from "./format";
import type { DevicesPayload, LiveMode, SSHPoolPayload, Stats, ToolEvent } from "./types";
import type { ViewId } from "./navigation";
import { REDUCE_MOTION } from "./dashboard-shell";
import "./operations-island.css";

interface OperationsIslandProps {
  mode: LiveMode;
  paused: boolean;
  liveEvent: ToolEvent | null;
  liveEventAt: number | null;
  events: ToolEvent[];
  stats: Stats | null;
  statsAt: number | null;
  devices: DevicesPayload | null;
  pool: SSHPoolPayload | null;
  poolAt: number | null;
  alerts: number | null;
  alertsAt: number | null;
  onNavigate: (page: ViewId) => void;
  onEvent: (event: ToolEvent) => void;
  /** Phone header: dot and "Live" only. */
  compact?: boolean;
}

type Tab = "pulse" | "fleet" | "activity";
const TABS: { id: Tab; label: string }[] = [
  { id: "pulse", label: "Pulse" },
  { id: "fleet", label: "Routers" },
  { id: "activity", label: "Activity" },
];

const TONE: Record<ReturnType<typeof islandSignal>["kind"], string> = {
  offline: "off",
  paused: "warn",
  error: "bad",
  alerts: "warn",
  busy: "ok",
  completed: "ok",
  listening: "ok",
};

function hhmm(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The header's Live capsule and the Operations panel it opens. Display only: it
 * reads the existing stream and cached polls and never sends a request.
 */
export function OperationsIsland(props: OperationsIslandProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("pulse");
  const [tick, setNow] = useState(Date.now);
  // Receipt times are local, not device clocks. A poll may arrive between ticks.
  const now = Math.max(
    tick,
    props.statsAt ?? 0,
    props.poolAt ?? 0,
    props.alertsAt ?? 0,
    props.liveEventAt ?? 0,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1000);
    const refresh = () => setNow(Date.now());
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      if (returnFocus.current) capsuleRef.current?.focus({ preventScroll: true });
      returnFocus.current = false;
      return;
    }
    panelRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const signal = islandSignal({ ...props, now });
  const connected = props.mode !== "off" && !props.paused;
  const statsFresh = connected && isFreshSample(props.statsAt, now);
  const events = useMemo(() => islandRecentEvents(props.events, now), [props.events, now]);
  const devices = props.devices?.devices ?? [];
  const reachable = devices.filter(
    (device) => islandDeviceState(device, now, connected) === "reachable",
  ).length;
  const series =
    props.stats?.series
      .filter(
        (bucket) =>
          Number.isFinite(bucket.ok) &&
          Number.isFinite(bucket.error) &&
          bucket.ok >= 0 &&
          bucket.error >= 0,
      )
      .slice(-18) ?? [];
  const ceiling = Math.max(1, ...series.map((bucket) => bucket.ok + bucket.error));
  const total = series.reduce((sum, bucket) => sum + bucket.ok + bucket.error, 0);
  const failed = series.reduce((sum, bucket) => sum + bucket.error, 0);
  const bucketMs = series.length > 1 ? series[1].t - series[0].t : 0;
  const minutes = bucketMs > 0 ? Math.round((bucketMs * series.length) / 60_000) : null;
  const perMinute =
    props.stats && Number.isFinite(props.stats.callsPerMin)
      ? `${num(Math.round(props.stats.callsPerMin))} calls/min`
      : "— calls/min";
  const sparkKey = series.map((bucket) => bucket.ok + bucket.error).join(",");

  // The capsule dot breathes and its sparkline draws in when data changes.
  useEffect(() => {
    const scope = createScope({ root: rootRef, mediaQueries: { reduceMotion: REDUCE_MOTION } }).add(
      (self) => {
        if (self?.matches.reduceMotion) return;
        animate('.cap .shell-dot[data-tone="ok"]', {
          opacity: [1, 0.45, 1],
          duration: 2400,
          loop: true,
          ease: "inOutSine",
        });
        const line = rootRef.current?.querySelector<SVGPolylineElement>(".cap .sp polyline");
        if (line)
          animate(svg.createDrawable(line), {
            draw: ["0 0", "0 1"],
            duration: 600,
            ease: "outQuart",
          });
      },
    );
    return () => scope.revert();
  }, [sparkKey, signal.kind, props.compact]);

  // The panel grows out of the capsule.
  useLayoutEffect(() => {
    if (!open) return;
    const scope = createScope({ root: rootRef, mediaQueries: { reduceMotion: REDUCE_MOTION } }).add(
      (self) => {
        if (self?.matches.reduceMotion) return;
        animate(".pop", { opacity: [0, 1], scale: [0.96, 1], duration: 180, ease: "outQuart" });
      },
    );
    return () => scope.revert();
  }, [open]);

  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  const navigate = (page: ViewId) => {
    setOpen(false);
    props.onNavigate(page);
  };
  const onTabKey = (event: ReactKeyboardEvent): void => {
    const index = TABS.findIndex((item) => item.id === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].id);
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>(`#ops-tab-${TABS[next].id}`)?.focus(),
    );
  };

  const spark = (() => {
    if (series.length < 2) return null;
    const w = 44;
    const h = 14;
    const step = w / (series.length - 1);
    const points = series
      .map((bucket, index) => {
        const value = (bucket.ok + bucket.error) / ceiling;
        return `${(index * step).toFixed(1)},${(h - 1 - value * (h - 2)).toFixed(1)}`;
      })
      .join(" ");
    return (
      <svg className="sp" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <polyline points={points} />
      </svg>
    );
  })();

  const latest = (count: number) =>
    events.slice(0, count).map((event) => (
      <button
        key={event.id}
        type="button"
        className="isl-row"
        onClick={() => {
          setOpen(false);
          props.onEvent(event);
        }}
      >
        <span className="shell-dot" data-tone={event.isError ? "bad" : "ok"} aria-hidden="true" />
        <span className="isl-tool">{event.tool}</span>
        <span className="sr-only">{event.isError ? "failed" : "completed"}</span>
        <span className="r">
          {event.device ?? "Server"} · {hhmm(islandCompletedAt(event))}
        </span>
      </button>
    ));

  return (
    <div
      ref={rootRef}
      className="isl"
      data-signal={signal.kind}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {signal.label}
      </span>
      <button
        ref={capsuleRef}
        type="button"
        className={open ? "cap open" : "cap"}
        data-compact={props.compact || undefined}
        aria-label={`Open operations panel: ${signal.label}`}
        aria-expanded={open}
        aria-controls="operations-island-panel"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="shell-dot" data-tone={TONE[signal.kind]} aria-hidden="true" />
        <b>{props.mode === "off" ? "Offline" : props.paused ? "Paused" : "Live"}</b>
        {!props.compact && (
          <>
            {props.mode !== "off" && <span className="mut">{props.mode.toUpperCase()}</span>}
            {spark}
            <span className="num mut">{perMinute}</span>
            {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          id="operations-island-panel"
          className="pop"
          role="dialog"
          aria-label="Operations pulse"
        >
          <div className="isl-head">
            <span className="shell-dot" data-tone={TONE[signal.kind]} aria-hidden="true" />
            <b>{signal.label}</b>
            <span className="mut">
              · {signal.count != null ? `${num(signal.count)} · ` : ""}
              {signal.detail}
            </span>
          </div>
          <div className="seg isl-tabs" role="tablist" aria-label="Operations views">
            {TABS.map((item) => (
              <button
                key={item.id}
                id={`ops-tab-${item.id}`}
                type="button"
                role="tab"
                className={tab === item.id ? "on" : undefined}
                aria-selected={tab === item.id}
                aria-controls={`isl-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={onTabKey}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div
            id={`isl-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`ops-tab-${tab}`}
            className="isl-panel"
          >
            {tab === "pulse" && (
              <>
                <div className="isl-chart" data-stale={!statsFresh}>
                  <div className="isl-total">
                    <span className="num">{props.stats ? num(total) : "—"}</span>
                    <span className="mut">
                      {minutes != null
                        ? `calls in the last ${minutes} minutes · ${num(failed)} failed`
                        : props.stats
                          ? `calls · ${num(failed)} failed`
                          : "Waiting for recorded activity"}
                    </span>
                  </div>
                  {total > 0 ? (
                    <svg
                      viewBox="0 0 340 72"
                      width="100%"
                      height="72"
                      role="img"
                      aria-label={`Calls per bucket${minutes != null ? `, last ${minutes} minutes` : ""}`}
                    >
                      {series.map((bucket, index) => {
                        const height = Math.round(((bucket.ok + bucket.error) / ceiling) * 64);
                        const x = index * 19;
                        return (
                          <g key={bucket.t}>
                            <rect
                              className="isl-bar"
                              x={x}
                              y={72 - height}
                              width="13"
                              height={height}
                              rx="2"
                            />
                            {bucket.error > 0 && (
                              <rect
                                className="isl-fail"
                                x={x}
                                y={72 - height - 8}
                                width="13"
                                height="6"
                                rx="2"
                              />
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  ) : (
                    <p className="isl-empty">
                      {props.stats ? "No calls in this window" : "Waiting for recorded activity"}
                    </p>
                  )}
                </div>
                <div className="isl-list">
                  <span className="label">Latest calls</span>
                  {events.length ? (
                    latest(3)
                  ) : (
                    <p className="isl-empty">
                      No recorded calls yet. Activity appears when MCP tools complete.
                    </p>
                  )}
                </div>
              </>
            )}
            {tab === "fleet" && (
              <div className="isl-list" data-first>
                <span className="label">
                  Last router checks ·{" "}
                  {props.devices
                    ? `${reachable} / ${devices.filter((device) => !device.disabled).length} reachable`
                    : "Not loaded"}
                </span>
                {devices.length ? (
                  devices.map((device) => {
                    const state = islandDeviceState(device, now, connected);
                    return (
                      <div key={device.name} className="isl-row" data-state={state}>
                        <span
                          className="shell-dot"
                          data-tone={
                            state === "reachable" ? "ok" : state === "unreachable" ? "bad" : "off"
                          }
                          aria-hidden="true"
                        />
                        <span className="isl-tool">{device.name}</span>
                        <span className="r">
                          {state === "unknown" ? "Unknown / stale" : state} ·{" "}
                          {islandAge(device.status.checkedAt, now)}
                          {state === "reachable" && device.status.latencyMs != null
                            ? ` · ${ms(device.status.latencyMs)}`
                            : ""}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="isl-empty">
                    Router status has not loaded. No healthy state is assumed.
                  </p>
                )}
                <p className="isl-note">
                  Management reachability is not proof of client or VPN health.
                </p>
              </div>
            )}
            {tab === "activity" && (
              <div className="isl-list" data-first>
                <span className="label">Recorded completions · latest {events.length}</span>
                {events.length ? (
                  latest(4)
                ) : (
                  <p className="isl-empty">
                    No recorded calls yet. Activity appears when MCP tools complete.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="isl-foot">
            <button type="button" className="shell-link" onClick={() => navigate("feed")}>
              Open Live Feed
            </button>
            <span className="shell-header-spacer" />
            {tab === "fleet" ? (
              <button type="button" className="shell-link" onClick={() => navigate("devices")}>
                Devices
              </button>
            ) : (
              <button type="button" className="shell-link" onClick={() => navigate("overview")}>
                Overview
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
