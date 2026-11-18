/**
 * The topology of the Explain document, drawn from its Mermaid source: the
 * internet on the left, the router in the middle, its interfaces and their
 * ports and peers to the right. Hover a node to light the path through it.
 *
 * chart-exempt: a diagram, not a chart. Each node carries its text and a title.
 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { layoutFlow, parseFlow, related } from "./explain-flow-lib";
import type { FlowKind } from "./explain-flow-lib";

const LEGEND: [FlowKind, string][] = [
  ["wan", "Internet and WAN"],
  ["router", "Router, bridge, VLAN"],
  ["tunnel", "Tunnel and peer"],
  ["wireless", "Wireless"],
  ["port", "Port"],
];

export function ExplainFlow({ source }: { source: string }): ReactNode {
  const graph = useMemo(() => parseFlow(source), [source]);
  const layout = useMemo(() => layoutFlow(graph), [graph]);
  const [hover, setHover] = useState<string | null>(null);
  const lit = useMemo(() => (hover ? related(graph, hover) : null), [graph, hover]);

  if (layout.nodes.length === 0) return <pre>{source}</pre>;

  return (
    <figure className="explain-flow">
      <div className="explain-flow-legend" aria-hidden="true">
        {LEGEND.map(([kind, text]) => (
          <span key={kind} data-kind={kind}>
            <i />
            {text}
          </span>
        ))}
        <span data-kind="off">
          <i />
          Disabled
        </span>
      </div>
      <div className="explain-flow-canvas">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`Topology diagram with ${layout.nodes.length} nodes`}
          data-hover={lit ? "" : undefined}
          onMouseLeave={() => setHover(null)}
        >
          {layout.edges.map((edge) => {
            const on = lit !== null && lit.has(edge.from) && lit.has(edge.to);
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                className="explain-flow-edge"
                d={edge.path}
                data-dashed={edge.dashed ? "" : undefined}
                data-flow={edge.label && !edge.dashed ? "" : undefined}
                data-lit={on ? "" : undefined}
                data-dim={lit && !on ? "" : undefined}
              />
            );
          })}
          {layout.edges.map((edge) => {
            if (!edge.label) return null;
            const width = edge.label.length * 5.7 + 14;
            const on = lit !== null && lit.has(edge.from) && lit.has(edge.to);
            return (
              <g
                key={`${edge.from}>${edge.to}`}
                className="explain-flow-tag"
                data-dim={lit && !on ? "" : undefined}
              >
                <rect x={edge.lx - width / 2} y={edge.ly - 8} width={width} height={16} rx={8} />
                <text x={edge.lx} y={edge.ly + 3.5} textAnchor="middle">
                  {edge.label}
                </text>
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const two = node.lines.length > 1;
            return (
              <g
                key={node.id}
                className="explain-flow-node"
                data-kind={node.kind}
                data-off={node.disabled ? "" : undefined}
                data-dim={lit && !lit.has(node.id) ? "" : undefined}
                onMouseEnter={() => setHover(node.id)}
              >
                <title>{`${node.lines.join(" · ")}${node.disabled ? " · disabled" : ""}`}</title>
                <rect
                  x={node.x}
                  y={node.y - node.h / 2}
                  width={node.w}
                  height={node.h}
                  rx={node.kind === "internet" ? node.h / 2 : 9}
                />
                <rect
                  className="bar"
                  x={node.x + 5}
                  y={node.y - node.h / 2 + 7}
                  width={3}
                  height={node.h - 14}
                  rx={1.5}
                />
                <text className="nm" x={node.x + 16} y={node.y + (two ? -3 : 4)}>
                  {node.lines[0]}
                </text>
                {two && (
                  <text className="sub" x={node.x + 16} y={node.y + 11}>
                    {node.lines.slice(1).join(" · ")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="explain-flow-src">
        <summary>Mermaid source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
