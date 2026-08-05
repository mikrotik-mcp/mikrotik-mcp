/**
 * Posture views: L2 Fabric, Vulnerabilities and Access Scope.
 *
 * All three read a single JSON endpoint backed by the same pure analyzer the
 * MCP tools use (`src/core/l2-fabric.ts`, `advisories.ts`, `access.ts`), so the
 * dashboard can never disagree with what a tool call reports.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Cable, Network, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { api } from "./api";
import { Panel } from "./atoms";
import { Button } from "./geist";

// ── Shared bits ──────────────────────────────────────────────────────────────

interface DeviceInfo {
  name: string;
}
interface DevicesPayload {
  defaultDevice: string;
  devices: DeviceInfo[];
}

/** Device picker shared by the two device-scoped views. */
function DevicePicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (d: string | undefined) => void;
}): ReactNode {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    void api<DevicesPayload>("/api/devices")
      .then((d) => setNames(d.devices.map((x) => x.name)))
      .catch(() => setNames([]));
  }, []);
  if (names.length <= 1) return null;
  return (
    <select
      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">(default device)</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

function Loading(): ReactNode {
  return <div className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</div>;
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

const ROLE_STYLE: Record<string, string> = {
  uplink: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  access: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  hybrid: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  empty: "bg-muted text-muted-foreground",
};

/** Per-port occupancy: which hosts sit behind each bridge port. */
export function FabricView(): ReactNode {
  const [device, setDevice] = useState<string | undefined>(undefined);
  const [data, setData] = useState<FabricMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    void api<FabricMap>(`/api/fabric${device ? `?device=${encodeURIComponent(device)}` : ""}`)
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [device]);
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

  return (
    <Panel
      title="Layer-2 Fabric — hosts by physical port"
      extra={
        <div className="flex items-center gap-2">
          <input
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            placeholder="find MAC / IP / host…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <DevicePicker value={device} onChange={setDevice} />
          <Button size="sm" ghost loading={busy} icon={<RefreshCw />} onClick={load}>
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
          <div className="mb-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>
              <strong className="text-foreground">{data.stats.ports}</strong> occupied ports
            </span>
            <span>
              <strong className="text-foreground">{data.stats.hosts}</strong> hosts
            </span>
            <span>
              <strong className="text-foreground">{data.stats.accessPorts}</strong> access
            </span>
            <span>
              <strong className="text-foreground">{data.stats.uplinks}</strong> uplink
            </span>
            {data.stats.unidentified > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                <strong>{data.stats.unidentified}</strong> unidentified
              </span>
            )}
          </div>

          {ports.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {data.ports.length === 0
                ? "No bridge host entries — this device may have no bridge, or switch-chip offload " +
                  "is forwarding without populating the host table."
                : "No host matches that search."}
            </div>
          ) : (
            <div className="grid gap-2 pb-2">
              {ports.map((p) => (
                <div key={p.interface} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Cable className="size-3.5 text-muted-foreground" />
                    <span className="font-mono text-sm font-semibold">{p.interface}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                        ROLE_STYLE[p.role] ?? ""
                      }`}
                    >
                      {p.role}
                    </span>
                    {p.bridge != null && (
                      <span className="text-[11px] text-muted-foreground">{p.bridge}</span>
                    )}
                    <span className="flex-1" />
                    <span className="text-[11px] text-muted-foreground">
                      {p.hostCount} host{p.hostCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="grid gap-1">
                    {p.hosts.map((h) => (
                      <div key={h.mac} className="flex items-center gap-2 text-xs">
                        {h.isNetworkDevice ? (
                          <Network className="size-3 shrink-0 text-blue-500" />
                        ) : (
                          <span className="size-3 shrink-0" />
                        )}
                        <span className="font-medium">{h.label}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{h.mac}</span>
                        {h.ip != null && (
                          <span className="text-[11px] text-muted-foreground">{h.ip}</span>
                        )}
                        {h.vendor != null && (
                          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            {h.vendor}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
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
  const [busy, setBusy] = useState(false);
  const [fleet, setFleet] = useState(false);
  const [showMitigated, setShowMitigated] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    void api<AdvisoryReport>(`/api/advisories${fleet ? "?all=1" : ""}`)
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [fleet]);
  useEffect(() => load(), [load]);

  const findings = (data?.findings ?? []).filter(
    (f) => showMitigated || f.exposure !== "mitigated",
  );

  return (
    <Panel
      title="Known vulnerabilities"
      extra={
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={fleet} onChange={(e) => setFleet(e.target.checked)} />
            whole fleet
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showMitigated}
              onChange={(e) => setShowMitigated(e.target.checked)}
            />
            show mitigated
          </label>
          <Button size="sm" ghost loading={busy} icon={<RefreshCw />} onClick={load}>
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

// ── Access scope ─────────────────────────────────────────────────────────────

interface AccessPayload {
  enabled: boolean;
  scope: {
    maxRisk?: string;
    devices?: string[];
    denyDevices?: string[];
    tools?: string[];
    denyTools?: string[];
    expiresAt?: number;
    label?: string;
  };
  denials: {
    ts: number;
    tool: string;
    risk: string;
    device?: string;
    rule: string;
    reason: string;
  }[];
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex gap-3 py-1 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/** The caller boundary enforced on this session, plus what it has blocked. */
export function AccessView(): ReactNode {
  const [data, setData] = useState<AccessPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    void api<AccessPayload>("/api/access")
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => load(), [load]);

  return (
    <div className="grid content-start gap-[18px]">
      <Panel
        title="Access scope"
        extra={
          <Button size="sm" ghost loading={busy} icon={<RefreshCw />} onClick={load}>
            Refresh
          </Button>
        }
      >
        {data == null ? (
          <Loading />
        ) : !data.enabled ? (
          <div className="px-5 pb-2 text-sm">
            <div className="mb-2 flex items-center gap-2">
              <ShieldOff className="size-4 text-muted-foreground" />
              <strong>Not enforced</strong>
            </div>
            <p className="text-xs text-muted-foreground">
              Every tool may be called on every configured device. Set <code>access.enabled</code>{" "}
              in the server configuration — with <code>access.maxRisk</code>,{" "}
              <code>access.devices</code> or <code>access.denyTools</code> — to bound what a session
              can reach. A session can also restrict itself at runtime via{" "}
              <code>narrow_access_scope</code>, which is one-way.
            </p>
          </div>
        ) : (
          <div className="px-5 pb-2">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-emerald-500" />
              <strong>Enforced</strong>
              {data.scope.label != null && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                  {data.scope.label}
                </span>
              )}
            </div>
            <Row label="max risk" value={data.scope.maxRisk ?? "(no ceiling)"} />
            <Row
              label="devices"
              value={
                data.scope.devices && data.scope.devices.length > 0
                  ? data.scope.devices.join(", ")
                  : "(all configured)"
              }
            />
            {data.scope.denyDevices != null && data.scope.denyDevices.length > 0 && (
              <Row label="denied devices" value={data.scope.denyDevices.join(", ")} />
            )}
            <Row
              label="tools"
              value={
                data.scope.tools && data.scope.tools.length > 0
                  ? data.scope.tools.join(", ")
                  : "(all)"
              }
            />
            {data.scope.denyTools != null && data.scope.denyTools.length > 0 && (
              <Row label="denied tools" value={data.scope.denyTools.join(", ")} />
            )}
            <Row
              label="expires"
              value={
                data.scope.expiresAt != null
                  ? new Date(data.scope.expiresAt).toLocaleString()
                  : "(never)"
              }
            />
          </div>
        )}
      </Panel>

      <Panel title={`Denied calls (${data?.denials.length ?? 0})`}>
        {data == null || data.denials.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No call has been blocked.
          </div>
        ) : (
          <div className="grid gap-1 px-5 pb-2">
            {data.denials.map((d, i) => (
              <div key={`${d.ts}${i}`} className="rounded border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{d.tool}</span>
                  <span className="rounded bg-muted px-1 text-[10px]">{d.risk}</span>
                  {d.device != null && (
                    <span className="text-[11px] text-muted-foreground">on {d.device}</span>
                  )}
                  <span className="rounded bg-red-500/15 px-1 text-[10px] text-red-600 dark:text-red-400">
                    {d.rule}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(d.ts).toLocaleTimeString()}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">{d.reason}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
