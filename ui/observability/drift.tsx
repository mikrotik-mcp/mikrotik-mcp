/**
 * Drift Guard (the Cfg-Drift board): fleet-wide golden-config drift. One card
 * per router, a detail panel with the score, the sections that moved, who
 * moved them (from the router log) and the unified diff, and the baselines
 * each router is checked against. Setting a baseline opens a dialog
 * (Cfg-Drift-SetBaseline).
 */
import "./drift.css";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Archive, Check, ChevronDown, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api, deleteJson, postJson } from "./api";
import { DiffPre, ScoreRing } from "./config-charts";
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
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type {
  DriftAttribution,
  DriftBaseline,
  DriftDeviceStatus,
  DriftReport,
  DriftSection,
} from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  return new Date(ms).toLocaleString();
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortSha(sha: string): string {
  return sha.length > 10 ? `${sha.slice(0, 4)}…${sha.slice(-4)}` : sha;
}

type Status = DriftDeviceStatus["status"];
const STATUS_TONE: Record<Status, Tone> = {
  "in-sync": "good",
  drifted: "warn",
  unknown: "bad",
  "no-baseline": "default",
};
const STATUS_LABEL: Record<Status, string> = {
  "in-sync": "In sync",
  drifted: "Drifted",
  unknown: "Unknown",
  "no-baseline": "No baseline",
};

// ── Set baseline dialog ─────────────────────────────────────────────────────

interface SnapshotMeta {
  id: string;
  ts: number;
  label?: string;
  lines: number;
  bytes: number;
  sha: string;
}

function SetBaselineDialog({
  device,
  onClose,
  onDone,
}: {
  device: string;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [selected, setSelected] = useState("");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api<{ device: string; snapshots: SnapshotMeta[] }>(
      `/api/drift/history/${encodeURIComponent(device)}?limit=20`,
    )
      .then((r) => {
        setSnapshots(r.snapshots);
        if (r.snapshots.length > 0) setSelected(r.snapshots[0]!.id);
      })
      .catch(() => setSnapshots([]));
  }, [device]);

  const submit = async (): Promise<void> => {
    if (!selected) return;
    setLoading(true);
    setMsg("");
    const res = await postJson<{ ok?: boolean; error?: string }>("/api/drift/baseline", {
      device,
      snapshotId: selected,
      label: label || undefined,
    });
    setLoading(false);
    if (res.ok) {
      toast.success("Baseline set");
      onDone();
    } else {
      const err = res.error ?? "Failed";
      setMsg(err);
      toast.error(err);
    }
  };

  return (
    <MonitorDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Set baseline for ${device}`}
      description="Drift checks compare the live config against this snapshot."
      dismissible={false}
      closeDisabled={loading}
      footer={
        <>
          <MonitorButton variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </MonitorButton>
          <span className="flex-1" />
          <MonitorButton
            variant="primary"
            icon={<Check aria-hidden="true" />}
            disabled={loading || !selected}
            aria-busy={loading || undefined}
            onClick={() => void submit()}
          >
            {loading ? "Setting…" : "Set as baseline"}
          </MonitorButton>
        </>
      }
    >
      <div className="drift-dialog flex flex-col gap-4">
        <div className="monitor-fl">
          <span className="monitor-label">Baseline snapshot</span>
          {snapshots === null ? (
            <LoadingState label="Loading snapshots" layout="form" />
          ) : snapshots.length === 0 ? (
            <span className="monitor-hint">
              No snapshots for this router. Capture one with capture_config_snapshot first.
            </span>
          ) : (
            <span className="monitor-select drift-select">
              <Archive aria-hidden="true" className="drift-select-icon" />
              <select
                aria-label="Baseline snapshot"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {[device, s.label ?? s.id, shortDate(s.ts), size(s.bytes)].join(" · ")}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" />
            </span>
          )}
          <span className="monitor-hint">
            Pick a known-good export. Capture one with capture_config_snapshot if the list is empty.
          </span>
        </div>
        <label className="monitor-fl">
          <span className="monitor-label">Label (optional)</span>
          <input
            className="monitor-input"
            placeholder="golden-7.16"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <MonitorNote>
          Setting a baseline replaces the old one. Nothing on the router changes.
        </MonitorNote>
        {msg && <span className="monitor-err">{msg}</span>}
      </div>
    </MonitorDialog>
  );
}

// ── Detail parts ────────────────────────────────────────────────────────────

function SectionBars({ sections }: { sections: DriftSection[] }): ReactNode {
  const max = Math.max(1, ...sections.map((s) => s.added + s.removed));
  return (
    <>
      {sections.map((s) => (
        <div key={s.path} className="drift-section" title={s.hunks}>
          <span className="mono trunc text-fg-secondary">{s.path}</span>
          <span className="drift-section-bars">
            {s.added > 0 && (
              <span className="monitor-bar" style={{ flex: s.added }}>
                <span data-tone="good" />
              </span>
            )}
            {s.removed > 0 && (
              <span className="monitor-bar" style={{ flex: s.removed }}>
                <span data-tone="bad" />
              </span>
            )}
            <span style={{ flex: max - s.added - s.removed }} />
          </span>
          <span className="mono">
            <span className="text-success">+{s.added}</span>{" "}
            <span className="text-destructive">−{s.removed}</span>
          </span>
        </div>
      ))}
    </>
  );
}

function Attribution({ rows }: { rows: DriftAttribution[] }): ReactNode {
  return (
    <>
      <div className="monitor-thead drift-attr">
        <span>Time</span>
        <span>User</span>
        <span>Action</span>
        <span>Section</span>
        <span>Log</span>
      </div>
      {rows.map((a, i) => (
        <div key={`${a.section}-${i}`} className="monitor-row drift-attr">
          <span className="mono trunc text-muted-foreground">{a.timestamp ?? "—"}</span>
          <span className="mono trunc">{a.user ?? "—"}</span>
          <span className="trunc">{a.action ?? "—"}</span>
          <span className="mono trunc">{a.section}</span>
          <span className="mono trunc" title={a.logLine}>
            {a.logLine}
          </span>
        </div>
      ))}
    </>
  );
}

function DeviceDetail({
  device,
  report,
  onReport,
  onClose,
  onChanged,
}: {
  device: string;
  report: DriftReport | undefined;
  onReport: (r: DriftReport) => void;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api<DriftReport | { error: string }>(
        `/api/drift/check/${encodeURIComponent(device)}`,
      );
      if ("error" in r) setError(r.error);
      else onReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [device, onReport]);

  const promote = async (): Promise<void> => {
    const res = await postJson<{ ok?: boolean; error?: string }>("/api/drift/baseline", {
      device,
      snapshotId: report?.baselineId,
      label: "promoted",
    });
    if (res.error) {
      toast.error(res.error);
    } else {
      toast.success("Drift promoted");
      onChanged();
    }
  };

  const remove = async (): Promise<void> => {
    await deleteJson<{ ok?: boolean }>(`/api/drift/baseline/${encodeURIComponent(device)}`, {});
    toast.success("Baseline removed");
    onChanged();
  };

  const drifted = report !== undefined && !report.identical;

  return (
    <MonitorPanel
      title={`${device} · drift detail`}
      description="Live export compared with the golden baseline."
      flush
      extra={
        <div className="flex flex-wrap items-center gap-2">
          <MonitorButton
            variant="primary"
            size="sm"
            icon={<RefreshCw aria-hidden="true" />}
            disabled={loading}
            aria-busy={loading || undefined}
            onClick={() => void check()}
          >
            {loading ? "Checking…" : "Check now"}
          </MonitorButton>
          <MonitorButton
            variant="ghost"
            size="sm"
            icon={<Trash2 aria-hidden="true" />}
            onClick={() => void remove()}
          >
            Remove baseline
          </MonitorButton>
          <MonitorButton
            variant="ghost"
            size="sm"
            icon={<X aria-hidden="true" />}
            onClick={onClose}
          >
            Close
          </MonitorButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-[18px] pb-4">
        {error && (
          <MonitorNote tone="bad" role="alert">
            {error}
          </MonitorNote>
        )}
        {loading && !report && <LoadingState label="Checking drift" layout="cards" />}
        {!report && !loading && !error && (
          <MonitorEmpty compact title="Not checked yet">
            Press Check now to compare the live config with the golden baseline.
          </MonitorEmpty>
        )}
        {report && (
          <div className="glass drift-summary">
            <ScoreRing
              value={drifted ? report.score : 100}
              size={54}
              stroke={5}
              fontSize={14}
              tone={drifted ? "warn" : "good"}
              label={`Drift score ${report.score} of 100`}
            >
              {report.score}
            </ScoreRing>
            <div className="flex flex-col gap-0.5">
              <b className={`text-[15px] ${drifted ? "text-warning" : "text-success"}`}>
                {drifted ? "Drifted" : "In sync"}
              </b>
              <span className="monitor-hint">score {report.score}/100</span>
            </div>
            <span className="mono big text-success">+{report.summary.added}</span>
            <span className="mono big text-destructive">−{report.summary.removed}</span>
            <span className="text-[12px] text-muted-foreground">
              {report.summary.unchanged} unchanged
            </span>
            <span className="flex-1" />
            <span className="monitor-hint" title={clock(report.capturedAt)}>
              Checked {hhmm(report.capturedAt)}
            </span>
            {drifted && (
              <MonitorButton
                size="sm"
                icon={<Check aria-hidden="true" />}
                onClick={() => void promote()}
              >
                Promote as baseline
              </MonitorButton>
            )}
          </div>
        )}
        {report && report.sections.length > 0 && (
          <div className="monitor-fl">
            <span className="monitor-label">Sections with drift</span>
            <SectionBars sections={report.sections} />
          </div>
        )}
      </div>
      {report && report.attributions.length > 0 && (
        <>
          <div className="px-[18px] pb-1.5">
            <span className="monitor-label">Change attribution · from the router log</span>
          </div>
          <Attribution rows={report.attributions} />
        </>
      )}
      {drifted && (
        <div className="drift-diff-block">
          <span className="monitor-label">Unified diff</span>
          <DiffPre text={report.unified} className="drift-diff" />
        </div>
      )}
    </MonitorPanel>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

function FleetCard({
  d,
  selected,
  report,
  onPick,
  onSetBaseline,
}: {
  d: DriftDeviceStatus;
  selected: boolean;
  report: DriftReport | undefined;
  onPick: () => void;
  onSetBaseline: () => void;
}): ReactNode {
  const tone = STATUS_TONE[d.status];
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={tone} />
          <span className="mono trunc text-foreground">{d.device}</span>
        </span>
        <span className="flex-1" />
        <StatusBadge tone={tone} dot={false} quiet={tone === "default"}>
          {STATUS_LABEL[d.status]}
        </StatusBadge>
      </div>
      <div className="drift-card-lines">
        {d.baseline ? (
          <>
            Baseline: {ago(d.baseline.setAt)}
            {d.baseline.label && (
              <>
                <br />
                Label: {d.baseline.label}
              </>
            )}
            {d.error && (
              <>
                <br />
                <span className="text-destructive">{d.error}</span>
              </>
            )}
          </>
        ) : (
          "Nothing to compare against yet."
        )}
      </div>
      {d.status === "in-sync" && (
        <span className="monitor-bar">
          <span data-tone="good" style={{ width: "100%" }} />
        </span>
      )}
      {d.status === "drifted" && report && !report.identical && (
        <span className="monitor-bar">
          <span data-tone="warn" style={{ width: `${Math.max(2, report.score)}%` }} />
        </span>
      )}
    </>
  );
  if (d.status === "no-baseline")
    return (
      <div className="glass drift-card">
        {body}
        <span>
          <MonitorButton size="sm" icon={<Plus aria-hidden="true" />} onClick={onSetBaseline}>
            Set baseline
          </MonitorButton>
        </span>
      </div>
    );
  return (
    <button
      type="button"
      className="glass drift-card"
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onPick}
    >
      {body}
    </button>
  );
}

export function DriftView(): ReactNode {
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<DriftDeviceStatus[]>([]);
  const [baselines, setBaselines] = useState<DriftBaseline[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [showSetBaseline, setShowSetBaseline] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, DriftReport>>({});
  const [error, setError] = useState("");

  const load = useCallback(() => {
    return Promise.all([
      api<{ devices: DriftDeviceStatus[] }>("/api/drift/status"),
      api<{ baselines: DriftBaseline[] }>("/api/drift/baselines"),
    ])
      .then(([status, bl]) => {
        setDevices(status.devices);
        setBaselines(bl.baselines);
        setError("");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
  }, [load]);

  const onReport = useCallback((r: DriftReport) => {
    setReports((prev) => ({ ...prev, [r.device]: r }));
  }, []);

  if (initialLoading) return <LoadingState label="Loading drift baselines" />;

  const withBaseline = devices.filter((d) => d.status !== "no-baseline");
  const noBaseline = devices.filter((d) => d.status === "no-baseline");
  const inSync = devices.filter((d) => d.status === "in-sync");
  const drifted = devices.filter((d) => d.status === "drifted");
  const unknown = devices.filter((d) => d.status === "unknown");
  const names = (list: DriftDeviceStatus[]): string => list.map((d) => d.device).join(", ");
  const firstReport = drifted[0] ? reports[drifted[0].device] : undefined;

  const verdict =
    drifted.length === 1 ? (
      <>
        <span className="w">{drifted[0]!.device}</span> has drifted from its baseline.
      </>
    ) : drifted.length > 1 ? (
      <>
        <span className="w">{drifted.length} routers</span> have drifted from their baselines.
      </>
    ) : withBaseline.length === 0 ? (
      "No baselines set yet."
    ) : unknown.length === withBaseline.length ? (
      <>
        <em>No router</em> could be checked.
      </>
    ) : (
      <>
        <span className="s">Every checked router</span> matches its baseline.
      </>
    );

  const leadParts: string[] = [];
  if (firstReport && !firstReport.identical) {
    const changed = firstReport.summary.added + firstReport.summary.removed;
    const top = [...firstReport.sections].sort(
      (a, b) => b.added + b.removed - (a.added + a.removed),
    )[0];
    leadParts.push(
      `${changed} line${changed === 1 ? "" : "s"} changed since ${day(firstReport.baselineTs)}${top ? `, mostly in ${top.path}` : ""}.`,
    );
  }
  if (unknown.length > 0) leadParts.push(`${names(unknown)} could not be checked.`);
  if (leadParts.length === 0)
    leadParts.push("Each router's live config is compared with its golden snapshot.");

  const driftHint = drifted[0]
    ? `${drifted[0].device}${firstReport ? ` · score ${firstReport.score}` : ""}${drifted.length > 1 ? ` +${drifted.length - 1}` : ""}`
    : "none";

  return (
    <section className="drift grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Drift Guard · golden baselines"
        verdict={verdict}
        lead={leadParts.join(" ")}
      />

      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}

      <MetricStrip label="Drift counts">
        <Metric label="Devices" value={String(devices.length)} hint="in the fleet" />
        <Metric
          label="With baseline"
          value={String(withBaseline.length)}
          hint={
            noBaseline.length === 0
              ? "all have one"
              : `${names(noBaseline)} ${noBaseline.length === 1 ? "has" : "have"} none`
          }
        />
        <Metric
          label="In sync"
          value={String(inSync.length)}
          hint={inSync.length > 0 ? names(inSync) : "none"}
          tone={inSync.length > 0 ? "good" : "default"}
        />
        <Metric
          label="Drifted"
          value={String(drifted.length)}
          hint={driftHint}
          tone={drifted.length > 0 ? "warn" : "default"}
        />
      </MetricStrip>

      <MonitorPanel title="Fleet" description="Pick a router to see what changed.">
        {devices.length === 0 ? (
          <MonitorEmpty compact title="No routers yet">
            Add a router to start using Drift Guard.
          </MonitorEmpty>
        ) : (
          <div className="drift-fleet">
            {devices.map((d) => (
              <FleetCard
                key={d.device}
                d={d}
                selected={selectedDevice === d.device}
                report={reports[d.device]}
                onPick={() => setSelectedDevice(d.device)}
                onSetBaseline={() => setShowSetBaseline(d.device)}
              />
            ))}
          </div>
        )}
      </MonitorPanel>

      {selectedDevice && (
        <DeviceDetail
          device={selectedDevice}
          report={reports[selectedDevice]}
          onReport={onReport}
          onClose={() => setSelectedDevice(null)}
          onChanged={() => {
            setSelectedDevice(null);
            void load();
          }}
        />
      )}

      {baselines.length > 0 && (
        <MonitorPanel
          title="Baselines"
          description="The golden snapshot each router is checked against."
          flush
        >
          <div className="monitor-thead drift-base">
            <span>Device</span>
            <span>Snapshot</span>
            <span>Set at</span>
            <span>Set by</span>
            <span>Label</span>
            <span>Size</span>
            <span>SHA</span>
          </div>
          {baselines.map((b) => {
            const status = devices.find((d) => d.device === b.device)?.status ?? "unknown";
            return (
              <button
                key={b.device}
                type="button"
                className="monitor-row drift-base"
                data-selected={selectedDevice === b.device || undefined}
                aria-pressed={selectedDevice === b.device}
                onClick={() => setSelectedDevice(b.device)}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <StatusDot tone={STATUS_TONE[status]} />
                  <span className="mono p trunc">{b.device}</span>
                </span>
                <span className="mono trunc">{b.snapshotId}</span>
                <span className="mono trunc text-muted-foreground" title={clock(b.setAt)}>
                  {shortDate(b.setAt)}
                </span>
                <span className="mono trunc">{b.setBy}</span>
                <span className="trunc">{b.label ?? <span className="text-faint">—</span>}</span>
                <span className="mono trunc">
                  {b.snapshot ? size(b.snapshot.bytes) : "deleted"}
                </span>
                <span className="mono trunc text-faint" title={b.snapshot?.sha}>
                  {b.snapshot?.sha ? shortSha(b.snapshot.sha) : "—"}
                </span>
              </button>
            );
          })}
        </MonitorPanel>
      )}

      {showSetBaseline && (
        <SetBaselineDialog
          device={showSetBaseline}
          onClose={() => setShowSetBaseline(null)}
          onDone={() => {
            setShowSetBaseline(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
