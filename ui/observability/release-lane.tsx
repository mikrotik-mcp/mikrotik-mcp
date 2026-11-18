import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { animate, createScope, stagger } from "animejs";
import type { Scope } from "animejs";
import { tipProps } from "./kit";
import type { TipCard } from "./kit";
import type { ReleaseItem } from "./releases";

const W = 1100;
/** Versions drawn on the lane; older ones drop off the left. */
const MAX = 8;

/** "6.15.0-rc.2" → "rc.2"; stable versions keep "v6.15.0". */
function laneLabel(r: ReleaseItem): string {
  const dash = r.version.indexOf("-");
  return r.prerelease && dash > 0 ? r.version.slice(dash + 1) : `v${r.version}`;
}

/**
 * Every recent version on one line, oldest left. The running version is the
 * large teal node; the stretch ahead of it is dashed. Nodes settle in on load.
 */
export function VersionLane({
  releases,
  latest,
}: {
  releases: ReleaseItem[];
  latest: string | null;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const shown = releases.slice(0, MAX).reverse();
  const step = shown.length > 1 ? (W - 160) / (shown.length - 1) : 0;
  const x = (i: number): number => Math.round(80 + i * step);
  const cur = shown.findIndex((r) => r.relation === "current");
  const key = shown.map((r) => r.version).join(",");
  const card = (r: ReleaseItem, i: number): TipCard => {
    const published = new Date(r.publishedAt);
    const prev = shown[i - 1];
    const days =
      prev && !Number.isNaN(published.getTime())
        ? Math.round((published.getTime() - new Date(prev.publishedAt).getTime()) / 86_400_000)
        : null;
    return {
      title: `v${r.version}`,
      sub: r.name && !r.name.includes(r.version) ? r.name : undefined,
      led: r.relation === "current" ? "ok" : r.relation === "older" ? "off" : "acc",
      rows: [
        {
          label: "Published",
          value: Number.isNaN(published.getTime())
            ? "Unknown"
            : published.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }),
        },
        { label: "Channel", value: r.prerelease ? "Pre-release" : "Stable" },
        {
          label: "Relation",
          value:
            r.relation === "current"
              ? "Running"
              : r.relation === "older"
                ? "Older than running"
                : "Newer than running",
        },
        ...(r.version === latest ? [{ label: "Latest", value: "Yes" }] : []),
      ],
      ...(days !== null && prev
        ? { foot: { label: `After ${laneLabel(prev)}`, value: `${days} days` } }
        : {}),
    };
  };
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({
      root: root as unknown as RefObject<HTMLElement | null>,
      mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate("[data-node]", {
        opacity: [0, 1],
        scale: [0.5, 1],
        duration: 380,
        delay: stagger(40),
        ease: "outBack(1.4)",
      });
    });
    return () => scope.current?.revert();
  }, [key]);
  return (
    <svg
      ref={root}
      viewBox={`0 0 ${W} 70`}
      width="100%"
      height="70"
      role="img"
      aria-label="Version lane"
      className="release-lane kit-tips"
    >
      <line x1="20" y1="30" x2={W - 20} y2="30" stroke="var(--line-2)" strokeWidth="2" />
      {cur >= 0 && cur < shown.length - 1 && (
        <line
          x1={x(cur)}
          y1="30"
          x2={x(shown.length - 1)}
          y2="30"
          stroke="var(--sig)"
          strokeWidth="2"
          strokeDasharray="5 5"
        />
      )}
      {shown.map((r, i) => {
        const current = r.relation === "current";
        const isLatest = r.version === latest;
        const radius = current ? 9 : isLatest ? 7 : 5;
        const stroke =
          r.relation === "older"
            ? "var(--text-faint)"
            : r.prerelease
              ? "var(--muted-foreground)"
              : "var(--sig)";
        return (
          <g
            key={r.version}
            data-node
            style={{ transformOrigin: `${x(i)}px 30px` }}
            {...tipProps(() => card(r, i))}
          >
            <circle
              cx={x(i)}
              cy="30"
              r={radius}
              fill={current ? "var(--sig)" : "var(--surface-2)"}
              stroke={current ? "var(--sig)" : stroke}
              strokeWidth="2"
            />
            <text
              x={x(i)}
              y="58"
              textAnchor="middle"
              fontSize="11"
              fill="var(--muted-foreground)"
              fontFamily="var(--font-mt)"
            >
              {laneLabel(r)}
              {current ? " · running" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
