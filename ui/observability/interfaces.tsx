import "./interfaces.css";
import { LoadingState } from "./loading-state";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Pause, Play, RefreshCw, Server } from "lucide-react";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorSearch,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  StatusBadge,
  StatusDot,
  formatBytes,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { api, withToken } from "./api";
import { clock } from "./format";
import type { DevicesPayload } from "./types";
import type { InterfaceSample, InterfaceStats } from "../../src/observability/interface-stats";

type Point = { ts: number; rx: number | null; tx: number | null };

const PAGE = 24;
const LEAD =
  "Every port, bridge and tunnel on one router, with live traffic and counters. Read-only.";
/** The table's columns, from the board. */
const COLS = "grid-cols-[minmax(200px,1.6fr)_88px_96px_96px_128px_64px]";

/** Bits per second the way the board writes them: "386 Mbps", "42.7 Mbps", "1.20 Gbps". */
const rate = (b: number | null): string => {
  if (b == null) return "—";
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} Gbps`;
  if (b >= 1e6) return `${b >= 1e8 ? Math.round(b / 1e6) : (b / 1e6).toFixed(1)} Mbps`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kbps`;
  return `${Math.round(b)} bps`;
};
const count = (value: number | null): string =>
  value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
/** Large packet counts: "1.31 B", "402 M". */
const compact = (value: number | null): string => {
  if (value == null) return "—";
  if (value >= 1e9) return `${(value / 1e9).toPrecision(3)} B`;
  if (value >= 1e6) return `${(value / 1e6).toPrecision(3)} M`;
  return count(value);
};
const pair = (a: string, b: string): string => (a === "—" && b === "—" ? "—" : `${a} · ${b}`);
/** Byte totals to three figures: "1.84 TB", "212 GB". */
const total = (value: number | null): string => {
  if (value == null) return "—";
  if (value < 1000) return formatBytes(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
  return `${Number((value / 1000 ** i).toPrecision(3))} ${units[i]}`;
};
const stateLabel = (row: InterfaceStats): string =>
  row.disabled ? "Disabled" : row.running ? "Running" : "Link down";
const stateTone = (row: InterfaceStats): Tone =>
  row.disabled ? "default" : row.running ? "good" : "warn";

/** Axis label: "0", "100M", "2.5G". */
const axis = (v: number): string => {
  if (v === 0) return "0";
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}G`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
};
/** A round top for five grid steps: 1, 2 or 5 × 10^n per step. */
const niceMax = (v: number): number => {
  if (!(v > 0)) return 5;
  const step = v / 5;
  const p = 10 ** Math.floor(Math.log10(step));
  const m = step / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p * 5;
};

// The board's chart box: 760×228, plot from x 64 to 756 and y 12 to 196.
const X0 = 64;
const X1 = 756;
const Y0 = 12;
const Y1 = 196;

/** Line segments (split at gaps) for one series. */
function segments(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: { line: string; area: string }[] = [];
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length) {
      const line = run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`);
      const first = run[0][0].toFixed(1);
      const last = run[run.length - 1][0].toFixed(1);
      out.push({
        line: line.join(" "),
        area: `${line.join(" ")} L${last} ${Y1} L${first} ${Y1} Z`,
      });
    }
    run = [];
  };
  values.forEach((v, i) => {
    if (v == null) flush();
    else run.push([x(i), y(v)]);
  });
  flush();
  return out;
}

function TrafficChart({ points, name }: { points: Point[]; name: string }): ReactNode {
  const id = useId().replace(/:/g, "");
  const n = points.length;
  const top = niceMax(Math.max(0, ...points.flatMap((p) => [p.rx ?? 0, p.tx ?? 0])));
  const x = (i: number) => (n > 1 ? X0 + (i / (n - 1)) * (X1 - X0) : X0);
  const y = (v: number) => Y1 - (v / top) * (Y1 - Y0);
  const grid = [0, 1, 2, 3, 4, 5].map((k) => (top / 5) * k);
  const ticks = n ? [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4)))] : [];
  const series = [
    { key: "rx" as const, color: "var(--success)" },
    { key: "tx" as const, color: "var(--chart-1)" },
  ];
  return (
    <svg
      className="ifaces-chart"
      viewBox="0 0 760 228"
      width="100%"
      height="228"
      role="img"
      aria-label={`Receive and transmit rate on ${name} over the last 2 minutes`}
    >
      <defs>
        {series.map((s) => (
          <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={s.color} stopOpacity={0.28} />
            <stop offset="1" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {grid.map((v) => (
        <g key={v}>
          <line
            x1={64}
            x2={756}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--chart-grid)"
            strokeDasharray="2 4"
          />
          <text
            x={56}
            y={y(v) + 4}
            textAnchor="end"
            fontSize={11}
            fill="var(--muted-foreground)"
            className="font-mono"
          >
            {axis(v)}
          </text>
        </g>
      ))}
      {series.map((s) =>
        segments(
          points.map((p) => p[s.key]),
          x,
          y,
        ).map((seg, i) => (
          <g key={`${s.key}-${i}`}>
            <path d={seg.area} fill={`url(#${id}-${s.key})`} />
            <path d={seg.line} fill="none" stroke={s.color} strokeWidth={1.5} />
          </g>
        )),
      )}
      {ticks.map((i, k) => (
        <text
          key={i}
          x={x(i)}
          y={222}
          textAnchor={k === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          fontSize={11}
          fill="var(--muted-foreground)"
          className="font-mono"
        >
          {clock(points[i].ts)}
        </text>
      ))}
    </svg>
  );
}

/** The table's 120×24 sparkline: the last 24 RX readings against the busiest row. */
function Spark({ points, max, muted }: { points: Point[]; max: number; muted: boolean }) {
  const last = points.slice(-24);
  let d = "";
  let pen = false;
  last.forEach((p, i) => {
    if (p.rx == null) {
      pen = false;
      return;
    }
    const y = muted || p.rx <= 0 || max <= 0 ? 22 : 20 - (p.rx / max) * 18;
    d += `${pen ? "L" : "M"}${(i * 5.2).toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return (
    <svg viewBox="0 0 120 24" width="120" height="24" aria-hidden="true">
      <path
        d={d.trim() || "M0 22 L119.6 22"}
        fill="none"
        stroke={muted ? "var(--text-faint)" : "var(--success)"}
        strokeWidth={1.25}
      />
    </svg>
  );
}

function InterfaceMonitor({ device, picker }: { device: string; picker: ReactNode }): ReactNode {
  const [sample, setSample] = useState<InterfaceSample | null>(null);
  const [history, setHistory] = useState<Record<string, Point[]>>(() => Object.create(null));
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [connectionError, setConnectionError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [limit, setLimit] = useState(PAGE);
  const tableRef = useRef<HTMLDivElement>(null);
  useStaggerIn(tableRef, ".ifaces-row", `${query}|${filter}|${kind}|${!!sample}`);

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (paused || !visible) return;
    let live = true;
    let first = true;
    const stream = new EventSource(
      withToken(`/api/interfaces/stream?device=${encodeURIComponent(device)}`),
    );
    stream.addEventListener("interfaces", (event) => {
      if (!live) return;
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as InterfaceSample;
        if (next.device !== device || !Array.isArray(next.interfaces)) return;
        const gap = first || !!next.error;
        first = false;
        setConnectionError(false);
        setSample(next);
        setNow(Date.now());
        setHistory((old) => {
          const updated: Record<string, Point[]> = Object.create(null);
          for (const row of next.interfaces) {
            const previous = old[row.name] ?? [];
            updated[row.name] = [
              ...previous,
              { ts: next.ts, rx: gap ? null : row.rxRate, tx: gap ? null : row.txRate },
            ].slice(-60);
          }
          return updated;
        });
      } catch {
        setConnectionError(true);
      }
    });
    stream.onerror = () => {
      if (live) {
        first = true;
        setConnectionError(true);
      }
    };
    return () => {
      live = false;
      stream.close();
    };
  }, [device, paused, visible, retry]);

  const rows = sample?.interfaces ?? [];
  const ready = !!sample && !sample.error;
  const stale = !paused && visible && !!sample && now - sample.ts > 10_000;
  const unavailable = connectionError || !!sample?.error || stale;
  const active =
    rows.find((row) => row.name === selected) ??
    rows.find((row) => row.running && !row.disabled) ??
    rows[0];
  const matching = rows.filter(
    (row) =>
      `${row.name} ${row.type} ${row.comment} ${row.mac}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (kind === "all" || row.type === kind) &&
      (filter === "all" ||
        (filter === "running"
          ? row.running && !row.disabled
          : filter === "disabled"
            ? row.disabled
            : !row.running && !row.disabled)),
  );
  const shown = matching.slice(0, limit);
  const currentRate = (value: number | null) => (unavailable ? "—" : rate(value));
  const sparkMax = Math.max(
    0,
    ...shown.flatMap((row) => (history[row.name] ?? []).slice(-24).map((p) => p.rx ?? 0)),
  );

  const running = rows.filter((r) => r.running && !r.disabled);
  const down = rows.filter((r) => !r.running && !r.disabled);
  const disabled = rows.filter((r) => r.disabled);
  const sum = (key: "rxRate" | "txRate") => {
    const values = rows.map((r) => r[key]).filter((v): v is number => v != null);
    return values.length && !unavailable ? rate(values.reduce((a, b) => a + b, 0)) : "—";
  };

  const status: { tone: Tone; live: boolean; text: string } = paused
    ? { tone: "default", live: false, text: "Paused" }
    : !visible
      ? { tone: "default", live: false, text: "Background · paused" }
      : unavailable
        ? { tone: "warn", live: false, text: "Reconnecting" }
        : sample
          ? { tone: "good", live: true, text: "Live · 2 s sampling" }
          : { tone: "default", live: false, text: "Connecting" };

  const resetPage =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setLimit(PAGE);
    };

  return (
    <section className="ifaces grid min-w-0 content-start gap-6">
      <PageIntro
        tone={status.tone}
        live={status.live}
        title={
          <>
            <b>{status.text}</b>
            <span>
              · {device}
              {ready ? ` · ${rows.length} interfaces` : ""}
            </span>
          </>
        }
        controls={
          <>
            {picker}
            <MonitorButton
              size="sm"
              aria-label={paused ? "Resume interface monitoring" : "Pause interface monitoring"}
              icon={paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </MonitorButton>
          </>
        }
      >
        {LEAD}
      </PageIntro>

      <MetricStrip label="Interface totals" minCell={150}>
        <Metric
          label="Interfaces"
          value={ready ? rows.length : "—"}
          hint="ports, bridges, tunnels"
        />
        <Metric
          label="Running"
          tone={ready && running.length ? "good" : "default"}
          value={ready ? running.length : "—"}
          hint="link up"
        />
        <Metric
          label="Link down"
          tone={ready && down.length ? "warn" : "default"}
          value={ready ? down.length : "—"}
          hint={!ready ? "—" : down.length ? down.map((r) => r.name).join(", ") : "none"}
        />
        <Metric
          label="Disabled"
          value={ready ? disabled.length : "—"}
          hint="turned off on the router"
        />
        <Metric label="Receiving now" value={sum("rxRate")} hint="all interfaces" />
        <Metric label="Sending now" value={sum("txRate")} hint="all interfaces" />
      </MetricStrip>

      {unavailable && (
        <div className="monitor-note" data-tone="warn" role="status">
          <AlertTriangle aria-hidden="true" className="text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-[590]">Live readings unavailable.</span>{" "}
            <span className="text-muted-foreground">
              {sample?.error || "The stream is delayed or disconnected."}{" "}
              {paused ? "Resume monitoring to retry." : "Retrying automatically."} Any chart points
              left on screen are history, not current readings.
            </span>
          </span>
          <MonitorButton
            size="sm"
            variant="ghost"
            aria-label="Reconnect interface stream"
            icon={<RefreshCw aria-hidden="true" />}
            onClick={() => {
              setPaused(false);
              setRetry(retry + 1);
            }}
          >
            Reconnect
          </MonitorButton>
        </div>
      )}

      {!sample && !unavailable && (
        <div role="status" className="monitor-panel">
          <MonitorEmpty
            icon={<Loader2 className="animate-spin" />}
            title={`Reading interfaces from ${device}`}
          >
            The first sample takes a couple of seconds.
          </MonitorEmpty>
        </div>
      )}

      {active && (
        <section
          className="monitor-panel ifaces-sel"
          aria-label={`Selected interface ${active.name}`}
        >
          <div className="flex flex-wrap">
            <div className="min-w-0 flex-[999_1_560px]">
              <div className="monitor-panel-head">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-mono text-[15px] leading-5 font-medium text-foreground">
                      {active.name}
                    </h2>
                    <StatusBadge tone={stateTone(active)}>{stateLabel(active)}</StatusBadge>
                  </div>
                  <p className="monitor-panel-desc">
                    {active.comment ? `${active.comment} · ` : ""}
                    {active.type} · {paused ? "frozen at" : "last sample"}{" "}
                    {sample ? clock(sample.ts) : "—"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-4 text-[12px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-[2px] bg-success" />
                    RX · received
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-[2px] bg-chart-1" />
                    TX · sent
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-3 px-5 pb-5">
                <div className="flex flex-wrap gap-8">
                  {(
                    [
                      ["RX · received", active.rxRate],
                      ["TX · sent", active.txRate],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex flex-col">
                      <span className="monitor-label">{label}</span>
                      <span className="text-[28px] leading-[34px] font-[590] tracking-[-0.02em] text-emphasis tabular-nums">
                        {currentRate(value)}
                      </span>
                    </div>
                  ))}
                </div>
                <TrafficChart points={history[active.name] ?? []} name={active.name} />
                <span className="text-[12px] text-muted-foreground">
                  {active.rxRate == null && active.txRate == null
                    ? "Collecting a baseline · rates need two valid samples"
                    : "Last 60 samples · each rate is averaged between two reads"}
                </span>
              </div>
            </div>
            <aside
              className="monitor-side ifaces-side flex flex-col gap-3 px-5 pt-4 pb-5"
              aria-label={`Counters for ${active.name}`}
            >
              <span className="monitor-label">Counters</span>
              <dl className="monitor-facts my-[13px] grid-cols-[128px_minmax(0,1fr)]">
                {(
                  [
                    ["RX total", total(active.rxBytes)],
                    ["TX total", total(active.txBytes)],
                    [
                      "Packets/s RX · TX",
                      unavailable ? "—" : pair(count(active.rxPps), count(active.txPps)),
                    ],
                    ["Packets RX · TX", pair(compact(active.rxPackets), compact(active.txPackets))],
                    ["Errors RX · TX", pair(count(active.rxErrors), count(active.txErrors))],
                    ["Drops RX · TX", pair(count(active.rxDrops), count(active.txDrops))],
                    ["TX queue drops", count(active.queueDrops)],
                    ["Link downs", count(active.linkDowns)],
                    ["MTU", active.mtu == null ? "—" : String(active.mtu)],
                    ["MAC address", active.mac || "Not reported"],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt>{label}</dt>
                    <dd
                      className={`break-all tabular-nums ${
                        label.startsWith("Drops") && (active.rxDrops || active.txDrops)
                          ? "text-warning"
                          : ""
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <span className="border-t border-border pt-3 text-[12px] text-muted-foreground">
                Totals count since the router last reset its counters.
              </span>
            </aside>
          </div>
        </section>
      )}

      {sample && (
        <section className="monitor-panel" aria-label="All interfaces">
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <h2 className="mr-2 text-[14px] font-[590]">All interfaces</h2>
            <MonitorSearch
              className="flex-[1_1_260px]"
              label="Search interfaces"
              placeholder="Name, type, MAC or comment"
              value={query}
              onChange={resetPage(setQuery)}
            />
            <MonitorSelect
              label="Filter interface status"
              value={filter}
              onChange={resetPage(setFilter)}
              options={[
                { value: "all", label: "All states" },
                { value: "running", label: "Running" },
                { value: "down", label: "Link down" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
            <MonitorSelect
              label="Filter interface type"
              value={kind}
              onChange={resetPage(setKind)}
              options={[
                { value: "all", label: "All types" },
                ...[...new Set(rows.map((row) => row.type))]
                  .sort()
                  .map((type) => ({ value: type, label: type })),
              ]}
            />
            <span className="ml-1 text-[12px] text-muted-foreground tabular-nums">
              {matching.length} / {rows.length}
            </span>
          </div>
          {matching.length ? (
            <div ref={tableRef} className="overflow-x-auto">
              <div className={`monitor-thead min-w-[760px] ${COLS}`}>
                <span>Interface</span>
                <span>Type</span>
                <span className="text-right">RX</span>
                <span className="text-right">TX</span>
                <span>Last 2 min</span>
                <span className="text-right">Errors</span>
              </div>
              {shown.map((row) => {
                const off = row.disabled;
                const isDown = !row.running && !row.disabled;
                const quiet = off || isDown;
                const errors =
                  row.rxErrors == null && row.txErrors == null
                    ? null
                    : (row.rxErrors ?? 0) + (row.txErrors ?? 0);
                const sub = isDown
                  ? ["Link down", row.comment].filter(Boolean).join(" · ")
                  : off
                    ? ["Disabled", row.comment].filter(Boolean).join(" · ")
                    : row.comment || `${row.type} interface`;
                return (
                  <button
                    type="button"
                    key={row.name}
                    className={`monitor-row ifaces-row min-w-[760px] ${COLS}`}
                    data-selected={active?.name === row.name || undefined}
                    aria-pressed={active?.name === row.name}
                    onClick={() => setSelected(row.name)}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={stateTone(row)} />
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`truncate font-mono text-[13px] ${off ? "text-muted-foreground" : "text-foreground"}`}
                        >
                          {row.name}
                        </span>
                        <span
                          className={`truncate text-[12px] ${isDown ? "text-warning" : "text-muted-foreground"}`}
                        >
                          {sub}
                          {row.dynamic ? " · dynamic" : ""}
                        </span>
                      </span>
                    </span>
                    <span className="truncate font-mono text-[12px] text-muted-foreground">
                      {row.type}
                    </span>
                    <span className="text-right text-fg-secondary tabular-nums">
                      {quiet ? "—" : currentRate(row.rxRate)}
                    </span>
                    <span className="text-right text-fg-secondary tabular-nums">
                      {quiet ? "—" : currentRate(row.txRate)}
                    </span>
                    <Spark points={history[row.name] ?? []} max={sparkMax} muted={quiet} />
                    <span
                      className={`text-right tabular-nums ${errors ? "text-warning" : "text-muted-foreground"}`}
                    >
                      {off ? "—" : count(errors)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="border-t border-border">
              <MonitorEmpty compact title={rows.length ? "No interfaces match" : "No interfaces"}>
                {rows.length
                  ? "Try a different name, state or type."
                  : "This router returned no interfaces."}
              </MonitorEmpty>
            </div>
          )}
          <div className="monitor-row grid-cols-[1fr_auto] text-[12px] text-muted-foreground">
            <span>
              RX is traffic entering the interface, TX is traffic leaving it. "—" means the router
              hasn't reported it yet, or the rate needs a second sample.
            </span>
            {matching.length > limit && (
              <MonitorButton size="sm" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, matching.length - limit)} more
              </MonitorButton>
            )}
          </div>
        </section>
      )}
    </section>
  );
}

export function InterfacesView(): ReactNode {
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [device, setDevice] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api<DevicesPayload>("/api/devices", abort.signal)
      .then((result) => {
        setDevices(result);
        setDevice(
          result.devices.find((d) => d.name === result.defaultDevice && !d.disabled)?.name ??
            result.devices.find((d) => !d.disabled)?.name ??
            "",
        );
        setError("");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Device list unavailable");
      });
    return () => abort.abort();
  }, [retry]);
  if (!devices && !error) return <LoadingState label="Loading interfaces" />;

  const routers = (devices?.devices ?? []).filter((d) => !d.disabled).map((d) => d.name);
  const picker = (
    <>
      <span className="monitor-label">Router</span>
      <RouterPicker
        label="Select router for interfaces"
        value={device}
        onChange={setDevice}
        routers={routers}
        defaultRouter={devices?.defaultDevice}
        disabled={!devices}
      />
    </>
  );

  if (device && !error) return <InterfaceMonitor key={device} device={device} picker={picker} />;

  return (
    <section className="ifaces grid min-w-0 content-start gap-6">
      <PageIntro controls={devices ? picker : undefined}>{LEAD}</PageIntro>
      {error ? (
        <div className="monitor-note" data-tone="bad" role="alert">
          <AlertTriangle aria-hidden="true" className="text-destructive" />
          <span className="min-w-0 flex-1">
            <span className="font-[590]">Could not load routers.</span>{" "}
            <span className="text-muted-foreground">{error}</span>
          </span>
          <MonitorButton size="sm" variant="ghost" onClick={() => setRetry(retry + 1)}>
            Try again
          </MonitorButton>
        </div>
      ) : (
        <div className="monitor-panel">
          <MonitorEmpty icon={<Server />} title="No enabled routers">
            Add or enable one on the Devices page.
          </MonitorEmpty>
        </div>
      )}
    </section>
  );
}
