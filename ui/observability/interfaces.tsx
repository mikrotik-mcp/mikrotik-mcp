import { useEffect, useId, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  Network,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./components/ui/chart";
import { AnimatedBadge } from "./components/beui/registry/components/motion/animated-badge";
import { Badge, Button, Card, Input, Note, Select, Spinner } from "./geist";
import { api, withToken } from "./api";
import { bytes, clock } from "./format";
import type { DevicesPayload } from "./types";
import type { InterfaceSample, InterfaceStats } from "../../src/observability/interface-stats";

type Point = { ts: number; rx: number | null; tx: number | null };
const SERIES = {
  rx: { label: "RX · received", color: "var(--chart-2)" },
  tx: { label: "TX · sent", color: "var(--chart-1)" },
};
const rate = (value: number | null) => {
  if (value == null) return "—";
  const scale = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return `${(value / scale).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${scale === 1e9 ? "Gbps" : scale === 1e6 ? "Mbps" : scale === 1e3 ? "kbps" : "bps"}`;
};
const count = (value: number | null) =>
  value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const total = (value: number | null) => (value == null ? "—" : bytes(value));
const stateLabel = (row: InterfaceStats) =>
  row.disabled ? "Disabled" : row.running ? "Running" : "Link down";

function TrafficGraph({ points, small = false }: { points: Point[]; small?: boolean }) {
  const id = useId().replace(/:/g, "");
  const reducedMotion = useReducedMotion();
  return (
    <ChartContainer
      config={SERIES}
      className={small ? "h-16 w-full aspect-auto" : "h-64 sm:h-72 w-full aspect-auto"}
      aria-label="Interface receive and transmit rates in bits per second"
    >
      <AreaChart
        data={points}
        margin={{ top: 12, right: 10, bottom: 0, left: small ? 0 : 5 }}
        accessibilityLayer={!small}
      >
        <defs>
          {(["rx", "tx"] as const).map((key) => (
            <linearGradient key={key} id={`${id}-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[key].color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={SERIES[key].color} stopOpacity={0.015} />
            </linearGradient>
          ))}
        </defs>
        {!small && <CartesianGrid vertical={false} strokeDasharray="2 6" />}
        {!small && (
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={clock}
            minTickGap={60}
            axisLine={false}
            tickLine={false}
          />
        )}
        {!small && (
          <YAxis
            tickFormatter={(v: number) => rate(v)}
            width={80}
            axisLine={false}
            tickLine={false}
          />
        )}
        {!small && (
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => clock(Number(value))}
                formatter={(value, name) => (
                  <span className="font-mono">
                    {name === "rx" ? "RX" : "TX"} {rate(Number(value))}
                  </span>
                )}
              />
            }
          />
        )}
        {(["rx", "tx"] as const).map((key) => (
          <Area
            key={key}
            type="linear"
            dataKey={key}
            stroke={SERIES[key].color}
            fill={`url(#${id}-${key})`}
            strokeWidth={small ? 1.5 : 2}
            connectNulls={false}
            dot={false}
            activeDot={small ? false : { r: 4 }}
            isAnimationActive={!small && !reducedMotion}
            animationDuration={300}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

function InterfaceMonitor({ device }: { device: string }) {
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
  const [limit, setLimit] = useState(24);

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
  const liveLabel = paused
    ? "Paused"
    : !visible
      ? "Background · paused"
      : unavailable
        ? "Reconnecting"
        : sample
          ? "Live · 2s sampling"
          : "Connecting";
  const currentRate = (value: number | null) => (unavailable ? "—" : rate(value));

  return (
    <div className="grid gap-5">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-chart-2/30 bg-chart-2/10 text-chart-2">
              <Activity className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold">Interface activity</h2>
              <p className="text-xs text-muted-foreground">
                Ports, bridges & tunnels · one live view
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AnimatedBadge
              size="sm"
              status={unavailable ? "warning" : paused ? "neutral" : sample ? "success" : "loading"}
              pulse={!paused && !unavailable && !!sample}
            >
              {liveLabel}
            </AnimatedBadge>
            <Button
              ghost
              size="sm"
              aria-label={paused ? "Resume interface monitoring" : "Pause interface monitoring"}
              onClick={() => setPaused(!paused)}
              icon={paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              ghost
              size="sm"
              aria-label="Reconnect interface stream"
              onClick={() => {
                setPaused(false);
                setRetry(retry + 1);
              }}
              icon={<RefreshCw className="size-3.5" />}
            >
              Reconnect
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border bg-muted/20">
          {[
            ["Interfaces", rows.length],
            ["Running", rows.filter((r) => r.running && !r.disabled).length],
            ["Link down", rows.filter((r) => !r.running && !r.disabled).length],
            ["Disabled", rows.filter((r) => r.disabled).length],
          ].map(([label, value]) => (
            <div key={label} className="px-5 py-4">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono text-2xl tabular-nums">
                {sample && !sample.error ? value : "—"}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {unavailable && (
        <Note type="warning" label="Live readings unavailable">
          {sample?.error || "The stream is delayed or disconnected."}{" "}
          {paused ? "Resume monitoring to retry." : "Retrying automatically."} Any retained chart
          points are historical, not current measurements.
        </Note>
      )}
      {!sample && !unavailable && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-muted-foreground"
        >
          <Spinner /> Reading interfaces from {device}…
        </div>
      )}

      {active && (
        <Card className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_250px]">
            <div
              className="min-w-0 p-5"
              style={{
                backgroundImage: "radial-gradient(var(--border) 0.7px, transparent 0.7px)",
                backgroundSize: "18px 18px",
              }}
            >
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mb-1 text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                    Selected interface
                  </p>
                  <h3 className="break-all font-mono text-xl font-semibold">{active.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {active.comment || `${active.type} interface on ${device}`}
                  </p>
                </div>
                <Badge
                  type={active.disabled ? "secondary" : active.running ? "success" : "warning"}
                >
                  {stateLabel(active)}
                </Badge>
              </div>
              <div className="mb-3 flex flex-wrap gap-x-8 gap-y-3">
                <div>
                  <span className="flex items-center gap-1 text-xs text-chart-2">
                    <ArrowDownLeft className="size-3.5" /> RX · received
                  </span>
                  <p className="mt-1 font-mono text-2xl tracking-tight">
                    {currentRate(active.rxRate)}
                  </p>
                </div>
                <div>
                  <span className="flex items-center gap-1 text-xs text-chart-1">
                    <ArrowUpRight className="size-3.5" /> TX · sent
                  </span>
                  <p className="mt-1 font-mono text-2xl tracking-tight">
                    {currentRate(active.txRate)}
                  </p>
                </div>
              </div>
              <TrafficGraph points={history[active.name] ?? []} />
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {active.rxRate == null && active.txRate == null
                    ? "Collecting a baseline · rates need two valid samples"
                    : "Last 60 samples · rates averaged between reads"}
                </span>
                <span>
                  {paused ? "Frozen at " : "Last sample "}
                  {sample ? clock(sample.ts) : "—"}
                </span>
              </div>
            </div>
            <div className="border-t lg:border-t-0 lg:border-l border-border bg-muted/20 p-5">
              <p className="mb-4 flex items-center gap-2 text-xs font-semibold">
                <Cable className="size-4 text-primary" /> Interface counters
              </p>
              <dl className="grid grid-cols-2 lg:grid-cols-1 gap-3 text-xs">
                {[
                  ["RX total", total(active.rxBytes)],
                  ["TX total", total(active.txBytes)],
                  [
                    "Packets/s · RX / TX",
                    unavailable ? "—" : `${count(active.rxPps)} / ${count(active.txPps)}`,
                  ],
                  ["Packets · RX / TX", `${count(active.rxPackets)} / ${count(active.txPackets)}`],
                  ["Errors · RX / TX", `${count(active.rxErrors)} / ${count(active.txErrors)}`],
                  ["Drops · RX / TX", `${count(active.rxDrops)} / ${count(active.txDrops)}`],
                  ["TX queue drops", count(active.queueDrops)],
                  ["Link downs", count(active.linkDowns)],
                  ["MTU", count(active.mtu)],
                  ["MAC address", active.mac || "Not reported"],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 break-all font-mono tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </Card>
      )}

      <section aria-label="All interfaces" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold">
            <Network className="size-4 text-primary" /> All interfaces{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {matching.length} / {rows.length}
            </span>
          </h3>
          <div className="relative w-full sm:w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search interfaces"
              placeholder="Name, type, MAC or comment…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(24);
              }}
              className="pl-9"
            />
          </div>
          <Select
            aria-label="Filter interface status"
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setLimit(24);
            }}
            options={[
              { value: "all", label: "All states" },
              { value: "running", label: "Running" },
              { value: "down", label: "Link down" },
              { value: "disabled", label: "Disabled" },
            ]}
          />
          <Select
            aria-label="Filter interface type"
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              setLimit(24);
            }}
            options={[
              { value: "all", label: "All types" },
              ...[...new Set(rows.map((row) => row.type))]
                .sort()
                .map((type) => ({ value: type, label: type })),
            ]}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {matching.slice(0, limit).map((row) => (
            <button
              type="button"
              key={row.name}
              aria-pressed={active?.name === row.name}
              onClick={() => setSelected(row.name)}
              className={`min-w-0 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${active?.name === row.name ? "border-primary/70 bg-primary/5 shadow-sm" : "border-border bg-card hover:border-primary/40 hover:bg-accent/40"}`}
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <span className="break-all font-mono text-sm font-semibold">{row.name}</span>
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${row.disabled ? "bg-muted-foreground" : row.running ? "bg-chart-2" : "bg-warning"}`}
                  aria-label={stateLabel(row)}
                />
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {row.type} · {stateLabel(row)}
                {row.dynamic ? " · dynamic" : ""}
              </p>
              <div aria-hidden="true" className="my-2 pointer-events-none">
                <TrafficGraph points={history[row.name] ?? []} small />
              </div>
              <div className="flex flex-wrap justify-between gap-2 font-mono text-xs tabular-nums">
                <span className="text-chart-2">↓ RX {currentRate(row.rxRate)}</span>
                <span className="text-chart-1">↑ TX {currentRate(row.txRate)}</span>
              </div>
              {row.comment && (
                <p className="mt-2 truncate text-[11px] text-muted-foreground" title={row.comment}>
                  {row.comment}
                </p>
              )}
            </button>
          ))}
        </div>
        {sample && !sample.error && !matching.length && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {rows.length
              ? "No interfaces match these filters. Try a different name or state."
              : "This router returned no interfaces."}
          </div>
        )}
        {matching.length > limit && (
          <Button ghost onClick={() => setLimit(limit + 24)}>
            Show more interfaces ({matching.length - limit} remaining)
          </Button>
        )}
      </section>
      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        Read-only monitoring. RX enters the interface; TX leaves it. Bridge, tunnel and
        physical-port counters can overlap and are not added together. Totals are router counters,
        not session usage. “—” means not reported or awaiting a baseline.
      </p>
    </div>
  );
}

export function InterfacesView() {
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
  return (
    <section className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-chart-2">
            Interface observatory
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Every link. In view.</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Inspect traffic and counters without changing your network.
          </p>
        </div>
        <div className="grid min-w-48 gap-1.5">
          <span className="text-[11px] text-muted-foreground">Router</span>
          <Select
            aria-label="Select router for interfaces"
            value={device}
            onValueChange={setDevice}
            disabled={!devices}
            placeholder="Choose a router"
            options={(devices?.devices ?? [])
              .filter((d) => !d.disabled)
              .map((d) => ({ value: d.name, label: d.name }))}
          />
        </div>
      </div>
      {error ? (
        <Note type="error" label="Could not load routers">
          {error}{" "}
          <Button ghost size="sm" onClick={() => setRetry(retry + 1)}>
            Try again
          </Button>
        </Note>
      ) : device ? (
        <InterfaceMonitor key={device} device={device} />
      ) : (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {devices
            ? "No enabled routers. Add or enable one on the Devices page."
            : "Loading configured routers…"}
        </p>
      )}
    </section>
  );
}
