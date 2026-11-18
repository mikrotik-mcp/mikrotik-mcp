import "./interfaces.css";
import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Pause, Play, RefreshCw, Server } from "lucide-react";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  StatusBadge,
  StatusDot,
  formatBytes,
  useLineDraw,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { api, withToken } from "./api";
import { clock } from "./format";
import { sparkPoints } from "./signal-charts";
import type { DevicesPayload } from "./types";
import type { InterfaceSample, InterfaceStats } from "../../src/observability/interface-stats";

type Point = { ts: number; rx: number | null; tx: number | null };
type Total = { rx: number; tx: number };

const PAGE = 24;
const LEAD =
  "Every port, bridge and tunnel on one router, with live traffic and counters. Read-only.";
/** The table's columns, from the board. */
const COLS = "grid-cols-[minmax(0,1.6fr)_88px_96px_96px_128px_64px]";

/** Bits per second as a number and a unit: ["386", "Mbps"], ["1.20", "Gbps"]. */
const rateParts = (b: number | null): [string, string] | null => {
  if (b == null) return null;
  if (b >= 1e9) return [(b / 1e9).toFixed(2), "Gbps"];
  if (b >= 1e6) return [b >= 1e8 ? String(Math.round(b / 1e6)) : (b / 1e6).toFixed(1), "Mbps"];
  if (b >= 1e3) return [String(Math.round(b / 1e3)), "kbps"];
  return [String(Math.round(b)), "bps"];
};
/** Bits per second the way the board writes them: "386 Mbps", "42.7 Mbps". */
const rate = (b: number | null): string => {
  const parts = rateParts(b);
  return parts ? `${parts[0]} ${parts[1]}` : "—";
};
/** A rate with its unit in `<small>`, for the KPI cards and the big readouts. */
function Rate({ value }: { value: number | null }): ReactNode {
  const parts = rateParts(value);
  if (!parts) return "—";
  return (
    <>
      {parts[0]}
      <small>{parts[1]}</small>
    </>
  );
}
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

// The board's chart: 720×210, drawn edge to edge.
const CW = 720;
const CH = 210;

/** Line segments (split at gaps) for one series. */
function segments(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: { line: string; area: string }[] = [];
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length) {
      const line = run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`);
      const first = run[0][0].toFixed(1);
      const last = run[run.length - 1][0].toFixed(1);
      out.push({
        line: line.join(" "),
        area: `${line.join(" ")} L${last},${CH} L${first},${CH} Z`,
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

/** RX and TX over the last 60 samples: the board's line chart with five time marks. */
function TrafficChart({ points, name }: { points: Point[]; name: string }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useLineDraw(root, name);
  const n = points.length;
  const top = Math.max(0, ...points.flatMap((p) => [p.rx ?? 0, p.tx ?? 0])) || 1;
  const x = (i: number) => (n > 1 ? (i * CW) / (n - 1) : 0);
  const y = (v: number) => CH - 8 - (v / top) * (CH - 20);
  const ticks = n ? [0, 1, 2, 3, 4].map((k) => points[Math.round((k * (n - 1)) / 4)]) : [];
  const rx = segments(
    points.map((p) => p.rx),
    x,
    y,
  );
  const tx = segments(
    points.map((p) => p.tx),
    x,
    y,
  );
  return (
    <div ref={root} className="contents">
      <svg
        className="block"
        viewBox={`0 0 ${CW} ${CH}`}
        width="100%"
        height={CH}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Receive and transmit rate on ${name} over the last 2 minutes`}
      >
        {[1, 2, 3].map((k) => (
          <line
            key={k}
            x1={0}
            x2={CW}
            y1={(CH * k) / 4}
            y2={(CH * k) / 4}
            stroke="var(--line)"
            strokeDasharray="2 5"
          />
        ))}
        {rx.map((seg, i) => (
          <path key={`a${i}`} d={seg.area} fill="var(--sig-fill)" />
        ))}
        {[
          { segs: rx, color: "var(--sig)", key: "rx" },
          { segs: tx, color: "var(--brand)", key: "tx" },
        ].map((s) =>
          s.segs.map((seg, i) => (
            <path
              key={`${s.key}${i}`}
              data-draw
              d={seg.line}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )),
        )}
      </svg>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        {ticks.map((p, i) => (
          <span key={i}>{clock(p.ts)}</span>
        ))}
      </div>
    </div>
  );
}

/** The table's 120×24 sparkline: the last 24 RX readings, scaled to the row. */
function Spark({ points, muted }: { points: Point[]; muted: boolean }) {
  const values = points
    .slice(-24)
    .map((p) => p.rx)
    .filter((v): v is number => v != null);
  if (muted || values.length < 2)
    return (
      <svg width="120" height="24" aria-hidden="true">
        <line x1="0" y1="22" x2="120" y2="22" stroke="var(--text-faint)" strokeWidth={1.25} />
      </svg>
    );
  const d = `M${sparkPoints(values, 120, 24)
    .map(([px, py]) => `${px},${py}`)
    .join(" L")}`;
  return (
    <svg viewBox="0 0 120 24" width="120" height="24" aria-hidden="true">
      <path d={d} fill="none" stroke="var(--sig)" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** The board's small uppercase section label. */
function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="text-[11px] font-medium tracking-[0.08em] text-faint uppercase">
      {children}
    </span>
  );
}

function InterfaceMonitor({ device, picker }: { device: string; picker: ReactNode }): ReactNode {
  const [sample, setSample] = useState<InterfaceSample | null>(null);
  const [history, setHistory] = useState<Record<string, Point[]>>(() => Object.create(null));
  const [totals, setTotals] = useState<Total[]>([]);
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
        if (!gap) {
          const sum = (key: "rxRate" | "txRate") =>
            next.interfaces.reduce((a, row) => a + (row[key] ?? 0), 0);
          setTotals((old) => [...old, { rx: sum("rxRate"), tx: sum("txRate") }].slice(-12));
        }
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

  const running = rows.filter((r) => r.running && !r.disabled);
  const down = rows.filter((r) => !r.running && !r.disabled);
  const disabled = rows.filter((r) => r.disabled);
  const sum = (key: "rxRate" | "txRate"): number | null => {
    const values = rows.map((r) => r[key]).filter((v): v is number => v != null);
    return values.length && !unavailable ? values.reduce((a, b) => a + b, 0) : null;
  };

  const status = paused
    ? "Paused"
    : !visible
      ? "Background · paused"
      : unavailable
        ? "Reconnecting"
        : sample
          ? "Live · 2 s sampling"
          : "Connecting";

  const resetPage =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setLimit(PAGE);
    };

  return (
    <section className="ifaces grid min-w-0 content-start gap-6">
      <PageIntro
        eyebrow={status}
        heading={
          ready ? (
            <>
              {device}: {running.length} running
              {down.length ? (
                <>
                  , <span className="w">{down.length} link down.</span>
                </>
              ) : (
                "."
              )}
            </>
          ) : (
            device
          )
        }
        actions={
          <>
            {picker}
            <MonitorButton
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

      <MetricStrip label="Interface totals" minCell={150} className="ifaces-kpis">
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
        <Metric
          label="Receiving now"
          value={<Rate value={sum("rxRate")} />}
          hint="all interfaces"
          spark={unavailable ? undefined : totals.map((t) => t.rx)}
        />
        <Metric
          label="Sending now"
          value={<Rate value={sum("txRate")} />}
          hint="all interfaces"
          spark={unavailable ? undefined : totals.map((t) => t.tx)}
        />
      </MetricStrip>

      {unavailable && (
        <div className="monitor-note" data-tone="warn" role="status">
          <AlertTriangle aria-hidden="true" className="text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Live readings unavailable.</span>{" "}
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
          <div className="ifaces-sel-main flex min-w-0 flex-col gap-1.5 px-[18px] py-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="ifaces-sel-title flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <h2 className="truncate font-mono text-[16px] font-semibold text-emphasis">
                    {active.name}
                  </h2>
                  <StatusBadge tone={stateTone(active)}>{stateLabel(active)}</StatusBadge>
                </div>
                <p className="text-[12px] text-muted-foreground">
                  {active.comment ? `${active.comment} · ` : ""}
                  {active.type} · {paused ? "frozen at" : "last sample"}{" "}
                  {sample ? clock(sample.ts) : "—"}
                </p>
              </div>
              <span className="monitor-legend">
                <span>
                  <i className="bg-sig" />
                  RX · received
                </span>
                <span>
                  <i className="bg-brand" />
                  TX · sent
                </span>
              </span>
            </div>
            <div className="mb-2.5 flex flex-wrap gap-7">
              {(
                [
                  ["RX · received", active.rxRate, "text-success"],
                  ["TX · sent", active.txRate, "text-brand"],
                ] as const
              ).map(([label, value, color]) => (
                <div key={label} className="flex flex-col">
                  <span className="monitor-label">{label}</span>
                  <span
                    className={`ifaces-big text-[28px] leading-[34px] font-semibold tabular-nums ${color}`}
                  >
                    {unavailable ? "—" : <Rate value={value} />}
                  </span>
                </div>
              ))}
            </div>
            <TrafficChart points={history[active.name] ?? []} name={active.name} />
            <span className="monitor-hint mt-1">
              {active.rxRate == null && active.txRate == null
                ? "Collecting a baseline · rates need two valid samples"
                : "Last 60 samples · each rate is averaged between two reads"}
            </span>
          </div>
          <aside
            className="ifaces-side flex min-w-0 flex-col gap-3 px-[18px] py-4"
            aria-label={`Counters for ${active.name}`}
          >
            <SectionLabel>Counters</SectionLabel>
            <dl className="monitor-facts grid-cols-[132px_minmax(0,1fr)]">
              {(
                [
                  ["RX total", total(active.rxBytes), false],
                  ["TX total", total(active.txBytes), false],
                  [
                    "Packets/s RX · TX",
                    unavailable ? "—" : pair(count(active.rxPps), count(active.txPps)),
                    true,
                  ],
                  [
                    "Packets RX · TX",
                    pair(compact(active.rxPackets), compact(active.txPackets)),
                    true,
                  ],
                  ["Errors RX · TX", pair(count(active.rxErrors), count(active.txErrors)), true],
                  ["Drops RX · TX", pair(count(active.rxDrops), count(active.txDrops)), true],
                  ["TX queue drops", count(active.queueDrops), true],
                  ["Link downs", count(active.linkDowns), true],
                  ["MTU", active.mtu == null ? "—" : String(active.mtu), true],
                  ["MAC address", active.mac || "Not reported", !!active.mac],
                ] as const
              ).map(([label, value, mono]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd className="truncate">
                    <span className={mono ? "font-mono text-[12px]" : undefined}>{value}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <span className="monitor-hint mt-auto">
              Totals count since the router last reset its counters.
            </span>
          </aside>
        </section>
      )}

      {sample && (
        <MonitorPanel
          aria-label="All interfaces"
          title="All interfaces"
          description="Select a row to chart it above."
          flush
          extra={
            <div className="flex flex-wrap items-center gap-2">
              <MonitorSearch
                className="ifaces-search"
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
              <span className="ml-1 font-mono text-[12px] text-muted-foreground">
                {matching.length} / {rows.length}
              </span>
            </div>
          }
        >
          {matching.length ? (
            <div ref={tableRef} className="overflow-x-auto">
              <div className={`monitor-thead min-w-[720px] ${COLS}`}>
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
                    className={`monitor-row ifaces-row min-w-[720px] ${COLS}`}
                    data-selected={active?.name === row.name || undefined}
                    aria-pressed={active?.name === row.name}
                    onClick={() => setSelected(row.name)}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={stateTone(row)} />
                      <span className="flex min-w-0 flex-col">
                        <span className="p truncate font-mono text-[13px]">{row.name}</span>
                        <span
                          className={`truncate text-[12px] leading-[17px] ${isDown ? "text-warning" : "text-muted-foreground"}`}
                        >
                          {sub}
                          {row.dynamic ? " · dynamic" : ""}
                        </span>
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="monitor-chip">{row.type}</span>
                    </span>
                    <span
                      className={`truncate text-right font-mono text-[12px] ${quiet ? "text-faint" : "text-fg-secondary"}`}
                    >
                      {quiet ? "—" : currentRate(row.rxRate)}
                    </span>
                    <span
                      className={`truncate text-right font-mono text-[12px] ${quiet ? "text-faint" : "text-fg-secondary"}`}
                    >
                      {quiet ? "—" : currentRate(row.txRate)}
                    </span>
                    <Spark points={history[row.name] ?? []} muted={quiet} />
                    <span
                      className={`text-right font-mono text-[12px] ${errors ? "text-warning" : "text-faint"}`}
                    >
                      {off ? "—" : count(errors)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="border-t border-line">
              <MonitorEmpty compact title={rows.length ? "No interfaces match" : "No interfaces"}>
                {rows.length
                  ? "Try a different name, state or type."
                  : "This router returned no interfaces."}
              </MonitorEmpty>
            </div>
          )}
          <div className="monitor-foot">
            <span>
              — means the router hasn't reported it yet, or the rate needs a second sample.
            </span>
            <span className="flex-1" />
            {matching.length > limit && (
              <MonitorButton size="sm" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, matching.length - limit)} more
              </MonitorButton>
            )}
          </div>
        </MonitorPanel>
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
      <PageIntro actions={devices ? picker : undefined}>{LEAD}</PageIntro>
      {error ? (
        <div className="monitor-note" data-tone="bad" role="alert">
          <AlertTriangle aria-hidden="true" className="text-destructive" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Could not load routers.</span>{" "}
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
