import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { formatMs, useLineDraw } from "./monitoring-ui";
import { deviceState } from "./device-card";
import { tipProps } from "./kit";
import type { TipCard, TipRow } from "./kit";
import type { DeviceInfo } from "./types";

/** How long a line stays lit after a tool call reaches its router. */
const LIT_MS = 1600;
const ROW = 72;
const BOX_W = 240;
const BOX_H = 44;
const COL_1 = 470;
const COL_2 = 800;
const SERVER_RIGHT = 240;
const BEND_1 = 355;
const BEND_2 = 755;

type Placed = { d: DeviceInfo; x: number; cy: number; via: string | null };

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

const STATE_WORD = {
  online: "Online",
  offline: "Offline",
  pending: "Not checked",
  disabled: "Off for MCP",
} as const;

function linkWord(d: DeviceInfo, via: string | null): string {
  if (d.mac) return "MAC-Telnet (layer 2)";
  if (via) return "Through a jump host";
  return d.transport === "rest" ? "REST, direct" : "Direct SSH";
}

/** The address the open session uses, or the one the last check reached, else the primary. */
function addressInUse(d: DeviceInfo): string {
  const host = d.endpoints?.connected[0]?.host ?? d.status.connectedHost;
  return host && !d.mac ? `${host}:${d.port}` : (d.address ?? `${d.host}:${d.port}`);
}

function latencyRow(d: DeviceInfo): TipRow[] {
  return d.status.latencyMs != null
    ? [{ label: "Latency", value: formatMs(d.status.latencyMs) }]
    : [];
}

function errorFoot(d: DeviceInfo): TipCard["foot"] {
  return d.status.error ? { label: "Error", value: d.status.error, tone: "down" } : undefined;
}

/** The card for a router box. */
function routerCard(d: DeviceInfo, via: string | null, on: boolean): TipCard {
  const state = deviceState(d);
  return {
    title: d.name,
    sub: STATE_WORD[state],
    led: state === "online" ? "ok" : state === "offline" ? "bad" : "off",
    rows: [
      { label: "Address", value: addressInUse(d) },
      ...(d.geo
        ? [{ label: "Country", value: [d.geo.city, d.geo.country].filter(Boolean).join(", ") }]
        : []),
      { label: "Path", value: via ? `via ${via}` : linkWord(d, via) },
      ...latencyRow(d),
      { label: "Calls", value: d.activity.calls.toLocaleString("en-US") },
      { label: "Errors", value: d.activity.errors.toLocaleString("en-US") },
      ...(d.pool ? [{ label: "In flight", value: String(d.pool.inflight) }] : []),
      ...(on ? [{ label: "Now", value: "call running" }] : []),
    ],
    foot: errorFoot(d),
  };
}

/** The card for the line from the server (or jump host) to a router. */
function pathCard(d: DeviceInfo, via: string | null, from: string): TipCard {
  return {
    title: `${from} → ${d.name}`,
    sub: linkWord(d, via),
    rows: [
      { label: "From", value: from },
      ...(via ? [{ label: "Via", value: via }] : []),
      { label: "To", value: addressInUse(d) },
      ...latencyRow(d),
      { label: "State", value: STATE_WORD[deviceState(d)] },
    ],
    foot: errorFoot(d),
  };
}

/** Place direct routers in one column and routers behind a jump host in the next. */
function layout(devices: DeviceInfo[]): { placed: Placed[]; height: number; mid: number } {
  const names = new Set(devices.map((d) => d.name));
  const behind = (d: DeviceInfo) => !d.mac && !!d.jumpVia && names.has(d.jumpVia);
  const first = devices.filter((d) => !behind(d));
  const second = devices.filter(behind);
  const slots = Math.max(first.length, second.length, 1);
  const height = slots * ROW + 20;
  const mid = height / 2 + 2;
  const top = 46 + ((slots - first.length) * ROW) / 2;
  const placed: Placed[] = first.map((d, i) => ({
    d,
    x: COL_1,
    cy: top + i * ROW,
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
    placed.push({ d, x: COL_2, cy: 46 + slot * ROW, via: d.jumpVia ?? null });
  }
  return { placed, height, mid };
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

const short = (name: string) => (name.length > 24 ? `${name.slice(0, 23)}…` : name);

/** The line legend under the panel title: solid, dashed and dotted management paths. */
export function PathLegend(): ReactNode {
  const items: [string, string | undefined][] = [
    ["Direct SSH", undefined],
    ["Through a jump host", "6 5"],
    ["MAC-Telnet (layer 2)", "2 5"],
  ];
  return (
    <span className="monitor-legend">
      {items.map(([label, dash]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <svg width="24" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="24"
              y2="3"
              stroke="var(--text-secondary)"
              strokeWidth="2"
              strokeDasharray={dash}
              strokeLinecap="round"
            />
          </svg>
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * "How MCP reaches each router": the management path from this server to every
 * router. Solid for direct SSH or REST, dashed through a jump host, dotted for
 * MAC-Telnet. A path and its router light up while a call to it runs.
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
  const { placed, height, mid } = layout(devices);
  useLineDraw(
    root as unknown as RefObject<HTMLElement | null>,
    devices.map((d) => d.name).join(","),
  );
  const byName = new Map(placed.map((p) => [p.d.name, p]));
  const isLit = (d: DeviceInfo) =>
    deviceState(d) === "online" && (lit.has(d.name) || (d.pool?.inflight ?? 0) > 0);
  return (
    <svg
      ref={root}
      className="dv-paths kit-tips"
      viewBox={`0 0 1080 ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`Management paths from the MCP server to ${devices.length} router${devices.length === 1 ? "" : "s"}`}
    >
      <g
        {...tipProps((): TipCard => ({
          title: "MCP server",
          sub: "this machine",
          rows: [
            { label: "Routers", value: String(devices.length) },
            {
              label: "Online",
              value: String(devices.filter((d) => deviceState(d) === "online").length),
              color: "var(--sig)",
            },
            {
              label: "Offline",
              value: String(devices.filter((d) => deviceState(d) === "offline").length),
              color: "var(--destructive)",
            },
          ],
        }))}
      >
        <rect
          x="20"
          y={mid - 26}
          width="220"
          height="52"
          rx="12"
          fill="var(--glass-2)"
          stroke="var(--sig)"
          strokeOpacity=".55"
        />
        <circle cx="42" cy={mid} r="4" fill="var(--sig)" />
        <circle cx="42" cy={mid} r="9" fill="none" stroke="var(--sig)" strokeOpacity=".35" />
        <text x="60" y={mid - 4} fontSize="13" fontWeight="600" fill="var(--foreground)">
          MCP server
        </text>
        <text
          x="60"
          y={mid + 13}
          fontSize="11"
          fill="var(--muted-foreground)"
          fontFamily="var(--font-mt)"
        >
          this machine
        </text>
      </g>
      {placed.map(({ d, x, cy, via }) => {
        const state = deviceState(d);
        const on = isLit(d);
        const host = x === COL_2 && d.jumpVia ? byName.get(d.jumpVia) : undefined;
        const from = host
          ? { x: host.x + BOX_W, y: host.cy, bend: BEND_2 }
          : { x: SERVER_RIGHT, y: mid, bend: BEND_1 };
        const path = `M${from.x} ${from.y} C${from.bend} ${from.y} ${from.bend} ${cy} ${x} ${cy}`;
        const stroke =
          state === "offline" ? "var(--destructive)" : on ? "var(--sig)" : "var(--line-2)";
        const dash = d.mac ? "2 5" : via || host ? "6 5" : undefined;
        const box = on
          ? "var(--sig)"
          : state === "offline"
            ? "var(--destructive)"
            : "var(--line-2)";
        const dot =
          state === "online"
            ? "var(--sig)"
            : state === "offline"
              ? "var(--destructive)"
              : "var(--text-faint)";
        // The middle of the curve, where the lit marker sits.
        const markX = (from.x + 6 * from.bend + x) / 8;
        const markY = (4 * from.y + 4 * cy) / 8;
        return (
          <Fragment key={d.name}>
            <g
              opacity={state === "disabled" ? 0.5 : 1}
              {...tipProps(() => pathCard(d, via, host ? host.d.name : "MCP server"))}
            >
              <path d={path} fill="none" stroke="transparent" strokeWidth="12" />
              {on && (
                <path
                  d={path}
                  fill="none"
                  stroke="var(--sig)"
                  strokeOpacity=".18"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
              )}
              <path
                data-draw=""
                d={path}
                fill="none"
                stroke={stroke}
                strokeWidth={on ? 2.5 : 1.6}
                strokeOpacity={on ? undefined : 0.9}
                strokeDasharray={dash}
                strokeLinecap="round"
              />
              {on && (
                <>
                  <circle cx={markX} cy={markY} r="4" fill="var(--sig)" />
                  <circle cx={markX} cy={markY} r="9" fill="var(--sig)" opacity=".18" />
                </>
              )}
            </g>
            <g
              className="dv-path-box"
              opacity={state === "disabled" ? 0.5 : 1}
              {...tipProps(() => routerCard(d, via, on))}
            >
              <rect
                x={x}
                y={cy - BOX_H / 2}
                width={BOX_W}
                height={BOX_H}
                rx="10"
                fill="var(--surface-2)"
                stroke={box}
                strokeOpacity={on || state === "offline" ? 1 : 0.9}
              />
              <circle cx={x + 18} cy={cy} r="3.5" fill={dot} />
              <text
                x={x + 32}
                y={cy - 3}
                fontSize="13"
                fontWeight="600"
                fill="var(--foreground)"
                fontFamily="var(--font-mt)"
              >
                {short(d.name)}
              </text>
              <text
                x={x + 32}
                y={cy + 13}
                fontSize="11"
                fill={state === "offline" ? "var(--destructive)" : "var(--muted-foreground)"}
              >
                {pathSub(d, via)}
              </text>
              {on && (
                <text
                  x={x + 228}
                  y={cy - 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--success)"
                  fontFamily="var(--font-mt)"
                >
                  call running
                </text>
              )}
            </g>
          </Fragment>
        );
      })}
    </svg>
  );
}
