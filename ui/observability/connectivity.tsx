import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ms } from "./format";
import { withToken } from "./api";
import { Activity, Cpu, Loader2, RadioTower, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Badge } from "./geist";
import type { CapabilitiesJson, DeviceInfo, DevicesPayload, DeviceStatus } from "./types";

/**
 * A pill-backed SVG label whose rounded rect is sized to the REAL rendered text
 * width (`getComputedTextLength`) rather than a character-count guess — so the
 * "⤳ via …" jump badge fits its content exactly, whatever the bastion name and
 * however the arrow/space glyphs render. Falls back to an estimate for the first
 * paint, then snaps to the measured width on mount/text change.
 */
function PillLabel({
  x,
  y,
  text,
  className,
  textClassName,
  padX = 9,
  fontSize = 9,
}: {
  x: number;
  y: number;
  text: string;
  className: string;
  textClassName: string;
  padX?: number;
  fontSize?: number;
}): ReactNode {
  const ref = useRef<SVGTextElement>(null);
  const [w, setW] = useState(() => text.length * fontSize * 0.62);
  useLayoutEffect(() => {
    const measured = ref.current?.getComputedTextLength();
    if (measured && measured > 0) setW(measured);
  }, [text, fontSize]);
  const bw = Math.round(w + padX * 2);
  return (
    <g transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
      <rect className={className} x={-bw / 2} y={-9} rx={9} width={bw} height={18} />
      <text
        ref={ref}
        className={textClassName}
        x={0}
        y={3.5}
        textAnchor="middle"
        fontSize={fontSize}
      >
        {text}
      </text>
    </g>
  );
}

// ── connectivity graph ───────────────────────────────────────────────────────
export function statusInfo(s: DeviceStatus): { label: string; color: string } {
  // `var()` rather than hex: these land in SVG attributes and inline styles,
  // where a utility class can't reach, and they must follow the theme.
  if (s.reachable === true) return { label: "online", color: "var(--foreground)" };
  if (s.reachable === false) return { label: "offline", color: "var(--destructive)" };
  return { label: "checking…", color: "var(--muted-foreground)" };
}

/**
 * A stable, vivid, UNIQUE colour per device. The hue is spread evenly by the
 * device's rank within a stable (sorted) list of ALL device names, so no two
 * devices can share a colour — a plain name→hue hash clustered near-identical
 * hues, making distinct devices look the same. Sorting (rather than render order)
 * keeps a device's colour stable across reloads and identical between the radar
 * (full fleet) and the device cards (which may render a filtered subset), so the
 * two never disagree. Lightness is staggered by rank so that even a large fleet —
 * where evenly-spaced hues get close — stays visually separable.
 */
export function deviceColor(name: string, allNames: string[]): string {
  const ranked = [...new Set(allNames)].sort();
  const count = Math.max(1, ranked.length);
  const rank = Math.max(0, ranked.indexOf(name));
  const hue = Math.round((rank * 360) / count);
  const light = 62 - (rank % 3) * 5;
  return `hsl(${hue} 70% ${light}%)`;
}

/** A point on a quadratic Bézier (core → control → device) at parameter `t`. */
export function qPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/** Tangent angle (degrees) of that Bézier at `t`, for orienting direction arrows. */
export function qAngle(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): number {
  const u = 1 - t;
  const dx = 2 * u * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
  const dy = 2 * u * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// `var()` rather than hex: these feed SVG stroke/fill attributes and inline
// styles, where a utility class cannot reach, and they must follow the theme.
export const FLOW_CMD = "var(--foreground)"; // command: LLM → device
export const FLOW_RES = "var(--muted-foreground)"; // response: device → LLM
export const JUMP_HUE = "var(--warning)"; // SSH jump tunnel (ProxyJump)
export const POOL_HUE = "var(--success)"; // pooled SSH connection

/**
 * The bastion a device is reached through, or null. A `jumpVia` names another
 * configured device; an inline `jumpHost` is shown as `host:port`.
 */
export function jumpLabel(d: DeviceInfo): string | null {
  if (d.jumpVia) return d.jumpVia;
  if (d.jumpHost) return `${d.jumpHost.host}:${d.jumpHost.port}`;
  return null;
}

/**
 * Animated "radar hub" connectivity map that shows **traffic direction**. Each
 * device hangs off the MCP core on a two-lane curved link: the outer lane is the
 * **command** stream (LLM → device, indigo, packets flowing outward) and the
 * inner lane is the **response** stream (device → LLM, emerald, packets flowing
 * back). Direction chevrons sit mid-lane. Every real tool call fires a bright
 * round-trip "burst" orb (core → device → core) on that device's link — so you
 * literally watch a request go out and its response come home, even for
 * mac-telnet devices the background probe can't poll. All motion is CSS/SMIL
 * (`.conn-*` in styles.css) and respects `prefers-reduced-motion`.
 */
/** Truncate a node label to what the largest orb can hold (mono ≈ 6.2px/char). */
export const NODE_MAX_R = 70;
export const NODE_MAX_CHARS = Math.floor((2 * NODE_MAX_R - 24) / 6.2);
export const nodeLabel = (raw: string): string =>
  raw.length > NODE_MAX_CHARS ? `${raw.slice(0, NODE_MAX_CHARS - 1)}…` : raw;
/** Circle radius that fits `label` across its diameter, clamped to [23, NODE_MAX_R]. */
export const nodeRadius = (label: string): number =>
  Math.max(23, Math.min(NODE_MAX_R, label.length * 3.1 + 12));

export function ConnectivityGraph({
  payload,
  pulses,
}: {
  payload: DevicesPayload;
  pulses: Record<string, number>;
}): ReactNode {
  const devices = payload.devices;
  const n = Math.max(1, devices.length);
  const names = devices.map((d) => d.name);

  // Each orb's radius scales with its device name, so the ring must leave room
  // for the largest orb AND a clear lane between the core and every node, or the
  // command/response lines, arrows and packets get hidden under the circles.
  const sized = devices.map((d) => {
    const label = nodeLabel(d.name);
    return { d, label, r: nodeRadius(label) };
  });
  const maxR = Math.max(23, ...sized.map((s) => s.r));
  const CORE = 46; // core hub glow radius
  const LANE = 64; // guaranteed clear gap (core edge → node edge) for the flow
  // Ring radius: clearance from the core for the lanes, plus enough that adjacent
  // orbs on the ring don't collide, plus a sensible floor.
  const spacingR = n > 1 ? (maxR + 18) / Math.sin(Math.PI / n) : 0;
  const R = Math.max(CORE + LANE + maxR, spacingR, 120);
  const PAD = maxR + 60; // orb + its two label lines + margin
  const W = Math.max(700, Math.round((R + maxR + 40) * 2));
  const H = Math.round((R + PAD) * 2);
  const cx = W / 2;
  const cy = H / 2;
  const core = { x: cx, y: cy };

  const nodes = sized.map((s, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2 + (n % 2 === 0 ? Math.PI / n : 0);
    return { ...s, i, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  });

  return (
    <>
      <svg
        className="conn"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="conn-hub" cx="0.5" cy="0.34" r="0.75">
            <stop offset="0" stopColor="var(--foreground)" />
            <stop
              offset="0.6"
              stopColor="color-mix(in srgb, var(--foreground) 70%, var(--muted-foreground))"
            />
            <stop offset="1" stopColor="var(--muted-foreground)" />
          </radialGradient>
          <radialGradient id="conn-orb" cx="0.5" cy="0.32" r="0.85">
            <stop offset="0" stopColor="var(--muted)" />
            <stop offset="1" stopColor="var(--card)" />
          </radialGradient>
          {/* Vignette laid over a device's flag: a near-clear centre so the flag
              reads, deepening to the orb colour at the rim so the circle stays
              crisp and the centred label stays legible over any flag. */}
          <radialGradient id="conn-orb-veil" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="var(--card)" stopOpacity="0.2" />
            <stop offset="0.6" stopColor="var(--card)" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--card)" stopOpacity="0.85" />
          </radialGradient>
          <radialGradient id="conn-burst" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="var(--foreground)" />
            <stop offset="0.5" stopColor="color-mix(in srgb, var(--foreground) 80%, transparent)" />
            <stop offset="1" stopColor="var(--muted-foreground)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="conn-tunnel-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={JUMP_HUE} stopOpacity="0.15" />
            <stop offset="0.5" stopColor={JUMP_HUE} stopOpacity="0.95" />
            <stop offset="1" stopColor={JUMP_HUE} stopOpacity="0.15" />
          </linearGradient>
          <filter id="conn-tunnel-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* faint concentric range rings for depth */}
        {[0.5, 0.78, 1].map((f, i) => (
          <circle key={`g-${i}`} className="conn-grid" cx={cx} cy={cy} r={R * f} />
        ))}

        {/* sonar pulses radiating from the core */}
        {[0, 1, 2].map((i) => (
          <circle
            key={`s-${i}`}
            className="conn-sonar"
            cx={cx}
            cy={cy}
            style={{ animationDelay: `${i * 1.1}s` }}
          />
        ))}

        {/* two-lane directional links + flowing packets + activity bursts */}
        {nodes.map(({ d, i, x, y }) => {
          const info = statusInfo(d.status);
          const online = d.status.reachable === true;
          const checking = d.status.reachable == null;
          const node = { x, y };
          const mx = (cx + x) / 2;
          const my = (cy + y) / 2;
          const dx = x - cx;
          const dy = y - cy;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          const OFF = 16;
          // Command lane bows one way, response lane the other — a two-lane road.
          const cmdC = { x: mx + nx * OFF, y: my + ny * OFF };
          const resC = { x: mx - nx * OFF, y: my - ny * OFF };
          const cmdPath = `M${cx},${cy} Q${cmdC.x.toFixed(1)},${cmdC.y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
          const resPath = `M${cx},${cy} Q${resC.x.toFixed(1)},${resC.y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
          const burstPath = `M${cx},${cy} Q${mx.toFixed(1)},${my.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
          // Direction chevrons at lane midpoints.
          const cmdMid = qPoint(core, cmdC, node, 0.52);
          const cmdAng = qAngle(core, cmdC, node, 0.52); // points toward device
          const resMid = qPoint(core, resC, node, 0.48);
          const resAng = qAngle(core, resC, node, 0.48) + 180; // points toward core
          const pulse = pulses[d.name] ?? 0;
          return (
            <g key={`l-${d.name}`}>
              {/* command lane (LLM → device) */}
              <path
                id={`conn-cmd-${i}`}
                className="conn-link"
                d={cmdPath}
                stroke={online ? FLOW_CMD : info.color}
                strokeOpacity={online ? 0.5 : 0.32}
                strokeDasharray={checking ? "2 8" : online ? undefined : "6 7"}
              />
              {/* response lane (device → LLM) */}
              <path
                id={`conn-res-${i}`}
                className="conn-link"
                d={resPath}
                stroke={online ? FLOW_RES : info.color}
                strokeOpacity={online ? 0.5 : 0.18}
                strokeDasharray={online ? undefined : "6 7"}
              />
              {online && (
                <>
                  <path className="conn-flow" d={cmdPath} stroke={FLOW_CMD} />
                  <circle className="conn-packet" r={3.2} fill={FLOW_CMD}>
                    <animateMotion dur="2.6s" repeatCount="indefinite" calcMode="linear">
                      <mpath href={`#conn-cmd-${i}`} />
                    </animateMotion>
                  </circle>
                  {/* response packet rides the inner lane in reverse (device → core) */}
                  <rect
                    className="conn-packet"
                    x={-2.6}
                    y={-2.6}
                    width={5.2}
                    height={5.2}
                    fill={FLOW_RES}
                    transform="rotate(45)"
                  >
                    <animateMotion
                      dur="2.6s"
                      begin="0.9s"
                      repeatCount="indefinite"
                      calcMode="linear"
                      keyPoints="1;0"
                      keyTimes="0;1"
                    >
                      <mpath href={`#conn-res-${i}`} />
                    </animateMotion>
                  </rect>
                  {/* direction chevrons */}
                  <path
                    className="conn-chevron"
                    d="M-4,-3 L4,0 L-4,3"
                    stroke={FLOW_CMD}
                    transform={`translate(${cmdMid.x.toFixed(1)},${cmdMid.y.toFixed(1)}) rotate(${cmdAng.toFixed(1)})`}
                  />
                  <path
                    className="conn-chevron"
                    d="M-4,-3 L4,0 L-4,3"
                    stroke={FLOW_RES}
                    transform={`translate(${resMid.x.toFixed(1)},${resMid.y.toFixed(1)}) rotate(${resAng.toFixed(1)})`}
                  />
                </>
              )}
              {/* round-trip activity burst: fires once per live tool call (any status) */}
              {pulse > 0 && (
                <g key={`burst-${d.name}-${pulse}`}>
                  <circle r={6} fill="url(#conn-burst)">
                    <animateMotion
                      dur="1.1s"
                      repeatCount="1"
                      calcMode="linear"
                      keyPoints="0;1;0"
                      keyTimes="0;0.5;1"
                      path={burstPath}
                    />
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.1;0.85;1"
                      dur="1.1s"
                      repeatCount="1"
                      fill="freeze"
                    />
                  </circle>
                </g>
              )}
            </g>
          );
        })}

        {/* ── SSH ProxyJump tunnels ─────────────────────────────────────────
            A device reached THROUGH a bastion gets an encrypted side-channel
            drawn around the rim: an amber, glowing, animated conduit from its
            jump host to it, with a padlock that physically travels the tunnel in
            the jump direction. When the bastion is a configured device the arc
            links the two orbs; an inline jumpHost gets its own satellite lock. */}
        {nodes.map((nd) => {
          const via = nd.d.jumpVia;
          const bastion = via ? nodes.find((m) => m.d.name === via) : undefined;
          const inline = !bastion && nd.d.jumpHost ? nd.d.jumpHost : undefined;
          if (!bastion && !inline) return null;

          // Endpoints: bastion orb → this orb, or external satellite → this orb.
          const to = { x: nd.x, y: nd.y };
          const dirL = Math.hypot(nd.x - cx, nd.y - cy) || 1;
          const ux = (nd.x - cx) / dirL;
          const uy = (nd.y - cy) / dirL;
          const from = bastion
            ? { x: bastion.x, y: bastion.y }
            : { x: nd.x + ux * (nd.r + 46), y: nd.y + uy * (nd.r + 46) };

          // Bow the arc OUTWARD (away from the core) so it rides the rim, clear
          // of the central command/response lanes.
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2;
          const ol = Math.hypot(mx - cx, my - cy) || 1;
          const bow = bastion ? 50 : 16;
          const ctrl = {
            x: mx + ((mx - cx) / ol) * bow,
            y: my + ((my - cy) / ol) * bow,
          };
          const path = `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${ctrl.x.toFixed(1)},${ctrl.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
          const label = jumpLabel(nd.d) ?? "";
          const badge = qPoint(from, ctrl, to, 0.5);
          const pid = `conn-tunnel-${nd.i}`;

          return (
            <g key={`jump-${nd.d.name}`} className="conn-tunnel-g">
              {/* soft amber halo under the conduit */}
              <path className="conn-tunnel-halo" d={path} stroke={JUMP_HUE} />
              {/* the encrypted conduit: animated dashed gradient stroke */}
              <path
                id={pid}
                className="conn-tunnel"
                d={path}
                stroke="url(#conn-tunnel-grad)"
                filter="url(#conn-tunnel-glow)"
              />
              {/* external-bastion satellite (no device orb to anchor to) */}
              {inline && (
                <>
                  <circle
                    className="conn-tunnel-sat"
                    cx={from.x}
                    cy={from.y}
                    r={11}
                    fill="var(--background)"
                    stroke={JUMP_HUE}
                  />
                  <text x={from.x} y={from.y + 3.5} textAnchor="middle" fontSize={11}>
                    🛡️
                  </text>
                </>
              )}
              {/* the padlock that travels the tunnel (bastion → device) */}
              <text className="conn-tunnel-lock" fontSize={13} textAnchor="middle">
                🔒
                <animateMotion dur="2.4s" repeatCount="indefinite" calcMode="linear" rotate="auto">
                  <mpath href={`#${pid}`} />
                </animateMotion>
              </text>
              {/* midpoint "via" badge — pill sized to the real text width */}
              <PillLabel
                x={badge.x}
                y={badge.y}
                text={`⤳ via ${label}`}
                className="conn-tunnel-badge"
                textClassName="conn-tunnel-badge-tx"
              />
            </g>
          );
        })}

        {/* core hub */}
        <circle className="conn-hub-glow" cx={cx} cy={cy} r={42} />
        <circle className="conn-hub-ring" cx={cx} cy={cy} r={37} />
        <circle
          cx={cx}
          cy={cy}
          r={29}
          fill="url(#conn-hub)"
          stroke="var(--border)"
          strokeWidth={1.5}
        />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fill="var(--background)"
          fontSize={12}
          fontWeight={700}
        >
          LLM
        </text>
        <text
          x={cx}
          y={cy + 8}
          textAnchor="middle"
          fill="var(--background)"
          fillOpacity={0.66}
          fontSize={8}
          fontWeight={600}
        >
          ⇄ MCP
        </text>
        <text
          x={cx}
          y={cy + 18}
          textAnchor="middle"
          fill="var(--background)"
          fillOpacity={0.66}
          fontSize={7.5}
          fontWeight={600}
        >
          server
        </text>

        {/* device nodes */}
        {nodes.map(({ d, x, y, r, label, i }) => {
          const info = statusInfo(d.status);
          const online = d.status.reachable === true;
          const detail = online ? `${d.status.latencyMs ?? "?"} ms` : info.label;
          // Each device's orb carries its own persistent colour; the small corner
          // dot still shows live online/offline status.
          const col = deviceColor(d.name, names);
          return (
            <g key={`n-${d.name}`} className="conn-node" opacity={d.disabled ? 0.35 : 1}>
              {online && <circle className="conn-node-halo" cx={x} cy={y} r={r + 1} stroke={col} />}
              {/* pool halo: dashed when idle, solid+blink when busy */}
              {d.pool?.pooled && (
                <circle
                  cx={x}
                  cy={y}
                  r={r + 5}
                  fill="none"
                  stroke={d.pool.inflight > 0 ? "var(--chart-1)" : "var(--success)"}
                  strokeWidth={1.5}
                  strokeDasharray={d.pool.inflight > 0 ? undefined : "4 4"}
                  opacity={0.5}
                  className={d.pool.inflight > 0 ? "conn-blink" : undefined}
                />
              )}
              {/* the dark orb backing */}
              <circle cx={x} cy={y} r={r} fill="url(#conn-orb)" />
              {d.geo?.countryCode ? (
                <>
                  {/* the device's country flag, filling the orb and clipped to a
                      circle (unique id per node), then veiled so it reads as a
                      tasteful backdrop with the label still legible over it.
                      An <image> href — NOT inlined SVG — so each flag stays an
                      isolated document (every circle-flags SVG reuses `id="a"`;
                      inlining several would collide and render them all alike). */}
                  <clipPath id={`conn-orb-clip-${i}`}>
                    <circle cx={x} cy={y} r={r} />
                  </clipPath>
                  <image
                    href={withToken(`/api/flag/${d.geo.countryCode}`)}
                    x={x - r}
                    y={y - r}
                    width={r * 2}
                    height={r * 2}
                    clipPath={`url(#conn-orb-clip-${i})`}
                    preserveAspectRatio="xMidYMid slice"
                    opacity={0.6}
                  >
                    <title>{d.geo.city ? `${d.geo.country} · ${d.geo.city}` : d.geo.country}</title>
                  </image>
                  <circle cx={x} cy={y} r={r} fill="url(#conn-orb-veil)" />
                </>
              ) : (
                <circle cx={x} cy={y} r={r} fill={col} opacity={0.16} />
              )}
              <circle cx={x} cy={y} r={r} fill="none" stroke={col} strokeWidth={2.5} />
              <circle
                className={online ? "conn-blink" : undefined}
                cx={x + r * 0.7}
                cy={y - r * 0.7}
                r={4.5}
                fill={info.color}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
              <text
                x={x}
                y={y + 3.5}
                textAnchor="middle"
                fill="var(--foreground)"
                fontSize={10}
                fontWeight={600}
                // Background-coloured outline keeps the name readable over the
                // flag backdrop (paint the stroke first, then the fill on top).
                stroke="var(--card)"
                strokeWidth={2.75}
                paintOrder="stroke"
              >
                {label}
              </text>
              <text
                x={x}
                y={y + r + 14}
                textAnchor="middle"
                fill="var(--muted-foreground)"
                fontSize={9}
              >
                {d.address ?? d.host}
              </text>
              <text
                x={x}
                y={y + r + 26}
                textAnchor="middle"
                fill={info.color}
                fontSize={9}
                fontWeight={600}
              >
                {detail}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="text-muted-foreground mt-2 flex flex-wrap justify-center gap-4 text-[11px] [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5 [&_i]:inline-block [&_i]:size-2.5 [&_i]:rounded-[3px]">
        <span>
          <i style={{ background: FLOW_CMD }} /> command · LLM → device
        </span>
        <span>
          <i style={{ background: FLOW_RES }} /> response · device → LLM
        </span>
        <span>
          <i style={{ background: FLOW_CMD }} /> live call (round-trip)
        </span>
        {payload.devices.some((d) => jumpLabel(d)) && (
          <span>
            <i style={{ background: JUMP_HUE }} /> 🔒 SSH jump tunnel (ProxyJump)
          </span>
        )}
        {payload.devices.some((d) => d.pool?.pooled) && (
          <span>
            <i style={{ background: POOL_HUE }} /> pooled SSH connection
          </span>
        )}
      </div>
    </>
  );
}

/** Short label for the wireless stack a device answers on. */
function stackLabel(stack: CapabilitiesJson["wirelessStack"]): string | null {
  switch (stack) {
    case "wifi":
      return "wifi (v7)";
    case "wireless":
      return "wireless (legacy)";
    case "capsman-legacy":
      return "caps-man";
    default:
      return null;
  }
}

/**
 * What the device is known to support. Rendered only once a probe has resolved:
 * an unprobed device shows a Probe button instead, never an empty matrix that
 * reads as "supports nothing".
 */
function CapabilityStrip({
  caps,
  busy,
  onProbe,
}: {
  caps: CapabilitiesJson | null;
  busy: boolean;
  onProbe?: () => void;
}): ReactNode {
  if (!caps) {
    return (
      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-[10px]">
        <span>capabilities not probed</span>
        {onProbe && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onProbe}
            title="Probe this device's capabilities (version, packages, wireless stack, device-mode)"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Cpu />} Probe
          </Button>
        )}
      </div>
    );
  }
  const stack = stackLabel(caps.wirelessStack);
  const blocked = (["container", "scheduler", "fetch"] as const).filter((k) => !caps.deviceMode[k]);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
      {caps.version && (
        <span title={`RouterOS ${caps.version} (${caps.channel})`}>
          <Badge type="secondary">v{caps.version}</Badge>
        </span>
      )}
      {caps.isRouterBoard && <Badge type="secondary">RouterBOARD</Badge>}
      {stack && <Badge type="secondary">{stack}</Badge>}
      {caps.packages
        .filter((p) => p !== "routeros" && p !== "system")
        .slice(0, 4)
        .map((p) => (
          <span key={p} title={`\`${p}\` package enabled`}>
            <Badge type="accent">{p}</Badge>
          </span>
        ))}
      {blocked.length > 0 && (
        <span
          title={`device-mode blocks: ${blocked.join(", ")} — changing it needs a physical reset-button confirmation`}
        >
          <Badge type="warning">{blocked.join("/")} blocked</Badge>
        </span>
      )}
      {onProbe && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={onProbe}
          title="Reprobe capabilities"
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      )}
    </div>
  );
}

export function DeviceCard({
  d,
  allNames,
  capabilities,
  onToggle,
  onTest,
  onReconnect,
  onProbeCapabilities,
}: {
  d: DeviceInfo;
  /** Every device name in the fleet — needed so the card's colour matches the
   *  radar's for the same device regardless of any filtering applied to the grid. */
  allNames: string[];
  /** Probed capabilities, or null when nothing has been probed yet. */
  capabilities?: CapabilitiesJson | null;
  onToggle?: (name: string, disabled: boolean) => void;
  /** Probe the device now (fresh SSH connect + health refresh). */
  onTest?: (name: string) => Promise<void>;
  /** Drop the pooled connection and re-establish it, then refresh health. */
  onReconnect?: (name: string) => Promise<void>;
  /** Probe (or reprobe) this device's capabilities. */
  onProbeCapabilities?: (name: string) => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState<"test" | "reconnect" | null>(null);
  const [probing, setProbing] = useState(false);
  const runAction = (kind: "test" | "reconnect"): void => {
    if (busy) return;
    const fn = kind === "test" ? onTest : onReconnect;
    if (!fn) return;
    setBusy(kind);
    void fn(d.name).finally(() => setBusy(null));
  };
  const info = statusInfo(d.status);
  const statusLine =
    d.status.reachable === true
      ? `${info.label} · ${d.status.latencyMs ?? "?"}ms${d.status.version ? ` · v${d.status.version}` : ""}`
      : d.status.reachable === false
        ? `${info.label}${d.status.error ? ` · ${d.status.error}` : ""}`
        : info.label;
  const col = deviceColor(d.name, allNames);
  return (
    <div
      className={cn(
        "bg-card grid gap-2 rounded-lg border px-[15px] py-3.5 transition-[transform,border-color] duration-300",
        "hover:border-chart-2/35 hover:-translate-y-0.5",
        d.disabled && "opacity-50 grayscale-[0.4]",
      )}
      style={{ borderLeft: `3px solid ${col}` }}
      data-disabled={d.disabled ? "1" : undefined}
    >
      <div className="flex items-center gap-2">
        <span
          className="size-[9px] shrink-0 rounded-full"
          style={{ background: col }}
          title="device colour"
        />
        {d.geo?.countryCode && (
          <img
            src={withToken(`/api/flag/${d.geo.countryCode}`)}
            alt={d.geo.country}
            title={d.geo.city ? `${d.geo.country} · ${d.geo.city}` : d.geo.country}
            className="size-4 shrink-0"
            loading="lazy"
          />
        )}
        <span className="text-[13px] font-medium">{d.name}</span>
        {d.isDefault && <Badge type="accent">default</Badge>}
        {d.disabled && <Badge type="warning">disabled</Badge>}
        <span
          className="size-[7px] shrink-0 rounded-full"
          style={{ background: info.color }}
          title={info.label}
        />
        <span className="flex-1" />
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={!d.disabled}
            onCheckedChange={() => onToggle?.(d.name, !d.disabled)}
            title={d.disabled ? "Enable device" : "Disable device"}
            aria-label={d.disabled ? "Enable device" : "Disable device"}
          />
        </span>
        {d.transport === "rest" && (
          <span
            title={`Attempts the RouterOS REST API on port ${d.restPort ?? 443}, falling back to SSH for anything REST cannot express`}
          >
            <Badge type="accent">rest</Badge>
          </span>
        )}
        <Badge type="secondary">{d.authMode}</Badge>
      </div>
      <div className="text-muted-foreground [&_b]:text-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] text-[11px] [&_b]:font-medium [&_b]:break-words">
        <span>{d.mac ? "mac" : "host"}</span>
        <b>{d.address ?? `${d.host}:${d.port}`}</b>
        <span>user</span>
        <b>{d.username}</b>
        <span>status</span>
        <b style={{ color: info.color }}>{statusLine}</b>
        <span>activity</span>
        <b>
          {d.activity.calls} calls · {d.activity.errors} err
          {d.activity.avgMs ? ` · ${ms(d.activity.avgMs)} avg` : ""}
        </b>
        {d.pool && (
          <>
            <span>pool</span>
            <b
              className={
                d.pool.dead
                  ? "text-destructive"
                  : d.pool.inflight > 0
                    ? "text-chart-1"
                    : d.pool.pooled
                      ? "text-success"
                      : "text-muted-foreground"
              }
            >
              {d.pool.pooled
                ? d.pool.inflight > 0
                  ? `${d.pool.inflight} inflight`
                  : "connected"
                : "\u2014"}
            </b>
          </>
        )}
        {d.description && (
          <>
            <span>note</span>
            <b>{d.description}</b>
          </>
        )}
      </div>
      <CapabilityStrip
        caps={capabilities ?? null}
        busy={probing}
        onProbe={
          onProbeCapabilities
            ? () => {
                if (probing) return;
                setProbing(true);
                void onProbeCapabilities(d.name).finally(() => setProbing(false));
              }
            : undefined
        }
      />
      {jumpLabel(d) && (
        <div
          className="border-warning/30 bg-warning/8 mt-2.5 mb-0.5 flex items-center gap-1.5 overflow-hidden rounded-[10px] border px-2.5 py-[7px] text-[10px]"
          title={`Reached over SSH through the bastion ${jumpLabel(d)} (ProxyJump) — no port exposed on ${d.name}.`}
        >
          <span className="border-warning/60 text-warning bg-background inline-flex items-center gap-1.5 rounded-[7px] border px-2 py-[3px] whitespace-nowrap">
            <ShieldCheck className="size-3" /> {jumpLabel(d)}
            {d.jumpVia ? (
              <i className="bg-warning text-background rounded-[4px] px-1 py-px text-[7px] tracking-[0.08em] uppercase not-italic">
                jump
              </i>
            ) : null}
          </span>
          {/* Gradient + keyframe driven — `.jump-route__wire` lives in viz.css. */}
          <span className="jump-route__wire jump-route__wire--enc">
            <span className="jump-route__lock" aria-hidden>
              🔒
            </span>
          </span>
          <span
            className="bg-background text-foreground inline-flex items-center gap-1.5 rounded-[7px] border px-2 py-[3px] whitespace-nowrap"
            style={{ borderColor: col }}
            title={d.name}
          >
            <RadioTower className="size-3" /> {d.name}
          </span>
        </div>
      )}
      {(onTest || onReconnect) && (
        <div className="mt-1.5 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {onTest && (
            <Button
              variant="outline"
              size="xs"
              disabled={!!busy}
              onClick={() => runAction("test")}
              title="Probe this device now (fresh SSH connect + health refresh)"
            >
              {busy === "test" ? <Loader2 className="animate-spin" /> : <Activity />} Test
            </Button>
          )}
          {onReconnect && (
            <Button
              variant="outline"
              size="xs"
              disabled={!!busy}
              onClick={() => runAction("reconnect")}
              title="Drop the pooled SSH connection and re-establish it"
            >
              {busy === "reconnect" ? <Loader2 className="animate-spin" /> : <RotateCw />} Reconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
