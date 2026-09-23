import { UnifiedDiff } from "./diff-view";
/**
 * Drift Guard dashboard view — fleet-wide golden-config drift detection,
 * per-device diff viewer with change attribution, and baseline management.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, deleteJson, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot, Input, Select } from "./geist";
import type { GeistType } from "./geist";
import type {
  DriftAttribution,
  DriftBaseline,
  DriftDeviceStatus,
  DriftReport,
  DriftSection,
} from "./types";
import { toast } from "./toast-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Status → Geist semantic variant, shared by the status badge/dot. */
const STATUS_TYPE: Record<string, GeistType> = {
  "in-sync": "success",
  drifted: "warning",
  unknown: "secondary",
  "no-baseline": "secondary",
};

const STATUS_LABELS: Record<string, string> = {
  "in-sync": "In Sync",
  drifted: "Drifted",
  unknown: "Unknown",
  "no-baseline": "No Baseline",
};

// ── Snapshot picker for setting baselines from the dashboard ─────────────

interface SnapshotMeta {
  id: string;
  ts: number;
  label?: string;
  lines: number;
  bytes: number;
  sha: string;
}

function SetBaselineForm({ device, onDone }: { device: string; onDone: () => void }): ReactNode {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [selected, setSelected] = useState("");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api<{ device: string; snapshots: SnapshotMeta[] }>(
      `/api/drift/history/${encodeURIComponent(device)}?limit=20`,
    ).then((r) => {
      setSnapshots(r.snapshots);
      if (r.snapshots.length > 0) setSelected(r.snapshots[0]!.id);
    });
  }, [device]);

  const submit = async () => {
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

  if (snapshots.length === 0) {
    return (
      <div className="p-2">
        <span className="text-muted-foreground text-[11px]">
          No snapshots for this device. Capture one with capture_config_snapshot first.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      <Select
        value={selected}
        onValueChange={setSelected}
        aria-label="Baseline snapshot"
        className="min-w-[200px] flex-1"
        options={snapshots.map((s) => ({
          value: s.id,
          label: `${s.id} — ${clock(s.ts)} — ${s.lines} lines${s.label ? ` "${s.label}"` : ""}`,
        }))}
      />
      <Input
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-40"
      />
      <Button size="sm" onClick={() => void submit()} disabled={loading || !selected}>
        {loading ? "Setting..." : "Set as Baseline"}
      </Button>
      {msg && <span className="text-destructive text-xs">{msg}</span>}
    </div>
  );
}

// ── Diff viewer ─────────────────────────────────────────────────────────────

const DiffViewer = UnifiedDiff;

// ── Section breakdown bars ──────────────────────────────────────────────────

function SectionBars({ sections }: { sections: DriftSection[] }): ReactNode {
  if (sections.length === 0) return null;
  const maxChanges = Math.max(...sections.map((s) => s.added + s.removed), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {sections.slice(0, 15).map((s) => {
        return (
          <div key={s.path} className="flex items-center gap-2">
            <span className="w-[220px] truncate text-[11px] text-foreground" title={s.path}>
              {s.path}
            </span>
            <div className="flex h-3.5 flex-1 overflow-hidden rounded-[3px] bg-muted">
              {/* Widths are data-driven, so they stay inline. */}
              <div
                className="h-full bg-success"
                style={{ width: `${(s.added / maxChanges) * 100}%` }}
              />
              <div
                className="h-full bg-destructive"
                style={{ width: `${(s.removed / maxChanges) * 100}%` }}
              />
            </div>
            <span className="min-w-[60px] text-[11px] text-muted-foreground">
              +{s.added} -{s.removed}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Attribution table ───────────────────────────────────────────────────────

function AttributionTable({ attributions }: { attributions: DriftAttribution[] }): ReactNode {
  if (attributions.length === 0) {
    return (
      <span className="text-muted-foreground text-[11px]">
        No config-related log entries found.
      </span>
    );
  }
  return (
    <div className="max-h-[250px] overflow-auto">
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Section</TableHead>
            <TableHead>Log</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attributions.map((a, i) => (
            <TableRow key={i}>
              <TableCell className="whitespace-nowrap">{a.timestamp ?? "—"}</TableCell>
              <TableCell>{a.user ?? "—"}</TableCell>
              <TableCell>
                <span className="rounded bg-muted px-1.5 py-px text-[10px]">{a.action ?? "?"}</span>
              </TableCell>
              <TableCell className="max-w-[160px] truncate" title={a.section}>
                {a.section}
              </TableCell>
              <TableCell className="max-w-[300px] truncate text-muted-foreground" title={a.logLine}>
                {a.logLine}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Device detail panel ─────────────────────────────────────────────────────

function DeviceDetail({
  device,
  onClose,
  onChanged,
}: {
  device: string;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api<DriftReport | { error: string }>(
        `/api/drift/check/${encodeURIComponent(device)}`,
      );
      if ("error" in r) {
        setError(r.error);
      } else {
        setReport(r);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [device]);

  const promote = async () => {
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

  const remove = async () => {
    await deleteJson<{ ok?: boolean }>(`/api/drift/baseline/${encodeURIComponent(device)}`, {});
    toast.success("Baseline removed");
    onChanged();
  };

  return (
    <Panel
      title={`${device} — Drift Detail`}
      className="reveal"
      extra={
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void check()} disabled={loading}>
            {loading ? "Checking..." : "Check Now"}
          </Button>
          <Button size="sm" type="error" ghost onClick={() => void remove()}>
            Remove Baseline
          </Button>
          <Button size="sm" type="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {error && <div className="text-destructive">{error}</div>}

      {report && (
        <div>
          {/* Summary bar */}
          <div className="mb-3 flex items-center gap-6 border-b border-border py-3">
            <div className="flex items-center gap-1.5">
              <Dot type={report.identical ? "success" : "warning"} />
              <strong>{report.identical ? "In Sync" : "Drifted"}</strong>
            </div>
            {!report.identical && (
              <>
                <div>
                  Score: <strong>{report.score}</strong>/100
                </div>
                <div className="text-success">+{report.summary.added}</div>
                <div className="text-destructive">-{report.summary.removed}</div>
                <div className="text-muted-foreground text-[11px]">
                  {report.summary.unchanged} unchanged
                </div>
                <Button size="sm" onClick={() => void promote()}>
                  Promote as Baseline
                </Button>
              </>
            )}
            <div className="text-muted-foreground ml-auto text-[11px]">
              Checked: {clock(report.capturedAt)}
            </div>
          </div>

          {/* Section breakdown */}
          {report.sections.length > 0 && (
            <div className="mb-4">
              <h4 className="mt-0 mb-2 text-[13px]">Sections with drift</h4>
              <SectionBars sections={report.sections} />
            </div>
          )}

          {/* Change attribution */}
          {report.attributions.length > 0 && (
            <div className="mb-4">
              <h4 className="mt-0 mb-2 text-[13px]">Change attribution</h4>
              <AttributionTable attributions={report.attributions} />
            </div>
          )}

          {/* Unified diff */}
          {!report.identical && (
            <div>
              <h4 className="mt-0 mb-2 text-[13px]">Unified diff</h4>
              <DiffViewer unified={report.unified} />
            </div>
          )}
        </div>
      )}

      {!report && !loading && !error && (
        <p className="text-muted-foreground text-center text-[11px]">
          Click "Check Now" to run a live drift check against the golden baseline.
        </p>
      )}
    </Panel>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

export function DriftView(): ReactNode {
  const [devices, setDevices] = useState<DriftDeviceStatus[]>([]);
  const [baselines, setBaselines] = useState<DriftBaseline[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [showSetBaseline, setShowSetBaseline] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [status, bl] = await Promise.all([
        api<{ devices: DriftDeviceStatus[] }>("/api/drift/status"),
        api<{ baselines: DriftBaseline[] }>("/api/drift/baselines"),
      ]);
      setDevices(status.devices);
      setBaselines(bl.baselines);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
  }, [load]);

  if (error && devices.length === 0) {
    return (
      <Panel className="reveal">
        <p className="text-destructive">{error}</p>
      </Panel>
    );
  }

  const withBaseline = devices.filter((d) => d.status !== "no-baseline");

  return (
    <>
      {/* Stats row */}
      <div className="reveal grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard k="Devices" v={String(devices.length)} />
        <StatCard k="With Baseline" v={String(withBaseline.length)} />
        <StatCard k="In Sync" v={String(devices.filter((d) => d.status === "in-sync").length)} />
        <StatCard k="Drifted" v={String(devices.filter((d) => d.status === "drifted").length)} />
      </div>

      {/* Fleet overview cards */}
      <Panel title="Fleet Drift Overview" className="reveal">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {devices.map((d) => (
            <div
              key={d.device}
              onClick={() => {
                if (d.status !== "no-baseline") setSelectedDevice(d.device);
              }}
              className={cn(
                "rounded-lg border bg-card p-4 transition-colors",
                selectedDevice === d.device ? "border-brand" : "border-border",
                d.status !== "no-baseline"
                  ? "cursor-pointer hover:border-brand/40"
                  : "cursor-default",
              )}
            >
              <div className="mb-2 flex justify-between">
                <strong className="text-sm">{d.device}</strong>
                <Badge type={STATUS_TYPE[d.status]}>{STATUS_LABELS[d.status]}</Badge>
              </div>
              {d.baseline && (
                <div className="text-muted-foreground text-[11px]">
                  <div>Baseline: {ago(d.baseline.setAt)}</div>
                  {d.baseline.label && <div>Label: {d.baseline.label}</div>}
                </div>
              )}
              {d.status === "no-baseline" && (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSetBaseline(d.device);
                  }}
                >
                  Set Baseline
                </Button>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {/* Set baseline form */}
      {showSetBaseline && (
        <Panel
          title={`Set baseline for ${showSetBaseline}`}
          className="reveal"
          extra={
            <Button size="sm" type="secondary" onClick={() => setShowSetBaseline(null)}>
              Cancel
            </Button>
          }
        >
          <SetBaselineForm
            device={showSetBaseline}
            onDone={() => {
              setShowSetBaseline(null);
              void load();
            }}
          />
        </Panel>
      )}

      {/* Device detail panel */}
      {selectedDevice && (
        <DeviceDetail
          device={selectedDevice}
          onClose={() => setSelectedDevice(null)}
          onChanged={() => {
            setSelectedDevice(null);
            void load();
          }}
        />
      )}

      {/* Baseline manager table */}
      {baselines.length > 0 && (
        <Panel title="Baseline Manager" className="reveal">
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Snapshot ID</TableHead>
                  <TableHead>Set At</TableHead>
                  <TableHead>Set By</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>SHA</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {baselines.map((b) => (
                  <TableRow key={b.device}>
                    <TableCell>
                      <strong>{b.device}</strong>
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{b.snapshotId}</TableCell>
                    <TableCell title={clock(b.setAt)}>{ago(b.setAt)}</TableCell>
                    <TableCell>{b.setBy}</TableCell>
                    <TableCell>{b.label ?? "—"}</TableCell>
                    <TableCell>
                      {b.snapshot
                        ? `${b.snapshot.lines} lines / ${b.snapshot.bytes} bytes`
                        : "deleted"}
                    </TableCell>
                    <TableCell className="font-mono text-[10px]">
                      {b.snapshot?.sha?.slice(0, 8) ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        type="error"
                        ghost
                        onClick={() => {
                          void deleteJson(
                            `/api/drift/baseline/${encodeURIComponent(b.device)}`,
                            {},
                          ).then(() => {
                            toast.success("Baseline removed");
                            void load();
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}

      {/* Empty state */}
      {devices.length === 0 && !error && (
        <Panel className="reveal">
          <p className="text-muted-foreground text-center text-[11px]">
            No devices configured. Add devices to start using Drift Guard.
          </p>
        </Panel>
      )}
    </>
  );
}
