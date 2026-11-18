/**
 * The Round-trip result graphic: the request lane (client → destination) over
 * the reply lane (destination → client), one node per router. A lane is solid
 * while the model lets the packet through, pink into the router that drops it,
 * and dashed grey after it, where nothing was reached.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HopEvidence, PathLeg, PathStatus } from "../../src/paths/types";
import { useLineDraw } from "./monitoring-ui";

const H = 196;
const Y_REQ = 46;
const Y_REP = 150;
const EDGE = 70;

export const PATH_LABEL: Record<PathStatus, string> = {
  modelled: "Allowed in the model",
  blocked: "Blocked in the model",
  unknown: "Cannot determine",
};
const STATUS_COLOR: Record<PathStatus, string> = {
  modelled: "var(--sig)",
  blocked: "var(--destructive)",
  unknown: "var(--warning)",
};
const TITLE_COLOR: Record<PathStatus, string> = {
  modelled: "var(--success)",
  blocked: "var(--destructive)",
  unknown: "var(--warning)",
};
const FAINT = "var(--text-faint)";
const MONO = { fontFamily: "var(--font-mt)" };

/** "forward #7 · drop": the rule that stopped the packet, when the trace has one. */
export function stoppingRule(hop: HopEvidence): string | null {
  const step = [...(hop.trace?.steps ?? [])]
    .reverse()
    .find((s) => /^(drop|reject|tarpit)$/i.test(s.action));
  if (!step) return null;
  return `${step.chain}${step.index >= 0 ? ` #${step.index}` : ""} · ${step.action}`;
}

interface LaneNode {
  x: number;
  /** null for the client and destination ends. */
  hop: HopEvidence | null;
}

function spread(count: number, width: number): number[] {
  if (count < 2) return [width / 2];
  return Array.from({ length: count }, (_, i) => EDGE + ((width - 2 * EDGE) * i) / (count - 1));
}

/** Segment and node colours for one lane, in travel order. */
function walk(nodes: LaneNode[]) {
  let reached = true;
  const segments: { from: number; to: number; color: string; dashed: boolean }[] = [];
  const colors: string[] = ["var(--sig)"];
  for (let i = 0; i < nodes.length - 1; i++) {
    const next = nodes[i + 1];
    const tone = next.hop ? STATUS_COLOR[next.hop.status] : "var(--sig)";
    segments.push({
      from: nodes[i].x,
      to: next.x,
      color: reached ? tone : FAINT,
      dashed: !reached,
    });
    colors.push(reached ? tone : FAINT);
    if (next.hop && next.hop.status !== "modelled") reached = false;
  }
  return { segments, colors };
}

function Node({
  x,
  y,
  color,
  hop,
}: {
  x: number;
  y: number;
  color: string;
  hop: HopEvidence | null;
}) {
  if (hop?.status === "blocked" && color !== FAINT)
    return (
      <g transform={`translate(${x} ${y})`}>
        <circle r={15} fill="var(--bad-soft)" stroke="var(--destructive)" strokeWidth={1.6} />
        <path
          d="M-5 -5 L5 5 M5 -5 L-5 5"
          stroke="var(--destructive)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </g>
    );
  return (
    <g>
      <circle cx={x} cy={y} r={15} fill="var(--surface-2)" stroke={color} strokeWidth={1.6} />
      <circle cx={x} cy={y} r={4} fill={color} />
    </g>
  );
}

function Lane({ nodes, y, arrows }: { nodes: LaneNode[]; y: number; arrows: boolean }): ReactNode {
  const { segments, colors } = walk(nodes);
  return (
    <>
      {segments.map((s, i) => {
        const dir = s.to > s.from ? 1 : -1;
        const a = s.from + 16 * dir;
        const b = s.to - 16 * dir;
        return (
          <g key={i}>
            <path
              data-draw={s.dashed ? undefined : true}
              d={`M${a} ${y} L${b} ${y}`}
              stroke={s.color}
              strokeWidth={2}
              strokeOpacity={0.75}
              strokeDasharray={s.dashed ? "5 5" : undefined}
              fill="none"
            />
            {arrows && !s.dashed && (
              <path
                d={`M${b - 8 * dir} ${y - 5} l${6 * dir} 5 ${-6 * dir} 5`}
                fill="none"
                stroke={s.color}
                strokeWidth={1.6}
              />
            )}
          </g>
        );
      })}
      {nodes.map((n, i) => (
        <Node key={i} x={n.x} y={y} color={colors[i]} hop={n.hop} />
      ))}
    </>
  );
}

export function RoundTripLanes({
  client,
  destination,
  forward,
  reverse,
}: {
  client: string;
  destination: string;
  forward: PathLeg;
  reverse: PathLeg;
}): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1096);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLineDraw(
    box,
    `${forward.hops.length}-${reverse.hops.length}-${forward.status}-${reverse.status}`,
  );

  const reqX = spread(forward.hops.length + 2, width);
  const request: LaneNode[] = reqX.map((x, i) => ({
    x,
    hop: i === 0 || i === reqX.length - 1 ? null : forward.hops[i - 1],
  }));
  // The reply travels right to left; a mirrored path reuses the request's columns.
  const repX = spread(reverse.hops.length + 2, width).reverse();
  const reply: LaneNode[] = repX.map((x, i) => ({
    x,
    hop: i === 0 || i === repX.length - 1 ? null : reverse.hops[i - 1],
  }));
  const ownColumns = reverse.hops.length !== forward.hops.length;
  const labels = request.map((n, i) => ({
    x: n.x,
    name: i === 0 ? client : i === request.length - 1 ? destination : (n.hop?.device ?? ""),
    sub:
      i === 0
        ? "client"
        : i === request.length - 1
          ? "destination"
          : `${n.hop?.ingress} → ${n.hop?.egress}`,
  }));

  return (
    <div className="min-w-0 overflow-x-auto">
      <div ref={box} className="min-w-[600px]">
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label="Request and reply paths"
          className="block overflow-visible"
        >
          <text
            x={0}
            y={Y_REQ - 26}
            fontSize={11}
            letterSpacing=".1em"
            fill={TITLE_COLOR[forward.status]}
          >
            REQUEST → DESTINATION · {PATH_LABEL[forward.status].toUpperCase()}
          </text>
          <text
            x={0}
            y={Y_REP - 26}
            fontSize={11}
            letterSpacing=".1em"
            fill={TITLE_COLOR[reverse.status]}
          >
            REPLY → CLIENT ·{" "}
            {reverse.hops.length ? PATH_LABEL[reverse.status].toUpperCase() : "NOT EVALUATED"}
          </text>
          <Lane nodes={request} y={Y_REQ} arrows />
          {reverse.hops.length ? (
            <Lane nodes={reply} y={Y_REP} arrows={false} />
          ) : (
            <path
              d={`M${EDGE} ${Y_REP} L${width - EDGE} ${Y_REP}`}
              stroke={FAINT}
              strokeWidth={2}
              strokeOpacity={0.75}
              strokeDasharray="5 5"
            />
          )}
          {labels.map((l, i) => (
            <g key={i}>
              <text
                x={l.x}
                y={Y_REQ + 32}
                textAnchor="middle"
                fontSize={12}
                fill="var(--foreground)"
                style={MONO}
              >
                {l.name}
              </text>
              <text
                x={l.x}
                y={Y_REQ + 48}
                textAnchor="middle"
                fontSize={11}
                fill="var(--muted-foreground)"
                style={MONO}
              >
                {l.sub}
              </text>
            </g>
          ))}
          {request.map((n, i) => {
            const rule = n.hop?.status === "blocked" ? stoppingRule(n.hop) : null;
            return (
              rule && (
                <text
                  key={`req-rule-${i}`}
                  x={n.x}
                  y={Y_REQ + 64}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--destructive)"
                  style={MONO}
                >
                  {rule}
                </text>
              )
            );
          })}
          {reply.map((n, i) => {
            if (!n.hop) return null;
            const rule = n.hop.status === "blocked" ? stoppingRule(n.hop) : null;
            const text = [ownColumns ? n.hop.device : null, rule].filter(Boolean).join(" · ");
            return (
              text && (
                <text
                  key={`rep-${i}`}
                  x={n.x}
                  y={Y_REP + 34}
                  textAnchor="middle"
                  fontSize={11}
                  fill={rule ? "var(--destructive)" : "var(--muted-foreground)"}
                  style={MONO}
                >
                  {text}
                </text>
              )
            );
          })}
        </svg>
      </div>
    </div>
  );
}
