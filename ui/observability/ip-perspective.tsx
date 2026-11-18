/**
 * The IP Intelligence hero graphic: one address in the middle, a line out to
 * each provider with its response time. Lines draw out from the address when
 * a new answer arrives; nothing moves with reduced motion.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, createScope, svg } from "animejs";
import type { Scope } from "animejs";
import { DUR, EASE, tipProps } from "./kit";
import type { TipCard } from "./kit";

const REDUCE = "(prefers-reduced-motion: reduce)";

export interface PerspectiveSource {
  name: string;
  /** The line under the name, e.g. "212 ms". */
  detail: string;
  tone: "good" | "bad" | "muted";
}

const COLOR = { good: "var(--sig)", bad: "var(--destructive)", muted: "var(--text-faint)" };

const STATUS = { good: "Answered", bad: "Unavailable", muted: "Skipped" };

function status(source: PerspectiveSource): string {
  return source.detail === "—" ? "Not asked yet" : STATUS[source.tone];
}

function shorten(text: string): string {
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

export function PerspectiveGraphic({
  address,
  sources,
  drawKey,
}: {
  address: string;
  sources: [PerspectiveSource, PerspectiveSource];
  /** The lines draw again when this changes, e.g. on a new answer. */
  drawKey: unknown;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const paths = root.current?.querySelectorAll<SVGPathElement>("path[data-draw]");
      if (!paths?.length) return;
      animate(svg.createDrawable(paths), {
        draw: ["0 0", "0 1"],
        duration: DUR.draw,
        ease: EASE.enter,
      });
      animate(root.current!.querySelectorAll("[data-node]"), {
        opacity: [0, 1],
        duration: DUR.slow,
        delay: 420,
        ease: EASE.enter,
      });
    });
    return () => scope.current?.revert();
  }, [drawKey]);

  const addressCard = (): TipCard => ({
    title: address,
    sub: "address",
    rows: sources.map((s) => ({ label: s.name, value: s.detail, color: COLOR[s.tone] })),
  });
  return (
    <svg
      ref={root}
      className="kit-tips"
      viewBox="0 0 440 210"
      width="100%"
      height="210"
      role="img"
      aria-label="One address, two independent sources"
    >
      <circle cx="120" cy="105" r="70" fill="none" stroke="var(--line)" strokeDasharray="1 5" />
      {sources.map((source, i) => {
        const y = i === 0 ? 55 : 155;
        const color = COLOR[source.tone];
        return (
          <g key={source.name}>
            <path
              data-draw
              d={`M150 105 C 230 105, 250 ${y}, 320 ${y}`}
              fill="none"
              stroke={color}
              strokeOpacity=".6"
              strokeWidth="1.6"
            />
            <g
              data-node
              {...tipProps((): TipCard => ({
                title: source.name,
                sub: shorten(address),
                led: source.tone === "good" ? "ok" : source.tone === "bad" ? "bad" : "off",
                rows: [
                  { label: "Answer", value: source.detail, color },
                  { label: "Status", value: status(source) },
                ],
              }))}
            >
              <circle
                cx="335"
                cy={y}
                r="15"
                fill="var(--surface-2)"
                stroke={color}
                strokeWidth="1.5"
              />
              <circle cx="335" cy={y} r="4" fill={color} />
              <text
                x="360"
                y={y - 2}
                fontSize="12"
                fill="var(--foreground)"
                fontFamily="Geist Mono, monospace"
              >
                {source.name}
              </text>
              <text x="360" y={y + 14} fontSize="11" fill="var(--muted-foreground)">
                {source.detail}
              </text>
            </g>
          </g>
        );
      })}
      <g {...tipProps(addressCard)}>
        <circle
          cx="120"
          cy="105"
          r="30"
          fill="var(--glass-2)"
          stroke="var(--brand)"
          strokeOpacity=".7"
        />
        <text
          x="120"
          y="109"
          textAnchor="middle"
          fontSize="12"
          fill="var(--foreground)"
          fontFamily="Geist Mono, monospace"
        >
          {shorten(address)}
        </text>
      </g>
    </svg>
  );
}
