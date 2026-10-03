import { useEffect, useState } from "react";
import {
  FlaskConical,
  FileCheck2,
  ShieldCheck,
  Play,
  RefreshCw,
  Trash2,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  useOperations,
  WorkspaceHeader,
  WorkspaceError,
  WorkspaceSafety,
  EvidenceState,
} from "./operations-ui";
import { api } from "./api";
import type { RecoveryRun, RunnerCapabilities } from "../../src/recovery-lab/model";
import "./recovery-lab.css";
interface Inventory {
  snapshots: { id: string; at: number; label?: string; version?: string }[];
  runner: RunnerCapabilities | null;
}
export function RecoveryLabView() {
  const w = useOperations<{
    runs: RecoveryRun[];
    configured: boolean;
    configurationError?: string;
  }>("/api/recovery-lab");
  const [id, setId] = useState<string>(),
    [create, setCreate] = useState(false),
    [inventory, setInventory] = useState<Inventory>();
  const [snapshot, setSnapshot] = useState(""),
    [version, setVersion] = useState(""),
    [mode, setMode] = useState<"restore" | "upgrade">("restore");
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState<"start" | "destroy">(),
    [consent, setConsent] = useState(false);
  const run = w.data?.runs.find((r) => r.id === id) ?? w.data?.runs[0];
  const { refresh, busy } = w;
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [refresh, busy]);
  async function newRun() {
    setCreate(true);
    setInventory(undefined);
    setError("");
    setSnapshot("");
    setVersion("");
    setLoading(true);
    try {
      setInventory(
        await api<Inventory>(`/api/recovery-lab/inventory?device=${encodeURIComponent(w.device)}`),
      );
    } catch {
      setError(
        "Could not load snapshots or runner capabilities. Check the runner configuration, or create a snapshot first.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="ops-workspace">
      <WorkspaceHeader
        eyebrow="RECOVERY LAB / A SAFE PLACE TO REHEARSE"
        title="Test the recovery. Keep the network."
        description="Prepare a reviewed configuration subset, run it in a disposable isolated CHR, and see exactly what the rehearsal did—and did not—verify."
        device={w.device}
        devices={w.devices}
        busy={w.busy || loading}
        onDevice={(d) => {
          setId(undefined);
          setCreate(false);
          setConfirm(undefined);
          setInventory(undefined);
          setError("");
          w.setDevice(d);
        }}
        onRefresh={() => void w.refresh()}
      >
        <Button disabled={!w.device || w.busy || loading} onClick={() => void newRun()}>
          <FlaskConical size={16} />
          New rehearsal
        </Button>
      </WorkspaceHeader>
      <WorkspaceError message={w.error || error || w.data?.configurationError || ""} />
      {!w.data?.configured && (
        <div className="lab-setup">
          <ShieldCheck size={24} />
          <div>
            <h3>Connect an isolated runner to execute.</h3>
            <p>
              Local preparation is available. Set <code>MIKROTIK_RECOVERY_RUNNER_URL</code> and{" "}
              <code>MIKROTIK_RECOVERY_RUNNER_TOKEN</code> on the MCP service. The runner is a
              separately deployed VM service—not either of your production routers.
            </p>
            <p>
              HTTPS or explicit loopback HTTP · pinned images · no production network access ·
              automatic lab expiry
            </p>
          </div>
        </div>
      )}
      <div className="lab-process" aria-label="Rehearsal workflow">
        {["Review snapshot", "Isolate lab", "Restore & verify", "Confirm cleanup"].map(
          (label, i) => (
            <div key={label}>
              <span>0{i + 1}</span>
              <strong>{label}</strong>
              {i < 3 && <ArrowRight size={16} />}
            </div>
          ),
        )}
      </div>
      <div className="ops-split">
        <aside aria-label="Recovery rehearsals">
          <ScrollArea className="lab-history" viewportProps={{ className: "lab-history-viewport" }}>
            <div className="ops-list">
              {w.data?.runs.map((r) => (
                <button
                  key={r.id}
                  className="ops-list-item"
                  aria-pressed={run?.id === r.id}
                  onClick={() => setId(r.id)}
                >
                  <small>{new Date(r.preparedAt).toLocaleString()}</small>
                  <strong>
                    {r.mode === "upgrade"
                      ? `${r.sourceVersion ?? "unknown"} → ${r.version}`
                      : `Restore on ${r.version}`}
                  </strong>
                  <small>
                    {r.commands.length} portable records ·{" "}
                    {r.coverage.reduce((n, c) => n + c.excluded, 0)} excluded
                  </small>
                  <EvidenceState state={r.state} />
                </button>
              ))}
            </div>
            {!w.data?.runs.length && (
              <div className="ops-empty">
                No rehearsals yet.
                <p>Start with an existing snapshot. Production configuration stays untouched.</p>
                <a href="#snapshots">
                  Open snapshots <ExternalLink size={12} />
                </a>
              </div>
            )}
          </ScrollArea>
        </aside>
        {run ? (
          <section className="ops-panel lab-detail">
            <header className="lab-ticket">
              <div>
                <p className="ops-eyebrow">IMMUTABLE REHEARSAL</p>
                <h3>{run.mode === "upgrade" ? "Upgrade compatibility" : "Portable restore"}</h3>
                <p>
                  {run.device} · RouterOS {run.version}
                </p>
              </div>
              <EvidenceState state={run.state} />
            </header>
            <dl className="lab-facts">
              <div>
                <dt>Source snapshot</dt>
                <dd>{run.snapshotId}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>{new Date(run.snapshotAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Runner</dt>
                <dd>{run.runnerId ?? "Not configured"}</dd>
              </div>
              <div>
                <dt>Subset fingerprint</dt>
                <dd title={run.commandSha256}>{run.commandSha256.slice(0, 16)}…</dd>
              </div>
            </dl>
            <WorkspaceSafety>
              Only the reviewed portable subset is tested. Binary backups, User Manager data,
              credentials, scripts, Wi-Fi radios, ASIC offload and real throughput remain
              unverified.
            </WorkspaceSafety>
            {run.error && <WorkspaceError message={run.error} />}
            <div className="ops-toolbar">
              {run.state === "prepared" ? (
                <Button
                  disabled={w.busy || !w.data?.configured || !run.runnerId || !run.commands.length}
                  onClick={() => {
                    setConsent(false);
                    setConfirm("start");
                  }}
                >
                  <Play size={15} />
                  Review & run
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={w.busy}
                  onClick={() => void w.action("/poll", { id: run.id })}
                >
                  <RefreshCw size={15} />
                  Check runner evidence
                </Button>
              )}
              {run.startedAt &&
                run.state !== "destroyed" &&
                run.result?.cleanup !== "destroyed" && (
                  <Button
                    variant="outline"
                    disabled={w.busy}
                    onClick={() => {
                      setConsent(false);
                      setConfirm("destroy");
                    }}
                  >
                    <Trash2 size={15} />
                    Clean up lab
                  </Button>
                )}
            </div>
            {run.result && (
              <div className="lab-checks">
                <h3>Runner-reported verification</h3>
                {run.result.checks.map((c) => (
                  <div key={c.name}>
                    <FileCheck2 size={16} />
                    <div>
                      <strong>{c.name.replaceAll("-", " ")}</strong>
                      <p>{c.detail}</p>
                    </div>
                    <EvidenceState state={c.state} />
                  </div>
                ))}
                <p className="ops-description">
                  Cleanup: {run.result.cleanup}.{" "}
                  {run.state === "passed"
                    ? "The listed checks passed for the included subset only."
                    : "A started VM or a successful import alone is not a passed rehearsal."}
                </p>
              </div>
            )}
            <h3>Coverage, not assumptions</h3>
            <ScrollArea className="w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead>Included</TableHead>
                    <TableHead>Untested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.coverage.map((c) => (
                    <TableRow key={c.scope}>
                      <TableCell>
                        <code>{c.scope}</code>
                        {c.reason && <p className="lab-muted">{c.reason}</p>}
                      </TableCell>
                      <TableCell>{c.included}</TableCell>
                      <TableCell>{c.excluded || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
            <details>
              <summary>Inspect exact transmitted commands · {run.commands.length}</summary>
              <ScrollArea className="h-[240px] mt-3">
                <pre className="ops-code">
                  {run.commands.join("\n") || "No supported portable records."}
                </pre>
              </ScrollArea>
            </details>
          </section>
        ) : (
          <section className="lab-blank">
            <FlaskConical size={46} />
            <h3>Rehearse before it matters.</h3>
            <p>
              A snapshot is a starting point—not proof of recoverability. Prepare a rehearsal to
              inspect portable coverage before authorizing any lab execution.
            </p>
          </section>
        )}
      </div>
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Prepare a recovery rehearsal</DialogTitle>
            <DialogDescription>
              Preparation reads an existing local snapshot. It does not contact the router or send
              configuration to the runner.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh]">
            <div className="ops-form">
              <WorkspaceError message={w.error || error} />
              {loading ? (
                <p role="status">Loading snapshots and runner capabilities…</p>
              ) : (
                <>
                  <label>
                    Source snapshot
                    <Select value={snapshot} onValueChange={setSnapshot}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a snapshot" />
                      </SelectTrigger>
                      <SelectContent>
                        {inventory?.snapshots.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.label || s.id} · {s.version ?? "version unknown"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {!inventory?.snapshots.length && (
                    <p className="lab-muted">
                      No available snapshots. Capture one from the Snapshots page first.
                    </p>
                  )}
                  <label>
                    Rehearsal type
                    <Select value={mode} onValueChange={(v) => setMode(v as "restore" | "upgrade")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="restore">Restore directly on target version</SelectItem>
                        <SelectItem value="upgrade">
                          Restore source, then upgrade to target
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label>
                    Target RouterOS version
                    {inventory?.runner ? (
                      <Select value={version} onValueChange={setVersion}>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a pinned image" />
                        </SelectTrigger>
                        <SelectContent>
                          {inventory.runner.versions.map((v) => (
                            <SelectItem key={v.version} value={v.version}>
                              {v.version} · {v.architecture}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        placeholder="7.20.1"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                      />
                    )}
                  </label>
                  <WorkspaceSafety>
                    The preview excludes unsupported fields/scopes rather than silently claiming a
                    full restore. A separately configured isolated runner is required for execution.
                  </WorkspaceSafety>
                </>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreate(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                loading ||
                w.busy ||
                !snapshot ||
                !/^7\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?$/.test(version)
              }
              onClick={async () => {
                const value = await w.action<RecoveryRun>("/prepare", {
                  snapshotId: snapshot,
                  version,
                  mode,
                });
                if (value) {
                  setId(value.id);
                  setCreate(false);
                }
              }}
            >
              Prepare preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "start" ? "Authorize this isolated rehearsal" : "Destroy this lab only"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "start"
                ? `Send ${run?.commands.length ?? 0} reviewed commands to runner ${run?.runnerId ?? "not configured"}. The disposable VM must have no production network access and a 15-minute TTL.`
                : "Only the disposable resources owned by this rehearsal ID are targeted. Saved evidence is retained; production routers are never contacted."}
            </DialogDescription>
          </DialogHeader>
          <WorkspaceError message={w.error} />
          <label className="flex items-start gap-3 text-sm">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
            <span>
              {confirm === "start"
                ? "I reviewed the commands and approve this transfer to the configured isolated runner."
                : "I confirm cleanup of this rehearsal's disposable lab."}
            </span>
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={!consent || w.busy || !run}
              onClick={async () => {
                if (await w.action(`/${confirm}`, { id: run!.id, confirm: true }))
                  setConfirm(undefined);
              }}
            >
              {confirm === "start" ? "Start isolated rehearsal" : "Confirm lab cleanup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
