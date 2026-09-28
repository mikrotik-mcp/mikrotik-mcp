/**
 * CAPsMAN dashboard: per-device manager controls and Wi-Fi fabric analysis.
 *
 * Reads /api/capsman/overview|clients|audit and renders the Wi-Fi fabric:
 * a per-floor coverage grid (co-channel conflicts highlighted), a resource-aware
 * load board, a weak-signal client table with the recommended neighbor AP, and a
 * roaming/HA audit strip. Every write targets the selected router explicitly.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Power,
  RefreshCw,
  Radio as RadioIcon,
  Scale,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { MetricArea } from "./charts";
import { Badge, Button, Note, Select, Spinner } from "./geist";
import type { DevicesPayload } from "./types";
import type { CapsmanManager } from "../../src/observability/capsman-manager";
import { num } from "./format";
import { toast } from "./toast-action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Band = "2ghz" | "5ghz" | "unknown";
type Severity = "critical" | "high" | "medium" | "low";

interface RadioNode {
  cap: string;
  radioId: string;
  band: Band;
  channel?: number;
  clientCount: number;
  floor?: string;
  zone?: string;
  cpuLoad?: number;
  memUsedPct?: number;
  adjacent: string[];
  conflicts: string[];
}
interface Overview {
  managerEnabled: boolean;
  managerCount: number;
  capsHaveBackupManager: boolean;
  requirePeerCertificate: boolean;
  radios: RadioNode[];
  cochannel: [string, string][];
  proposedChannels: Record<string, number>;
  bandSplit: Record<Band, number>;
  totals: { radios: number; clients: number; caps: number };
}
interface WeakClient {
  mac: string;
  currentCap: string;
  currentRadio: string;
  signal: number;
  band: Band;
  recommendCap?: string;
  gainDb?: number;
}
interface Finding {
  finding_id: string;
  category: string;
  severity: Severity;
  confidence: string;
  title: string;
  target: string;
  detail: string;
  recommendation: string;
}
interface AuditPayload {
  findings: Finding[];
  summary: Record<Severity, number>;
  total: number;
}
interface RadioSeries {
  radioId: string;
  cap: string;
  band: Band;
  points: { ts: number; clients: number; channel: number | null }[];
  peak: number;
  avg: number;
}
interface TrendsPayload {
  series: RadioSeries[];
  days: number;
}

const SEV_COLOR: Record<Severity, string> = {
  critical: "text-destructive",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-muted-foreground",
};

function bandBadge(b: Band): ReactNode {
  const label = b === "2ghz" ? "2.4G" : b === "5ghz" ? "5G" : "?";
  return (
    <Badge type={b === "5ghz" ? "success" : b === "2ghz" ? "warning" : "secondary"}>{label}</Badge>
  );
}

interface ApplyResult {
  ok?: boolean;
  error?: string;
  snapshotId?: string;
  applied?: number;
  message?: string;
}

/** Confirm + POST a CAPsMAN write, toasting the outcome. */
async function runApply(
  path: string,
  body: unknown,
  label: string,
  onDone: () => void,
): Promise<void> {
  const id = toast.loading(`${label}…`);
  try {
    const r = await postJson<ApplyResult>(path, { ...(body as object), confirm: true });
    if (r?.ok) {
      toast.success(`${label} applied`, {
        id,
        description: r.snapshotId ? `snapshot ${r.snapshotId}` : r.message,
      });
      onDone();
    } else {
      toast.error(r?.error ?? `${label} failed`, { id });
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `${label} failed`, { id });
  }
}

/** "Steer" action for one weak client — confirmed in an AlertDialog. */
function SteerButton({
  device,
  mac,
  cap,
  onDone,
}: {
  device: string;
  mac: string;
  cap: string;
  onDone: () => void;
}): ReactNode {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" icon={<Wifi />}>
          Steer
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Steer {mac} toward {cap}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Installs a hard signal-range reject on the client&rsquo;s current radio so it
            re-associates on the stronger neighbor. This may briefly disconnect the client, and
            RouterOS ultimately lets the client decide (advisory). A config snapshot is taken first
            and the change runs in Safe Mode.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={() =>
              void runApply(
                "/api/capsman/apply/steer",
                { device, mac, mode: "hard" },
                `Steer ${mac}`,
                onDone,
              )
            }
          >
            Steer (hard)
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Radio health 0..1 (higher = better): fewer clients, lower CPU. */
function health(r: RadioNode): number {
  const load = Math.min(1, r.clientCount / 30);
  const cpu = Math.min(1, (r.cpuLoad ?? 0) / 100);
  const conflict = r.conflicts.length > 0 ? 0.4 : 0;
  return Math.max(0, 1 - (load * 0.5 + cpu * 0.4 + conflict));
}
function healthColor(h: number): string {
  if (h > 0.66) return "bg-emerald-500/15 border-emerald-500/40";
  if (h > 0.33) return "bg-yellow-500/15 border-yellow-500/40";
  return "bg-destructive/15 border-destructive/50";
}

export function CapsmanView(): ReactNode {
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [device, setDevice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<DevicesPayload>("/api/devices", controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setRouters(r);
        setDevice(
          r.devices.some((d) => d.name === r.defaultDevice)
            ? r.defaultDevice
            : (r.devices[0]?.name ?? ""),
        );
        setError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load routers.");
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <section className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Wireless control plane</div>
          <p className="text-xs text-muted-foreground">Manage CAPsMAN on one router at a time.</p>
        </div>
        {routers && routers.devices.length > 0 && (
          <Select
            aria-label="CAPsMAN router"
            value={device}
            disabled={busy}
            onValueChange={setDevice}
            options={routers.devices.map((d) => ({
              value: d.name,
              label: `${d.name}${d.name === routers.defaultDevice ? " (default)" : ""}`,
            }))}
          />
        )}
      </div>
      {error ? (
        <Note type="error" label="Routers unavailable">
          {error}{" "}
          <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </Button>
        </Note>
      ) : !routers ? (
        <div role="status">
          <Spinner /> Loading routers…
        </div>
      ) : !device ? (
        <Note>No configured routers.</Note>
      ) : (
        <>
          <ManagerControl
            key={device}
            device={device}
            onBusyChange={setBusy}
            onApplied={() => setRevision((r) => r + 1)}
          />
          <fieldset disabled={busy} className="min-w-0">
            <legend className="sr-only">CAPsMAN fabric for {device}</legend>
            <CapsmanFabric key={`${device}:${revision}`} device={device} />
          </fieldset>
        </>
      )}
    </section>
  );
}

function ManagerControl({
  device,
  onBusyChange,
  onApplied,
}: {
  device: string;
  onBusyChange: (busy: boolean) => void;
  onApplied: () => void;
}): ReactNode {
  const [managers, setManagers] = useState<CapsmanManager[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CapsmanManager | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const result = await api<{ device: string; managers: CapsmanManager[] }>(
          `/api/capsman/manager?device=${encodeURIComponent(device)}`,
          signal,
        );
        if (signal?.aborted) return;
        if (result.device !== device)
          throw new Error("The returned settings belong to another router.");
        setManagers(result.managers);
        setError(null);
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : "Could not read manager settings.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [device],
  );
  useEffect(() => {
    const controller = new AbortController();
    // State updates inside load happen only after the asynchronous router read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function apply(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true);
    onBusyChange(true);
    let failure: string | null = null;
    try {
      const result = await postJson<ApplyResult>("/api/capsman/manager", {
        device,
        path: selected.path,
        enabled: !selected.enabled,
        confirm: true,
      });
      if (!result.ok) throw new Error(result.error ?? "CAPsMAN change could not be verified.");
      toast.success(`${selected.label} ${selected.enabled ? "disabled" : "enabled"} on ${device}`, {
        description: result.snapshotId ? `Snapshot: ${result.snapshotId}` : result.message,
      });
    } catch (e) {
      failure =
        e instanceof Error ? e.message : "The outcome is unknown. Refresh before trying again.";
      toast.error(failure);
    } finally {
      setSelected(null);
      setLoading(true);
      await load();
      // Keep failures visible; never optimistically flip the enabled state.
      if (failure) setError(failure);
      setBusy(false);
      onBusyChange(false);
      onApplied();
    }
  }
  return (
    <Panel
      title="CAPsMAN manager"
      extra={
        <Button
          size="sm"
          ghost
          icon={<RefreshCw />}
          disabled={loading || busy}
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Refresh status
        </Button>
      }
    >
      <div className="grid gap-4">
        <p className="text-xs text-muted-foreground">
          Controller service on <span className="font-mono text-foreground">{device}</span>. Local
          Wi-Fi, CAP client mode and provisioning rules are not changed.
        </p>
        {error && (
          <Note type="error" label="Manager status needs attention">
            {error}
          </Note>
        )}
        {loading ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Reading manager status…
          </div>
        ) : !error && managers.length === 0 ? (
          <Note label="Not supported">
            No supported CAPsMAN manager was found on this router. Check the installed RouterOS
            packages.
          </Note>
        ) : (
          managers.map((manager) => (
            <div
              key={manager.path}
              className={cn(
                "flex flex-wrap items-center gap-4 rounded-lg border p-4 transition-colors motion-reduce:transition-none",
                manager.enabled ? "border-success/30 bg-success/5" : "border-border bg-background",
              )}
            >
              <div
                className={cn(
                  "grid size-11 shrink-0 place-items-center rounded-lg border",
                  manager.enabled
                    ? "border-success/30 text-success"
                    : "border-border text-muted-foreground",
                )}
              >
                <RadioIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{manager.label}</h3>
                  <Badge type={error ? "warning" : manager.enabled ? "success" : "secondary"}>
                    {error ? "Refresh required" : manager.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {manager.path}
                </p>
              </div>
              <Button
                size="sm"
                ghost
                icon={busy ? <Spinner /> : <Power />}
                disabled={busy || !!error}
                onClick={() => setSelected(manager)}
                aria-label={`${manager.enabled ? "Disable" : "Enable"} ${manager.label}`}
              >
                {busy ? "Applying…" : manager.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          ))
        )}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          Configuration snapshot → Safe Mode → verify status
        </div>
      </div>
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selected?.enabled ? "Disable" : "Enable"} {selected?.label} on {device}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selected?.enabled
                ? "Managed access points may disconnect and their Wi-Fi clients may lose access. "
                : "This starts the controller with its existing configuration. Existing provisioning rules may take effect; no rules or profiles are modified. "}
              Use a wired or independent management connection. A configuration snapshot is saved
              first; the change requires Safe Mode and a verified status readback.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => void apply()}
              icon={busy ? <Spinner /> : <Power />}
            >
              {busy ? "Applying…" : selected?.enabled ? "Disable manager" : "Enable manager"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function CapsmanFabric({ device }: { device: string }): ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [weak, setWeak] = useState<WeakClient[]>([]);
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [trends, setTrends] = useState<RadioSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const [o, c, a] = await Promise.all([
          api<Overview>(`/api/capsman/overview?device=${encodeURIComponent(device)}`, signal),
          api<{ weak: WeakClient[] }>(
            `/api/capsman/clients?device=${encodeURIComponent(device)}`,
            signal,
          ),
          api<AuditPayload>(`/api/capsman/audit?device=${encodeURIComponent(device)}`, signal),
        ]);
        if (signal?.aborted) return;
        setOverview(o);
        setWeak(c.weak);
        setAudit(a);
        setError(null);
      } catch (e) {
        if (signal?.aborted) return;
        setError(e instanceof Error ? e.message : "Could not load CAPsMAN data");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
      // Trends are optional (the sampler DB may be off/empty) — never fail the view.
      try {
        const t = await api<TrendsPayload>(
          `/api/capsman/trends?device=${encodeURIComponent(device)}`,
          signal,
        );
        if (!signal?.aborted) setTrends(t.series ?? []);
      } catch {
        if (!signal?.aborted) setTrends([]);
      }
    },
    [device],
  );

  useEffect(() => {
    const controller = new AbortController();
    // load synchronizes state with asynchronous device responses, not with props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Group radios by floor (unknown floor → "?"), then render a grid per floor.
  const floors = useMemo(() => {
    const byFloor = new Map<string, RadioNode[]>();
    for (const r of overview?.radios ?? []) {
      const f = r.floor ?? "?";
      (byFloor.get(f) ?? byFloor.set(f, []).get(f)!).push(r);
    }
    return [...byFloor.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [overview]);

  if (loading && !overview) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
        <Spinner /> Loading CAPsMAN fabric…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <Note type="error" label="CAPsMAN unavailable">
          {error}
        </Note>
        <Button size="sm" onClick={() => void load()}>
          Retry fabric data
        </Button>
      </div>
    );
  }
  if (!overview) return null;

  const notManager = !overview.managerEnabled;

  return (
    <div className="flex flex-col gap-5">
      {notManager && (
        <Note label="Local radio view">
          The fabric collector did not report an active manager for this wireless stack. Local
          radios may still appear below; use the manager controls above for the verified service
          status.
        </Note>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard k="CAPs" v={num(overview.totals.caps)} sub="managed access points" />
        <StatCard k="Radios" v={num(overview.totals.radios)} />
        <StatCard k="Clients" v={num(overview.totals.clients)} />
        <StatCard
          k="2.4G / 5G"
          v={`${overview.bandSplit["2ghz"]} / ${overview.bandSplit["5ghz"]}`}
          sub="client band split"
        />
        <StatCard
          k="Co-channel"
          v={num(overview.cochannel.length)}
          cls={overview.cochannel.length ? "text-destructive" : undefined}
          sub="conflicting pairs"
        />
        <StatCard
          k="Findings"
          v={num(audit?.total ?? 0)}
          cls={audit && audit.total > 0 ? "text-orange-500" : undefined}
        />
      </div>

      {/* §5.1 Floor coverage heatmap + §5.4 load (per-radio cards carry both) */}
      <Panel
        title="Coverage & load by floor"
        extra={
          <div className="flex items-center gap-2">
            {overview.cochannel.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" icon={<RadioIcon />}>
                    Apply channel plan
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Apply the proposed channel plan?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Re-channels radios to the non-overlapping plan (2.4 GHz 1/6/11, 5 GHz
                      DFS-aware) to clear the {overview.cochannel.length} co-channel conflict(s).
                      Clients on a re-channeled radio briefly re-associate. Snapshot + Safe Mode;
                      idempotent. (v7 /interface wifi only.)
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        void runApply(
                          "/api/capsman/apply/channel-plan",
                          { device },
                          "Channel plan",
                          () => void load(),
                        )
                      }
                    >
                      Apply
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" icon={<Scale />}>
                  Auto-balance
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Apply resource-aware load balance?</AlertDialogTitle>
                  <AlertDialogDescription>
                    For each overloaded or CPU-constrained radio that has an idle adjacent neighbor,
                    installs a connect-priority nudge so NEW clients prefer the neighbor. Existing
                    clients are not disconnected. Snapshot + Safe Mode; idempotent.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      void runApply(
                        "/api/capsman/apply/load-balance",
                        { device },
                        "Load balance",
                        () => void load(),
                      )
                    }
                  >
                    Apply
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <button
              type="button"
              onClick={() => void load()}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              <RefreshCw className="size-3.5" /> refresh
            </button>
          </div>
        }
      >
        {floors.length === 0 ? (
          <p className="text-muted-foreground text-sm">No managed radios.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {floors.map(([floor, radios]) => (
              <div key={floor}>
                <div className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
                  {floor === "?" ? "Unfloored (inferred by signal)" : `Floor ${floor}`}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {radios.map((r) => {
                    const proposed = overview.proposedChannels[r.radioId];
                    const changeCh = proposed != null && proposed !== r.channel;
                    return (
                      <div
                        key={r.radioId}
                        className={cn(
                          "flex flex-col gap-1 rounded-lg border p-2.5",
                          healthColor(health(r)),
                        )}
                        title={`${r.cap} · ${r.adjacent.length} neighbors`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="inline-flex items-center gap-1 text-xs font-semibold">
                            <RadioIcon className="size-3" /> {r.cap}
                          </span>
                          {bandBadge(r.band)}
                        </div>
                        <div className="text-muted-foreground flex items-center justify-between text-[11px]">
                          <span
                            className={cn(r.conflicts.length > 0 && "text-destructive font-medium")}
                          >
                            ch {r.channel ?? "?"}
                            {changeCh && <span className="text-brand"> →{proposed}</span>}
                          </span>
                          <span>{r.clientCount} cl</span>
                        </div>
                        <div className="text-muted-foreground flex items-center justify-between text-[11px]">
                          <span>CPU {r.cpuLoad != null ? `${r.cpuLoad}%` : "—"}</span>
                          {r.conflicts.length > 0 && (
                            <span className="text-destructive inline-flex items-center gap-0.5">
                              <AlertTriangle className="size-3" /> co-ch
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* §5.5 Roaming & HA audit strip */}
      <Panel
        title="Roaming (FT) & HA audit"
        extra={
          <div className="flex items-center gap-2">
            {audit && audit.findings.some((f) => f.category === "ft") && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" icon={<Wifi />}>
                    Enable FT
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Enable 802.11r fast-roaming?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Turns on FT across the CAPsMAN security configs and converges them on ONE
                      shared mobility domain, so clients roam between floors without a full re-auth.
                      This briefly re-keys associated clients. Snapshot + Safe Mode; idempotent.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        void runApply(
                          "/api/capsman/apply/ft",
                          { device },
                          "Enable FT",
                          () => void load(),
                        )
                      }
                    >
                      Enable FT
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {audit && audit.findings.some((f) => f.category === "ha") && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" icon={<AlertTriangle />}>
                    Harden HA
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Harden CAPsMAN HA (require peer certificate)?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      Enables require-peer-certificate on this manager so a rogue manager
                      can&rsquo;t adopt your CAPs. Standing up a second manager and pointing every
                      CAP at both is multi-device and NOT auto-applied — the tool returns those
                      manual steps. Snapshot + Safe Mode; idempotent.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        void runApply(
                          "/api/capsman/apply/ha",
                          { device },
                          "Harden HA",
                          () => void load(),
                        )
                      }
                    >
                      Harden HA
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        }
      >
        {!audit || audit.total === 0 ? (
          <p className="text-emerald-500 text-sm">
            No findings — roaming &amp; redundancy look healthy. ✓
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {audit.findings.map((f) => (
              <div key={f.finding_id} className="flex items-start gap-2 rounded-md border p-2.5">
                <span
                  className={cn("mt-0.5 text-[10px] font-bold uppercase", SEV_COLOR[f.severity])}
                >
                  {f.severity.slice(0, 4)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{f.title}</div>
                  <div className="text-muted-foreground text-xs">{f.detail}</div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    → {f.recommendation}
                    <span className="ml-2 opacity-60">
                      [{f.category} · {f.confidence}]
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* §5.3 Weak-signal client table */}
      <Panel
        title="Weak-signal clients"
        extra={<span className="text-muted-foreground text-xs">{weak.length} below threshold</span>}
      >
        {weak.length === 0 ? (
          <p className="text-emerald-500 text-sm">No weak clients. ✓</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Current AP</TableHead>
                  <TableHead>Recommended</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {weak.map((w) => (
                  <TableRow key={w.mac}>
                    <TableCell className="font-mono text-xs">{w.mac}</TableCell>
                    <TableCell
                      className={cn(
                        w.signal < -80 ? "text-destructive" : "text-orange-500",
                        "tabular-nums",
                      )}
                    >
                      {w.signal} dBm
                    </TableCell>
                    <TableCell>{bandBadge(w.band)}</TableCell>
                    <TableCell className="text-xs">{w.currentCap}</TableCell>
                    <TableCell className="text-xs">
                      {w.recommendCap ? (
                        <span className="text-brand inline-flex items-center gap-1">
                          <Wifi className="size-3" /> {w.recommendCap} (+{w.gainDb} dB)
                        </span>
                      ) : (
                        <span className="text-muted-foreground">coverage gap</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {w.recommendCap && (
                        <SteerButton
                          device={device}
                          mac={w.mac}
                          cap={w.recommendCap}
                          onDone={() => void load()}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {trends.length > 0 && (
        <Panel
          title="Radio load trends"
          extra={
            <span className="text-muted-foreground text-[11px]">
              associated clients per radio · sampled every 5 min
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-4 p-1 sm:grid-cols-2 xl:grid-cols-3">
            {trends.map((s) => {
              const color =
                s.band === "5ghz"
                  ? "var(--success)"
                  : s.band === "2ghz"
                    ? "var(--warning)"
                    : "var(--muted-foreground)";
              return (
                <div key={s.radioId} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1.5 font-medium">
                      {bandBadge(s.band)}
                      <span className="truncate">{s.cap}</span>
                      <span className="text-muted-foreground">/{s.radioId}</span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      peak {s.peak} · avg {s.avg}
                    </span>
                  </div>
                  <MetricArea
                    values={s.points.map((p) => p.clients)}
                    color={color}
                    id={`capsman-${s.radioId}`}
                  />
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      <p className="text-muted-foreground text-[11px]">
        Steering, load-balance, channel-plan, FT and HA apply are all live (snapshot + Safe Mode,
        confirmed). All steering is advisory — RouterOS lets the client decide. Load trends fill in
        as the background sampler runs.
      </p>
    </div>
  );
}
