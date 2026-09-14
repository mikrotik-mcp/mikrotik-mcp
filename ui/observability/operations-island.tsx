import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  ChevronUp,
  CircleAlert,
  Clock3,
  Gauge,
  Pause,
  Radio,
  Router,
  Unplug,
  X,
} from "lucide-react";
import {
  DynamicIsland,
  DynamicIslandView,
} from "./components/beui/registry/components/motion/dynamic-island";
import { DigitSwap } from "./components/beui/digit-swap";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
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
}

const SIGNAL_ICONS = {
  offline: Unplug,
  paused: Pause,
  error: CircleAlert,
  alerts: Bell,
  busy: Activity,
  completed: Check,
  listening: Radio,
};

/** A display-only companion to the existing dashboard stream and cached polls. */
export function OperationsIsland(props: OperationsIslandProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("pulse");
  const [tick, setNow] = useState(Date.now);
  // Receipt times are local, not device clocks. A poll may arrive between ticks.
  const now = Math.max(
    tick,
    props.statsAt ?? 0,
    props.poolAt ?? 0,
    props.alertsAt ?? 0,
    props.liveEventAt ?? 0,
  );
  const rootRef = useRef<HTMLElement>(null);
  const compactRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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
      if (returnFocus.current) compactRef.current?.focus({ preventScroll: true });
      returnFocus.current = false;
      return;
    }
    closeRef.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const signal = islandSignal({ ...props, now });
  const SignalIcon = SIGNAL_ICONS[signal.kind];
  const connected = props.mode !== "off" && !props.paused;
  const statsFresh = connected && isFreshSample(props.statsAt, now);
  const poolFresh = connected && isFreshSample(props.poolAt, now);
  const alertsFresh = connected && isFreshSample(props.alertsAt, now, 45_000);
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
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  const navigate = (page: ViewId) => {
    setOpen(false);
    props.onNavigate(page);
  };
  const windowLabel = props.stats
    ? `${Math.round(props.stats.windowMs / 60_000)} min window`
    : "Waiting for analytics";
  const knownNumber = (value: number | undefined, formatter = num) =>
    value != null && Number.isFinite(value) ? formatter(value) : "—";

  return (
    <aside
      ref={rootRef}
      className="operations-island-anchor"
      aria-label="Operations Island"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      data-signal={signal.kind}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {signal.label}
      </span>
      <DynamicIsland
        announce={false}
        anchor="bottom"
        view={open ? "operations" : null}
        className="operations-island"
        compact={
          <Button
            ref={compactRef}
            variant="ghost"
            className="island-compact"
            aria-label={`Open Operations Island: ${signal.label}`}
            aria-expanded={open}
            aria-controls="operations-island-panel"
            onClick={() => setOpen(true)}
          >
            <span className="island-signal-icon">
              <SignalIcon size={17} />
            </span>
            <span className="island-compact-copy">
              <strong>{signal.label}</strong>
              <span>{signal.detail}</span>
            </span>
            {signal.count != null ? (
              <span className="island-count">
                <DigitSwap value={signal.count} />
              </span>
            ) : (
              <span
                className="island-equalizer"
                data-moving={signal.kind === "busy"}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
            <ChevronUp size={14} className="island-chevron" />
          </Button>
        }
      >
        <DynamicIslandView id="operations" className="island-expanded-slot">
          <section
            id="operations-island-panel"
            className="island-panel"
            aria-label="Operations summary"
          >
            <header className="island-header">
              <span className="island-signal-icon">
                <SignalIcon size={20} />
              </span>
              <div>
                <p>OPERATIONS PULSE</p>
                <h2>{signal.label}</h2>
              </div>
              <Button
                ref={closeRef}
                size="icon-sm"
                variant="ghost"
                className="island-close"
                aria-label="Collapse Operations Island"
                onClick={close}
              >
                <X size={16} />
              </Button>
            </header>
            <div className="island-connection">
              <span className={connected ? "island-dot is-connected" : "island-dot"} />
              <span>
                {props.mode === "off"
                  ? "Disconnected · last-known data only"
                  : props.paused
                    ? "Stream connected · dashboard updates paused"
                    : `${props.mode.toUpperCase()} connected · no extra router probes`}
              </span>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="island-tabs">
              <TabsList aria-label="Operations views" className="island-tab-list">
                <TabsTrigger value="pulse">
                  <Activity size={13} />
                  Pulse
                </TabsTrigger>
                <TabsTrigger value="fleet">
                  <Router size={13} />
                  Routers
                </TabsTrigger>
                <TabsTrigger value="activity">
                  <Clock3 size={13} />
                  Activity
                </TabsTrigger>
              </TabsList>
              <TabsContent value="pulse" className="island-tab-panel">
                <div className="island-chart-heading">
                  <span>TOOL CALL VOLUME</span>
                  <span>{windowLabel}</span>
                </div>
                <div className="island-volume" aria-hidden="true" data-stale={!statsFresh}>
                  {series.some((bucket) => bucket.ok + bucket.error > 0) ? (
                    series.map((bucket) => (
                      <div key={bucket.t} className="island-bar-track">
                        <span
                          className="island-bar-ok"
                          style={{ height: `${(bucket.ok / ceiling) * 100}%` }}
                        />
                        <span
                          className="island-bar-error"
                          style={{ height: `${(bucket.error / ceiling) * 100}%` }}
                        />
                      </div>
                    ))
                  ) : (
                    <span className="island-empty-chart">
                      {props.stats ? "No calls in this window" : "Waiting for recorded activity"}
                    </span>
                  )}
                </div>
                <div className="island-chart-caption">
                  <span>
                    <i />
                    Successful <i className="is-error" />
                    Failed
                  </span>
                  <span>
                    {statsFresh ? "Updated" : "Snapshot"} · {islandAge(props.statsAt, now)}
                  </span>
                </div>
                <div className="island-metrics">
                  <div>
                    <span>Calls / min</span>
                    <strong>
                      {knownNumber(props.stats?.callsPerMin, (value) => value.toFixed(1))}
                    </strong>
                  </div>
                  <div>
                    <span>Tool p95</span>
                    <strong>
                      {knownNumber(
                        props.stats && props.stats.total > 0 ? props.stats.latency.p95 : undefined,
                        ms,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Failed calls</span>
                    <strong className={props.stats?.errors ? "island-error-text" : ""}>
                      {knownNumber(props.stats?.errors)}
                    </strong>
                  </div>
                </div>
                <div className="island-insights">
                  <span>
                    <Gauge size={13} />
                    {poolFresh && props.pool
                      ? props.pool.enabled
                        ? `${props.pool.aggregate.totalInflight} SSH channels in flight`
                        : "SSH pooling disabled"
                      : "SSH pool status unavailable"}
                  </span>
                  <span>
                    <Bell size={13} />
                    {alertsFresh && props.alerts != null
                      ? `${props.alerts} active alert rules`
                      : "Alert status unavailable"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  className="island-link"
                  onClick={() => navigate("overview")}
                >
                  Open analytics
                  <ArrowUpRight size={14} />
                </Button>
              </TabsContent>
              <TabsContent value="fleet" className="island-tab-panel">
                <div className="island-chart-heading">
                  <span>LAST ROUTER CHECKS</span>
                  <span>
                    {props.devices
                      ? `${reachable} / ${devices.filter((device) => !device.disabled).length} reachable`
                      : "Not loaded"}
                  </span>
                </div>
                <div className="island-scroll-list">
                  {devices.length ? (
                    devices.map((device) => {
                      const state = islandDeviceState(device, now, connected);
                      return (
                        <div key={device.name} className="island-device" data-state={state}>
                          <span className="island-router-icon">
                            <Router size={18} />
                          </span>
                          <div className="island-row-copy">
                            <strong>{device.name}</strong>
                            <span>
                              {state === "unknown" ? "Unknown / stale" : state} ·{" "}
                              {islandAge(device.status.checkedAt, now)}
                            </span>
                          </div>
                          <span className="island-device-latency">
                            {state === "reachable" && device.status.latencyMs != null
                              ? ms(device.status.latencyMs)
                              : "—"}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <p className="island-empty">
                      Router status has not loaded. No healthy state is assumed.
                    </p>
                  )}
                </div>
                <p className="island-footnote">
                  Management reachability is not proof of client or VPN health.
                </p>
                <Button variant="ghost" className="island-link" onClick={() => navigate("devices")}>
                  Open devices
                  <ArrowUpRight size={14} />
                </Button>
              </TabsContent>
              <TabsContent value="activity" className="island-tab-panel">
                <div className="island-chart-heading">
                  <span>RECORDED COMPLETIONS</span>
                  <span>Latest {events.length}</span>
                </div>
                <div className="island-scroll-list">
                  {events.length ? (
                    events.map((event) => (
                      <Button
                        key={event.id}
                        variant="ghost"
                        className="island-event"
                        onClick={() => {
                          setOpen(false);
                          props.onEvent(event);
                        }}
                      >
                        <span
                          className={event.isError ? "island-error-text" : "island-success-text"}
                        >
                          {event.isError ? <CircleAlert size={16} /> : <Check size={16} />}
                        </span>
                        <span className="island-row-copy">
                          <strong>{event.tool}</strong>
                          <span>
                            {event.device ?? "Server"} · {islandAge(islandCompletedAt(event), now)}
                          </span>
                        </span>
                        <span className="island-event-duration">
                          {ms(event.durationMs)}
                          <ArrowUpRight size={12} />
                        </span>
                      </Button>
                    ))
                  ) : (
                    <p className="island-empty">
                      No recorded calls yet. Activity appears when MCP tools complete.
                    </p>
                  )}
                </div>
                <p className="island-footnote">
                  Completed tool calls, not a live packet trace. Open a call for its evidence.
                </p>
                <Button variant="ghost" className="island-link" onClick={() => navigate("feed")}>
                  Open Live Feed
                  <ArrowUpRight size={14} />
                </Button>
              </TabsContent>
            </Tabs>
            <footer className="island-footer">
              <Radio size={11} />
              <span>OBSERVE ONLY</span>
              <span>No configuration changes</span>
            </footer>
          </section>
        </DynamicIslandView>
      </DynamicIsland>
    </aside>
  );
}
