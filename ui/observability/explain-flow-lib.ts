/**
 * The Explain document's topology diagram: read the Mermaid `graph LR` source
 * the server writes (`src/narrative/mermaid.ts`) and lay it out left to right.
 *
 * Pure (no React, no DOM) so it is tested offline. It reads only the subset of
 * Mermaid that the server emits: one node or one edge per line.
 *
 * Layout: the router is the trunk. Everything it leads to is a tidy tree to its
 * right (a parent sits at the middle of its children). What leads to it — the
 * internet and the WAN interfaces — is stacked in columns to its left, centred
 * on the router.
 */

export type FlowShape = "box" | "circle" | "hex" | "round" | "stadium";
export type FlowKind =
  | "internet"
  | "wan"
  | "router"
  | "bridge"
  | "vlan"
  | "tunnel"
  | "peer"
  | "wireless"
  | "port";

export interface FlowNode {
  id: string;
  /** The label, one entry for each line. The first is the name. */
  lines: string[];
  shape: FlowShape;
  disabled: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const OPENERS: [string, FlowShape][] = [
  ["((", "circle"],
  ["{{", "hex"],
  ["([", "stadium"],
  ["(", "round"],
  ["[", "box"],
];
const NODE = /^(\w+)(\(\(|\{\{|\(\[|\(|\[)"(.*)"(?:\)\)|\}\}|\]\)|\)|\])$/;
const EDGE = /^(\w+) (---|-\.-)(?:\|"(.*?)"\|)? (.+)$/;

function readNode(text: string): FlowNode | null {
  const match = text.match(NODE);
  if (!match) return null;
  const all = match[3]!
    .replace(/&quot;/g, '"')
    .split(/<br\s*\/?>/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = all.filter((line) => line !== "disabled");
  return {
    id: match[1]!,
    lines: lines.length > 0 ? lines : [match[1]!],
    shape: OPENERS.find(([open]) => open === match[2])![1],
    disabled: lines.length !== all.length,
  };
}

export function parseFlow(source: string): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const need = (id: string): void => {
    if (!nodes.has(id)) nodes.set(id, { id, lines: [id], shape: "box", disabled: false });
  };
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const node = readNode(line);
    if (node) {
      nodes.set(node.id, node);
      continue;
    }
    const edge = line.match(EDGE);
    if (!edge) continue;
    // The target may carry its own definition: `router --- empty["…"]`.
    const target = readNode(edge[4]!);
    if (target) nodes.set(target.id, target);
    const to = target?.id ?? edge[4]!;
    need(edge[1]!);
    need(to);
    edges.push({ from: edge[1]!, to, label: edge[3] || undefined, dashed: edge[2] === "-.-" });
  }
  return { nodes: Array.from(nodes.values()), edges };
}

export interface PlacedNode extends FlowNode {
  kind: FlowKind;
  /** Left edge and vertical centre. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEdge extends FlowEdge {
  path: string;
  /** The middle of the line, where its label sits. */
  lx: number;
  ly: number;
}

export interface FlowLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

const SLOT = 50;
const GAP = 92;
const GAP_PLAIN = 52;
const PAD = 18;
const CHAR = 6.9;

function kindOf(node: FlowNode, graph: FlowGraph, hasChildren: boolean): FlowKind {
  if (node.id === "internet") return "internet";
  if (node.id === "router") return "router";
  if (graph.edges.some((e) => e.to === node.id && e.dashed)) return "peer";
  if (graph.edges.some((e) => e.to === node.id && e.from === "internet")) return "wan";
  if (node.shape === "hex") return "tunnel";
  if (node.shape === "stadium") return "wireless";
  if (node.shape === "round") return "vlan";
  return hasChildren ? "bridge" : "port";
}

export function layoutFlow(graph: FlowGraph): FlowLayout {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  // Column: the longest chain of edges that leads to the node.
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let round = 0; round < nodes.length; round += 1) {
    let moved = false;
    for (const e of edges) {
      const next = depth.get(e.from)! + 1;
      if (next > depth.get(e.to)! && next <= nodes.length) {
        depth.set(e.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const trunk =
    nodes.find((n) => n.id === "router") ??
    [...nodes].sort((a, b) => (out.get(b.id)?.length ?? 0) - (out.get(a.id)?.length ?? 0))[0]!;

  // The tree to the right of the trunk: each leaf takes the next row.
  const y = new Map<string, number>();
  const kids = new Map<string, string[]>();
  let row = 0;
  const place = (id: string): number => {
    y.set(id, 0); // marks the node as visited before its children are walked
    const children = (out.get(id) ?? []).filter((child) => !y.has(child));
    const placed = children.map((child) => place(child));
    kids.set(id, children);
    const at = placed.length > 0 ? (placed[0]! + placed.at(-1)!) / 2 : row++;
    y.set(id, at);
    return at;
  };
  place(trunk.id);

  // What leads to the trunk, and anything not connected: stacked by column.
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    if (y.has(n.id)) continue;
    const d = depth.get(n.id)!;
    columns.set(d, [...(columns.get(d) ?? []), n.id]);
  }
  const centre = y.get(trunk.id)!;
  for (const [d, ids] of columns) {
    const beside = d < depth.get(trunk.id)!;
    ids.forEach((id, index) => {
      y.set(id, beside ? centre + index - (ids.length - 1) / 2 : row++);
    });
  }
  const top = Math.min(...y.values());

  const maxDepth = Math.max(...depth.values());
  const widths: number[] = [];
  for (let d = 0; d <= maxDepth; d += 1) {
    const chars = nodes
      .filter((n) => depth.get(n.id) === d)
      .flatMap((n) => n.lines.map((line) => line.length));
    widths.push(Math.min(280, Math.max(104, Math.max(0, ...chars) * CHAR + 34)));
  }
  // A gap is wide only where a line with a label crosses it.
  const labelled = new Set(edges.filter((e) => e.label).map((e) => depth.get(e.from)!));
  const left: number[] = [];
  widths.forEach((_, d) =>
    left.push(
      d === 0 ? PAD : left[d - 1]! + widths[d - 1]! + (labelled.has(d - 1) ? GAP : GAP_PLAIN),
    ),
  );

  const placed: PlacedNode[] = nodes.map((n) => {
    const d = depth.get(n.id)!;
    const big = n.id === trunk.id;
    return {
      ...n,
      kind: kindOf(n, graph, (kids.get(n.id)?.length ?? 0) > 0),
      x: left[d]!,
      y: PAD + (y.get(n.id)! - top) * SLOT + SLOT / 2,
      w: widths[d]!,
      h: (n.lines.length > 1 ? 40 : 28) + (big ? 10 : 0),
    };
  });
  const byId = new Map(placed.map((n) => [n.id, n]));

  const lines: PlacedEdge[] = edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const x1 = a.x + a.w;
    const bend = (b.x - x1) / 2;
    return {
      ...e,
      path: `M ${x1} ${a.y} C ${x1 + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`,
      lx: x1 + bend,
      ly: (a.y + b.y) / 2,
    };
  });

  return {
    nodes: placed,
    edges: lines,
    width: left[maxDepth]! + widths[maxDepth]! + PAD,
    height: Math.max(...placed.map((n) => n.y + n.h / 2)) + PAD,
  };
}

/** A node, everything that leads to it and everything it leads to. */
export function related(graph: FlowGraph, id: string): Set<string> {
  const seen = new Set([id]);
  const walk = (from: string, forward: boolean): void => {
    for (const e of graph.edges) {
      const next = forward ? (e.from === from ? e.to : null) : e.to === from ? e.from : null;
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      walk(next, forward);
    }
  };
  walk(id, true);
  walk(id, false);
  return seen;
}
