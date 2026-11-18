/**
 * Network → Topology: the layer-2 neighbours each router reports, drawn as one
 * map (Signal board Net-Topology).
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
 * non-matching nodes. Nodes settle into place when the map first draws.
 */
import "./topology.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent,
} from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { Copy, Plus, Radar, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { tipProps } from "./kit";
import type { TipCard, TipRow } from "./kit";
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
import { CX, CY, H, HUB_ID, INNER_Y, layout, OUTER_Y, W } from "./topology-layout";
import type { TopoEdge, TopoNode, TopologyPayload } from "./types";

type Onboard = (name: string, body: Record<string, unknown>) => void;

/** Colour a 0–100 metric the way the board does: teal, then amber, then pink. */
function metricColor(v: number): string {
  if (v >= 85) return "var(--destructive)";
  if (v >= 60) return "var(--warning)";
  return "var(--sig)";
}

/** Dash pattern that paints `pct` of a circle of radius `r` (board: `on full`). */
function ringDash(r: number, pct: number): string {
  const full = 2 * Math.PI * r;
  return `${((Math.min(100, Math.max(0, pct)) / 100) * full).toFixed(1)} ${full.toFixed(1)}`;
}

const pct = (v: number): string => `${Math.round(v)}%`;

/** The card for a managed router or a neighbour on the map. */
function nodeCard(n: TopoNode, seenBy?: TopoEdge): TipCard {
  const rows: TipRow[] = [];
  if (n.kind === "device") {
    if (n.cpuLoad != null)
      rows.push({ label: "CPU", value: pct(n.cpuLoad), color: metricColor(n.cpuLoad) });
    if (n.memUsedPct != null)
      rows.push({ label: "Memory", value: pct(n.memUsedPct), color: metricColor(n.memUsedPct) });
  } else if (seenBy) {
    rows.push({ label: "Seen by", value: seenBy.from });
    if (seenBy.interface) rows.push({ label: "On", value: seenBy.interface });
  }
  if (n.identity && n.identity !== n.label) rows.push({ label: "Identity", value: n.identity });
  if (n.ip) rows.push({ label: "IP", value: n.ip });
  if (n.mac) rows.push({ label: "MAC", value: n.mac });
  if (n.board) rows.push({ label: "Board", value: n.board });
  if (n.platform) rows.push({ label: "Platform", value: n.platform });
  if (n.version) rows.push({ label: "Version", value: n.version });
  if (n.uptime) rows.push({ label: "Uptime", value: n.uptime });
  const state =
    n.kind === "device"
      ? n.reachable === false
        ? "Offline"
        : n.reachable === true
          ? "Online"
          : "Not checked"
      : n.onboardable
        ? "Can be added"
        : n.configured
          ? "Managed"
          : "Neighbour";
  return {
    title: n.label || n.id,
    sub: n.kind === "device" ? "router" : "neighbour",
    led:
      n.kind === "device"
        ? n.reachable === false
          ? "bad"
          : n.reachable === true
            ? "ok"
            : "off"
        : n.onboardable
          ? "acc"
          : "off",
    rows,
    foot: { label: "State", value: state },
  };
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
  stroke: "var(--background)",
  strokeWidth: 4,
  paintOrder: "stroke",
  strokeLinejoin: "round",
} as const;

const REDUCE = "(prefers-reduced-motion: reduce)";

/** The board's small uppercase section label. */
function SectionLabel({
  children,
  muted = false,
}: {
  children: ReactNode;
  /** The inspector's kind label is a step brighter than a section label. */
  muted?: boolean;
}): ReactNode {
  return (
    <span
      className={cn(
        "text-[11px] font-medium tracking-[0.08em] uppercase",
        muted ? "text-muted-foreground" : "text-faint",
      )}
    >
      {children}
    </span>
  );
}

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
        eyebrow={topo ? `Live · updated ${clock(topo.generatedAt)}` : undefined}
        heading={
          topo ? (
            <>
              {topo.stats.devices} managed, {topo.stats.neighbors} discovered.
              {topo.stats.onboardable > 0 && (
                <>
                  {" "}
                  <span className="s">{topo.stats.onboardable} can be added.</span>
                </>
              )}
            </>
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
              tone={topo.stats.onboardable > 0 ? "good" : "default"}
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

  // Nodes settle into place when the map first draws (and when the node set changes).
  const scope = useRef<Scope | null>(null);
  const settleKey = topo.nodes.map((n) => n.id).join("|");
  useEffect(() => {
    if (!svgRef.current) return;
    scope.current = createScope({ root: svgRef, mediaQueries: { reduceMotion: REDUCE } }).add(
      (self) => {
        if (self?.matches.reduceMotion) return;
        animate("[data-settle]", {
          opacity: [0, 1],
          scale: [0.6, 1],
          duration: 520,
          delay: stagger(28),
          ease: "outBack(1.4)",
        });
      },
    );
    return () => scope.current?.revert();
  }, [settleKey]);

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

  const pickedEdge = picked ? topo.edges.find((e) => e.to === picked) : undefined;

  return (
    <section className="monitor-panel" aria-label="Topology map">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <MonitorSearch
          className="topo-search"
          label="Filter the map"
          placeholder="Filter by name, identity, IP, MAC or board"
          value={query}
          onChange={setQuery}
        />
        <MonitorButton
          size="sm"
          className="aria-pressed:bg-acc-soft aria-pressed:text-brand aria-pressed:shadow-[inset_0_0_0_1px_var(--brand)]"
          aria-pressed={onlyNew}
          icon={<Plus aria-hidden="true" />}
          onClick={() => setOnlyNew((v) => !v)}
        >
          Can be added ({topo.stats.onboardable})
        </MonitorButton>
        <span className="flex-1" />
        <span className="monitor-seg items-center gap-0.5">
          <button
            type="button"
            className="monitor-seg-item"
            aria-label="Zoom out"
            onClick={() => zoom(1 / 1.25)}
          >
            −
          </button>
          <span className="px-1.5 font-mono text-[12px] text-fg-secondary tabular-nums">
            {Math.round(view.k * 100)}%
          </span>
          <button
            type="button"
            className="monitor-seg-item"
            aria-label="Zoom in"
            onClick={() => zoom(1.25)}
          >
            +
          </button>
        </span>
        <MonitorButton size="sm" variant="ghost" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          Reset view
        </MonitorButton>
      </div>

      <div className="topo-body" data-inspector={pickedNode ? true : undefined}>
        {/* ── map ─────────────────────────────────────────────────────────── */}
        <div className="min-w-0 px-2 py-1.5">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`Map of ${devices.length} managed routers and the ${neighbors.length} neighbours they report`}
            className={cn(
              "block aspect-[800/650] max-h-[650px] w-full touch-none select-none",
              panning ? "cursor-grabbing" : "cursor-grab",
            )}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            onClick={() => setPicked(null)}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {[
                [rInner, INNER_Y],
                [rOuter, OUTER_Y],
              ].map(([r, f]) => (
                <ellipse
                  key={r}
                  cx={CX}
                  cy={CY}
                  rx={r}
                  ry={r * f}
                  fill="none"
                  stroke="var(--line)"
                  strokeDasharray="1 5"
                />
              ))}

              {/* links: hub → router, then router → neighbour */}
              {devices.map((d) => {
                const b = pos.get(d.id);
                if (!b) return null;
                const down = d.reachable === false;
                return (
                  <line
                    key={`h-${d.id}`}
                    x1={CX}
                    y1={CY}
                    x2={b.x}
                    y2={b.y}
                    stroke={down ? "var(--destructive)" : "var(--sig)"}
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                    strokeDasharray={down ? "4 4" : undefined}
                    className={cn("transition-opacity", dimmed(d.id) && "opacity-15")}
                    {...tipProps((): TipCard => ({
                      title: `${topo.server} → ${d.label || d.id}`,
                      sub: "polled",
                      led: down ? "bad" : d.reachable === true ? "ok" : "off",
                      rows: [
                        { label: "From", value: topo.server },
                        { label: "To", value: d.label || d.id },
                        ...(d.ip ? [{ label: "IP", value: d.ip }] : []),
                      ],
                      foot: {
                        label: "State",
                        value: down ? "Offline" : d.reachable === true ? "Online" : "Not checked",
                      },
                    }))}
                  />
                );
              })}
              {topo.edges.map((e, i) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                const lit = e === pickedEdge;
                const faded = dimmed(e.from) || dimmed(e.to);
                const mx = (a.x + b.x) / 2;
                const my = (a.y + b.y) / 2;
                return (
                  <g key={`e-${i}`} className={cn("transition-opacity", faded && "opacity-15")}>
                    <path
                      d={curve(a, b, 0.12)}
                      fill="none"
                      stroke={lit ? "var(--sig)" : "var(--line-2)"}
                      strokeWidth={lit ? 2 : 1.2}
                      {...tipProps((): TipCard => ({
                        title: `${byId.get(e.from)?.label || e.from} → ${byId.get(e.to)?.label || e.to}`,
                        sub: "layer-2 link",
                        rows: [
                          { label: "Router", value: byId.get(e.from)?.label || e.from },
                          { label: "Neighbour", value: byId.get(e.to)?.label || e.to },
                          { label: "Interface", value: e.interface ?? "Not reported" },
                        ],
                      }))}
                    />
                    {lit && e.interface && (
                      <text
                        x={(mx - 46).toFixed(0)}
                        y={(my + 14).toFixed(0)}
                        fontSize={10}
                        fill="var(--success)"
                        className="pointer-events-none font-mono"
                        {...HALO}
                      >
                        {e.interface}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* hub: the MCP server every managed router is polled from */}
              <g
                className={cn("transition-opacity", focus && !focus.has(HUB_ID) && "opacity-15")}
                onMouseEnter={() => setHover(HUB_ID)}
                onMouseLeave={() => setHover(null)}
                {...tipProps((): TipCard => ({
                  title: topo.server,
                  sub: "MCP server",
                  rows: [
                    { label: "Routers", value: String(topo.stats.devices) },
                    { label: "Neighbours", value: String(topo.stats.neighbors) },
                    { label: "Can be added", value: String(topo.stats.onboardable) },
                  ],
                }))}
              >
                <circle cx={CX} cy={CY} r={46} fill="var(--sig)" opacity={0.06} />
                <circle
                  cx={CX}
                  cy={CY}
                  r={30}
                  fill="var(--glass-2)"
                  stroke="var(--sig)"
                  strokeOpacity={0.6}
                />
                <text
                  x={CX}
                  y={CY + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  letterSpacing="0.08em"
                  fill="var(--foreground)"
                  className="pointer-events-none"
                >
                  MCP
                </text>
              </g>

              {/* nodes */}
              {topo.nodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const sel = picked === n.id;
                const name = (n.label || n.id).slice(0, 22);
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
                  onKeyDown: (ev: {
                    key: string;
                    preventDefault: () => void;
                    stopPropagation: () => void;
                  }) => {
                    if (ev.key !== "Enter" && ev.key !== " ") return;
                    ev.preventDefault();
                    select(ev);
                  },
                  ...tipProps(() =>
                    nodeCard(
                      n,
                      topo.edges.find((e) => e.to === n.id),
                    ),
                  ),
                };

                if (n.kind === "device") {
                  const down = n.reachable === false;
                  // The top router's label sits to its right, so it stays clear of its neighbours.
                  const right = p.y < CY - 1;
                  const lx = right ? 38 : 0;
                  const ly = right ? -2 : 46;
                  const anchor = right ? "start" : "middle";
                  return (
                    <g key={n.id} {...common}>
                      <g data-settle>
                        {sel && (
                          <>
                            <circle r={33} fill="var(--sig)" opacity={0.14} />
                            <circle r={33} fill="none" stroke="var(--sig)" />
                          </>
                        )}
                        <circle r={27} fill="var(--surface-2)" stroke="var(--line-2)" />
                        {(
                          [
                            [24, n.cpuLoad],
                            [17.5, n.memUsedPct],
                          ] as const
                        ).map(([r, v]) => (
                          <g key={r}>
                            <circle r={r} fill="none" stroke="var(--line)" strokeWidth={3.5} />
                            {v != null && (
                              <circle
                                r={r}
                                fill="none"
                                stroke={metricColor(v)}
                                strokeWidth={3.5}
                                strokeLinecap="round"
                                strokeDasharray={ringDash(r, v)}
                                transform="rotate(-90)"
                              />
                            )}
                          </g>
                        ))}
                        <circle r={5} fill={down ? "var(--destructive)" : "var(--sig)"} />
                        <text
                          x={lx}
                          y={ly}
                          textAnchor={anchor}
                          fontSize={12}
                          fontWeight={600}
                          fill="var(--foreground)"
                          className="pointer-events-none font-mono"
                          {...HALO}
                        >
                          {name}
                        </text>
                        <text
                          x={lx}
                          y={ly + 14}
                          textAnchor={anchor}
                          fontSize={10}
                          fill={down ? "var(--destructive)" : "var(--muted-foreground)"}
                          className="pointer-events-none font-mono"
                          {...HALO}
                        >
                          {down ? "offline" : n.ip || n.board || ""}
                        </text>
                      </g>
                    </g>
                  );
                }

                const parentDown = byId.get(parentOf.get(n.id) ?? "")?.reachable === false;
                const above = p.y < CY;
                const ty = above ? -36 : 28;
                return (
                  <g key={n.id} {...common}>
                    <g data-settle>
                      {sel && (
                        <>
                          <circle r={17} fill="var(--sig)" opacity={0.14} />
                          <circle r={17} fill="none" stroke="var(--sig)" />
                        </>
                      )}
                      {/* a diamond, so a neighbour never reads as a managed router */}
                      <rect
                        x={-7}
                        y={-7}
                        width={14}
                        height={14}
                        rx={2.5}
                        transform="rotate(45)"
                        fill="var(--surface-2)"
                        stroke={
                          n.onboardable
                            ? "var(--brand)"
                            : parentDown
                              ? "var(--destructive)"
                              : "var(--muted-foreground)"
                        }
                        strokeWidth={1.4}
                        strokeDasharray={n.onboardable ? "3 2" : undefined}
                      />
                      {n.onboardable && (
                        <path
                          d="M-3.5 0h7M0 -3.5v7"
                          stroke="var(--brand)"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                        />
                      )}
                      <text
                        y={ty}
                        textAnchor="middle"
                        fontSize={11}
                        fill={sel ? "var(--foreground)" : "var(--text-secondary)"}
                        className="pointer-events-none font-mono"
                        {...HALO}
                      >
                        {name}
                      </text>
                      <text
                        y={ty + 13}
                        textAnchor="middle"
                        fontSize={10}
                        fill="var(--text-faint)"
                        className="pointer-events-none font-mono"
                        {...HALO}
                      >
                        {n.ip || n.board || n.platform || ""}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
          </svg>
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

      {/* ── legend ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 border-t border-line px-4 py-2.5 text-[12px] text-muted-foreground">
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
            className="size-[9px] rotate-45 rounded-[2px] border-[1.25px] border-dashed border-brand"
          />
          Can be added
        </span>
        <span>Outer ring CPU · inner ring memory</span>
        <span className="flex-1" />
        <span className="text-faint">
          Drag to move · scroll to zoom · hover a node to see its links
        </span>
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

  return (
    <aside
      className="topo-inspector flex min-w-0 flex-col"
      aria-label={`${isDev ? "Router" : "Neighbour"} details: ${name}`}
    >
      <div className="flex flex-col gap-1.5 border-b border-line px-[18px] pt-4 pb-3">
        <div className="flex items-center gap-2">
          <SectionLabel muted>{isDev ? "Managed router" : "Neighbour"}</SectionLabel>
          {node.onboardable && (
            <StatusBadge tone="brand" dot={false}>
              Can be added
            </StatusBadge>
          )}
          {node.reachable === false && <StatusBadge tone="bad">Offline</StatusBadge>}
          {isDev && node.reachable === true && <StatusBadge tone="good">Online</StatusBadge>}
          <span className="flex-1" />
          <button
            type="button"
            className="monitor-icon-btn"
            aria-label={`Close ${isDev ? "router" : "neighbour"} details`}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <h2 className="font-mono text-[16px] font-semibold break-all text-emphasis">{name}</h2>
        {isDev ? (
          <p className="text-[12px] text-muted-foreground">
            {node.reachable === false ? "Managed router, not answering" : "Managed router"}
          </p>
        ) : seenBy ? (
          <p className="text-[12px] text-muted-foreground">
            Seen by <span className="font-mono text-fg-secondary">{seenBy}</span>
            {via && (
              <>
                {" "}
                on <span className="font-mono text-fg-secondary">{via}</span>
              </>
            )}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-3.5 px-[18px] py-3.5">
        {known.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No details advertised.</p>
        ) : (
          <dl
            className="monitor-facts"
            style={{ gridTemplateColumns: "76px minmax(0,1fr)" } as CSSProperties}
          >
            {known.map(([k, v, mono]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="break-all">
                  {mono ? <span className="font-mono text-[12px]">{v}</span> : v}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {stub && node.suggestedConfig && (
          <>
            <div className="flex flex-col gap-2 border-t border-line pt-3.5">
              <SectionLabel>Not managed yet</SectionLabel>
              <p className="text-[13px] text-fg-secondary">
                Add this entry to your device config to manage it from MCP.
              </p>
              <pre className="monitor-pre">{stub}</pre>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyStub text={stub} />
              {onOnboard && (
                <MonitorButton
                  size="sm"
                  variant="primary"
                  icon={<Plus aria-hidden="true" />}
                  onClick={() =>
                    onOnboard(node.suggestedConfig!.name, stubBody(node.suggestedConfig!))
                  }
                >
                  Add to Devices
                </MonitorButton>
              )}
            </div>
            {onOnboard && (
              <span className="monitor-hint">
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
    <MonitorButton size="sm" icon={<Copy aria-hidden="true" />} onClick={copy}>
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
