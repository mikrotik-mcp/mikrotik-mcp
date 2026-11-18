/**
 * Network → CAPsMAN: the Wi-Fi access points one router manages, after the
 * Net-Capsman and Net-Capsman-Confirm boards.
 *
 * Reads /api/capsman/manager|overview|clients|audit|trends for the chosen
 * router and shows the manager switch, a per-floor coverage grid (co-channel
 * overlaps marked), roaming and HA findings, weak-signal clients with a better
 * AP, and client load per radio. Every write names the router, asks for
 * confirmation in a dialog first, and reloads the data afterwards.
 */
import "./monitoring.css";
import "./capsman.css";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Lock,
  Power,
  RefreshCw,
  Shield,
  Wifi,
  Zap,
} from "lucide-react";
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
  MonitorNote,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  StatusBadge,
  useLineDraw,
} from "./monitoring-ui";
import { sparkPoints } from "./signal-charts";
import { DetailList, LineHover, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import type { TipCard } from "./kit";
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

/** What the header needs from the fabric data. */
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
/** The risk pill per severity: pink for high and critical, amber for medium. */
const SEV_RISK: Record<Severity, string | undefined> = {
  critical: "destructive",
  high: "destructive",
  medium: "write",
  low: undefined,
};

const bandLabel = (b: Band): string => (b === "2ghz" ? "2.4G" : b === "5ghz" ? "5G" : "?");
const dbm = (v: number): string => `${v < 0 ? "−" : ""}${Math.abs(v)} dBm`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const categoryLabel = (c: string): string => (c === "ft" ? "roaming" : c === "ha" ? "HA" : c);

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
 * The confirm dialog every CAPsMAN write uses (board "Net-Capsman-Confirm"):
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
          <MonitorButton
            size="sm"
            variant="primary"
            disabled={busy}
            icon={<Check aria-hidden="true" />}
            onClick={onConfirm}
          >
            {action}
          </MonitorButton>
        </>
      }
    >
      <div className="monitor-dialog-body flex flex-col gap-4">
        {changes}
        {note != null && (
          <MonitorNote
            tone={noteTone === "warn" ? "warn" : undefined}
            icon={noteTone === "warn" ? <AlertTriangle aria-hidden="true" /> : undefined}
          >
            {note}
          </MonitorNote>
        )}
        <p className="monitor-hint flex items-start gap-2">
          <Shield aria-hidden="true" className="size-4 shrink-0" />
          <span>{footnote}</span>
        </p>
      </div>
    </MonitorDialog>
  );
}

/** A button that opens a ConfirmWrite and runs `run` on confirm. */
function WriteButton({
  label,
  icon,
  dialog,
  run,
  open: openProp,
  onOpenChange,
}: {
  label: string;
  icon?: ReactNode;
  dialog: Omit<Parameters<typeof ConfirmWrite>[0], "open" | "onOpenChange" | "onConfirm">;
  run: () => void;
  /** Set both to open the dialog from elsewhere too (a row menu). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  return (
    <>
      <MonitorButton size="sm" icon={icon} onClick={() => setOpen(true)}>
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

  let eyebrow: string | undefined;
  let heading: ReactNode;
  if (fabricFailed) {
    eyebrow = `CAPsMAN · ${device}`;
    heading = <em>Could not read CAPsMAN data.</em>;
  } else if (summary) {
    const issues = summary.cochannel + summary.findings;
    eyebrow = `CAPsMAN · read ${hhmm(summary.at)} from ${device}`;
    heading =
      issues > 0 ? (
        <span className="w">
          {plural(summary.cochannel, "co-channel pair", "co-channel pairs")},{" "}
          {plural(summary.findings, "finding", "findings")}.
        </span>
      ) : summary.radios > 0 ? (
        <span className="s">No co-channel pairs or findings.</span>
      ) : (
        "No managed radios."
      );
  } else if (device) {
    eyebrow = `CAPsMAN · reading ${device}`;
  }

  return (
    <section className="capsman grid min-w-0 content-start gap-[18px] max-sm:gap-3.5">
      <PageIntro
        eyebrow={eyebrow}
        heading={heading}
        lead="Wi-Fi access points managed by one router: coverage, load, weak clients, roaming and failover."
        actions={
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
                icon={<RefreshCw aria-hidden="true" />}
                disabled={busy || !device}
                onClick={() => setRefresh((r) => r + 1)}
              >
                Refresh
              </MonitorButton>
            </>
          ) : undefined
        }
      />

      {error ? (
        <MonitorNote tone="bad" icon={<AlertTriangle aria-hidden="true" />}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">
              <b className="text-foreground font-medium">Routers unavailable.</b> {error}
            </span>
            <MonitorButton size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </MonitorButton>
          </div>
        </MonitorNote>
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

  const hint = (
    <span className="capsman-manager-hint monitor-hint">
      The controller service on {device}. Turning it on or off leaves local Wi-Fi, CAP mode and
      provisioning alone. Each change takes a snapshot, runs in Safe Mode, then checks the manager
      state.
    </span>
  );
  const mark = (
    <span aria-hidden="true" className="capsman-mark">
      <Wifi />
    </span>
  );
  const turningOff = selected?.enabled === true;
  return (
    <section className="monitor-panel capsman-manager" aria-label="Manager">
      {error && (
        <MonitorNote tone="bad" icon={<AlertTriangle aria-hidden="true" />}>
          <b className="text-foreground font-medium">Manager status needs a refresh.</b> {error}
        </MonitorNote>
      )}
      {loading ? (
        <div className="capsman-manager-row">
          {mark}
          <span role="status" className="capsman-manager-name">
            <span className="text-foreground text-[14px] font-semibold">Manager</span>
            <span className="text-muted-foreground text-[12px]">Reading manager status…</span>
          </span>
          {hint}
        </div>
      ) : !error && managers.length === 0 ? (
        <div className="capsman-manager-row">
          {mark}
          <span className="capsman-manager-name">
            <span className="text-foreground text-[14px] font-semibold">
              Not supported on this router
            </span>
            <span className="text-muted-foreground text-[12px]">
              No CAPsMAN manager found. Check the installed RouterOS packages.
            </span>
          </span>
        </div>
      ) : (
        managers.map((manager) => (
          <div key={manager.path} className="capsman-manager-row">
            {mark}
            <span className="capsman-manager-name">
              <span className="text-foreground truncate text-[14px] font-semibold">
                Manager · {manager.label}
              </span>
              <span className="text-muted-foreground truncate font-mono text-[12px]">
                {manager.path}
              </span>
            </span>
            <StatusBadge tone={error ? "warn" : manager.enabled ? "good" : "default"}>
              {error ? "Refresh required" : manager.enabled ? "Enabled" : "Disabled"}
            </StatusBadge>
            {hint}
            <span className="flex-1 max-md:hidden" />
            <MonitorButton
              size="sm"
              icon={<Power aria-hidden="true" />}
              disabled={busy || !!error}
              onClick={() => setSelected(manager)}
            >
              {busy ? "Applying…" : manager.enabled ? "Disable" : "Enable"}
            </MonitorButton>
          </div>
        ))
      )}
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
    </section>
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
  // Weak-client row drawer and the Steer confirm, by client MAC.
  const [weakOpen, setWeakOpen] = useState<string | null>(null);
  const [steer, setSteer] = useState<string | null>(null);
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
  const categories = [...new Set(findings.map((f) => categoryLabel(f.category)))];
  const series = trends?.series ?? [];
  const days = trends?.days ?? 1;

  return (
    <div className="flex flex-col gap-[18px] max-sm:gap-3.5">
      {!overview.managerEnabled && (
        <MonitorNote>
          This router reports no active manager for this Wi-Fi stack. Its own radios may still show
          below; the Manager panel has the checked status.
        </MonitorNote>
      )}

      <MetricStrip label="CAPsMAN counts" minCell={150}>
        <Metric label="CAPs" value={overview.totals.caps} hint="managed access points" />
        <Metric
          label="Radios"
          value={overview.totals.radios}
          hint={flooredCount > 0 ? `across ${plural(flooredCount, "floor", "floors")}` : undefined}
        />
        <Metric label="Clients" tone="good" value={overview.totals.clients} hint="associated now" />
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
                icon={<Zap aria-hidden="true" />}
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
                      <div className="glass capsman-changes">
                        <div className="flex items-center px-3 py-2">
                          <span className="capsman-section-label">What changes</span>
                        </div>
                        {moves.map((r) => (
                          <div key={r.radioId} className="capsman-change">
                            <span className="text-foreground truncate font-mono text-[12px]">
                              {r.cap}/{r.radioId}
                            </span>
                            <span className="monitor-chip">{bandLabel(r.band)}</span>
                            <span className="text-fg-secondary text-right font-mono text-[12px] whitespace-nowrap">
                              ch {r.channel ?? "?"} <span className="text-faint">→</span>{" "}
                              <span className="text-success">
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
              icon={<ChevronsUpDown aria-hidden="true" />}
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
          <div className="flex flex-col gap-3.5">
            {floors.map(([floor, radios]) => (
              <div key={floor} className="capsman-floor">
                <div className="capsman-floor-head">
                  <span className="capsman-section-label">
                    {floor === "?" ? "Unfloored" : `Floor ${floor}`}
                  </span>
                  <span className="text-emphasis text-[20px] leading-[21px] font-semibold tabular-nums">
                    {radios.reduce((sum, r) => sum + r.clientCount, 0)}
                  </span>
                  <span className="monitor-hint">clients</span>
                </div>
                <div className="capsman-tiles kit-tips">
                  {radios.map((r) => (
                    <RadioTile
                      key={r.radioId}
                      radio={r}
                      to={overview.proposedChannels[r.radioId]}
                      overlaps={r.conflicts.map((id) => capOf.get(id) ?? id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </MonitorPanel>

      <div className="capsman-pair">
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
                  icon={<Lock aria-hidden="true" />}
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
            <div className="border-line border-t">
              <MonitorEmpty compact title="No findings">
                Roaming and failover checks all pass.
              </MonitorEmpty>
            </div>
          ) : (
            findings.map((f) => (
              <div key={f.finding_id} className="capsman-finding">
                <span className="monitor-risk justify-center" data-risk={SEV_RISK[f.severity]}>
                  {SEV_LABEL[f.severity]}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground text-[13px] font-medium">{f.title}</span>
                  <span className="text-fg-secondary text-[12px]">{f.detail}</span>
                  <span className="text-[12px]">
                    <span className="text-success">→ {f.recommendation}</span>{" "}
                    <span className="text-faint">
                      · {categoryLabel(f.category)} · {f.confidence} confidence
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
            <div className="border-line border-t">
              <MonitorEmpty compact title="No weak clients">
                Every client hears its access point well.
              </MonitorEmpty>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[520px]">
                <div className="monitor-thead capsman-weak-cols">
                  <span>Client</span>
                  <span className="text-right">Signal</span>
                  <span>Band</span>
                  <span>Current AP</span>
                  <span>Better AP</span>
                  <span />
                  <span />
                </div>
                {weak.map((w) => {
                  const better = w.recommendCap
                    ? `${w.recommendCap} +${w.gainDb ?? 0} dB`
                    : "Coverage gap";
                  return (
                    <RowMenu
                      key={w.mac}
                      title={w.mac}
                      sub={`${dbm(w.signal)} · ${w.currentCap}`}
                      onOpen={() => setWeakOpen(w.mac)}
                      cells={{
                        client: { value: w.mac, kind: "id" },
                        signal: { value: dbm(w.signal) },
                        band: { value: bandLabel(w.band) },
                        current: { value: w.currentCap, kind: "router" },
                        better: { value: better, copy: !!w.recommendCap },
                      }}
                      copies={[{ label: "Client MAC", value: w.mac }]}
                      row={w}
                      actions={
                        w.recommendCap
                          ? [
                              {
                                label: `Steer to ${w.recommendCap}…`,
                                onSelect: () => setSteer(w.mac),
                              },
                            ]
                          : undefined
                      }
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`${w.mac}, ${dbm(w.signal)}`}
                        className="monitor-row capsman-weak-cols"
                        data-selected={weakOpen === w.mac || undefined}
                        onClick={() => setWeakOpen(w.mac)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setWeakOpen(w.mac);
                          }
                        }}
                      >
                        <span data-col="client" className="p truncate font-mono text-[12px]">
                          {w.mac}
                        </span>
                        <span
                          data-col="signal"
                          className={cn(
                            "text-right font-mono text-[12px] whitespace-nowrap",
                            w.signal < -75 ? "text-destructive" : "text-warning",
                          )}
                        >
                          {dbm(w.signal)}
                        </span>
                        <span data-col="band">
                          <span className="monitor-chip">{bandLabel(w.band)}</span>
                        </span>
                        <span
                          data-col="current"
                          className="text-fg-secondary truncate font-mono text-[12px]"
                        >
                          {w.currentCap}
                        </span>
                        <span
                          data-col="better"
                          className={cn(
                            "truncate text-[12px]",
                            w.recommendCap ? "text-success" : "text-warning",
                          )}
                        >
                          {better}
                        </span>
                        <span
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {w.recommendCap && (
                            <WriteButton
                              label="Steer"
                              open={steer === w.mac}
                              onOpenChange={(o) => setSteer(o ? w.mac : null)}
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
                        <RowMore />
                      </div>
                    </RowMenu>
                  );
                })}
              </div>
            </div>
          )}
          <div className="monitor-foot">
            <span>
              Steer rejects the client on its current radio so it reconnects to the stronger one.
              The client decides where to go.
            </span>
          </div>
        </MonitorPanel>
        {(() => {
          const at = weak.findIndex((w) => w.mac === weakOpen);
          const w = at >= 0 ? weak[at]! : null;
          if (!w) return null;
          return (
            <RowDrawer
              open
              onClose={() => setWeakOpen(null)}
              label={`Client details: ${w.mac}`}
              status={{
                tone: w.signal < -75 ? "bad" : "warn",
                label: `Weak signal · ${dbm(w.signal)}`,
              }}
              title={w.mac}
              meta={`${w.currentCap} · ${bandLabel(w.band)}`}
              rowKey={w.mac}
              nav={{
                index: at,
                total: weak.length,
                onPrev: at > 0 ? () => setWeakOpen(weak[at - 1]!.mac) : undefined,
                onNext: at < weak.length - 1 ? () => setWeakOpen(weak[at + 1]!.mac) : undefined,
              }}
              storageKey="capsman-weak"
              primary={
                w.recommendCap ? (
                  <MonitorButton size="sm" onClick={() => setSteer(w.mac)}>
                    Steer
                  </MonitorButton>
                ) : undefined
              }
            >
              <DetailList
                items={[
                  { label: "Client", value: w.mac, mono: true },
                  { label: "Signal", value: dbm(w.signal), mono: true },
                  { label: "Band", value: bandLabel(w.band) },
                  { label: "Current AP", value: w.currentCap, mono: true },
                  { label: "Radio", value: w.currentRadio, mono: true },
                  {
                    label: "Better AP",
                    value: w.recommendCap
                      ? `${w.recommendCap} +${w.gainDb ?? 0} dB`
                      : "Coverage gap",
                  },
                ]}
              />
            </RowDrawer>
          );
        })()}
      </div>

      {series.length > 0 && (
        <MonitorPanel
          title="Client load per radio"
          description={`Associated clients, sampled every 5 minutes over the last ${days === 1 ? "day" : `${days} days`}.`}
          extra={
            <span className="monitor-legend">
              <span>
                <i className="bg-sig" />
                5G
              </span>
              <span>
                <i className="bg-warning" />
                2.4G
              </span>
            </span>
          }
        >
          <LoadGrid series={series} />
        </MonitorPanel>
      )}

      <p className="monitor-hint">
        Every change asks you to confirm, then applies to the router right away. Steering asks the
        client to move; the client decides.
      </p>
    </div>
  );
}

/**
 * One radio on the coverage grid: tinted by load, pink when its channel
 * overlaps a neighbour, amber when busy.
 */
function RadioTile({
  radio: r,
  to,
  overlaps,
}: {
  radio: RadioNode;
  to: number | undefined;
  overlaps: string[];
}): ReactNode {
  const co = overlaps.length > 0;
  const load = radioLoad(r);
  const cpu = r.cpuLoad;
  const busy = cpu != null && cpu >= 60;
  const tint = co ? "var(--destructive)" : load > 0.6 || busy ? "var(--warning)" : "var(--sig)";
  const mix = co ? 14 : load > 0.6 || busy ? 12 : Math.round(4 + load * 12);
  const ring = co
    ? "color-mix(in srgb, var(--destructive) 45%, transparent)"
    : load > 0.6 || busy
      ? "color-mix(in srgb, var(--warning) 35%, transparent)"
      : "var(--line)";
  const style = {
    background: `color-mix(in srgb, ${tint} ${mix}%, transparent)`,
    boxShadow: `inset 0 0 0 1px ${ring}`,
  } as CSSProperties;
  return (
    <div
      className="capsman-tile"
      style={style}
      aria-label={`${r.cap} · ${plural(r.adjacent.length, "neighbour", "neighbours")}`}
      {...tipProps(() => ({
        title: `${r.cap}/${r.radioId}`,
        sub: bandLabel(r.band),
        led: co ? "bad" : load > 0.6 || busy ? "warn" : "ok",
        rows: [
          {
            label: "Channel",
            value:
              to != null && to !== r.channel
                ? `${r.channel ?? "?"} → ${to}`
                : String(r.channel ?? "?"),
          },
          { label: "Clients", value: r.clientCount },
          { label: "CPU", value: cpu != null ? `${cpu}%` : "—" },
          ...(r.memUsedPct != null ? [{ label: "Memory", value: `${r.memUsedPct}%` }] : []),
          { label: "Neighbours", value: r.adjacent.length },
          { label: "Load", value: `${Math.round(load * 100)}%`, color: tint },
        ],
        foot: co
          ? { label: "Overlaps", value: overlaps.join(", ") }
          : { label: "Overlaps", value: "none" },
      }))}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-foreground truncate font-mono text-[13px] font-medium">{r.cap}</span>
        <span className="text-faint shrink-0 font-mono text-[12px]">/{r.radioId}</span>
        <span className="flex-1" />
        <span className="monitor-chip">{bandLabel(r.band)}</span>
      </div>
      <div className="text-fg-secondary flex items-baseline gap-2 text-[12px] whitespace-nowrap">
        <span className="text-foreground font-mono text-[14px]">
          ch {r.channel ?? "?"}
          {to != null && to !== r.channel && <span className="text-success"> → {to}</span>}
        </span>
        <span className="flex-1" />
        <span>{plural(r.clientCount, "client", "clients")}</span>
      </div>
      <span className="monitor-bar" aria-hidden="true">
        <span
          data-tone={co ? "bad" : busy ? "warn" : "good"}
          style={{ width: `${Math.round(load * 100)}%` }}
        />
      </span>
      <div className="flex items-center gap-2 text-[12px] whitespace-nowrap">
        {co ? (
          <span className="text-destructive truncate">Overlaps {overlaps.join(", ")}</span>
        ) : (
          <span className="text-faint">No overlap</span>
        )}
        <span className="flex-1" />
        <span className={busy ? "text-warning" : "text-muted-foreground"}>
          CPU {cpu != null ? `${cpu}%` : "—"}
        </span>
      </div>
    </div>
  );
}

/** Client count per radio over time; lines draw in from the left. */
function LoadGrid({ series }: { series: RadioSeries[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLineDraw(ref, series.map((s) => `${s.cap}/${s.radioId}:${s.points.length}`).join("|"));
  return (
    <div ref={ref} className="capsman-trends">
      {series.map((s) => (
        <RadioSpark key={`${s.cap}/${s.radioId}`} s={s} />
      ))}
    </div>
  );
}

const SPARK_W = 230;
const SPARK_H = 40;

/** One radio's client count: area plus line, teal for 5G and amber for 2.4G. */
function RadioSpark({ s }: { s: RadioSeries }): ReactNode {
  const values = s.points.map((p) => p.clients);
  const points = values.length > 1 ? sparkPoints(values, SPARK_W, SPARK_H) : [];
  const line = points.length > 0 ? `M${points.map(([x, y]) => `${x},${y}`).join(" L")}` : "";
  const five = s.band === "5ghz";
  const color = five ? "var(--sig)" : s.band === "2ghz" ? "var(--warning)" : "var(--text-faint)";
  const fill = five ? "var(--sig-fill)" : "var(--warn-soft)";
  const name = `${s.cap}/${s.radioId}`;
  return (
    <div className="glass capsman-spark">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="monitor-chip">{bandLabel(s.band)}</span>
        <span className="text-fg-secondary flex-1 truncate font-mono">{name}</span>
        <span className="text-faint flex-none whitespace-nowrap">
          peak {s.peak} · avg {s.avg}
        </span>
      </div>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width="100%" height={SPARK_H}>
        {line && (
          <>
            <path d={`${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`} fill={fill} />
            <path
              data-draw
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
            <LineHover
              width={SPARK_W}
              height={SPARK_H}
              points={points}
              band={12}
              color={color}
              label={`Clients on ${name} over time`}
              card={(i): TipCard => {
                const p = s.points[i]!;
                const before = s.points[i - 1];
                const d = before ? p.clients - before.clients : null;
                return {
                  title: new Date(p.ts).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  }),
                  sub: name,
                  rows: [
                    { label: "Clients", value: p.clients, color },
                    { label: "Channel", value: p.channel ?? "—" },
                  ],
                  foot:
                    d == null
                      ? { label: "Peak", value: s.peak }
                      : {
                          label: "vs previous sample",
                          value: d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`,
                          tone: d > 0 ? "up" : d < 0 ? "down" : undefined,
                        },
                };
              }}
            />
          </>
        )}
      </svg>
    </div>
  );
}
