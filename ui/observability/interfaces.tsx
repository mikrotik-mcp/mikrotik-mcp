import { niceCeil, smoothPath } from "./kit/curve";
import "./interfaces.css";
import { LoadingState } from "./loading-state";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Cable,
  ChevronDown,
  Layers,
  List,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Server,
  Waypoints,
} from "lucide-react";
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
import { interfaceProtocol, protocolGroups } from "./interface-protocols";
import { clock } from "./format";
import { sparkPoints } from "./signal-charts";
import {
  DetailBlock,
  DetailList,
  LineHover,
  RowDrawer,
  RowMenu,
  RowMore,
  Segmented,
  tipProps,
} from "./kit";
import type { Tone as KitTone, TipCard } from "./kit";
import type { DevicesPayload } from "./types";
import type { InterfaceSample, InterfaceStats } from "../../src/observability/interface-stats";

type Point = { ts: number; rx: number | null; tx: number | null };
type Total = { rx: number; tx: number };

const PAGE = 24;
const VIEW_OPTIONS = [
  { value: "protocol", label: "By protocol", icon: <Layers aria-hidden="true" /> },
  { value: "table", label: "Table", icon: <List aria-hidden="true" /> },
] as const;
const LEAD =
  "Every port, bridge and tunnel on one router, with live traffic and counters. Read-only.";
/** The table's columns, from the board. */
const COLS = "grid-cols-[minmax(0,1.6fr)_88px_96px_96px_128px_64px_26px]";
const KIT_TONE: Record<Tone, KitTone> = {
  good: "ok",
  warn: "warn",
  bad: "bad",
  brand: "acc",
  default: "off",
};

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

/** The counters the side panel and the row drawer list: label, value, mono. */
function counters(row: InterfaceStats, unavailable: boolean): [string, string, boolean][] {
  return [
    ["RX total", total(row.rxBytes), false],
    ["TX total", total(row.txBytes), false],
    ["Packets/s RX · TX", unavailable ? "—" : pair(count(row.rxPps), count(row.txPps)), true],
    ["Packets RX · TX", pair(compact(row.rxPackets), compact(row.txPackets)), true],
    ["Errors RX · TX", pair(count(row.rxErrors), count(row.txErrors)), true],
    ["Drops RX · TX", pair(count(row.rxDrops), count(row.txDrops)), true],
    ["TX queue drops", count(row.queueDrops), true],
    ["Link downs", count(row.linkDowns), true],
    ["MTU", row.mtu == null ? "—" : String(row.mtu), true],
    ["MAC address", row.mac || "Not reported", !!row.mac],
  ];
}

/** "+12 Mbps", "−3.1 Mbps": the change from the previous reading. */
function rateDelta(
  now: number | null,
  before: number | null,
): { value: string; tone?: "up" | "down" } {
  if (now == null || before == null) return { value: "—" };
  const d = now - before;
  if (d === 0) return { value: "no change" };
  return { value: `${d > 0 ? "+" : "−"}${rate(Math.abs(d))}`, tone: d > 0 ? "up" : "down" };
}

// The board's chart: 720×210, drawn edge to edge.
const CW = 720;
const CH = 210;
/** Readings the chart holds: the history kept for an interface. */
const WINDOW = 60;

/** Line segments (split at gaps) for one series. */
function segments(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: { line: string; area: string }[] = [];
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length) {
      const line = smoothPath(run);
      const first = run[0][0].toFixed(1);
      const last = run[run.length - 1][0].toFixed(1);
      out.push({
        line,
        area: `${line} L${last},${CH} L${first},${CH} Z`,
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
  const slide = useRef<SVGGElement>(null);
  useLineDraw(root, name);
  const n = points.length;
  // The scale moves in steps (1, 2, 5, 10…), so one busier reading does not
  // make every line jump.
  const top = niceCeil(Math.max(0, ...points.flatMap((p) => [p.rx ?? 0, p.tx ?? 0])));
  // The window is always 60 readings wide and the newest is at the right edge.
  // A short history fills from the right; it is not stretched over the width.
  const step = CW / (WINDOW - 1);
  const x = (i: number) => CW - (n - 1 - i) * step;
  const y = (v: number) => CH - 8 - (v / top) * (CH - 20);
  const ticks = [0, 1, 2, 3, 4].map(
    (k) => points[n - 1 - Math.round(((4 - k) * (WINDOW - 1)) / 4)],
  );
  // A new reading slides in from the right, instead of the whole line jumping.
  const newest = points.at(-1)?.ts;
  useLayoutEffect(() => {
    const g = slide.current;
    if (!g || n < 2 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    g.style.transition = "none";
    g.style.transform = `translateX(${step}px)`;
    const frame = requestAnimationFrame(() => {
      g.style.transition = "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)";
      g.style.transform = "translateX(0)";
    });
    return () => cancelAnimationFrame(frame);
  }, [newest, n, step]);
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
  const hover: [number, number][] = points.map((p, i) => [x(i), y(p.rx ?? p.tx ?? 0)]);
  const card = (i: number): TipCard => {
    const p = points[i]!;
    const before = points[i - 1];
    const gap = p.rx == null && p.tx == null;
    return {
      title: clock(p.ts),
      sub: name,
      rows: gap
        ? [{ label: "Reading", value: "none (gap)" }]
        : [
            { label: "RX · received", value: rate(p.rx), color: "var(--sig)" },
            { label: "TX · sent", value: rate(p.tx), color: "var(--brand)" },
          ],
      foot: !gap && before ? { label: "RX vs previous", ...rateDelta(p.rx, before.rx) } : undefined,
    };
  };
  return (
    <div ref={root} className="contents">
      <svg
        className="block"
        viewBox={`0 0 ${CW} ${CH}`}
        width="100%"
        height={CH}
        preserveAspectRatio="none"
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
        <g ref={slide}>
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
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
        </g>
        {n > 0 && (
          <LineHover
            width={CW}
            height={CH}
            points={hover}
            card={card}
            label={`Receive and transmit rate on ${name} over the last 2 minutes`}
          />
        )}
      </svg>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        {ticks.map((p, i) => (
          <span key={i}>{p ? clock(p.ts) : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** The table's 120×24 sparkline: the last 24 RX readings, scaled to the row. */
function Spark({ points, muted, name }: { points: Point[]; muted: boolean; name: string }) {
  const recent = points.slice(-24).filter((p): p is Point & { rx: number } => p.rx != null);
  const values = recent.map((p) => p.rx);
  if (muted || values.length < 2)
    return (
      <svg width="120" height="24" aria-hidden="true">
        <line x1="0" y1="22" x2="120" y2="22" stroke="var(--text-faint)" strokeWidth={1.25} />
      </svg>
    );
  const d = smoothPath(sparkPoints(values, 120, 24));
  // The row is the focus stop, so the spark shows its card on hover only.
  const tip = tipProps(() => ({
    title: name,
    sub: `${clock(recent[0]!.ts)}–${clock(recent.at(-1)!.ts)}`,
    rows: [
      { label: "RX now", value: rate(values.at(-1)!), color: "var(--sig)" },
      { label: "RX peak", value: rate(Math.max(...values)) },
      { label: "RX low", value: rate(Math.min(...values)) },
    ],
    foot: { label: "Readings", value: String(values.length) },
  }));
  return (
    <svg viewBox="0 0 120 24" width="120" height="24" {...tip} tabIndex={-1} aria-hidden="true">
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

function ProtocolSection({
  group,
  renderRow,
  columnHead,
}: {
  group: ReturnType<typeof protocolGroups>[number];
  renderRow: (row: InterfaceStats) => ReactNode;
  columnHead: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const running = group.rows.filter((row) => row.running && !row.disabled).length;
  const Icon = group.tunnel ? Waypoints : Cable;
  return (
    <section className="ifaces-protocol" aria-label={group.label}>
      <h3>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon size={17} aria-hidden="true" />
          <span>{group.label}</span>
          <span className="ifaces-group-count">{group.rows.length}</span>
          <small>{running} running</small>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </h3>
      {open && (
        <div className="ifaces-group-rows">
          {columnHead}
          {group.rows.map(renderRow)}
        </div>
      )}
    </section>
  );
}

function InterfaceMonitor({ device, picker }: { device: string; picker: ReactNode }): ReactNode {
  const [sample, setSample] = useState<InterfaceSample | null>(null);
  const [history, setHistory] = useState<Record<string, Point[]>>(() => Object.create(null));
  const [totals, setTotals] = useState<Total[]>([]);
  const [selected, setSelected] = useState("");
  const [drawer, setDrawer] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [layout, setLayout] = useState<"protocol" | "table">("protocol");
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
  const groups = protocolGroups(rows);
  const needle = query.trim().toLowerCase();
  const matching = rows.filter((row) => {
    const protocol = interfaceProtocol(row.type);
    return (
      [row.name, row.type, row.comment, row.mac, protocol.label].some((value) =>
        value.toLowerCase().includes(needle),
      ) &&
      (kind === "all" ||
        kind === `type:${row.type}` ||
        kind === `group:${protocol.label}` ||
        (kind === "tunnels" && protocol.tunnel)) &&
      (filter === "all" ||
        filter === (row.disabled ? "disabled" : row.running ? "running" : "down"))
    );
  });
  const matchingGroups = protocolGroups(matching);
  const shown =
    layout === "table" ? matching.slice(0, limit) : matchingGroups.flatMap((group) => group.rows);
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

  const renderRow = (row: InterfaceStats) => {
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
      <RowMenu
        key={row.name}
        title={row.name}
        sub={`${row.type} · ${stateLabel(row)}`}
        onOpen={() => setDrawer(row.name)}
        opens={[{ label: "Chart this interface", onSelect: () => setSelected(row.name) }]}
        cells={{
          name: { value: row.name, search: () => resetPage(setQuery)(row.name) },
          type: {
            value: row.type,
            filter: () => resetPage(setKind)(`type:${row.type}`),
            clearFilter: kind !== "all" ? () => resetPage(setKind)("all") : undefined,
          },
          rx: { value: quiet ? "—" : currentRate(row.rxRate), copy: !quiet },
          tx: { value: quiet ? "—" : currentRate(row.txRate), copy: !quiet },
          errors: { value: off ? "—" : count(errors), copy: !off },
        }}
        copies={[
          { label: "Interface name", value: row.name },
          ...(row.mac ? [{ label: "MAC address", value: row.mac }] : []),
        ]}
        row={row}
      >
        <div
          role="button"
          tabIndex={0}
          className={`monitor-row ifaces-row min-w-[720px] ${COLS}`}
          data-selected={active?.name === row.name || undefined}
          aria-pressed={active?.name === row.name}
          onClick={() => setSelected(row.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSelected(row.name);
            }
          }}
        >
          <span data-col="name" className="flex min-w-0 items-center gap-2.5">
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
          <span data-col="type" className="min-w-0">
            <span className="monitor-chip">{row.type}</span>
          </span>
          <span
            data-col="rx"
            className={`truncate text-right font-mono text-[12px] ${quiet ? "text-faint" : "text-fg-secondary"}`}
          >
            {quiet ? "—" : currentRate(row.rxRate)}
          </span>
          <span
            data-col="tx"
            className={`truncate text-right font-mono text-[12px] ${quiet ? "text-faint" : "text-fg-secondary"}`}
          >
            {quiet ? "—" : currentRate(row.txRate)}
          </span>
          <Spark points={history[row.name] ?? []} muted={quiet} name={row.name} />
          <span
            data-col="errors"
            className={`text-right font-mono text-[12px] ${errors ? "text-warning" : "text-faint"}`}
          >
            {off ? "—" : count(errors)}
          </span>
          <RowMore />
        </div>
      </RowMenu>
    );
  };
  const columnHead = (
    <div className={`monitor-thead min-w-[720px] ${COLS}`}>
      <span>Interface</span>
      <span>Type</span>
      <span className="text-right">RX</span>
      <span className="text-right">TX</span>
      <span>Last 2 min</span>
      <span className="text-right">Errors</span>
      <span />
    </div>
  );
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
              {counters(active, unavailable).map(([label, value, mono]) => (
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
            <Segmented
              label="Interface view"
              value={layout}
              onChange={setLayout}
              options={VIEW_OPTIONS}
            />
          }
        >
          <div className="ifaces-filters">
            <MonitorSearch
              className="ifaces-search"
              label="Search interfaces"
              placeholder="Name, protocol, MAC or comment"
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
                { value: "tunnels", label: "All tunnels" },
                ...groups.flatMap((group) => {
                  const types = [...new Set(group.rows.map((row) => row.type))].sort();
                  if (types.length === 1 && kind !== `type:${types[0]}`)
                    return [{ value: `group:${group.label}`, label: group.label }];
                  return [
                    { value: `group:${group.label}`, label: `${group.label} · all types` },
                    ...types.map((type) => ({
                      value: `type:${type}`,
                      label: `${group.label} · ${type}`,
                    })),
                  ];
                }),
              ]}
            />
            <span className="ml-1 font-mono text-[12px] text-muted-foreground">
              {matching.length} / {rows.length}
            </span>
          </div>
          {matching.length ? (
            <div
              ref={tableRef}
              className={layout === "table" ? "overflow-x-auto" : "ifaces-groups"}
            >
              {layout === "table" ? (
                <>
                  {columnHead}
                  {shown.map(renderRow)}
                </>
              ) : (
                matchingGroups.map((group) => (
                  <ProtocolSection
                    key={group.label}
                    group={group}
                    renderRow={renderRow}
                    columnHead={columnHead}
                  />
                ))
              )}
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
            {layout === "table" && matching.length > limit && (
              <MonitorButton size="sm" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, matching.length - limit)} more
              </MonitorButton>
            )}
          </div>
        </MonitorPanel>
      )}
      {(() => {
        const at = shown.findIndex((r) => r.name === drawer);
        const row = at >= 0 ? shown[at]! : null;
        if (!row) return null;
        return (
          <RowDrawer
            open
            onClose={() => setDrawer(null)}
            label={`Interface details: ${row.name}`}
            status={{ tone: KIT_TONE[stateTone(row)], label: stateLabel(row) }}
            title={row.name}
            meta={[row.type, row.comment, row.dynamic ? "dynamic" : ""].filter(Boolean).join(" · ")}
            rowKey={row.name}
            nav={{
              index: at,
              total: shown.length,
              onPrev: at > 0 ? () => setDrawer(shown[at - 1]!.name) : undefined,
              onNext: at < shown.length - 1 ? () => setDrawer(shown[at + 1]!.name) : undefined,
            }}
            storageKey="interfaces"
            primary={
              <MonitorButton size="sm" onClick={() => setSelected(row.name)}>
                Chart this interface
              </MonitorButton>
            }
          >
            <DetailBlock label="Now">
              <DetailList
                items={[
                  { label: "RX · received", value: currentRate(row.rxRate), mono: true },
                  { label: "TX · sent", value: currentRate(row.txRate), mono: true },
                ]}
              />
            </DetailBlock>
            <DetailBlock label="Counters" aside="since the last reset">
              <DetailList
                items={counters(row, unavailable).map(([label, value, mono]) => ({
                  label,
                  value,
                  mono,
                }))}
              />
            </DetailBlock>
          </RowDrawer>
        );
      })()}
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
