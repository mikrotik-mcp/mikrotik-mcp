/**
 * Layer-2 topology, drawn as a radar.
 *
 * The MCP server sits at the hub, because it is the thing that actually polls
 * every device — `topo.server` was already in the payload and unused by the old
 * map, which left devices orbiting an empty centre. Configured devices orbit the
 * hub on an inner ring as gauge orbs (outer arc = CPU, inner arc = memory).
 * Neighbours discovered over MNDP/CDP/LLDP settle outside them, tethered to the
 * device that saw them by a dashed link — "seen, but not yet wired to the hub",
 * which is precisely what onboarding fixes. An onboardable neighbour breathes.
 *
 * Positions come from a tiny deterministic relaxation (no `Math.random`, so the
 * map is stable across renders): neighbours repel one another and spring back
 * toward their parent's bearing, which unpicks the overlaps a fixed arc always
 * produced once a device reported more than a handful of neighbours.
 *
 * Interaction: wheel to zoom about the cursor, drag to pan, hover to focus a
 * node's immediate neighbourhood (everything else dims), click to inspect,
 * search to dim non-matching nodes. Motion lives in `viz.css` (`.topo-*`) and is
 * disabled under `prefers-reduced-motion`.
 */
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from "react";
import { Crosshair, Minus, Plus, Radar, Search, ServerCog, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { CopyButton } from "./atoms";
import { Button, Input } from "./geist";
import { arcDash, CX, CY, H, HUB_ID, layout, sweepPath, W } from "./topology-layout";
import type { TopoNode, TopologyPayload } from "./types";

/** Colour a 0–100 metric: calm → warm → hot. */
function metricColor(v: number | undefined): string {
  if (v == null) return "var(--muted-foreground)";
  if (v >= 85) return "var(--destructive)";
  if (v >= 60) return "var(--warning)";
  return "var(--chart-2)";
}

function statusColor(n: TopoNode): string {
  if (n.reachable === true) return "var(--chart-2)";
  if (n.reachable === false) return "var(--destructive)";
  return n.kind === "device" ? "var(--muted-foreground)" : "var(--border)";
}

export function TopologyMap({
  topo,
  onOnboard,
}: {
  topo: TopologyPayload;
  onOnboard?: (name: string, body: Record<string, unknown>) => void;
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

  /** Ids adjacent to each node (including itself) — drives hover focus. */
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

  /** Hovering focuses a neighbourhood; otherwise the search result set. */
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

  /** Spokes from the hub to each managed device — not in `topo.edges`. */
  const hubEdges = devices.map((d) => ({ from: HUB_ID, to: d.id, interface: undefined }));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            className="pl-8"
            type="search"
            placeholder="Filter by name, identity, IP, MAC or board…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          ghost
          type={onlyNew ? "accent" : "default"}
          onClick={() => setOnlyNew((v) => !v)}
          title="Dim everything except neighbours that can be onboarded"
          icon={<Radar />}
        >
          Onboardable{topo.stats.onboardable > 0 ? ` (${topo.stats.onboardable})` : ""}
        </Button>
        <Separator orientation="vertical" className="h-6" />
        <Button
          size="sm"
          ghost
          onClick={() => zoom(1 / 1.25)}
          aria-label="Zoom out"
          icon={<Minus />}
        />
        <span className="text-muted-foreground w-11 text-center font-mono text-[11px] tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
        <Button size="sm" ghost onClick={() => zoom(1.25)} aria-label="Zoom in" icon={<Plus />} />
        <Button
          size="sm"
          ghost
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
          title="Reset view"
          icon={<Crosshair />}
        >
          Reset
        </Button>
      </div>

      {/* ── radar canvas ────────────────────────────────────────────────── */}
      <div className="bg-card relative overflow-hidden rounded-xl border">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={Math.min(H, 560)}
          preserveAspectRatio="xMidYMid meet"
          className={cn(
            "block w-full touch-none select-none",
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
              "radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 62%)",
          }}
        >
          <defs>
            {/* The sweep wedge, fading to nothing; `.topo-sweep` rotates it. */}
            <linearGradient id="topo-beam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="var(--brand)" stopOpacity="0.3" />
              <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
            <radialGradient id="topo-hub" cx="0.5" cy="0.35" r="0.75">
              <stop offset="0" stopColor="var(--foreground)" />
              <stop offset="1" stopColor="var(--muted-foreground)" />
            </radialGradient>
          </defs>

          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* range rings */}
            <g className="topo-ring">
              {[rInner, rOuter, rOuter + 62].map((r) => (
                <circle
                  key={r}
                  cx={CX}
                  cy={CY}
                  r={r}
                  fill="none"
                  className="stroke-border/70"
                  strokeDasharray="2 8"
                />
              ))}
            </g>

            {/*
              The beam pivots on its apex — the hub — so the origin is given in user
              units, and `.topo-sweep` must NOT set `transform-box: fill-box`, which
              would pivot on the wedge's bounding-box centre instead.
            */}
            <g className="topo-sweep" style={{ transformOrigin: `${CX}px ${CY}px` }}>
              <path d={sweepPath(rOuter + 62)} fill="url(#topo-beam)" />
            </g>

            {/* links */}
            {[...hubEdges, ...topo.edges].map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const toNeighbor = byId.get(e.to)?.kind === "neighbor";
              const faded = dimmed(e.from) || dimmed(e.to);
              // Bow each link slightly, so parallel spokes separate visually.
              const nx = -(b.y - a.y);
              const ny = b.x - a.x;
              const nl = Math.hypot(nx, ny) || 1;
              const bow = toNeighbor ? 16 : 8;
              const qx = (a.x + b.x) / 2 + (nx / nl) * bow;
              const qy = (a.y + b.y) / 2 + (ny / nl) * bow;
              return (
                <path
                  key={`e-${i}`}
                  d={`M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}`}
                  fill="none"
                  strokeWidth={toNeighbor ? 1.2 : 1.6}
                  strokeDasharray={toNeighbor ? "4 4" : "6 10"}
                  className={cn(
                    "transition-opacity",
                    toNeighbor ? "stroke-brand/55" : "topo-flow stroke-chart-2/70",
                    faded && "opacity-15",
                  )}
                >
                  <title>
                    {e.from === HUB_ID ? topo.server : e.from} → {e.to}
                    {e.interface ? ` (${e.interface})` : ""}
                  </title>
                </path>
              );
            })}

            {/* hub — the MCP server every managed device is polled from */}
            <g
              className={cn("transition-opacity", focus && !focus.has(HUB_ID) && "opacity-15")}
              onMouseEnter={() => setHover(HUB_ID)}
              onMouseLeave={() => setHover(null)}
            >
              <circle cx={CX} cy={CY} r={40} className="fill-brand/15" />
              <circle cx={CX} cy={CY} r={27} fill="url(#topo-hub)" className="stroke-border" />
              <ServerCog
                x={CX - 9}
                y={CY - 15}
                width={18}
                height={18}
                className="stroke-background pointer-events-none"
              />
              <text
                x={CX}
                y={CY + 16}
                textAnchor="middle"
                className="fill-background pointer-events-none font-mono text-[8px] font-bold"
              >
                MCP
              </text>
              <text
                x={CX}
                y={CY + 58}
                textAnchor="middle"
                className="fill-muted-foreground pointer-events-none font-mono text-[10px]"
              >
                {topo.server}
              </text>
            </g>

            {/* nodes */}
            {topo.nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const isDev = n.kind === "device";
              const sel = picked === n.id;
              const faded = dimmed(n.id);
              const stroke = statusColor(n);
              const r = isDev ? 26 : 15;

              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  className={cn("cursor-pointer transition-opacity", faded && "opacity-15")}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setPicked((cur) => (cur === n.id ? null : n.id));
                  }}
                >
                  {sel && (
                    <circle
                      r={r + 8}
                      className="topo-halo stroke-brand fill-none"
                      strokeWidth={2}
                    />
                  )}

                  {isDev ? (
                    <>
                      {/* outer arc = CPU, inner arc = memory */}
                      <circle r={r + 7} className="stroke-border/60 fill-none" strokeWidth={3} />
                      <circle
                        r={r + 7}
                        fill="none"
                        strokeWidth={3}
                        strokeLinecap="round"
                        transform="rotate(-90)"
                        style={{ stroke: metricColor(n.cpuLoad) }}
                        strokeDasharray={arcDash(r + 7, n.cpuLoad)}
                      />
                      <circle r={r + 2} className="stroke-border/40 fill-none" strokeWidth={2} />
                      <circle
                        r={r + 2}
                        fill="none"
                        strokeWidth={2}
                        strokeLinecap="round"
                        transform="rotate(-90)"
                        style={{ stroke: metricColor(n.memUsedPct) }}
                        strokeDasharray={arcDash(r + 2, n.memUsedPct)}
                      />
                      <circle
                        r={r - 4}
                        className="fill-muted"
                        style={{ stroke }}
                        strokeWidth={1.6}
                      />
                      <text
                        textAnchor="middle"
                        y={3}
                        className="fill-foreground pointer-events-none font-mono text-[9px] font-bold"
                      >
                        {(n.label || n.id).slice(0, 4).toUpperCase()}
                      </text>
                    </>
                  ) : (
                    <>
                      {n.onboardable && <circle r={r + 5} className="topo-pulse fill-brand/25" />}
                      {/* a diamond, so an unmanaged neighbour never reads as a device */}
                      <rect
                        x={-r * 0.72}
                        y={-r * 0.72}
                        width={r * 1.44}
                        height={r * 1.44}
                        rx={3}
                        transform="rotate(45)"
                        className="fill-card"
                        style={{ stroke }}
                        strokeWidth={1.4}
                        strokeDasharray={n.onboardable ? "3 2" : undefined}
                      />
                      {n.onboardable && (
                        <Plus
                          x={-5}
                          y={-5}
                          width={10}
                          height={10}
                          className="stroke-brand pointer-events-none"
                        />
                      )}
                    </>
                  )}

                  <text
                    textAnchor="middle"
                    y={r + (isDev ? 22 : 18)}
                    className="fill-foreground pointer-events-none font-mono text-[10px]"
                  >
                    {(n.label || n.id).slice(0, 18)}
                  </text>
                  {isDev && (
                    <text
                      textAnchor="middle"
                      y={r + 34}
                      className="fill-muted-foreground pointer-events-none font-mono text-[9px]"
                    >
                      {n.ip || n.board || ""}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* HUD, floating over the canvas */}
        <div className="text-muted-foreground pointer-events-none absolute top-3 left-3 flex flex-col gap-1 font-mono text-[10px]">
          <span className="text-foreground text-[11px] font-semibold">Layer-2 fabric</span>
          <span>
            {topo.stats.devices} managed · {topo.stats.neighbors} discovered
          </span>
          {topo.stats.onboardable > 0 && (
            <span className="text-brand">{topo.stats.onboardable} awaiting onboard</span>
          )}
        </div>

        <div className="text-muted-foreground pointer-events-none absolute right-3 bottom-3 flex flex-col items-end gap-1 font-mono text-[10px]">
          <span className="inline-flex items-center gap-1.5">
            <i className="bg-chart-2 inline-block size-2 rounded-full" /> online
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="bg-destructive inline-block size-2 rounded-full" /> offline
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="border-border inline-block size-2 rotate-45 border" /> neighbour
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="bg-brand/40 inline-block size-2 rounded-full" /> onboardable
          </span>
        </div>
      </div>

      {/* ── inspector ───────────────────────────────────────────────────── */}
      {pickedNode && (
        <Inspector node={pickedNode} onClose={() => setPicked(null)} onOnboard={onOnboard} />
      )}
    </div>
  );
}

/** Details for the selected node, plus its onboarding stub when it has one. */
function Inspector({
  node,
  onClose,
  onOnboard,
}: {
  node: TopoNode;
  onClose: () => void;
  onOnboard?: (name: string, body: Record<string, unknown>) => void;
}): ReactNode {
  const stub = node.suggestedConfig
    ? JSON.stringify({ [node.suggestedConfig.name]: stubBody(node.suggestedConfig) }, null, 2)
    : null;

  const facts: [string, string | undefined][] = [
    ["identity", node.identity],
    ["address", node.ip],
    ["mac", node.mac],
    ["board", node.board],
    ["platform", node.platform],
    ["version", node.version],
    ["uptime", node.uptime],
  ];
  const known = facts.filter((f): f is [string, string] => Boolean(f[1]));

  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="font-mono text-sm">{node.label || node.id}</strong>
        <Badge variant={node.kind === "device" ? "secondary" : "outline"}>{node.kind}</Badge>
        {node.onboardable && <Badge className="bg-brand text-brand-foreground">onboardable</Badge>}
        {node.reachable === false && <Badge variant="destructive">offline</Badge>}
        <span className="flex-1" />
        <Button ghost size="sm" icon={<X />} onClick={onClose} aria-label="Close" />
      </div>

      <div className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
        {known.length === 0 ? (
          <span>no details advertised</span>
        ) : (
          known.map(([k, v]) => (
            <Fragment key={k}>
              <span>{k}</span>
              <span className="text-foreground break-all">{v}</span>
            </Fragment>
          ))
        )}
      </div>

      {node.kind === "device" && (node.cpuLoad != null || node.memUsedPct != null) && (
        <div className="mt-3 flex gap-4 font-mono text-[11px]">
          {node.cpuLoad != null && (
            <span style={{ color: metricColor(node.cpuLoad) }}>cpu {node.cpuLoad}%</span>
          )}
          {node.memUsedPct != null && (
            <span style={{ color: metricColor(node.memUsedPct) }}>mem {node.memUsedPct}%</span>
          )}
        </div>
      )}

      {stub && node.suggestedConfig && (
        <>
          <Separator className="my-3" />
          <p className="text-muted-foreground mb-1.5 text-[11px]">
            Not managed yet — add this to your device config to onboard it:
          </p>
          <pre className="bg-background text-foreground m-0 mb-2 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-[11px]/[1.5] whitespace-pre">
            {stub}
          </pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton title="Copy config stub" label="Copy config stub" text={stub} />
            {onOnboard && (
              <Button
                type="accent"
                size="sm"
                onClick={() =>
                  onOnboard(node.suggestedConfig!.name, stubBody(node.suggestedConfig!))
                }
              >
                Add to Devices →
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The body half of an onboarding config stub (drops the `name` key). */
function stubBody(c: NonNullable<TopoNode["suggestedConfig"]>): Record<string, unknown> {
  const body: Record<string, unknown> = { port: c.port, username: c.username };
  if (c.host) body.host = c.host;
  if (c.mac) body.mac = c.mac;
  return body;
}
