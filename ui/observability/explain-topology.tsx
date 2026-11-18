/**
 * The Explain page's topology: the router at the centre, top-level interfaces
 * on a ring around it, and bridge ports or VLANs fanned out from their parent.
 *
 * Layout: the first WAN goes to the top, the parent with the most children
 * goes to the right so its ports have room, and the rest share the bottom and
 * left side. With neither, interfaces spread evenly round the ring.
 */
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { animate, createScope, stagger, svg } from "animejs";
import type { Scope } from "animejs";
import type { DeviceNarrativePayload } from "./types";

const W = 560;
const H = 330;
const CX = W / 2;
const CY = H / 2;
/** Half-width and half-height of the inner ring the top-level interfaces sit on. */
const RX = 140;
const RY = 117;
/** How far a child sits from its parent, and the angle between siblings. */
const CHILD_R = 120;
const CHILD_STEP = Math.PI / 5;

type Kind = "wan" | "bridge" | "vlan" | "tunnel" | "wireless" | "ether";

const NODE_FILL: Record<Kind, string> = {
  wan: "var(--destructive)",
  bridge: "var(--brand)",
  vlan: "var(--brand)",
  tunnel: "var(--sig)",
  wireless: "var(--warning)",
  ether: "var(--text-faint)",
};

interface Node {
  name: string;
  kind: Kind;
  x: number;
  y: number;
  parent?: string;
  disabled: boolean;
}

function kindOf(kind: string, name: string, wans: Set<string>): Kind {
  if (wans.has(name)) return "wan";
  if (kind === "bridge") return "bridge";
  if (kind === "vlan") return "vlan";
  if (kind.includes("wireguard") || kind.includes("tunnel") || kind.endsWith("-client")) {
    return "tunnel";
  }
  if (kind === "wireless" || kind === "wifi") return "wireless";
  return "ether";
}

/** A point on the inner ring: an ellipse squared off at the sides so nodes line up. */
function ringPoint(angle: number): { x: number; y: number } {
  const dx = Math.max(-RX, Math.min(RX, (RX * Math.cos(angle)) / Math.cos(Math.PI / 6)));
  return { x: CX + dx, y: CY + RY * Math.sin(angle) };
}

export function layoutTopology(n: DeviceNarrativePayload): Node[] {
  const wanNames = new Set(n.wans.map((w) => w.interface));
  const names = new Set(n.interfaces.map((i) => i.name));
  const top = n.interfaces.filter((i) => !i.parent || !names.has(i.parent));
  const children = n.interfaces.filter((i) => i.parent && names.has(i.parent));
  const childCount = new Map<string, number>();
  for (const c of children) childCount.set(c.parent!, (childCount.get(c.parent!) ?? 0) + 1);

  const wan = top.find((i) => wanNames.has(i.name));
  const hub = [...top]
    .filter((i) => i !== wan && (childCount.get(i.name) ?? 0) > 0)
    .sort((a, b) => (childCount.get(b.name) ?? 0) - (childCount.get(a.name) ?? 0))[0];
  const rest = top.filter((i) => i !== wan && i !== hub);

  const angle = new Map<string, number>();
  if (wan && hub) {
    angle.set(wan.name, -Math.PI / 2);
    angle.set(hub.name, 0);
    rest.forEach((i, k) =>
      angle.set(i.name, Math.PI / 2 + (k * Math.PI) / Math.max(1, rest.length)),
    );
  } else {
    const order = [...(wan ? [wan] : []), ...(hub ? [hub] : []), ...rest];
    order.forEach((i, k) => angle.set(i.name, -Math.PI / 2 + (k * 2 * Math.PI) / order.length));
  }

  const nodes: Node[] = [];
  const pos = new Map<string, { x: number; y: number; a: number }>();
  for (const i of top) {
    const a = angle.get(i.name) ?? 0;
    const p = ringPoint(a);
    pos.set(i.name, { ...p, a });
    nodes.push({
      name: i.name,
      kind: kindOf(i.kind, i.name, wanNames),
      ...p,
      disabled: i.disabled,
    });
  }
  const placed = new Map<string, number>();
  for (const c of children) {
    const parent = pos.get(c.parent!);
    if (!parent) continue;
    const total = childCount.get(c.parent!) ?? 1;
    const k = placed.get(c.parent!) ?? 0;
    placed.set(c.parent!, k + 1);
    const a = parent.a + (k - Math.floor((total - 1) / 2)) * CHILD_STEP;
    nodes.push({
      name: c.name,
      kind: kindOf(c.kind, c.name, wanNames),
      x: parent.x + CHILD_R * Math.cos(a),
      y: parent.y + CHILD_R * Math.sin(a),
      parent: c.parent,
      disabled: c.disabled,
    });
  }
  return nodes;
}

/** The network of an IPv4 CIDR, e.g. 203.0.113.2/30 → 203.0.113.0/30. */
export function networkOf(cidr: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return null;
  const bits = Number(m[5]);
  const ip = m.slice(1, 5).reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - bits);
  const net = Math.floor(ip / size) * size;
  const octets = [24, 16, 8, 0].map((s) => Math.floor(net / 2 ** s) % 256);
  return `${octets.join(".")}/${bits}`;
}

export function ExplainTopology({ narrative }: { narrative: DeviceNarrativePayload }): ReactNode {
  const nodes = useMemo(() => layoutTopology(narrative), [narrative]);
  const root = useRef<HTMLDivElement>(null);
  const scope = useRef<Scope | null>(null);

  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({
      root,
      mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      if (self?.matches.reduceMotion || !root.current?.querySelector("[data-dot]")) return;
      // Dashed tunnel links fade in; drawing them would replace their dash pattern.
      const dashed = root.current?.querySelectorAll("line[data-link][stroke-dasharray]");
      if (dashed?.length) animate(dashed, { opacity: [0, 1], duration: 600, ease: "outQuart" });
      const lines = root.current?.querySelectorAll<SVGLineElement>(
        "line[data-link]:not([stroke-dasharray])",
      );
      if (lines?.length) {
        animate(svg.createDrawable(lines), {
          draw: ["0 0", "0 1"],
          duration: 600,
          ease: "outQuart",
        });
      }
      animate("[data-dot]", {
        opacity: [0, 1],
        scale: [0.4, 1],
        duration: 360,
        delay: stagger(30, { start: 120 }),
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, [nodes]);

  if (narrative.interfaces.length === 0) {
    return <p className="explain-empty">No interfaces found in this export.</p>;
  }

  const byName = new Map(nodes.map((nd) => [nd.name, nd]));
  const wan = nodes.find(
    (nd) => nd.kind === "wan" && !nd.parent && nd.y < CY && Math.abs(nd.x - CX) < 1,
  );
  const wanAddress = wan
    ? narrative.interfaces.find((i) => i.name === wan.name)?.addresses[0]
    : undefined;
  const wanNet = wanAddress ? networkOf(wanAddress) : null;
  const name = narrative.identity.name ?? "router";
  // The hub circle holds about seven mono characters.
  const hubLabel = name.length > 8 ? `${name.slice(0, 7)}…` : name;

  return (
    <div ref={root} className="explain-topo">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Interface topology"
      >
        <circle cx={CX} cy={CY} r={117} fill="none" stroke="var(--line)" strokeDasharray="3 6" />
        <circle cx={CX} cy={CY} r={200} fill="none" stroke="var(--line)" strokeDasharray="3 6" />
        {nodes.map((nd) => {
          const from = nd.parent ? byName.get(nd.parent) : undefined;
          const stroke =
            nd.kind === "wan"
              ? "var(--destructive)"
              : nd.kind === "tunnel"
                ? "var(--sig)"
                : "var(--line-2)";
          return (
            <line
              key={`l-${nd.name}`}
              data-link=""
              x1={from?.x ?? CX}
              y1={from?.y ?? CY}
              x2={nd.x}
              y2={nd.y}
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray={nd.kind === "tunnel" ? "4 4" : undefined}
              opacity={nd.disabled ? 0.4 : undefined}
            />
          );
        })}
        <circle
          cx={CX}
          cy={CY}
          r={30}
          fill="var(--sig-soft)"
          stroke="var(--sig)"
          strokeWidth={1.5}
        />
        <text x={CX} y={CY + 4} textAnchor="middle" className="explain-topo-hub">
          <title>{name}</title>
          {hubLabel}
        </text>
        {nodes.map((nd) => (
          <g key={nd.name} data-node="" opacity={nd.disabled ? 0.45 : undefined}>
            <circle
              data-dot=""
              cx={nd.x}
              cy={nd.y}
              r={nd.parent ? 6 : 9}
              fill={NODE_FILL[nd.kind]}
              opacity={nd.parent ? 0.75 : 0.9}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            />
            <text
              x={nd.x}
              y={nd.y < CY ? nd.y - 14 : nd.y + 21}
              textAnchor="middle"
              className="explain-topo-label"
            >
              {nd.name}
            </text>
          </g>
        ))}
        {wan && (
          <text x={CX} y={20} textAnchor="middle" className="explain-topo-wan">
            {wanNet ? `WAN · ${wanNet}` : "WAN"}
          </text>
        )}
      </svg>
    </div>
  );
}
