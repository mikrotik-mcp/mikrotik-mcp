/**
 * Network → Topology: the layer-2 neighbours each router reports, drawn as one
 * radial map.
 *
 * The MCP server sits at the hub, because it polls every router. Managed routers
 * sit on the inner ring as gauge nodes (outer ring = CPU, inner ring = memory).
 * Neighbours found over MNDP/CDP/LLDP sit on the outer ring, linked to the
 * router that saw them. A neighbour MCP could manage has a dashed outline and a
 * plus.
 *
 * Positions come from `topology-layout.ts` (deterministic, no randomness).
 * Interaction: wheel to zoom about the cursor, drag to pan, hover to focus a
 * node's links (everything else dims), click to inspect, search to dim
 * non-matching nodes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent,
} from "react";
import { Minus, Plus, Radar, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorSearch,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import { toast } from "./toast-action";
import { CX, CY, H, HUB_ID, layout, W } from "./topology-layout";
import type { TopoNode, TopologyPayload } from "./types";

type Onboard = (name: string, body: Record<string, unknown>) => void;

/** Colour a 0–100 metric the way the board does: ok, then warn, then bad. */
function metricColor(v: number | undefined): string {
  if (v == null) return "var(--success)";
  if (v >= 85) return "var(--destructive)";
  if (v >= 60) return "var(--warning)";
  return "var(--success)";
}

function statusColor(n: TopoNode): string {
  if (n.reachable === true) return "var(--success)";
  if (n.reachable === false) return "var(--destructive)";
  return "var(--muted-foreground)";
}

/** Dash pattern that paints `pct` of a circle of radius `r` (board: `on full`). */
function ringDash(r: number, pct: number | undefined): string {
  const full = 2 * Math.PI * r;
  return `${(Math.min(100, Math.max(0, pct ?? 0)) / 100) * full} ${full}`;
}

/** A quadratic link from `a` to `b`, bowed sideways by `bow` of its length. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bow: number): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return `M${a.x} ${a.y} Q${(mx - dy * bow).toFixed(1)} ${(my + dx * bow).toFixed(1)} ${b.x} ${b.y}`;
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** Text halo so labels stay readable over links. */
const HALO = {
  stroke: "var(--card)",
  strokeWidth: 4,
  paintOrder: "stroke",
  strokeLinejoin: "round",
} as const;

/** The whole page: header, KPI strip and the map panel. */
export function TopologyView({
  topo,
  loading,
  onOnboard,
}: {
  topo: TopologyPayload | null;
  loading: boolean;
  onOnboard?: Onboard;
}): ReactNode {
  const hasMap = topo != null && topo.nodes.length > 0;
  const offline = topo?.nodes.filter((n) => n.kind === "device" && n.reachable === false) ?? [];

  return (
    <section className="grid min-w-0 content-start gap-6">
      <PageIntro
        tone={topo ? "good" : undefined}
        live={topo != null}
        title={
          topo ? (
            <span className="text-muted-foreground text-[13px] font-normal">
              <b className="text-foreground font-[510]">
                {topo.stats.devices} managed · {topo.stats.neighbors} discovered
              </b>{" "}
              · {topo.stats.onboardable} waiting to be added · updated {clock(topo.generatedAt)}
            </span>
          ) : undefined
        }
      >
        The layer-2 neighbours each router sees over MNDP, CDP and LLDP, drawn as one map.
      </PageIntro>

      {!topo && loading ? (
        <LoadingState label="Discovering network topology" layout="cards" />
      ) : hasMap ? (
        <>
          <MetricStrip label="Topology counts" minCell={200}>
            <Metric label="Managed" value={topo.stats.devices} hint="routers in your config" />
            <Metric label="Discovered" value={topo.stats.neighbors} hint="neighbours they report" />
            <Metric
              label="Waiting to be added"
              tone="brand"
              value={topo.stats.onboardable}
              hint="MikroTik, reachable by address or MAC"
            />
            <Metric
              label="Offline"
              tone={offline.length > 0 ? "bad" : "default"}
              value={offline.length}
              hint={
                offline.length > 0
                  ? offline.map((n) => n.label || n.id).join(", ")
                  : "every router answers"
              }
            />
          </MetricStrip>
          <TopologyMap topo={topo} onOnboard={onOnboard} />
        </>
      ) : (
        <div className="monitor-panel">
          <MonitorEmpty icon={<Radar />} title="No neighbours discovered yet">
            Layer-2 neighbours (MNDP, CDP, LLDP) show up here when a router reports them.
          </MonitorEmpty>
        </div>
      )}
    </section>
  );
}

/** The map panel: toolbar, map, legend, and the inspector on the right. */
export function TopologyMap({
  topo,
  onOnboard,
}: {
  topo: TopologyPayload;
  onOnboard?: Onboard;
}): ReactNode {
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const devices = useMemo(() => topo.nodes.filter((n) => n.kind === "device"), [topo.nodes]);
  const neighbors = useMemo(() => topo.nodes.filter((n) => n.kind === "neighbor"), [topo.nodes]);

  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    const nbIds = new Set(neighbors.map((n) => n.id));
    for (const e of topo.edges) if (nbIds.has(e.to) && !m.has(e.to)) m.set(e.to, e.from);
    return m;
  }, [topo.edges, neighbors]);

  const { pos, rInner, rOuter } = useMemo(
    () => layout(devices, neighbors, parentOf),
    [devices, neighbors, parentOf],
  );

  const byId = useMemo(() => new Map(topo.nodes.map((n) => [n.id, n])), [topo.nodes]);
  const pickedNode = picked ? byId.get(picked) : null;

  /** Ids next to each node (including itself): drives hover focus. */
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string): void => {
      if (!m.has(a)) m.set(a, new Set([a]));
      m.get(a)!.add(b);
    };
    for (const d of devices) {
      add(d.id, HUB_ID);
      add(HUB_ID, d.id);
    }
    for (const e of topo.edges) {
      add(e.from, e.to);
      add(e.to, e.from);
    }
    return m;
  }, [topo.edges, devices]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (n: TopoNode): boolean => {
      if (onlyNew && !n.onboardable) return false;
      if (!q) return true;
      return [n.label, n.id, n.ip, n.mac, n.board, n.identity]
        .filter((s): s is string => Boolean(s))
        .some((s) => s.toLowerCase().includes(q));
    },
    [q, onlyNew],
  );

  /** Hover focuses a node's links; otherwise the search decides. */
  const focus = hover ? adjacency.get(hover) : null;
  const dimmed = (id: string): boolean => {
    if (focus) return !focus.has(id);
    if (id === HUB_ID) return false;
    const n = byId.get(id);
    return n ? !matches(n) : false;
  };

  // ── pan / zoom ────────────────────────────────────────────────────────────
  const onWheel = (e: WheelEvent<SVGSVGElement>): void => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Zoom about the cursor: the point under the pointer stays put.
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    setView((v) => {
      const k = Math.min(3, Math.max(0.5, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const s = k / v.k;
      return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s };
    });
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    drag.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const sx = (W / rect.width) * (e.clientX - d.px);
    const sy = (H / rect.height) * (e.clientY - d.py);
    setView((v) => ({ ...v, x: d.ox + sx, y: d.oy + sy }));
  };
  const endDrag = (): void => {
    drag.current = null;
    setPanning(false);
  };
  const zoom = (f: number): void =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.5, v.k * f));
      const s = k / v.k;
      return { k, x: CX - (CX - v.x) * s, y: CY - (CY - v.y) * s };
    });

  const hub = { x: CX, y: CY };
  const pickedEdge = picked ? topo.edges.find((e) => e.to === picked) : undefined;

  return (
    <section className="monitor-panel @container" aria-label="Topology map">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        <MonitorSearch
          className="flex-[1_1_280px]"
          label="Filter the map"
          placeholder="Filter by name, identity, IP, MAC or board"
          value={query}
          onChange={setQuery}
        />
        <MonitorButton
          size="sm"
          className="aria-pressed:bg-accent aria-pressed:text-brand aria-pressed:shadow-[inset_0_0_0_1px_var(--chart-1)]"
          aria-pressed={onlyNew}
          icon={<Plus />}
          onClick={() => setOnlyNew((v) => !v)}
        >
          Can be added ({topo.stats.onboardable})
        </MonitorButton>
        <span aria-hidden="true" className="bg-input mx-1 h-5 w-px" />
        <div className="inline-flex items-center gap-0.5">
          <MonitorButton
            size="sm"
            variant="ghost"
            aria-label="Zoom out"
            icon={<Minus />}
            onClick={() => zoom(1 / 1.25)}
          />
          <span className="text-fg-secondary w-10 text-center text-[12px] tabular-nums">
            {Math.round(view.k * 100)}%
          </span>
          <MonitorButton
            size="sm"
            variant="ghost"
            aria-label="Zoom in"
            icon={<Plus />}
            onClick={() => zoom(1.25)}
          />
        </div>
        <MonitorButton size="sm" variant="ghost" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          Reset view
        </MonitorButton>
      </div>

      <div className="border-border flex flex-wrap border-t">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col">
          {/* ── map ─────────────────────────────────────────────────────── */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`Map of ${devices.length} managed routers and the ${neighbors.length} neighbours they report`}
            className={cn(
              "block aspect-[760/580] max-h-[580px] w-full touch-none select-none",
              panning ? "cursor-grabbing" : "cursor-grab",
            )}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            onClick={() => setPicked(null)}
            style={{
              background:
                "radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--chart-1) 7%, transparent), transparent 60%)",
            }}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {[rInner, rOuter].map((r) => (
                <circle
                  key={r}
                  cx={CX}
                  cy={CY}
                  r={r}
                  fill="none"
                  stroke="var(--chart-grid)"
                  strokeDasharray="2 6"
                />
              ))}

              {/* links: hub → router, then router → neighbour */}
              {devices.map((d) => {
                const b = pos.get(d.id);
                if (!b) return null;
                const down = d.reachable === false;
                return (
                  <path
                    key={`h-${d.id}`}
                    d={curve(hub, b, 0.08)}
                    fill="none"
                    stroke={down ? "var(--destructive)" : "var(--success)"}
                    strokeWidth={1.25}
                    strokeDasharray="4 4"
                    opacity={dimmed(d.id) ? 0.12 : down ? 0.8 : 0.6}
                    className="transition-opacity"
                  >
                    <title>
                      {topo.server} → {d.label || d.id}
                    </title>
                  </path>
                );
              })}
              {topo.edges.map((e, i) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                const down = byId.get(e.from)?.reachable === false;
                const faded = dimmed(e.from) || dimmed(e.to);
                return (
                  <path
                    key={`e-${i}`}
                    d={curve(a, b, 0.06)}
                    fill="none"
                    stroke={down ? "var(--destructive)" : "var(--chart-1)"}
                    strokeWidth={1.25}
                    strokeDasharray="3 4"
                    opacity={faded ? 0.12 : 0.55}
                    className="transition-opacity"
                  >
                    <title>
                      {e.from} → {e.to}
                      {e.interface ? ` (${e.interface})` : ""}
                    </title>
                  </path>
                );
              })}

              {/* hub: the MCP server every managed router is polled from */}
              <g
                className={cn("transition-opacity", focus && !focus.has(HUB_ID) && "opacity-15")}
                onMouseEnter={() => setHover(HUB_ID)}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  cx={CX}
                  cy={CY}
                  r={30}
                  fill="color-mix(in srgb, var(--chart-1) 16%, var(--card))"
                  stroke="var(--chart-1)"
                  strokeWidth={1.25}
                />
                <text
                  x={CX}
                  y={CY + 4}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={590}
                  fill="var(--foreground)"
                  className="pointer-events-none"
                >
                  MCP
                </text>
                <text
                  x={CX}
                  y={CY + 48}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--muted-foreground)"
                  className="pointer-events-none font-mono"
                  {...HALO}
                >
                  {topo.server}
                </text>
              </g>

              {/* nodes */}
              {topo.nodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const sel = picked === n.id;
                const name = n.label || n.id;
                const select = (ev: { stopPropagation: () => void }): void => {
                  ev.stopPropagation();
                  setPicked((cur) => (cur === n.id ? null : n.id));
                };
                const common = {
                  transform: `translate(${p.x},${p.y})`,
                  className: cn("cursor-pointer transition-opacity", dimmed(n.id) && "opacity-15"),
                  onMouseEnter: () => setHover(n.id),
                  onMouseLeave: () => setHover(null),
                  onClick: select,
                };

                if (n.kind === "device") {
                  const down = n.reachable === false;
                  return (
                    <g key={n.id} {...common}>
                      {sel && (
                        <circle
                          r={40}
                          fill="color-mix(in srgb, var(--chart-1) 18%, transparent)"
                          stroke="var(--chart-1)"
                          strokeWidth={1}
                        />
                      )}
                      <circle r={33} fill="none" stroke="var(--overlay-08)" strokeWidth={3} />
                      <circle
                        r={33}
                        fill="none"
                        stroke={metricColor(n.cpuLoad)}
                        strokeWidth={3}
                        strokeDasharray={ringDash(33, n.cpuLoad)}
                        transform="rotate(-90)"
                      />
                      <circle r={28} fill="none" stroke="var(--overlay-08)" strokeWidth={3} />
                      <circle
                        r={28}
                        fill="none"
                        stroke={metricColor(n.memUsedPct)}
                        strokeWidth={3}
                        strokeDasharray={ringDash(28, n.memUsedPct)}
                        transform="rotate(-90)"
                      />
                      <circle
                        r={22}
                        fill="var(--muted)"
                        stroke={statusColor(n)}
                        strokeWidth={1.5}
                      />
                      <text
                        y={4}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={590}
                        fill="var(--foreground)"
                        className="pointer-events-none font-mono"
                      >
                        {name.split("-")[0].slice(0, 4).toUpperCase()}
                      </text>
                      <text
                        y={52}
                        textAnchor="middle"
                        fontSize={12}
                        fill="var(--foreground)"
                        className="pointer-events-none font-mono"
                        {...HALO}
                      >
                        {name.slice(0, 22)}
                      </text>
                      <text
                        y={66}
                        textAnchor="middle"
                        fontSize={11}
                        fill={down ? "var(--destructive)" : "var(--muted-foreground)"}
                        className="pointer-events-none"
                        {...HALO}
                      >
                        {down ? "offline" : n.ip || n.board || ""}
                      </text>
                    </g>
                  );
                }

                const parentDown = byId.get(parentOf.get(n.id) ?? "")?.reachable === false;
                const below = p.y > CY + 1;
                return (
                  <g key={n.id} {...common}>
                    {sel && (
                      <circle
                        r={22}
                        fill="color-mix(in srgb, var(--chart-1) 18%, transparent)"
                        stroke="var(--chart-1)"
                        strokeWidth={1}
                      />
                    )}
                    {/* a diamond, so a neighbour never reads as a managed router */}
                    <rect
                      x={-9}
                      y={-9}
                      width={18}
                      height={18}
                      rx={3}
                      fill="var(--muted)"
                      stroke={
                        n.onboardable
                          ? "var(--chart-1)"
                          : parentDown
                            ? "var(--destructive)"
                            : "var(--muted-foreground)"
                      }
                      strokeWidth={1.25}
                      strokeDasharray={n.onboardable ? "3 2" : undefined}
                      transform="rotate(45)"
                    />
                    {n.onboardable && (
                      <text
                        y={5}
                        textAnchor="middle"
                        fontSize={13}
                        fontWeight={590}
                        fill="var(--brand)"
                        className="pointer-events-none"
                      >
                        +
                      </text>
                    )}
                    <text
                      y={below ? 30 : -18}
                      textAnchor="middle"
                      fontSize={11}
                      fill="var(--text-secondary)"
                      className="pointer-events-none font-mono"
                      {...HALO}
                    >
                      {name.slice(0, 22)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* ── legend ──────────────────────────────────────────────────── */}
          <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-3 text-[12px]">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone="good" />
              Online
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone="bad" />
              Offline
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-[9px] rotate-45 rounded-[2px] shadow-[inset_0_0_0_1.25px_var(--muted-foreground)]"
              />
              Neighbour
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="border-chart-1 size-[9px] rotate-45 rounded-[2px] border-[1.25px] border-dashed"
              />
              Can be added
            </span>
            <span className="inline-flex items-center gap-1.5">
              Outer ring CPU · inner ring memory
            </span>
            <span className="flex-1" />
            <span>Drag to move · scroll to zoom · hover a node to see its links</span>
          </div>
        </div>

        {/* ── inspector ───────────────────────────────────────────────────── */}
        {pickedNode && (
          <Inspector
            node={pickedNode}
            seenBy={pickedEdge?.from}
            via={pickedEdge?.interface}
            onClose={() => setPicked(null)}
            onOnboard={onOnboard}
          />
        )}
      </div>
    </section>
  );
}

/** Details for the selected node, plus its config stub when MCP could manage it. */
function Inspector({
  node,
  seenBy,
  via,
  onClose,
  onOnboard,
}: {
  node: TopoNode;
  seenBy?: string;
  via?: string;
  onClose: () => void;
  onOnboard?: Onboard;
}): ReactNode {
  const name = node.label || node.id;
  const isDev = node.kind === "device";
  const stub = node.suggestedConfig
    ? JSON.stringify({ [node.suggestedConfig.name]: stubBody(node.suggestedConfig) }, null, 2)
    : null;

  const facts: [string, string | undefined, boolean?][] = [
    ["Identity", node.identity],
    ["Address", node.ip, true],
    ["MAC", node.mac, true],
    ["Board", node.board],
    ["Platform", node.platform],
    ["Version", node.version],
    ["Uptime", node.uptime],
  ];
  if (isDev) {
    facts.push(["CPU", node.cpuLoad != null ? `${node.cpuLoad}%` : undefined]);
    facts.push(["Memory", node.memUsedPct != null ? `${node.memUsedPct}%` : undefined]);
  }
  const known = facts.filter((f) => Boolean(f[1]));

  const subtitle = isDev
    ? node.reachable === false
      ? "Managed router, not answering"
      : "Managed router"
    : seenBy
      ? `Seen by ${seenBy}${via ? ` on ${via}` : ""}`
      : null;

  return (
    <aside
      className="monitor-side flex flex-col @max-[900px]:max-w-none @max-[900px]:flex-[1_1_100%] @max-[900px]:border-t @max-[900px]:border-l-0"
      aria-label={`${isDev ? "Router" : "Neighbour"} details: ${name}`}
    >
      <div className="border-border flex flex-col gap-2 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="monitor-badge">{isDev ? "Managed" : "Neighbour"}</span>
          {node.onboardable && (
            <span className="monitor-badge text-brand">
              <StatusDot tone="brand" />
              Can be added
            </span>
          )}
          {node.reachable === false && <StatusBadge tone="bad">Offline</StatusBadge>}
          {isDev && node.reachable === true && <StatusBadge tone="good">Online</StatusBadge>}
          <span className="flex-1" />
          <MonitorButton
            size="sm"
            variant="ghost"
            aria-label={`Close ${isDev ? "router" : "neighbour"} details`}
            icon={<X />}
            onClick={onClose}
          />
        </div>
        <h3 className="text-emphasis font-mono text-[15px] font-medium break-all">{name}</h3>
        {subtitle && <p className="text-muted-foreground text-[12px]">{subtitle}</p>}
      </div>
      <div className="flex flex-col gap-4 px-5 pt-4 pb-5">
        {known.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">No details advertised.</p>
        ) : (
          <dl
            className="monitor-facts"
            style={{ gridTemplateColumns: "88px minmax(0,1fr)" } as CSSProperties}
          >
            {known.map(([k, v, mono]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className={cn("break-all", mono && "font-mono text-[12px]")}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {stub && node.suggestedConfig && (
          <>
            <div className="flex flex-col gap-2">
              <span className="monitor-label">Not managed yet</span>
              <p className="text-fg-secondary text-[13px]">
                Add this entry to your device config to manage it from MCP.
              </p>
              <pre className="monitor-pre">{stub}</pre>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyStub text={stub} />
              {onOnboard && (
                <MonitorButton
                  size="sm"
                  variant="inverse"
                  onClick={() =>
                    onOnboard(node.suggestedConfig!.name, stubBody(node.suggestedConfig!))
                  }
                >
                  Add to Devices
                </MonitorButton>
              )}
            </div>
            {onOnboard && (
              <span className="text-muted-foreground text-[12px]">
                Add to Devices opens the router form with these values. Nothing is saved until you
                save it there.
              </span>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function CopyStub({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = (): void => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable. Select the text and copy it manually.");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      () => toast.error("Couldn't copy. Select the text and copy it manually."),
    );
  };
  return (
    <MonitorButton size="sm" onClick={copy}>
      {copied ? "Copied" : "Copy config stub"}
    </MonitorButton>
  );
}

/** The body half of a config stub (drops the `name` key). */
function stubBody(c: NonNullable<TopoNode["suggestedConfig"]>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (c.host) body.host = c.host;
  if (c.mac) body.mac = c.mac;
  body.port = c.port;
  body.username = c.username;
  return body;
}
