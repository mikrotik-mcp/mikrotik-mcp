import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { formatMs, useLineDraw } from "./monitoring-ui";
import { deviceState } from "./device-card";
import type { DeviceInfo } from "./types";

/** How long a line stays lit after a tool call reaches its router. */
const LIT_MS = 1600;
const ROW = 66;
const BOX_W = 230;
const BOX_H = 44;
const COL_1 = 560;
const COL_2 = 852;

type Placed = { d: DeviceInfo; x: number; y: number; via: string | null };

/** The second line under a router name: how it is reached, then latency or the failure. */
function pathSub(d: DeviceInfo, via: string | null): string {
  const state = deviceState(d);
  const how = d.mac
    ? "MAC-Telnet"
    : via
      ? `via ${via}`
      : d.transport === "rest"
        ? "REST · direct"
        : "direct";
  const result =
    state === "disabled"
      ? "off for MCP"
      : state === "offline"
        ? /time ?d? ?out|timeout/i.test(d.status.error ?? "")
          ? "timed out"
          : "unreachable"
        : state === "pending"
          ? "not checked"
          : d.status.latencyMs != null
            ? formatMs(d.status.latencyMs)
            : "reachable";
  return `${how} · ${result}`;
}

/** Place direct routers in one column and routers behind a jump host in the next. */
function layout(devices: DeviceInfo[]): { placed: Placed[]; height: number } {
  const names = new Set(devices.map((d) => d.name));
  const behind = (d: DeviceInfo) => !d.mac && !!d.jumpVia && names.has(d.jumpVia);
  const first = devices.filter((d) => !behind(d));
  const second = devices.filter(behind);
  const slots = Math.max(first.length, second.length, 1);
  const height = Math.max(slots * ROW + 2, 134);
  const top = (height - (first.length * ROW + 2)) / 2;
  const placed: Placed[] = first.map((d, i) => ({
    d,
    x: COL_1,
    y: top + 12 + i * ROW,
    via: !d.mac && d.jumpHost ? `${d.jumpHost.host}:${d.jumpHost.port}` : null,
  }));
  const used = new Set<number>();
  for (const d of second) {
    const host = placed.findIndex((p) => p.d.name === d.jumpVia);
    const want = Math.max(0, host + 1);
    let slot = want;
    for (let step = 0; used.has(slot) || slot >= slots; step++) {
      slot = want + (step % 2 ? -Math.ceil(step / 2) : Math.ceil(step / 2));
      if (slot < 0) slot = want + step;
    }
    used.add(slot);
    placed.push({ d, x: COL_2, y: top + 12 + slot * ROW, via: d.jumpVia ?? null });
  }
  return { placed, height };
}

/** Which routers had a tool call in the last moment, from the live event counters. */
function useLit(pulses: Record<string, number>): Set<string> {
  const last = useRef(pulses);
  const [lit, setLit] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const changed = Object.keys(pulses).filter((k) => pulses[k] !== last.current[k]);
    last.current = pulses;
    if (!changed.length) return;
    setLit((old) => new Set([...old, ...changed]));
    const t = setTimeout(
      () =>
        setLit((old) => {
          const next = new Set(old);
          for (const k of changed) next.delete(k);
          return next;
        }),
      LIT_MS,
    );
    return () => clearTimeout(t);
  }, [pulses]);
  return lit;
}

/**
 * "How MCP reaches each router": the management path from this server to every
 * router. Solid for direct SSH or REST, dashed through a jump host, dotted for
 * MAC-Telnet. A router's box lights up while a call to it runs.
 */
export function ManagementPaths({
  devices,
  pulses,
}: {
  devices: DeviceInfo[];
  pulses: Record<string, number>;
}): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const lit = useLit(pulses);
  const { placed, height } = layout(devices);
  const mid = height / 2;
  useLineDraw(
    root as unknown as RefObject<HTMLElement | null>,
    devices.map((d) => d.name).join(","),
  );
  const byName = new Map(placed.map((p) => [p.d.name, p]));
  return (
    <svg
      ref={root}
      className="dv-paths"
      viewBox={`0 0 1096 ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`Management paths from the MCP server to ${devices.length} router${devices.length === 1 ? "" : "s"}`}
    >
      <g strokeWidth="1.5" fill="none">
        {placed.map(({ d, x, y, via }) => {
          const state = deviceState(d);
          const host = d.jumpVia ? byName.get(d.jumpVia) : undefined;
          const end = y + 22;
          const from =
            x === COL_2 && host ? { x: host.x + BOX_W, y: host.y + 22 } : { x: 150, y: mid };
          const bend = x === COL_2 ? 40 : 210;
          const path =
            x === COL_2
              ? `M${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${x - bend} ${end}, ${x} ${end}`
              : `M150 ${mid} C 360 ${mid}, 380 ${end}, ${x} ${end}`;
          const stroke =
            state === "offline"
              ? "var(--destructive)"
              : d.mac
                ? "var(--text-faint)"
                : "var(--chart-1)";
          const dash = d.mac ? "2 4" : via || x === COL_2 ? "5 4" : undefined;
          return (
            <path
              key={d.name}
              data-draw=""
              d={path}
              stroke={stroke}
              strokeDasharray={dash}
              opacity={state === "disabled" ? 0.4 : 1}
            />
          );
        })}
      </g>
      <g>
        <rect
          x="16"
          y={mid - 24}
          width="134"
          height="48"
          rx="8"
          fill="var(--accent)"
          stroke="var(--input)"
        />
        <text x="32" y={mid - 3} fontSize="13" fontWeight="590" fill="var(--foreground)">
          MCP server
        </text>
        <text x="32" y={mid + 14} fontSize="12" fill="var(--muted-foreground)">
          this machine
        </text>
      </g>
      {placed.map(({ d, x, y, via }) => {
        const state = deviceState(d);
        const stroke =
          state === "offline"
            ? "var(--destructive)"
            : lit.has(d.name) || (d.pool?.inflight ?? 0) > 0
              ? "var(--chart-1)"
              : "var(--input)";
        const dot =
          state === "online"
            ? "var(--success)"
            : state === "offline"
              ? "var(--destructive)"
              : "var(--text-faint)";
        return (
          <g key={d.name} opacity={state === "disabled" ? 0.5 : 1}>
            <title>{`${d.name}: ${pathSub(d, via)}`}</title>
            <rect
              className="dv-path-box"
              x={x}
              y={y}
              width={BOX_W}
              height={BOX_H}
              rx="8"
              fill="var(--muted)"
              stroke={stroke}
            />
            <circle cx={x + 16} cy={y + 22} r="3.5" fill={dot} />
            <text
              x={x + 30}
              y={y + 19}
              fontSize="13"
              fill="var(--foreground)"
              fontFamily="var(--font-mono)"
            >
              {d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name}
            </text>
            <text x={x + 30} y={y + 35} fontSize="12" fill="var(--muted-foreground)">
              {pathSub(d, via)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
