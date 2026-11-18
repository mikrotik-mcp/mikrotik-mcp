import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import type { Relation } from "../../src/memory/types";
import { tipProps } from "./kit";

const W = 320;
const H = 150;
const CX = 150;
const CY = 75;
/** Neighbours drawn around the entity; the rest are listed, not drawn. */
export const GRAPH_LIMIT = 6;

function short(name: string, max = 14): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * The entity in the middle and the entities it links to around it. Incoming
 * links are teal, outgoing ones indigo and dashed. Nodes settle in on load.
 */
export function RelationGraph({
  entity,
  relations,
  onSelect,
}: {
  entity: string;
  relations: Relation[];
  onSelect: (name: string) => void;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const shown = relations.slice(0, GRAPH_LIMIT);
  const key = `${entity}:${shown.map((r) => `${r.from}>${r.to}`).join(",")}`;
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({
      root: root as unknown as RefObject<HTMLElement | null>,
      mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate("[data-node]", {
        opacity: [0, 1],
        scale: [0.6, 1],
        duration: 420,
        delay: stagger(50),
        ease: "outBack(1.4)",
      });
    });
    return () => scope.current?.revert();
  }, [key]);
  const nodes = shown.map((r, i) => {
    const angle = -Math.PI / 2 + ((i + 0.5) / shown.length) * Math.PI * 2 - Math.PI / 2;
    const out = r.from === entity;
    return {
      name: out ? r.to : r.from,
      type: r.relationType,
      at: r.createdAt,
      out,
      x: Math.round(CX + Math.cos(angle) * 110),
      y: Math.round(CY + Math.sin(angle) * 48),
    };
  });
  return (
    <svg
      ref={root}
      viewBox={`-20 0 ${W + 20} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label={`Relations of ${entity}`}
      className="memory-graph kit-tips"
    >
      {nodes.map((n) => (
        <line
          key={`l-${n.name}-${n.type}`}
          x1={CX}
          y1={CY}
          x2={n.x}
          y2={n.y}
          stroke={n.out ? "var(--brand)" : "var(--sig)"}
          strokeOpacity={0.5}
          strokeWidth={1.5}
          strokeDasharray={n.out ? "4 4" : undefined}
        />
      ))}
      <circle cx={CX} cy={CY} r={22} fill="var(--glass-2)" stroke="var(--sig)" />
      <text
        x={CX}
        y={CY + 4}
        textAnchor="middle"
        fontSize="10"
        fill="var(--foreground)"
        fontFamily="var(--font-mt)"
      >
        {short(entity, 8)}
      </text>
      {nodes.map((n) => (
        <g
          key={`n-${n.name}-${n.type}`}
          data-node
          style={{ transformOrigin: `${n.x}px ${n.y}px`, cursor: "pointer" }}
          onClick={() => onSelect(n.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(n.name);
            }
          }}
          {...tipProps(() => ({
            title: n.name,
            sub: n.out ? "outgoing" : "incoming",
            rows: [
              { label: "Relation", value: n.type, color: n.out ? "var(--brand)" : "var(--sig)" },
              { label: n.out ? "From" : "To", value: entity },
              { label: "Added", value: new Date(n.at).toLocaleString("en-US") },
            ],
            action: { label: `Open ${short(n.name, 20)}`, onClick: () => onSelect(n.name) },
          }))}
        >
          <circle cx={n.x} cy={n.y} r={6} fill={n.out ? "var(--brand)" : "var(--sig)"} />
          <text
            x={n.x}
            y={n.y > CY ? n.y - 12 : n.y + 22}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted-foreground)"
            fontFamily="var(--font-mt)"
          >
            {short(n.name)}
          </text>
        </g>
      ))}
    </svg>
  );
}
