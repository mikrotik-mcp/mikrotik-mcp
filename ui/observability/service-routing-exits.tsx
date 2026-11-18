/**
 * The "Default exit of each table" map on the Service Routing board: one line
 * from the router to the 0.0.0.0/0 route of every routing table. Read-only,
 * drawn from the IPv4 routes the inventory already holds.
 */
import { useRef } from "react";
import type { ReactNode } from "react";
import type { RoutingInventory } from "../../src/service-routing/inventory";
import type { Row } from "../../src/service-routing/model";
import { MonitorPanel, StatusDot, useLineDraw } from "./monitoring-ui";

interface Exit {
  table: string;
  gateway: string;
  iface?: string;
  active: boolean;
  detail: string;
}

/** One default route per table: the active one if RouterOS picked one, else the first. */
export function defaultExits(data: RoutingInventory): Exit[] {
  const routes = data.sections.routes4;
  if (routes.state !== "ready") return [];
  const vrfs = new Set(
    data.sections.vrfs.rows.filter((v) => v.disabled !== "yes").map((v) => v.name),
  );
  const byTable = new Map<string, Row>();
  for (const r of routes.rows) {
    if (r["dst-address"] !== "0.0.0.0/0") continue;
    const table = r["routing-table"] || "main";
    const seen = byTable.get(table);
    if (!seen || (seen.active !== "yes" && r.active === "yes")) byTable.set(table, r);
  }
  const order = [...data.tables, ...byTable.keys()];
  return [...new Set(order)]
    .filter((t) => byTable.has(t))
    .map((table) => {
      const r = byTable.get(table)!;
      const active = r.active === "yes" && r.disabled !== "yes";
      const gateway = r.gateway || (r.blackhole === "yes" ? "Blackhole" : "No gateway");
      const hop = r["immediate-gw"];
      const iface = hop?.includes("%")
        ? hop.split("%")[1]
        : hop && hop !== gateway
          ? hop
          : undefined;
      const state = r.disabled === "yes" ? "Disabled" : active ? "Active" : "Inactive";
      return {
        table,
        gateway,
        iface,
        active,
        detail: [state, r.distance && `distance ${r.distance}`, vrfs.has(table) && "VRF"]
          .filter(Boolean)
          .join(" · "),
      };
    });
}

const ROW = 50;

function ExitMap({ device, exits }: { device: string; exits: Exit[] }): ReactNode {
  const H = exits.length * ROW;
  const mid = H / 2;
  return (
    <svg
      className="sr-exits-map"
      viewBox={`0 0 1100 ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="Default exit of each routing table"
    >
      <rect
        x="10"
        y={mid - 26}
        width="200"
        height="52"
        rx="12"
        fill="var(--glass-2)"
        stroke="var(--sig)"
        strokeOpacity=".55"
      />
      <text
        x="30"
        y={mid - 3}
        fontSize="13"
        fontWeight="600"
        fill="var(--foreground)"
        fontFamily="var(--font-mt)"
      >
        {device.length > 22 ? `${device.slice(0, 21)}…` : device}
      </text>
      <text x="30" y={mid + 14} fontSize="11" fill="var(--muted-foreground)">
        client traffic in
      </text>
      {exits.map((e, i) => {
        const cy = ROW / 2 + i * ROW;
        const col = e.active ? "var(--sig)" : "var(--text-faint)";
        const dash = e.active ? undefined : "4 5";
        const via = e.iface ? ` (${e.iface})` : "";
        return (
          <g key={e.table}>
            <path
              data-draw
              d={`M210 ${mid} C330 ${mid} 330 ${cy} 450 ${cy}`}
              fill="none"
              stroke={col}
              strokeWidth="1.8"
              strokeDasharray={dash}
              strokeOpacity=".8"
            />
            <rect
              x="450"
              y={cy - 17}
              width="150"
              height="34"
              rx="9"
              fill="var(--surface-2)"
              stroke="var(--line-2)"
            />
            <text
              x="466"
              y={cy + 4}
              fontSize="12"
              fontWeight="600"
              fill="var(--foreground)"
              fontFamily="var(--font-mt)"
            >
              {e.table.length > 16 ? `${e.table.slice(0, 15)}…` : e.table}
            </text>
            <path
              data-draw
              d={`M600 ${cy} L760 ${cy}`}
              stroke={col}
              strokeWidth="1.8"
              strokeDasharray={dash}
              strokeOpacity=".8"
            />
            <circle cx="680" cy={cy} r="3" fill={col} />
            <text x="680" y={cy - 8} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
              0.0.0.0/0
            </text>
            <rect
              x="760"
              y={cy - 17}
              width="330"
              height="34"
              rx="9"
              fill="var(--surface-2)"
              stroke={col}
              strokeOpacity={e.active ? 0.6 : 0.4}
            />
            <circle cx="778" cy={cy} r="3.5" fill={col} />
            <text
              x="792"
              y={cy + 4}
              fontSize="12"
              fill="var(--foreground)"
              fontFamily="var(--font-mt)"
            >
              {e.gateway}
              <tspan fill="var(--muted-foreground)">{via}</tspan>
            </text>
            <text
              x="1078"
              y={cy + 4}
              textAnchor="end"
              fontSize="11"
              fill={e.active ? "var(--success)" : "var(--text-faint)"}
            >
              {e.detail}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function RoutingExitsPanel({ data }: { data: RoutingInventory }): ReactNode {
  const exits = defaultExits(data);
  const ref = useRef<HTMLDivElement>(null);
  useLineDraw(ref, `${data.device}:${exits.map((e) => `${e.table}${e.active}`).join()}`);
  return (
    <MonitorPanel
      title="Default exit of each table"
      description="Where 0.0.0.0/0 leaves the router, per routing table. Active means RouterOS picked the route, not that the internet works through it."
      extra={
        <span className="monitor-legend">
          <span className="inline-flex items-center gap-1.5">
            <svg width="24" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="24"
                y2="3"
                stroke="var(--sig)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Active
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="24" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="24"
                y2="3"
                stroke="var(--text-faint)"
                strokeWidth="2"
                strokeDasharray="4 5"
                strokeLinecap="round"
              />
            </svg>
            Inactive
          </span>
        </span>
      }
    >
      <div ref={ref}>
        {data.sections.routes4.state !== "ready" ? (
          <p className="monitor-hint">IPv4 routes could not be read, so the exits are unknown.</p>
        ) : !exits.length ? (
          <p className="monitor-hint">This router has no IPv4 default route.</p>
        ) : (
          <>
            <ExitMap device={data.device} exits={exits} />
            {/* Phones: the same exits as a list; the map would be too small to read. */}
            <ul className="sr-exits-list m-0 hidden list-none flex-col p-0">
              {exits.map((e) => (
                <li
                  key={e.table}
                  className="flex min-w-0 items-center gap-2.5 border-t border-line py-2.5 first:border-t-0"
                >
                  <StatusDot tone={e.active ? "good" : "default"} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13px] text-foreground">
                      {e.table} → {e.gateway}
                      {e.iface && <span className="text-muted-foreground"> ({e.iface})</span>}
                    </span>
                    <span
                      className={e.active ? "text-[12px] text-success" : "text-[12px] text-faint"}
                    >
                      {e.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </MonitorPanel>
  );
}
