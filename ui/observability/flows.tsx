/**
 * Flows view — continuous traffic analytics from collected NetFlow/IPFIX.
 *
 * The page is built around the question people actually arrive with ("who is
 * using my bandwidth"), so the ranking comes first and the pretty parts follow:
 *
 *   • **Collector health strip** — packets, decode errors and *templates
 *     pending*, which is the number that explains an empty page. It sits at the
 *     top precisely because an empty flow page and an idle link look identical.
 *   • **Top talkers** — ranked bars, switchable by source / destination /
 *     conversation / application, with a window selector.
 *   • **Conversation chords** — src → dst arcs, thickness by bytes. Laid out
 *     with plain trigonometry (the same approach `topology.tsx` takes) rather
 *     than pulling in a chart dependency for one view.
 *   • **Timeline** — stacked bytes per bucket, top-N series plus "other".
 *   • **Protocol & application mix** — with the long tail already folded into
 *     "other" by the server, so this is never a 200-slice donut.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type {
  FlowConversation,
  FlowHealth,
  FlowTimelinePayload,
  FlowTopEntry,
  FlowTopPayload,
} from "./types";
import { cn } from "@/lib/utils";

const WINDOWS = ["5m", "15m", "1h", "6h", "24h"] as const;
type Window = (typeof WINDOWS)[number];

const DIMENSIONS = [
  { id: "source", label: "Source" },
  { id: "destination", label: "Destination" },
  { id: "conversation", label: "Conversation" },
  { id: "application", label: "Application" },
] as const;
type Dimension = (typeof DIMENSIONS)[number]["id"];

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Stable colour per series key so a talker keeps its colour across renders. */
function hueFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

function seriesColor(key: string): string {
  return key === "other" ? "var(--muted-foreground)" : `hsl(${hueFor(key)} 65% 55%)`;
}

// ── Collector health ────────────────────────────────────────────────────────

function HealthStrip({ health }: { health: FlowHealth | null }): ReactNode {
  if (!health) return null;
  const c = health.collector;
  const exporters = Object.entries(c.exporters);

  return (
    <Panel
      title="Collector"
      extra={
        <Badge type={c.running ? "success" : "secondary"}>
          {c.running ? `listening · UDP ${c.port}` : "stopped"}
        </Badge>
      }
    >
      {!c.running && (
        <p className="mb-3 text-sm text-muted-foreground">
          Nothing is being collected. Start it with{" "}
          <span className="font-mono">start_flow_collector</span>, then point the router at this
          host with <span className="font-mono">add_traffic_flow_target</span>.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard k="Packets" v={c.packets.toLocaleString()} sub="received" />
        <StatCard k="Flows" v={c.flows.toLocaleString()} sub="decoded" />
        <StatCard
          k="Templates"
          v={String(c.templates)}
          sub={c.templatesPending > 0 ? `${c.templatesPending} pending` : "all resolved"}
          cls={c.templatesPending > 0 ? "text-amber-500" : undefined}
        />
        <StatCard
          k="Decode errors"
          v={String(c.decodeErrors)}
          cls={c.decodeErrors > 0 ? "text-red-500" : undefined}
          sub={c.templatesDropped > 0 ? `${c.templatesDropped} dropped` : undefined}
        />
        <StatCard
          k="Stored"
          v={health.store ? health.store.rawRows.toLocaleString() : "—"}
          sub={health.store ? `${health.store.rollupRows.toLocaleString()} rollups` : "no store"}
        />
      </div>

      {c.templatesPending > 0 && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          {c.templatesPending} data set(s) are waiting for their template. v9/IPFIX exporters
          describe their field layout only every few minutes — flows appear right after the next
          refresh.
        </p>
      )}
      {c.lastError && (
        <p className="mt-2 font-mono text-xs text-muted-foreground">last: {c.lastError}</p>
      )}
      {exporters.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Exporters:{" "}
          {exporters.map(([addr, n]) => `${addr} (${n.toLocaleString()} pkt)`).join(" · ")}
        </p>
      )}
    </Panel>
  );
}

// ── Ranked bars ─────────────────────────────────────────────────────────────

function TalkerBars({ rows }: { rows: FlowTopEntry[] }): ReactNode {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No flows in this window.</p>;
  }
  const max = Math.max(...rows.map((r) => r.bytes), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3">
          <span className="truncate font-mono text-sm" title={r.key}>
            {r.key}
          </span>
          <span className="h-3 overflow-hidden rounded-sm bg-muted/40">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(r.bytes / max) * 100}%`, background: seriesColor(r.key) }}
            />
          </span>
          <span className="whitespace-nowrap text-sm tabular-nums">
            {humanBytes(r.bytes)}
            <span className="ml-2 text-xs text-muted-foreground">
              {(r.share * 100).toFixed(1)}%
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Conversation chords ─────────────────────────────────────────────────────

/**
 * Endpoints on a circle, one arc per conversation, stroke width by bytes. Plain
 * SVG + trigonometry — a chord diagram is a few lines of maths and does not
 * justify a charting dependency.
 */
function Chords({ rows }: { rows: FlowConversation[] }): ReactNode {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations in this window.</p>;
  }
  const nodes = [...new Set(rows.flatMap((r) => [r.src, r.dst]))];
  const size = 460;
  const radius = size / 2 - 70;
  const centre = size / 2;
  const angle = (i: number): number => (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
  const point = (i: number): { x: number; y: number } => ({
    x: centre + radius * Math.cos(angle(i)),
    y: centre + radius * Math.sin(angle(i)),
  });
  const maxBytes = Math.max(...rows.map((r) => r.bytes), 1);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto h-auto w-full max-w-[460px]">
        {rows.map((r) => {
          const a = point(nodes.indexOf(r.src));
          const b = point(nodes.indexOf(r.dst));
          // Quadratic through the centre: the arc bows inward, which is what
          // makes a busy diagram readable instead of a ball of straight lines.
          const width = 1 + (r.bytes / maxBytes) * 10;
          return (
            <path
              key={`${r.src}-${r.dst}`}
              d={`M ${a.x} ${a.y} Q ${centre} ${centre} ${b.x} ${b.y}`}
              fill="none"
              stroke={seriesColor(r.src)}
              strokeOpacity={0.45}
              strokeWidth={width}
            >
              <title>{`${r.src} ↔ ${r.dst} — ${humanBytes(r.bytes)} (${r.applications.slice(0, 3).join(", ")})`}</title>
            </path>
          );
        })}
        {nodes.map((node, i) => {
          const p = point(i);
          const isRight = Math.cos(angle(i)) >= 0;
          return (
            <g key={node}>
              <circle cx={p.x} cy={p.y} r={4} fill={seriesColor(node)} />
              <text
                x={p.x + (isRight ? 8 : -8)}
                y={p.y + 4}
                textAnchor={isRight ? "start" : "end"}
                className="fill-muted-foreground text-[10px]"
              >
                {node}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

function Timeline({ data }: { data: FlowTimelinePayload | null }): ReactNode {
  if (!data || data.buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">No traffic in this window.</p>;
  }
  const keys = [...data.keys, "other"];
  const totals = data.buckets.map((b) => keys.reduce((n, k) => n + (b.series[k] ?? 0), 0));
  const max = Math.max(...totals, 1);

  return (
    <div>
      <div className="flex h-40 items-end gap-px">
        {data.buckets.map((bucket) => (
          <div
            key={bucket.ts}
            className="flex flex-1 flex-col-reverse"
            title={`${new Date(bucket.ts).toLocaleTimeString()} — ${humanBytes(
              keys.reduce((n, k) => n + (bucket.series[k] ?? 0), 0),
            )}`}
          >
            {keys.map((key) => {
              const value = bucket.series[key] ?? 0;
              if (value === 0) return null;
              return (
                <span
                  key={key}
                  style={{ height: `${(value / max) * 100}%`, background: seriesColor(key) }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {keys.map((key) => (
          <span key={key} className="flex items-center gap-1">
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: seriesColor(key) }}
            />
            {key}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function FlowsView(): ReactNode {
  const [window, setWindow] = useState<Window>("1h");
  const [dimension, setDimension] = useState<Dimension>("source");
  const [top, setTop] = useState<FlowTopPayload | null>(null);
  const [talks, setTalks] = useState<FlowConversation[]>([]);
  const [line, setLine] = useState<FlowTimelinePayload | null>(null);
  const [health, setHealth] = useState<FlowHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [topRes, convRes, lineRes, healthRes] = await Promise.all([
        api<FlowTopPayload>(`/api/flows/top?window=${window}&dimension=${dimension}`),
        api<{ conversations: FlowConversation[] }>(`/api/flows/conversations?window=${window}`),
        api<FlowTimelinePayload>(`/api/flows/timeline?window=${window}&dimension=${dimension}`),
        api<FlowHealth>("/api/flows/health"),
      ]);
      setTop(topRes);
      setTalks(convRes.conversations);
      setLine(lineRes);
      setHealth(healthRes);
      setError(topRes.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [window, dimension]);

  useEffect(() => {
    void load();
    // Flow data changes on the exporter's timeout (15 s inactive by default), so
    // a 10-second refresh is as live as the data can actually be.
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const totals = top?.totals;

  return (
    <div className="space-y-4">
      <HealthStrip health={health} />

      {error && (
        <Panel title="Flows">
          <p className="text-sm text-red-500">{error}</p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard k="Traffic" v={totals ? humanBytes(totals.bytes) : "—"} sub={`last ${window}`} />
        <StatCard k="Flows" v={totals ? totals.flows.toLocaleString() : "—"} sub="records" />
        <StatCard k="Sources" v={totals ? String(totals.sources) : "—"} sub="talking" />
        <StatCard k="Destinations" v={totals ? String(totals.destinations) : "—"} sub="talked to" />
      </div>

      <Panel
        title="Top talkers"
        extra={
          <div className="flex flex-wrap items-center gap-1">
            {DIMENSIONS.map((d) => (
              <Button
                key={d.id}
                size="sm"
                type={d.id === dimension ? "default" : "secondary"}
                onClick={() => setDimension(d.id)}
              >
                {d.label}
              </Button>
            ))}
            <span className="mx-2 h-4 w-px bg-border" />
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                type={w === window ? "default" : "secondary"}
                onClick={() => setWindow(w)}
              >
                {w}
              </Button>
            ))}
          </div>
        }
      >
        <TalkerBars rows={top?.top ?? []} />
      </Panel>

      <Panel title={`Bytes over time · ${window}`}>
        <Timeline data={line} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Conversations">
          <Chords rows={talks.slice(0, 12)} />
        </Panel>

        <Panel title="Applications & protocols">
          <TalkerBars rows={top?.applications ?? []} />
          {top && top.protocols.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {top.protocols.map((p) => (
                <span key={p.protocol} className="flex items-center gap-1 text-sm">
                  <Dot type="default" />
                  <span className="font-mono">{p.protocol}</span>
                  <span className="text-muted-foreground">{(p.share * 100).toFixed(0)}%</span>
                </span>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Busiest conversations">
        {talks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded in this window.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {talks.map((c) => (
              <li
                key={`${c.src}-${c.dst}`}
                className={cn("flex items-center gap-3 py-2", "font-mono")}
              >
                <span className="flex-1 truncate">
                  {c.src} ↔ {c.dst}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {c.applications.slice(0, 3).join(", ")}
                </span>
                <span className="whitespace-nowrap tabular-nums">{humanBytes(c.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
