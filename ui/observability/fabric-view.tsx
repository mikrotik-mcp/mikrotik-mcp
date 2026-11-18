/**
 * Network → L2 Fabric, after the "Net-Fabric" board: which host sits behind
 * which bridge port. Reads /api/fabric, backed by the same analyzer the MCP
 * tools use (`src/core/l2-fabric.ts`), so the page never disagrees with a tool.
 */
import "./monitoring.css";
import "./fabric.css";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Inbox, RefreshCw, SearchX } from "lucide-react";
import { api } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  PageIntro,
  RouterPicker,
  StatusBadge,
  StatusDot,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";

interface DevicesPayload {
  defaultDevice: string;
  devices: { name: string }[];
}

interface FabricHost {
  mac: string;
  label: string;
  nameSource: string;
  ip?: string;
  hostname?: string;
  identity?: string;
  vendor?: string;
  isNetworkDevice: boolean;
  hasLease: boolean;
}
interface FabricPort {
  interface: string;
  bridge?: string;
  role: "access" | "uplink" | "hybrid" | "empty";
  hostCount: number;
  hosts: FabricHost[];
  peerIdentity?: string;
}
interface FabricMap {
  device: string;
  ports: FabricPort[];
  stats: {
    ports: number;
    hosts: number;
    accessPorts: number;
    uplinks: number;
    unidentified: number;
  };
  localMacs: string[];
  error?: string;
}

const ROLE_TONE: Record<FabricPort["role"], Tone> = {
  uplink: "brand",
  access: "good",
  hybrid: "warn",
  empty: "default",
};
/** The faceplate colour per role: indigo uplink, teal access, amber hybrid. */
const ROLE_COLOR: Record<FabricPort["role"], string> = {
  uplink: "var(--brand)",
  access: "var(--sig)",
  hybrid: "var(--warning)",
  empty: "var(--text-faint)",
};
const PORT_COLS = "grid-cols-[minmax(0,1.2fr)_112px_minmax(0,1fr)_96px]";
const HOST_COLS = "grid-cols-[16px_minmax(0,240px)_170px_130px_minmax(0,1fr)]";
/** Hosts shown under an open port before "Show N more hosts". */
const HOSTS_SHOWN = 5;
const LEAD =
  "Which host sits behind which bridge port. Names come from DHCP, ARP, neighbours and the vendor.";

/** No DHCP name, no IP and no neighbour entry: the analyzer counts these as unidentified. */
const unidentified = (h: FabricHost): boolean =>
  h.nameSource === "vendor" || h.nameSource === "none";
const roleName = (role: FabricPort["role"]): string => role[0].toUpperCase() + role.slice(1);
const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Per-port occupancy: which hosts sit behind each bridge port. */
export function FabricView(): ReactNode {
  const [device, setDevice] = useState<string | undefined>(undefined);
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [data, setData] = useState<FabricMap | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [query, setQuery] = useState("");
  // Ports the user opened or closed, against the default (first port, or search hits).
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<DevicesPayload>("/api/devices")
      .then(setRouters)
      .catch(() => setRouters(null));
  }, []);

  const load = useCallback(() => {
    void api<FabricMap>(`/api/fabric${device ? `?device=${encodeURIComponent(device)}` : ""}`)
      .then((d) => {
        setError(d.error ?? null);
        if (!d.error) {
          setData(d);
          setReadAt(Date.now());
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [device]);
  const [loadedDevice, setLoadedDevice] = useState(device);
  if (loadedDevice !== device) {
    setLoadedDevice(device);
    setBusy(true);
    setError(null);
    setData(null);
    setToggled(new Set());
    setExpanded(new Set());
  }
  const reload = () => {
    setBusy(true);
    setError(null);
    load();
  };
  useEffect(() => load(), [load]);

  const q = query.trim().toLowerCase();
  const ports = (data?.ports ?? [])
    .map((p) =>
      q
        ? {
            ...p,
            hosts: p.hosts.filter(
              (h) =>
                h.label.toLowerCase().includes(q) ||
                h.mac.toLowerCase().includes(q) ||
                (h.ip ?? "").includes(q) ||
                p.interface.toLowerCase().includes(q),
            ),
          }
        : p,
    )
    .filter((p) => !q || p.hosts.length > 0 || p.interface.toLowerCase().includes(q));
  useStaggerIn(listRef, ".fabric-port", `${q}|${data?.device ?? ""}|${readAt ?? 0}`);

  const isOpen = (p: FabricPort, i: number): boolean =>
    (q ? p.hosts.length > 0 : i === 0) !== toggled.has(p.interface);
  const openPorts = new Set(ports.filter((p, i) => isOpen(p, i)).map((p) => p.interface));
  const toggle = (name: string) => {
    const next = new Set(toggled);
    if (!next.delete(name)) next.add(name);
    setToggled(next);
  };
  const onSearch = (value: string) => {
    setQuery(value);
    setToggled(new Set());
  };

  const names = routers?.devices.map((d) => d.name) ?? [];
  const bridges = [...new Set((data?.ports ?? []).map((p) => p.bridge).filter(Boolean))];
  const s = data?.stats;
  const shown = data?.device ?? device ?? routers?.defaultDevice;

  return (
    <section className="fabric grid min-w-0 content-start gap-[18px] max-sm:gap-3.5">
      <PageIntro
        eyebrow={
          shown != null
            ? `L2 Fabric · ${shown}${readAt != null && data ? ` · read at ${hhmm(readAt)}` : ""}`
            : undefined
        }
        heading={
          error != null ? (
            <em>Could not read the bridge.</em>
          ) : data && s ? (
            <>
              {plural(s.hosts, "host", "hosts")} on {plural(s.ports, "port", "ports")}.
              {s.unidentified > 0 && (
                <>
                  {" "}
                  <span className="w">{s.unidentified} unidentified.</span>
                </>
              )}
            </>
          ) : undefined
        }
        lead={LEAD}
        actions={
          <>
            {names.length > 1 && (
              <>
                <span className="monitor-label">Router</span>
                <RouterPicker
                  label="Device"
                  value={device ?? routers?.defaultDevice ?? ""}
                  onChange={(next) => setDevice(next || undefined)}
                  routers={names}
                  defaultRouter={routers?.defaultDevice}
                />
              </>
            )}
            <MonitorButton
              disabled={busy}
              icon={<RefreshCw aria-hidden="true" className={busy ? "animate-spin" : undefined} />}
              onClick={reload}
            >
              Refresh
            </MonitorButton>
          </>
        }
      />

      {error != null ? (
        <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
          <b className="text-foreground font-medium">Could not reach the device.</b>{" "}
          <span className="text-muted-foreground">{error}</span>
        </MonitorNote>
      ) : data == null || s == null ? (
        <LoadingState label="Loading the L2 fabric" layout="cards" />
      ) : (
        <>
          <MetricStrip label="Fabric totals" minCell={150}>
            <Metric
              label="Occupied ports"
              value={s.ports}
              hint={
                bridges.length === 1
                  ? `on ${bridges[0]}`
                  : bridges.length
                    ? `on ${bridges.length} bridges`
                    : "no bridge"
              }
            />
            <Metric label="Hosts" tone="good" value={s.hosts} hint="seen passing frames" />
            <Metric label="Access" value={s.accessPorts} hint="one host each" />
            <Metric label="Uplink" value={s.uplinks} hint="switch or many hosts" />
            <Metric
              label="Unidentified"
              tone={s.unidentified > 0 ? "warn" : "default"}
              value={s.unidentified}
              hint="no lease, ARP or neighbour entry"
            />
          </MetricStrip>

          {data.ports.length > 0 && (
            <MonitorPanel
              title="Bridge ports"
              description="Each dot is a host seen behind that port. Indigo is an uplink, teal an access port, amber hybrid."
              extra={
                <span className="monitor-legend">
                  {(["uplink", "access", "hybrid"] as const).map((r) => (
                    <span key={r} className="inline-flex items-center gap-1.5">
                      <StatusDot tone={ROLE_TONE[r]} />
                      {roleName(r)}
                    </span>
                  ))}
                </span>
              }
            >
              <Faceplate device={data.device} ports={data.ports} readAt={readAt} open={openPorts} />
            </MonitorPanel>
          )}

          <MonitorPanel
            title="Hosts by port"
            aria-label="Hosts by port"
            flush
            extra={
              <>
                <MonitorSearch
                  className="fabric-search"
                  label="Find a host"
                  placeholder="Find a MAC, IP or host name"
                  value={query}
                  onChange={onSearch}
                />
                <StatusBadge quiet dot={false}>
                  Read-only
                </StatusBadge>
              </>
            }
          >
            {ports.length === 0 ? (
              <div className="border-t border-line">
                {data.ports.length === 0 ? (
                  <MonitorEmpty icon={<Inbox />} title="No bridge hosts">
                    This router may have no bridge, or switch-chip offload is forwarding without
                    filling the host table.
                  </MonitorEmpty>
                ) : (
                  <MonitorEmpty compact icon={<SearchX />} title="No host matches that search" />
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div ref={listRef} className="min-w-[720px]">
                  <div className={`monitor-thead ${PORT_COLS}`}>
                    <span>Port</span>
                    <span>Role</span>
                    <span>Bridge</span>
                    <span className="text-right">Hosts</span>
                  </div>
                  {ports.map((p, i) => {
                    const open = isOpen(p, i);
                    const all = expanded.has(p.interface);
                    const hosts = all ? p.hosts : p.hosts.slice(0, HOSTS_SHOWN);
                    const more = p.hosts.length - hosts.length;
                    const panelId = `fabric-hosts-${i}`;
                    return (
                      <Fragment key={p.interface}>
                        <button
                          type="button"
                          className={`monitor-row fabric-port ${PORT_COLS}`}
                          data-selected={open || undefined}
                          aria-expanded={open}
                          aria-controls={open ? panelId : undefined}
                          onClick={() => toggle(p.interface)}
                        >
                          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                            {open ? (
                              <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                            ) : (
                              <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
                            )}
                            <span className="p truncate font-mono text-[12px]">{p.interface}</span>
                            {p.peerIdentity != null && (
                              <span className="truncate text-[12px] text-faint">
                                ↔ {p.peerIdentity}
                              </span>
                            )}
                          </span>
                          <span>
                            <StatusBadge tone={ROLE_TONE[p.role]}>{roleName(p.role)}</StatusBadge>
                          </span>
                          <span className="truncate font-mono text-[12px] text-fg-secondary">
                            {p.bridge ?? "—"}
                          </span>
                          <span className="text-right text-foreground tabular-nums">
                            {p.hostCount}
                          </span>
                        </button>
                        {open && (
                          <div id={panelId} className="bg-glass">
                            {hosts.map((h) => {
                              const unknown = unidentified(h);
                              return (
                                <div
                                  key={h.mac}
                                  className={`grid ${HOST_COLS} items-center gap-3 border-t border-line py-[7px] pr-[18px] pl-[44px] text-[13px]`}
                                >
                                  <span className="grid place-items-center text-brand">
                                    {h.isNetworkDevice && (
                                      <svg
                                        viewBox="0 0 24 24"
                                        className="size-4"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        role="img"
                                        aria-label="Network device"
                                      >
                                        <rect x="3" y="8" width="18" height="8" rx="2" />
                                        <path d="M7 12h.01M11 12h.01M15 12h.01" />
                                      </svg>
                                    )}
                                  </span>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span
                                      className={`truncate ${unknown ? "text-warning" : "text-foreground"}`}
                                    >
                                      {h.label}
                                    </span>
                                    {unknown && (
                                      <span className="monitor-badge h-5" data-tone="warn">
                                        Unidentified
                                      </span>
                                    )}
                                  </span>
                                  <span className="truncate font-mono text-[12px] text-fg-secondary">
                                    {h.mac}
                                  </span>
                                  <span
                                    className={`truncate font-mono text-[12px] ${h.ip ? "text-fg-secondary" : "text-faint"}`}
                                  >
                                    {h.ip ?? "—"}
                                  </span>
                                  <span className="min-w-0">
                                    {h.vendor != null && (
                                      <span className="monitor-chip">{h.vendor}</span>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                            {more > 0 && (
                              <div className="border-t border-line py-2 pr-[18px] pb-2.5 pl-[44px]">
                                <MonitorButton
                                  variant="ghost"
                                  size="sm"
                                  className="fabric-more"
                                  icon={<ChevronDown aria-hidden="true" />}
                                  onClick={() => setExpanded(new Set(expanded).add(p.interface))}
                                >
                                  Show {more} more hosts
                                </MonitorButton>
                              </div>
                            )}
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="monitor-foot">
              <span>
                Roles come from how many hosts sit behind a port: one host is an access port, more
                than four or another switch is an uplink, in between is hybrid. Search finds a host
                on any port and opens it.
              </span>
            </div>
          </MonitorPanel>
        </>
      )}
    </section>
  );
}

const PORT_W = 136;
const PORT_GAP = 18;
const PLATE_H = 150;

/**
 * The bridge faceplate from the board: one tile per occupied port, tinted by
 * role, with a dot per host behind it. Open ports in the table are lit.
 */
function Faceplate({
  device,
  ports,
  readAt,
  open,
}: {
  device: string;
  ports: FabricPort[];
  readAt: number | null;
  open: Set<string>;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useStaggerIn(ref, ".fabric-plate-port", `${device}|${readAt ?? 0}`);
  const w = Math.max(1100, 48 + ports.length * (PORT_W + PORT_GAP) - PORT_GAP);
  return (
    <div ref={ref} className="overflow-x-auto leading-[21px]">
      <svg
        viewBox={`0 0 ${w} ${PLATE_H}`}
        width="100%"
        height={PLATE_H}
        className="inline align-baseline"
        style={{ minWidth: w > 1100 ? w * 0.75 : 640 }}
        role="img"
        aria-label="Occupied bridge ports and how many hosts sit behind each"
      >
        <rect
          x="0.5"
          y="0.5"
          width={w - 1}
          height={PLATE_H - 1}
          rx="14"
          fill="var(--surface-2)"
          stroke="var(--line-2)"
        />
        <text x="24" y="30" fontSize="11" fill="var(--text-faint)" letterSpacing=".08em">
          BRIDGE · {device}
        </text>
        {readAt != null && (
          <>
            <circle cx={w - 28} cy="26" r="3.5" fill="var(--sig)" />
            <text
              x={w - 40}
              y="30"
              textAnchor="end"
              fontSize="11"
              fill="var(--muted-foreground)"
              fontFamily="Geist Mono, monospace"
            >
              read {hhmm(readAt)}
            </text>
          </>
        )}
        {ports.map((p, i) => {
          const x = 24 + i * (PORT_W + PORT_GAP);
          const col = ROLE_COLOR[p.role];
          const lit = open.has(p.interface);
          const n = p.hostCount;
          return (
            <g key={p.interface} className="fabric-plate-port">
              <title>{`${p.interface}: ${roleName(p.role)}, ${plural(n, "host", "hosts")}`}</title>
              <rect
                x={x}
                y="46"
                width={PORT_W}
                height="82"
                rx="10"
                fill={col}
                fillOpacity={lit ? 0.12 : 0.06}
                stroke={col}
                strokeOpacity={lit ? 0.9 : 0.35}
              />
              <rect
                x={x + 12}
                y="58"
                width="30"
                height="22"
                rx="3"
                fill="none"
                stroke={col}
                strokeWidth="1.4"
              />
              <rect x={x + 20} y="76" width="14" height="4" fill={col} />
              <text
                x={x + 52}
                y="68"
                fontSize="12"
                fontWeight="600"
                fill="var(--foreground)"
                fontFamily="Geist Mono, monospace"
              >
                {p.interface}
              </text>
              <text x={x + 52} y="82" fontSize="10" fill={col}>
                {roleName(p.role)}
                {p.peerIdentity ? ` · ${p.peerIdentity}` : ""}
              </text>
              {Array.from({ length: Math.min(n, 10) }, (_, j) => (
                <circle
                  key={j}
                  cx={x + 16 + j * 11}
                  cy="104"
                  r="3.6"
                  fill={col}
                  fillOpacity={0.95}
                />
              ))}
              <text
                x={x + PORT_W - 12}
                y="122"
                textAnchor="end"
                fontSize="11"
                fill="var(--muted-foreground)"
                fontFamily="Geist Mono, monospace"
              >
                {plural(n, "host", "hosts")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
