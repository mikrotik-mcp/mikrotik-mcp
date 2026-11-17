/**
 * Network → CAPsMAN: the Wi-Fi access points one router manages.
 *
 * Reads /api/capsman/manager|overview|clients|audit|trends for the chosen
 * router and shows the manager switch, a per-floor coverage grid (co-channel
 * overlaps marked), roaming and HA findings, weak-signal clients with a better
 * AP, and client load per radio. Every write names the router, asks for
 * confirmation in a dialog first, and reloads the data afterwards.
 */
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CapsmanManager } from "../../src/observability/capsman-manager";
import { api, postJson } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  StatusBadge,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";

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
interface ApplyResult {
  ok?: boolean;
  error?: string;
  snapshotId?: string;
  applied?: number;
  message?: string;
}

/** What the header status line needs from the fabric data. */
interface Summary {
  cochannel: number;
  findings: number;
  /** Radios the manager reported; 0 means there is nothing to judge yet. */
  radios: number;
  at: number;
}

/** The server's default weak-signal threshold (DEFAULT_WEAK_DBM). */
const WEAK_DBM = -70;

const SEV_LABEL: Record<Severity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};
const SEV_CLASS: Record<Severity, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "",
};

const bandLabel = (b: Band): string => (b === "2ghz" ? "2.4G" : b === "5ghz" ? "5G" : "?");
const dbm = (v: number): string => `${v < 0 ? "−" : ""}${Math.abs(v)} dBm`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** POST a confirmed CAPsMAN write and toast the outcome. */
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

/**
 * The confirm dialog every CAPsMAN write uses (board "CAPsMAN · confirm"):
 * title and one line, optional list of changes, a note, the snapshot line,
 * then Cancel and the action.
 */
function ConfirmWrite({
  open,
  onOpenChange,
  title,
  description,
  changes,
  note,
  noteTone = "warn",
  footnote = "MCP takes a configuration snapshot, applies the change in Safe Mode, then reads it back.",
  action,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  changes?: ReactNode;
  note?: ReactNode;
  noteTone?: "warn" | "default";
  footnote?: ReactNode;
  action: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
}): ReactNode {
  return (
    <MonitorDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      width={540}
      confirm
      title={title}
      description={description}
      footer={
        <>
          <span className="flex-1" />
          <MonitorButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </MonitorButton>
          <MonitorButton size="sm" variant="inverse" disabled={busy} onClick={onConfirm}>
            {action}
          </MonitorButton>
        </>
      }
    >
      <div className="monitor-dialog-body flex flex-col gap-4">
        {changes}
        {note != null && (
          <div
            className="monitor-note text-fg-secondary"
            data-tone={noteTone === "warn" ? "warn" : undefined}
          >
            {noteTone === "warn" && <AlertTriangle aria-hidden="true" className="text-warning" />}
            <span>{note}</span>
          </div>
        )}
        <p className="text-muted-foreground text-[12px]">{footnote}</p>
      </div>
    </MonitorDialog>
  );
}

/** A button that opens a ConfirmWrite and runs `run` on confirm. */
function WriteButton({
  label,
  dialog,
  run,
}: {
  label: string;
  dialog: Omit<Parameters<typeof ConfirmWrite>[0], "open" | "onOpenChange" | "onConfirm">;
  run: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MonitorButton size="sm" onClick={() => setOpen(true)}>
        {label}
      </MonitorButton>
      <ConfirmWrite
        {...dialog}
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          setOpen(false);
          run();
        }}
      />
    </>
  );
}

export function CapsmanView(): ReactNode {
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [device, setDevice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [fabricFailed, setFabricFailed] = useState(false);

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

  const changeDevice = (name: string): void => {
    setSummary(null);
    setFabricFailed(false);
    setDevice(name);
  };

  let tone: Tone | undefined;
  let status: ReactNode;
  if (fabricFailed) {
    tone = "bad";
    status = <b className="text-foreground font-[510]">Could not read CAPsMAN data</b>;
  } else if (summary) {
    const issues = summary.cochannel + summary.findings;
    tone = issues > 0 ? "warn" : summary.radios > 0 ? "good" : "default";
    status = (
      <>
        <b className="text-foreground font-[510]">
          {issues > 0
            ? `${plural(summary.cochannel, "co-channel pair", "co-channel pairs")}, ${plural(summary.findings, "finding", "findings")}`
            : summary.radios > 0
              ? "No co-channel pairs or findings"
              : "No managed radios"}
        </b>{" "}
        · read {hhmm(summary.at)} from {device}
      </>
    );
  } else if (device) {
    status = `Reading ${device}`;
  }

  return (
    <section className="grid min-w-0 content-start gap-6">
      <PageIntro
        tone={tone}
        title={
          status != null ? (
            <span className="text-muted-foreground text-[13px] font-normal">{status}</span>
          ) : undefined
        }
        controls={
          routers && routers.devices.length > 0 ? (
            <>
              <RouterPicker
                label="CAPsMAN router"
                value={device}
                onChange={changeDevice}
                routers={routers.devices.map((d) => d.name)}
                defaultRouter={routers.defaultDevice}
                disabled={busy}
              />
              <MonitorButton
                size="sm"
                icon={<RefreshCw />}
                disabled={busy || !device}
                onClick={() => setRefresh((r) => r + 1)}
              >
                Refresh
              </MonitorButton>
            </>
          ) : undefined
        }
      >
        Wi-Fi access points managed by one router: coverage, load, weak clients, roaming and
        failover.
      </PageIntro>

      {error ? (
        <div className="monitor-note text-fg-secondary items-center" data-tone="bad">
          <span className="flex-1">
            <b className="text-foreground font-[510]">Routers unavailable.</b> {error}
          </span>
          <MonitorButton size="sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </MonitorButton>
        </div>
      ) : !routers ? (
        <LoadingState label="Loading routers" layout="cards" />
      ) : !device ? (
        <div className="monitor-panel">
          <MonitorEmpty title="No routers configured">
            Add a router on the Devices page to manage its access points here.
          </MonitorEmpty>
        </div>
      ) : (
        <>
          <ManagerControl
            key={device}
            device={device}
            refresh={refresh}
            onBusyChange={setBusy}
            onApplied={() => setRevision((r) => r + 1)}
          />
          <fieldset disabled={busy} className="min-w-0">
            <legend className="sr-only">CAPsMAN data for {device}</legend>
            <CapsmanFabric
              key={`${device}:${revision}`}
              device={device}
              refresh={refresh}
              onSummary={setSummary}
              onFailed={setFabricFailed}
            />
          </fieldset>
        </>
      )}
    </section>
  );
}

function ManagerControl({
  device,
  refresh,
  onBusyChange,
  onApplied,
}: {
  device: string;
  refresh: number;
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
    // The header's Refresh bumps `refresh`; show the read as in progress.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (refresh > 0) setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refresh]);

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
      // Keep failures visible; never flip the enabled state ahead of the router.
      if (failure) setError(failure);
      setBusy(false);
      onBusyChange(false);
      onApplied();
    }
  }

  const turningOff = selected?.enabled === true;
  return (
    <MonitorPanel
      title="Manager"
      description={
        <>
          The controller service on {device}. Turning it on or off leaves local Wi-Fi, CAP mode and
          provisioning alone.
        </>
      }
      flush
    >
      {error && (
        <div className="border-border border-t px-5 py-3">
          <div className="monitor-note text-fg-secondary" data-tone="bad">
            <AlertTriangle aria-hidden="true" className="text-destructive" />
            <span>
              <b className="text-foreground font-[510]">Manager status needs a refresh.</b> {error}
            </span>
          </div>
        </div>
      )}
      {loading ? (
        <div role="status" className="monitor-row text-muted-foreground grid-cols-1">
          Reading manager status…
        </div>
      ) : !error && managers.length === 0 ? (
        <div className="border-border border-t">
          <MonitorEmpty compact title="Not supported on this router">
            No CAPsMAN manager found. Check the installed RouterOS packages.
          </MonitorEmpty>
        </div>
      ) : (
        managers.map((manager) => (
          <div
            key={manager.path}
            className="monitor-row grid-cols-[32px_minmax(0,1fr)_auto_auto] hover:bg-transparent"
          >
            <span
              aria-hidden="true"
              className="bg-overlay-03 text-muted-foreground grid size-8 place-items-center rounded-lg shadow-[inset_0_0_0_1px_var(--border)] [&_svg]:size-4"
            >
              <Wifi />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-foreground">{manager.label}</span>
              <span className="text-muted-foreground truncate font-mono text-[12px]">
                {manager.path}
              </span>
            </span>
            <StatusBadge tone={error ? "warn" : manager.enabled ? "good" : "default"}>
              {error ? "Refresh required" : manager.enabled ? "Enabled" : "Disabled"}
            </StatusBadge>
            <MonitorButton
              size="sm"
              disabled={busy || !!error}
              onClick={() => setSelected(manager)}
            >
              {busy ? "Applying…" : manager.enabled ? "Disable" : "Enable"}
            </MonitorButton>
          </div>
        ))
      )}
      <div className="monitor-row text-muted-foreground grid-cols-1 text-[12px] hover:bg-transparent">
        Each change takes a configuration snapshot, runs in Safe Mode, then checks the manager
        state.
      </div>
      <ConfirmWrite
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        busy={busy}
        title={
          <>
            {turningOff ? "Disable" : "Enable"} {selected?.label} on {device}?
          </>
        }
        description={
          turningOff
            ? "Stops the controller. Managed access points stop getting their configuration from it."
            : "Starts the controller with its current configuration."
        }
        note={
          turningOff
            ? "Managed access points may disconnect and their Wi-Fi clients may lose access. Use a wired or separate management connection."
            : "Provisioning rules already set on this router may take effect. No rules or profiles are changed."
        }
        noteTone={turningOff ? "warn" : "default"}
        footnote="MCP takes a configuration snapshot, makes the change in Safe Mode, then reads the manager state back."
        action={busy ? "Applying…" : turningOff ? "Disable manager" : "Enable manager"}
        onConfirm={() => void apply()}
      />
    </MonitorPanel>
  );
}

/** A radio's load, 0–1: client count weighs 60%, CPU 40%. */
function radioLoad(r: RadioNode): number {
  return Math.min(1, r.clientCount / 30) * 0.6 + Math.min(1, (r.cpuLoad ?? 0) / 100) * 0.4;
}

function CapsmanFabric({
  device,
  refresh,
  onSummary,
  onFailed,
}: {
  device: string;
  refresh: number;
  onSummary: (s: Summary) => void;
  onFailed: (failed: boolean) => void;
}): ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [weak, setWeak] = useState<WeakClient[]>([]);
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [trends, setTrends] = useState<TrendsPayload | null>(null);
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
        onFailed(false);
        onSummary({
          cochannel: o.cochannel.length,
          findings: a.total ?? 0,
          radios: o.radios.length,
          at: Date.now(),
        });
      } catch (e) {
        if (signal?.aborted) return;
        setError(e instanceof Error ? e.message : "Could not load CAPsMAN data");
        onFailed(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
      // Trends are optional (the sampler may be off or empty), so never fail the view.
      try {
        const t = await api<TrendsPayload>(
          `/api/capsman/trends?device=${encodeURIComponent(device)}`,
          signal,
        );
        if (!signal?.aborted) setTrends(t);
      } catch {
        if (!signal?.aborted) setTrends(null);
      }
    },
    [device, onSummary, onFailed],
  );

  useEffect(() => {
    const controller = new AbortController();
    // load synchronizes state with asynchronous device responses, not with props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refresh]);

  // Group radios by floor; radios with no floor go last.
  const floors = useMemo(() => {
    const byFloor = new Map<string, RadioNode[]>();
    for (const r of overview?.radios ?? []) {
      const f = r.floor ?? "?";
      (byFloor.get(f) ?? byFloor.set(f, []).get(f)!).push(r);
    }
    return [...byFloor.entries()].sort((a, b) =>
      a[0] === "?" ? 1 : b[0] === "?" ? -1 : a[0].localeCompare(b[0], undefined, { numeric: true }),
    );
  }, [overview]);

  if (loading && !overview) {
    return <LoadingState label="Loading CAPsMAN data" layout="cards" />;
  }
  if (error) {
    return (
      <div className="monitor-panel">
        <MonitorEmpty
          icon={<AlertTriangle />}
          title="Could not read CAPsMAN data"
          action={
            <MonitorButton size="sm" onClick={() => void load()}>
              Try again
            </MonitorButton>
          }
        >
          {error}
        </MonitorEmpty>
      </div>
    );
  }
  if (!overview) return null;

  const reload = (): void => void load();
  const capOf = new Map(overview.radios.map((r) => [r.radioId, r.cap]));
  const moves = overview.radios.filter((r) => {
    const to = overview.proposedChannels[r.radioId];
    return to != null && to !== r.channel;
  });
  const movedClients = moves.reduce((sum, r) => sum + r.clientCount, 0);
  const flooredCount = floors.filter(([f]) => f !== "?").length;
  const findings = audit?.findings ?? [];
  const findingTotal = audit?.total ?? 0;
  const categories = [...new Set(findings.map((f) => f.category))].map((c) =>
    c === "ft" ? "roaming" : c === "ha" ? "HA" : c,
  );
  const series = trends?.series ?? [];
  const days = trends?.days ?? 1;

  return (
    <div className="flex flex-col gap-6">
      {!overview.managerEnabled && (
        <div className="monitor-note text-fg-secondary">
          <span>
            This router reports no active manager for this Wi-Fi stack. Its own radios may still
            show below; the Manager panel has the checked status.
          </span>
        </div>
      )}

      <MetricStrip label="CAPsMAN counts" minCell={150}>
        <Metric label="CAPs" value={overview.totals.caps} hint="managed access points" />
        <Metric
          label="Radios"
          value={overview.totals.radios}
          hint={flooredCount > 0 ? `across ${plural(flooredCount, "floor", "floors")}` : undefined}
        />
        <Metric label="Clients" value={overview.totals.clients} hint="associated now" />
        <Metric
          label="2.4G / 5G"
          value={`${overview.bandSplit["2ghz"] ?? 0} / ${overview.bandSplit["5ghz"] ?? 0}`}
          hint="client band split"
        />
        <Metric
          label="Co-channel"
          tone={overview.cochannel.length > 0 ? "bad" : "default"}
          value={overview.cochannel.length}
          hint="radio pairs overlap"
        />
        <Metric
          label="Findings"
          tone={findingTotal > 0 ? "warn" : "default"}
          value={findingTotal}
          hint={categories.length > 0 ? categories.join(" and ") : undefined}
        />
      </MetricStrip>

      <MonitorPanel
        title="Coverage and load by floor"
        description="One tile per radio. A stronger tint means more clients, higher CPU or a channel overlap."
        extra={
          <>
            {overview.cochannel.length > 0 && (
              <WriteButton
                label="Apply channel plan"
                run={() =>
                  void runApply(
                    "/api/capsman/apply/channel-plan",
                    { device },
                    "Channel plan",
                    reload,
                  )
                }
                dialog={{
                  title: `Apply the channel plan on ${device}?`,
                  description: `Moves ${plural(moves.length, "radio", "radios")} to free channels so no two neighbours share one.`,
                  changes:
                    moves.length > 0 ? (
                      <div className="flex flex-col">
                        <span className="monitor-label mb-1.5">What changes</span>
                        {moves.map((r) => (
                          <div
                            key={r.radioId}
                            className="border-border grid grid-cols-[minmax(0,1fr)_44px_auto] items-center gap-3 border-t py-2.5 text-[13px]"
                          >
                            <span className="text-foreground truncate font-mono text-[12px]">
                              {r.cap}/{r.radioId}
                            </span>
                            <span className="monitor-chip justify-self-start">
                              {bandLabel(r.band)}
                            </span>
                            <span className="text-fg-secondary whitespace-nowrap tabular-nums">
                              ch {r.channel ?? "?"} <span className="text-muted-foreground">→</span>{" "}
                              <span className="text-brand font-[510]">
                                ch {overview.proposedChannels[r.radioId]}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : undefined,
                  note:
                    moves.length > 0
                      ? `About ${movedClients} clients on these radios lose Wi-Fi for a few seconds while they reconnect.`
                      : undefined,
                  footnote:
                    "MCP takes a configuration snapshot, applies the plan in Safe Mode, then reads the channels back.",
                  action: "Apply channel plan",
                }}
              />
            )}
            <WriteButton
              label="Auto-balance"
              run={() =>
                void runApply("/api/capsman/apply/load-balance", { device }, "Load balance", reload)
              }
              dialog={{
                title: `Auto-balance clients on ${device}?`,
                description:
                  "New clients prefer an idle neighbour over an overloaded or busy radio.",
                note: "Clients already connected stay where they are.",
                noteTone: "default",
                action: "Auto-balance",
              }}
            />
          </>
        }
      >
        {floors.length === 0 ? (
          <MonitorEmpty compact title="No managed radios">
            Radios show up here once a CAP connects to this manager.
          </MonitorEmpty>
        ) : (
          <div className="flex flex-col gap-5">
            {floors.map(([floor, radios]) => (
              <div key={floor} className="flex flex-col gap-2">
                <span className="monitor-label">
                  {floor === "?" ? "Unfloored · placed by signal" : `Floor ${floor}`}
                </span>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-2">
                  {radios.map((r) => {
                    const to = overview.proposedChannels[r.radioId];
                    const co = r.conflicts.length > 0;
                    const load = radioLoad(r);
                    const tint = co
                      ? "var(--destructive)"
                      : load > 0.6
                        ? "var(--warning)"
                        : "var(--chart-1)";
                    const mix = co ? 8 : Math.round(3 + load * 8);
                    const style = {
                      background: `color-mix(in srgb, ${tint} ${mix}%, var(--card))`,
                      boxShadow: `inset 0 0 0 1px ${co ? "color-mix(in srgb, var(--destructive) 40%, transparent)" : "var(--border)"}`,
                    } as CSSProperties;
                    return (
                      <div
                        key={r.radioId}
                        className="flex flex-col gap-1.5 rounded-lg px-3.5 py-3"
                        style={style}
                        title={`${r.cap} · ${plural(r.adjacent.length, "neighbour", "neighbours")}`}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="text-foreground truncate font-mono text-[13px]">
                            {r.cap}
                          </span>
                          <span className="flex-1" />
                          <span className="monitor-chip">{bandLabel(r.band)}</span>
                        </div>
                        <div className="text-fg-secondary flex flex-wrap gap-x-2.5 gap-y-1 text-[12px] tabular-nums">
                          <span className={cn(co && "text-destructive")}>
                            ch {r.channel ?? "?"}
                            {to != null && to !== r.channel && (
                              <span className="text-brand"> → {to}</span>
                            )}
                          </span>
                          <span>{plural(r.clientCount, "client", "clients")}</span>
                          <span className="text-muted-foreground">
                            CPU {r.cpuLoad != null ? `${r.cpuLoad}%` : "—"}
                          </span>
                        </div>
                        {co && (
                          <span className="text-destructive text-[12px] font-[510]">
                            Overlaps {r.conflicts.map((id) => capOf.get(id) ?? id).join(", ")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </MonitorPanel>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(560px,100%),1fr))] gap-6">
        <MonitorPanel
          title="Roaming (FT) and HA"
          description="Fast roaming and backup-manager checks."
          flush
          extra={
            <>
              {findings.some((f) => f.category === "ft") && (
                <WriteButton
                  label="Enable FT"
                  run={() =>
                    void runApply("/api/capsman/apply/ft", { device }, "Enable FT", reload)
                  }
                  dialog={{
                    title: `Enable fast roaming on ${device}?`,
                    description:
                      "Turns on 802.11r in every CAPsMAN security config and puts them in one mobility domain.",
                    note: "Connected clients re-key once and may drop for a moment.",
                    action: "Enable FT",
                  }}
                />
              )}
              {findings.some((f) => f.category === "ha") && (
                <WriteButton
                  label="Harden HA"
                  run={() =>
                    void runApply("/api/capsman/apply/ha", { device }, "Harden HA", reload)
                  }
                  dialog={{
                    title: `Require the manager certificate on ${device}?`,
                    description: "Stops a rogue manager on the LAN from taking over your CAPs.",
                    note: "A second manager is not set up for you. MCP returns the manual steps for that.",
                    noteTone: "default",
                    action: "Harden HA",
                  }}
                />
              )}
            </>
          }
        >
          {findingTotal === 0 ? (
            <div className="border-border border-t">
              <MonitorEmpty compact title="No findings">
                Roaming and failover checks all pass.
              </MonitorEmpty>
            </div>
          ) : (
            findings.map((f) => (
              <div
                key={f.finding_id}
                className="monitor-row grid-cols-[56px_minmax(0,1fr)] items-start hover:bg-transparent"
              >
                <span className={cn("monitor-risk justify-self-start", SEV_CLASS[f.severity])}>
                  {SEV_LABEL[f.severity]}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground">{f.title}</span>
                  <span className="text-muted-foreground text-[12px]">{f.detail}</span>
                  <span className="text-fg-secondary text-[12px]">
                    → {f.recommendation}{" "}
                    <span className="text-muted-foreground">
                      · {f.category} · {f.confidence} confidence
                    </span>
                  </span>
                </span>
              </div>
            ))
          )}
        </MonitorPanel>

        <MonitorPanel
          title="Weak-signal clients"
          description={`${plural(weak.length, "client", "clients")} below ${dbm(WEAK_DBM)}.`}
          flush
        >
          {weak.length === 0 ? (
            <div className="border-border border-t">
              <MonitorEmpty compact title="No weak clients">
                Every client hears its access point well.
              </MonitorEmpty>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="monitor-thead min-w-[520px] grid-cols-[minmax(150px,1fr)_80px_56px_minmax(140px,1fr)_minmax(170px,1.2fr)_64px]">
                <span>Client</span>
                <span className="text-right">Signal</span>
                <span>Band</span>
                <span>Current AP</span>
                <span>Better AP</span>
                <span />
              </div>
              {weak.map((w) => (
                <div
                  key={w.mac}
                  className="monitor-row min-w-[520px] grid-cols-[minmax(150px,1fr)_80px_56px_minmax(140px,1fr)_minmax(170px,1.2fr)_64px]"
                >
                  <span className="text-fg-secondary truncate font-mono text-[12px]">{w.mac}</span>
                  <span
                    className={cn(
                      "text-right tabular-nums",
                      w.signal < -80 ? "text-destructive" : "text-warning",
                    )}
                  >
                    {dbm(w.signal)}
                  </span>
                  <span className="monitor-chip justify-self-start">{bandLabel(w.band)}</span>
                  <span className="text-fg-secondary truncate font-mono text-[12px]">
                    {w.currentCap}
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      w.recommendCap ? "text-fg-secondary" : "text-muted-foreground",
                    )}
                  >
                    {w.recommendCap ? `${w.recommendCap} +${w.gainDb ?? 0} dB` : "Coverage gap"}
                  </span>
                  <span>
                    {w.recommendCap && (
                      <WriteButton
                        label="Steer"
                        run={() =>
                          void runApply(
                            "/api/capsman/apply/steer",
                            { device, mac: w.mac, mode: "hard" },
                            `Steer ${w.mac}`,
                            reload,
                          )
                        }
                        dialog={{
                          title: `Steer ${w.mac} to ${w.recommendCap}?`,
                          description:
                            "Rejects the client on its current radio so it reconnects to the stronger one.",
                          note: "The client may drop for a moment. It decides where to go; RouterOS can only ask.",
                          action: "Steer client",
                        }}
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </MonitorPanel>
      </div>

      {series.length > 0 && (
        <MonitorPanel
          title="Client load per radio"
          description={`Associated clients, sampled every 5 minutes over the last ${days === 1 ? "day" : `${days} days`}.`}
        >
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-2">
            {series.map((s) => (
              <Sparkline key={`${s.cap}/${s.radioId}`} s={s} />
            ))}
          </div>
        </MonitorPanel>
      )}

      <p className="monitor-note text-fg-secondary">
        Every change asks you to confirm, then applies to the router right away. Steering asks the
        client to move; the client decides.
      </p>
    </div>
  );
}

/** One radio's client count over time, as on the board: area plus line. */
function Sparkline({ s }: { s: RadioSeries }): ReactNode {
  const values = s.points.map((p) => p.clients);
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 230 / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${Math.round(i * step)} ${Math.round(42 - (v / max) * 38)}`);
  const line = pts.length > 0 ? `M${pts.join(" L")}` : "";
  const color =
    s.band === "5ghz"
      ? "var(--success)"
      : s.band === "2ghz"
        ? "var(--warning)"
        : "var(--muted-foreground)";
  const name = `${s.cap}/${s.radioId}`;
  return (
    <div className="bg-overlay-02 flex flex-col gap-1.5 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="monitor-chip">{bandLabel(s.band)}</span>
        <span className="text-foreground truncate font-mono text-[12px]">{name}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground text-[12px] whitespace-nowrap tabular-nums">
          peak {s.peak} · avg {s.avg}
        </span>
      </div>
      <svg
        viewBox="0 0 230 44"
        width="100%"
        height={44}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Clients on ${name} over time`}
      >
        {line && (
          <>
            <path d={`${line} L230 44 L0 44 Z`} fill={color} opacity={0.15} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}
