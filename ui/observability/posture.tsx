/**
 * Posture views: L2 Fabric, Vulnerabilities and Access Scope.
 *
 * All three read a single JSON endpoint backed by the same pure analyzer the
 * MCP tools use (`src/core/l2-fabric.ts`, `advisories.ts`, `access.ts`), so the
 * dashboard can never disagree with what a tool call reports.
 */
import "./fabric.css";
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Inbox,
  RefreshCw,
  SearchX,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { api } from "./api";
import { Panel } from "./atoms";
import { Button } from "./geist";
import { Checkbox } from "./components/ui/checkbox";
import { clock } from "./format";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorSearch,
  PageIntro,
  RouterPicker,
  useStaggerIn,
} from "./monitoring-ui";

// ── Shared bits ──────────────────────────────────────────────────────────────

interface DeviceInfo {
  name: string;
}
interface DevicesPayload {
  defaultDevice: string;
  devices: DeviceInfo[];
}

function Loading(): ReactNode {
  return <LoadingState label="Loading security posture" layout="cards" />;
}

function ErrorBox({ message }: { message: string }): ReactNode {
  return (
    <div className="px-5 py-8 text-center text-sm text-destructive">
      Could not reach the device: {message}
    </div>
  );
}

// ── L2 Fabric ────────────────────────────────────────────────────────────────

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

/** Role colour on the badge text and its dot, from the board. */
const ROLE_TEXT: Record<FabricPort["role"], string> = {
  uplink: "text-brand",
  access: "text-success",
  hybrid: "text-warning",
  empty: "text-muted-foreground",
};
const PORT_COLS = "grid-cols-[minmax(180px,1.2fr)_112px_minmax(120px,1fr)_96px]";
const HOST_COLS = "grid-cols-[16px_minmax(160px,240px)_170px_130px_minmax(100px,1fr)]";
/** Hosts shown under an open port before "Show N more hosts". */
const HOSTS_SHOWN = 5;
const LEAD =
  "Which host sits behind which bridge port. Names come from DHCP, ARP, neighbours and the vendor.";

/** No DHCP name, no IP and no neighbour entry: the analyzer counts these as unidentified. */
const unidentified = (h: FabricHost): boolean =>
  h.nameSource === "vendor" || h.nameSource === "none";

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

  return (
    <section className="fabric grid min-w-0 content-start gap-6">
      <PageIntro
        tone={error != null ? "bad" : data ? "good" : "default"}
        title={
          error != null ? (
            <b>Could not read the bridge</b>
          ) : data && s ? (
            <>
              <b>
                {s.hosts} host{s.hosts === 1 ? "" : "s"} on {s.ports} port
                {s.ports === 1 ? "" : "s"}
              </b>
              <span>
                · {data.device}
                {readAt != null ? ` · read at ${clock(readAt)}` : ""}
              </span>
            </>
          ) : (
            <b>Reading the bridge host table</b>
          )
        }
        controls={
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
              size="sm"
              disabled={busy}
              icon={<RefreshCw aria-hidden="true" className={busy ? "animate-spin" : undefined} />}
              onClick={reload}
            >
              Refresh
            </MonitorButton>
          </>
        }
      >
        {LEAD}
      </PageIntro>

      {error != null ? (
        <div className="monitor-note" data-tone="bad" role="alert">
          <AlertTriangle aria-hidden="true" className="text-destructive" />
          <span className="min-w-0 flex-1">
            <span className="font-[590]">Could not reach the device.</span>{" "}
            <span className="text-muted-foreground">{error}</span>
          </span>
        </div>
      ) : data == null || s == null ? (
        <LoadingState label="Loading the L2 fabric" layout="cards" />
      ) : (
        <>
          <MetricStrip label="Fabric totals" minCell={170}>
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
            <Metric label="Hosts" value={s.hosts} hint="seen passing frames" />
            <Metric label="Access" value={s.accessPorts} hint="one host each" />
            <Metric label="Uplink" value={s.uplinks} hint="switch or many hosts" />
            <Metric
              label="Unidentified"
              tone={s.unidentified > 0 ? "warn" : "default"}
              value={s.unidentified}
              hint="no lease, ARP or neighbour entry"
            />
          </MetricStrip>

          <section className="monitor-panel" aria-label="Hosts by port">
            <div className="flex flex-wrap items-center gap-2 px-5 py-4">
              <div className="mr-2">
                <h2 className="text-[14px] font-[590]">Hosts by port</h2>
              </div>
              <MonitorSearch
                className="flex-[1_1_300px]"
                label="Find a host"
                placeholder="Find a MAC, IP or host name"
                value={query}
                onChange={onSearch}
              />
              <span className="text-[12px] text-muted-foreground">Read-only</span>
            </div>
            {ports.length === 0 ? (
              <div className="border-t border-border">
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
                          className={`monitor-row fabric-port ${PORT_COLS} ${open ? "bg-overlay-03" : ""}`}
                          aria-expanded={open}
                          aria-controls={open ? panelId : undefined}
                          onClick={() => toggle(p.interface)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <ChevronRight
                              aria-hidden="true"
                              strokeWidth={1.5}
                              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                            />
                            <span className="font-mono text-[13px] text-foreground">
                              {p.interface}
                            </span>
                          </span>
                          <span>
                            <span className={`monitor-badge ${ROLE_TEXT[p.role]}`}>
                              <span className="monitor-dot bg-current" aria-hidden="true" />
                              {p.role[0].toUpperCase() + p.role.slice(1)}
                            </span>
                          </span>
                          <span className="truncate font-mono text-[12px] text-muted-foreground">
                            {p.bridge ?? "—"}
                          </span>
                          <span className="text-right text-fg-secondary tabular-nums">
                            {p.hostCount}
                          </span>
                        </button>
                        {open && (
                          <div id={panelId} className="bg-overlay-02">
                            {hosts.map((h) => {
                              const unknown = unidentified(h);
                              return (
                                <div key={h.mac} className={`monitor-row ${HOST_COLS} pl-12`}>
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
                                      className={`truncate font-[510] ${unknown ? "text-fg-secondary" : "text-foreground"}`}
                                    >
                                      {h.label}
                                    </span>
                                    {unknown && (
                                      <span className="monitor-chip text-warning">
                                        Unidentified
                                      </span>
                                    )}
                                  </span>
                                  <span className="font-mono text-[12px] text-fg-secondary">
                                    {h.mac}
                                  </span>
                                  <span className="font-mono text-[12px] text-muted-foreground">
                                    {h.ip ?? "—"}
                                  </span>
                                  <span>
                                    {h.vendor != null && (
                                      <span className="monitor-chip">{h.vendor}</span>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                            {more > 0 && (
                              <div className="monitor-row grid-cols-1 pl-[72px]">
                                <button
                                  type="button"
                                  className="justify-self-start text-[12px] font-[510] text-brand hover:underline"
                                  onClick={() => setExpanded(new Set(expanded).add(p.interface))}
                                >
                                  Show {more} more hosts
                                </button>
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
            <div className="monitor-row grid-cols-1 text-[12px] text-muted-foreground">
              Roles come from how many hosts sit behind a port: one host is an access port, more
              than four or another switch is an uplink, in between is hybrid. Search finds a host on
              any port and opens it.
            </div>
          </section>
        </>
      )}
    </section>
  );
}

// ── Vulnerabilities ──────────────────────────────────────────────────────────

interface Finding {
  advisory: {
    id: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    cvss?: number;
    summary: string;
    remediation: string;
    references: string[];
  };
  device?: string;
  version: string;
  exposure: "unrestricted" | "restricted" | "mitigated" | "unknown";
  exposedServices: { name: string; port?: number; allowedFrom: string[] }[];
  manualCheck?: string;
  score: number;
  fixedIn: string;
}
interface AdvisoryReport {
  findings: Finding[];
  unreadable: string[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
  datasetDate: string;
  datasetSize: number;
  devices: {
    device?: string;
    version: string;
    board?: string;
    enabledServices: number;
    unrestrictedServices: number;
  }[];
  error?: string;
}

const SEV_STYLE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-600 dark:text-red-400",
  high: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  low: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
};
const EXPOSURE_TEXT: Record<string, string> = {
  unrestricted: "reachable — no source restriction",
  restricted: "restricted to specific addresses",
  mitigated: "mitigated — service not enabled",
  unknown: "needs manual confirmation",
};

/** Published CVEs matched to the running version and ranked by real exposure. */
export function AdvisoryView(): ReactNode {
  const [data, setData] = useState<AdvisoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [fleet, setFleet] = useState(false);
  const [showMitigated, setShowMitigated] = useState(false);

  const load = useCallback(() => {
    void api<AdvisoryReport>(`/api/advisories${fleet ? "?all=1" : ""}`)
      .then((d) => {
        setError(d.error ?? null);
        if (!d.error) setData(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [fleet]);
  const [loadedFleet, setLoadedFleet] = useState(fleet);
  if (loadedFleet !== fleet) {
    setLoadedFleet(fleet);
    setBusy(true);
    setError(null);
    setData(null);
  }
  const reload = () => {
    setBusy(true);
    setError(null);
    load();
  };
  useEffect(() => load(), [load]);

  const findings = (data?.findings ?? []).filter(
    (f) => showMitigated || f.exposure !== "mitigated",
  );

  return (
    <Panel
      title="Known vulnerabilities"
      extra={
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              aria-label="whole fleet"
              checked={fleet}
              onCheckedChange={(checked) => setFleet(checked === true)}
            />
            whole fleet
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              aria-label="show mitigated"
              checked={showMitigated}
              onCheckedChange={(checked) => setShowMitigated(checked === true)}
            />
            show mitigated
          </label>
          <Button size="sm" ghost loading={busy} icon={<RefreshCw />} onClick={reload}>
            Refresh
          </Button>
        </div>
      }
    >
      {error != null ? (
        <ErrorBox message={error} />
      ) : data == null ? (
        <Loading />
      ) : (
        <div className="px-5">
          <div className="mb-3 grid gap-1 text-xs text-muted-foreground">
            {data.devices.map((d) => (
              <div key={d.device ?? "default"}>
                <strong className="text-foreground">{d.device ?? "default"}</strong> — RouterOS{" "}
                {d.version || "(unreadable)"}
                {d.board != null && ` on ${d.board}`} · {d.enabledServices} service(s) enabled,{" "}
                <span
                  className={
                    d.unrestrictedServices > 0 ? "text-amber-600 dark:text-amber-400" : undefined
                  }
                >
                  {d.unrestrictedServices} unrestricted
                </span>
              </div>
            ))}
          </div>

          {data.unreadable.length > 0 && (
            <div className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Could not read a version from: {data.unreadable.join(", ")}. Not audited — treat as
              unknown, not clean.
            </div>
          )}

          {findings.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <ShieldCheck className="size-6 text-emerald-500" />
              <div className="text-sm">No matching advisories under the current filters.</div>
            </div>
          ) : (
            <div className="grid gap-2 pb-2">
              {findings.map((f, i) => (
                <div
                  key={`${f.device ?? ""}${f.advisory.id}${i}`}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        SEV_STYLE[f.advisory.severity] ?? ""
                      }`}
                    >
                      {f.advisory.severity}
                    </span>
                    <span className="font-mono text-sm font-semibold">{f.advisory.id}</span>
                    {f.advisory.cvss != null && (
                      <span className="text-[11px] text-muted-foreground">
                        CVSS {f.advisory.cvss}
                      </span>
                    )}
                    {f.device != null && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{f.device}</span>
                    )}
                    <span className="flex-1" />
                    <span className="text-[11px] text-muted-foreground">risk {f.score}</span>
                  </div>
                  <div className="text-sm font-medium">{f.advisory.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {f.exposure === "mitigated" ? (
                      <ShieldOff className="mr-1 inline size-3" />
                    ) : (
                      <AlertTriangle className="mr-1 inline size-3" />
                    )}
                    {EXPOSURE_TEXT[f.exposure]} · running {f.version} → fixed in{" "}
                    <strong className="text-foreground">{f.fixedIn}</strong>
                  </div>
                  {f.exposedServices.length > 0 && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      exposed via{" "}
                      {f.exposedServices
                        .map(
                          (s) =>
                            `${s.name}${s.port != null ? `:${s.port}` : ""}${
                              s.allowedFrom.length > 0
                                ? ` (from ${s.allowedFrom.join(", ")})`
                                : " (from ANY)"
                            }`,
                        )
                        .join(", ")}
                    </div>
                  )}
                  {f.manualCheck != null && (
                    <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      confirm: {f.manualCheck}
                    </div>
                  )}
                  <div className="mt-2 text-xs">{f.advisory.summary}</div>
                  <div className="mt-2 rounded bg-muted/60 p-2 text-xs">
                    <strong>Fix:</strong> {f.advisory.remediation}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {f.advisory.references.map((r) => (
                      <a
                        key={r}
                        href={r}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[11px] text-blue-600 underline dark:text-blue-400"
                      >
                        {new URL(r).hostname}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border pt-3 pb-1 text-[11px] text-muted-foreground">
            Dataset reviewed {data.datasetDate} · {data.datasetSize} advisories. A clean result
            means nothing in this dataset matched — not that no vulnerability exists. Cross-check
            the vendor's security notices for anything newer.
          </div>
        </div>
      )}
    </Panel>
  );
}

// Kept as a re-export for existing dashboard consumers.
export { AccessView } from "./access-view";
