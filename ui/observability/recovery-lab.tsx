/**
 * Recovery lab (the Rec-Lab board): rehearse a restore of a reviewed config
 * subset in a disposable, isolated CHR, and show exactly what the rehearsal
 * did and did not verify. Starting a run asks for consent in a dialog
 * (Rec-Lab-Authorize).
 */
import "./recovery-lab.css";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronRight,
  ExternalLink,
  FlaskConical,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import { StepTrail } from "./config-charts";
import { LoadingState } from "./loading-state";
import {
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
import type { Tone } from "./monitoring-ui";
import {
  Checkbox,
  DetailList,
  Field,
  RowDrawer,
  RowMenu,
  RowMore,
  Select,
  TextInput,
  tipProps,
} from "./kit";
import { useOperations } from "./operations-ui";
import type { RecoveryRun, RunnerCapabilities } from "../../src/recovery-lab/model";

interface Inventory {
  snapshots: { id: string; at: number; label?: string; version?: string }[];
  runner: RunnerCapabilities | null;
}

const STATE_TONE: Record<string, Tone | undefined> = {
  passed: "good",
  pass: "good",
  running: "warn",
  prepared: "brand",
  uncertain: "warn",
  pending: "warn",
  unsupported: "warn",
  failed: "bad",
  fail: "bad",
};

function StateBadge({ state }: { state: string }): ReactNode {
  const tone = STATE_TONE[state];
  return (
    <StatusBadge tone={tone ?? "default"} dot={tone !== undefined} quiet={tone === undefined}>
      {state.replaceAll("-", " ")}
    </StatusBadge>
  );
}

/** "Nov 17 13:10". */
function stamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { month: "short", day: "2-digit" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

function title(r: RecoveryRun): string {
  return r.mode === "upgrade"
    ? `${r.sourceVersion ?? "unknown"} → ${r.version}`
    : `Restore on ${r.version}`;
}

function rehearsal(r: RecoveryRun): string {
  return r.mode === "upgrade"
    ? `Restore on ${r.sourceVersion ?? "the source version"}, then upgrade to ${r.version}`
    : `Restore directly on ${r.version}`;
}

/** Where the selected run is in the four steps. */
function stepOf(r: RecoveryRun | undefined): number {
  if (!r) return 0;
  if (r.state === "destroyed" || r.result?.cleanup === "destroyed") return 4;
  if (r.result) return 3;
  if (r.startedAt) return 2;
  return 1;
}

/** The runner's checks as a path: one node per check, ticked or crossed. */
function CheckPath({
  checks,
}: {
  checks: { name: string; state: string; detail?: string }[];
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useLineDraw(root, checks.length);
  const w = 780;
  const n = checks.length;
  const x = (i: number): number => (n === 1 ? w / 2 : 70 + (i * (w - 140)) / (n - 1));
  return (
    <div ref={root}>
      <svg
        className="kit-tips"
        viewBox={`0 0 ${w} 76`}
        width="100%"
        height="76"
        role="img"
        aria-label="Runner checks"
      >
        {n > 1 && (
          <path
            data-draw
            d={`M70,30 L${w - 70},30`}
            stroke="var(--sig)"
            strokeWidth="2"
            opacity=".5"
            fill="none"
          />
        )}
        {checks.map((c, i) => {
          const cx = x(i);
          const ok = c.state === "pass";
          const bad = c.state === "fail";
          const color = ok ? "var(--sig)" : bad ? "var(--destructive)" : "var(--warning)";
          const soft = ok ? "var(--sig-soft)" : bad ? "var(--bad-soft)" : "var(--warn-soft)";
          return (
            <g
              key={c.name}
              {...tipProps(() => ({
                title: c.name.replaceAll("-", " "),
                sub: `check ${i + 1} of ${n}`,
                led: ok ? "ok" : bad ? "bad" : "warn",
                rows: [
                  { label: "State", value: c.state, color },
                  ...(c.detail ? [{ label: "Detail", value: c.detail }] : []),
                ],
              }))}
            >
              <circle cx={cx} cy="30" r="14" fill={soft} stroke={color} strokeWidth="1.5" />
              {ok ? (
                <path d={`M${cx - 5},30 l4,4 l7,-8`} fill="none" stroke={color} strokeWidth="2" />
              ) : bad ? (
                <path
                  d={`M${cx - 4},26 l8,8 M${cx + 4},26 l-8,8`}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                />
              ) : (
                <circle cx={cx} cy="30" r="2.5" fill={color} />
              )}
              <text x={cx} y="66" textAnchor="middle" fontSize="12" fill="var(--foreground)">
                {c.name.replaceAll("-", " ")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function RecoveryLabView(): ReactNode {
  const w = useOperations<{
    runs: RecoveryRun[];
    configured: boolean;
    configurationError?: string;
  }>("/api/recovery-lab");
  const [id, setId] = useState<string>();
  const [create, setCreate] = useState(false);
  const [inventory, setInventory] = useState<Inventory>();
  const [snapshot, setSnapshot] = useState("");
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<"restore" | "upgrade">("restore");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"start" | "destroy">();
  const [consent, setConsent] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  // The open coverage row, kept per run so another run starts closed.
  const [scopeSel, setScopeSel] = useState<{ run: string; i: number }>();
  const run = w.data?.runs.find((r) => r.id === id) ?? w.data?.runs[0];
  const { refresh, busy } = w;
  const scope = scopeSel && scopeSel.run === run?.id ? scopeSel.i : undefined;
  const setScope = (i: number | undefined): void =>
    setScopeSel(i === undefined || !run ? undefined : { run: run.id, i });

  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [refresh, busy]);

  async function newRun(): Promise<void> {
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

  if (!w.data && w.loading && !w.error)
    return <LoadingState label="Loading workspace evidence" layout="cards" />;

  const pageError = w.error || error || w.data?.configurationError || "";
  const scopeRow = scope === undefined ? undefined : run?.coverage[scope];
  const cleanupDone = run?.state === "destroyed" || run?.result?.cleanup === "destroyed";

  return (
    <section className="lab grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Recovery lab · a safe place to rehearse"
        verdict={
          <>
            Test the recovery. <span className="s">Keep the network.</span>
          </>
        }
        lead="Run a reviewed config subset in a disposable, isolated CHR and see exactly what the rehearsal did, and did not, verify."
        actions={
          <>
            <RouterPicker
              value={w.device}
              routers={w.devices}
              label="Workspace router"
              disabled={w.busy || loading}
              onChange={(d) => {
                setId(undefined);
                setCreate(false);
                setConfirm(undefined);
                setInventory(undefined);
                setError("");
                w.setDevice(d);
              }}
            />
            <MonitorButton
              variant="primary"
              icon={<FlaskConical aria-hidden="true" />}
              disabled={!w.device || w.busy || loading}
              onClick={() => void newRun()}
            >
              New rehearsal
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              icon={<RefreshCw aria-hidden="true" />}
              disabled={w.busy}
              onClick={() => void w.refresh()}
            >
              Refresh
            </MonitorButton>
          </>
        }
      />

      {pageError && !create && !confirm && (
        <MonitorNote tone="bad" role="alert">
          {pageError}
        </MonitorNote>
      )}

      {!w.data?.configured && (
        <MonitorNote icon={<ShieldCheck aria-hidden="true" />}>
          <b>Connect an isolated runner to execute.</b> Local preparation works now. Set{" "}
          <span className="mono">MIKROTIK_RECOVERY_RUNNER_URL</span> and{" "}
          <span className="mono">MIKROTIK_RECOVERY_RUNNER_TOKEN</span> on the MCP service. The
          runner is a separately deployed VM service, not either of your production routers. HTTPS
          or explicit loopback HTTP · pinned images · no production network access · automatic lab
          expiry.
        </MonitorNote>
      )}

      <StepTrail
        labels={["Review snapshot", "Isolate lab", "Restore & verify", "Confirm cleanup"]}
        active={stepOf(run)}
      />

      <div className="lab-split">
        <aside className="lab-runs" aria-label="Recovery rehearsals">
          <span className="monitor-label">Rehearsals · {w.device || "no router"}</span>
          {w.data?.runs.map((r) => (
            <button
              key={r.id}
              type="button"
              className="glass lab-run"
              aria-pressed={run?.id === r.id}
              onClick={() => setId(r.id)}
            >
              <span className="mono">{stamp(r.preparedAt)}</span>
              <b>{title(r)}</b>
              <span className="monitor-hint">
                {r.commands.length} portable records ·{" "}
                {r.coverage.reduce((n, c) => n + c.excluded, 0)} excluded
              </span>
              <span className="mt-1">
                <StateBadge state={r.state} />
              </span>
            </button>
          ))}
          {!w.data?.runs.length && (
            <MonitorEmpty
              compact
              title="No rehearsals yet"
              action={
                <a className="monitor-btn" data-variant="ghost" data-size="sm" href="#snapshots">
                  Open snapshots <ExternalLink aria-hidden="true" />
                </a>
              }
            >
              Start with an existing snapshot. Production config stays untouched.
            </MonitorEmpty>
          )}
        </aside>

        {run ? (
          <div className="lab-detail">
            <MonitorPanel
              className="lab-ticket"
              title={
                <>
                  <span className="monitor-eyebrow block">Immutable rehearsal</span>
                  {run.mode === "upgrade" ? "Upgrade compatibility" : "Portable restore"}
                </>
              }
              description={`${run.device} · RouterOS ${run.version}`}
              extra={<StateBadge state={run.state} />}
              bodyClassName="flex flex-col gap-4"
            >
              <dl className="monitor-facts">
                <dt>Source snapshot</dt>
                <dd className="mono">{run.snapshotId}</dd>
                <dt>Captured</dt>
                <dd>{stamp(run.snapshotAt)}</dd>
                <dt>Runner</dt>
                <dd className="mono">{run.runnerId ?? "Not configured"}</dd>
                <dt>Subset fingerprint</dt>
                <dd className="mono" title={run.commandSha256}>
                  {run.commandSha256.slice(0, 16)}…
                </dd>
              </dl>
              <MonitorNote tone="warn" icon={<ShieldCheck aria-hidden="true" />}>
                Only the reviewed portable subset is tested. Binary backups, User Manager data,
                credentials, scripts, Wi-Fi radios, ASIC offload and real throughput stay
                unverified.
              </MonitorNote>
              {run.error && (
                <MonitorNote tone="bad" role="alert">
                  {run.error}
                </MonitorNote>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {run.state === "prepared" ? (
                  <MonitorButton
                    variant="primary"
                    icon={<Play aria-hidden="true" />}
                    disabled={
                      w.busy || !w.data?.configured || !run.runnerId || !run.commands.length
                    }
                    onClick={() => {
                      setConsent(false);
                      setConfirm("start");
                    }}
                  >
                    Review & run
                  </MonitorButton>
                ) : (
                  <MonitorButton
                    variant="ghost"
                    icon={<RefreshCw aria-hidden="true" />}
                    disabled={w.busy}
                    onClick={() => void w.action("/poll", { id: run.id })}
                  >
                    Check runner evidence
                  </MonitorButton>
                )}
                {run.startedAt && !cleanupDone && (
                  <MonitorButton
                    variant="ghost"
                    icon={<Trash2 aria-hidden="true" />}
                    disabled={w.busy}
                    onClick={() => {
                      setConsent(false);
                      setConfirm("destroy");
                    }}
                  >
                    Clean up lab
                  </MonitorButton>
                )}
                {cleanupDone && (
                  <span className="monitor-hint">
                    The lab was destroyed after the run, so there is nothing left to clean up.
                  </span>
                )}
              </div>
            </MonitorPanel>

            {run.result && (
              <MonitorPanel
                title="Runner-reported verification"
                description="Evidence from the isolated runner, not from the router."
                bodyClassName="flex flex-col gap-2"
              >
                <CheckPath checks={run.result.checks} />
                {run.result.checks.map((c) => (
                  <div key={c.name} className="lab-check">
                    <b>{c.name.replaceAll("-", " ")}</b>
                    <span className="text-muted-foreground">{c.detail}</span>
                    <span>
                      <StatusBadge
                        tone={STATE_TONE[c.state] ?? "default"}
                        dot={false}
                        quiet={STATE_TONE[c.state] === undefined}
                      >
                        {c.state}
                      </StatusBadge>
                    </span>
                  </div>
                ))}
                <p className="monitor-hint">
                  Cleanup: {run.result.cleanup}.{" "}
                  {run.state === "passed"
                    ? "The listed checks passed for the included subset only."
                    : "A started VM or a successful import alone is not a passed rehearsal."}
                </p>
              </MonitorPanel>
            )}

            <MonitorPanel
              title="Coverage, not assumptions"
              description="What the rehearsal carried, and what it could not test."
              flush
            >
              <div className="monitor-thead lab-cov">
                <span>Scope</span>
                <span>Included</span>
                <span>Untested</span>
                <span />
              </div>
              {run.coverage.length === 0 && (
                <div className="monitor-row lab-cov">
                  <span className="text-muted-foreground">No scopes recorded.</span>
                </div>
              )}
              {run.coverage.map((c, i) => (
                <RowMenu
                  key={c.scope}
                  title={c.scope}
                  sub={`${c.included} included · ${c.excluded} untested`}
                  onOpen={() => setScope(i)}
                  cells={{
                    scope: { value: c.scope },
                    included: { value: String(c.included) },
                    untested: { value: String(c.excluded) },
                  }}
                  copies={[{ label: "Scope", value: c.scope }]}
                  row={c}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${c.scope}, ${c.included} included, ${c.excluded} untested`}
                    className="monitor-row lab-cov cursor-pointer"
                    data-selected={scopeRow?.scope === c.scope || undefined}
                    onClick={() => setScope(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setScope(i);
                      }
                    }}
                  >
                    <span data-col="scope" className="flex min-w-0 flex-col gap-0.5">
                      <span className="mono p">{c.scope}</span>
                      {c.reason && <span className="monitor-hint">{c.reason}</span>}
                    </span>
                    <span data-col="included" className="num">
                      {c.included}
                    </span>
                    {c.excluded ? (
                      <span data-col="untested" className="num text-warning">
                        {c.excluded}
                      </span>
                    ) : (
                      <span data-col="untested" className="text-faint">
                        —
                      </span>
                    )}
                    <RowMore />
                  </div>
                </RowMenu>
              ))}
              <RowDrawer
                open={Boolean(scopeRow)}
                onClose={() => setScope(undefined)}
                label={`Coverage details: ${scopeRow?.scope ?? ""}`}
                status={
                  scopeRow
                    ? scopeRow.excluded
                      ? { tone: "warn", label: `${scopeRow.excluded} untested` }
                      : { tone: "ok", label: "all included" }
                    : undefined
                }
                title={scopeRow?.scope ?? ""}
                meta={`${run.device} · RouterOS ${run.version}`}
                nav={
                  scope !== undefined && scopeRow
                    ? {
                        index: scope,
                        total: run.coverage.length,
                        onPrev: scope > 0 ? () => setScope(scope - 1) : undefined,
                        onNext:
                          scope < run.coverage.length - 1 ? () => setScope(scope + 1) : undefined,
                      }
                    : undefined
                }
                rowKey={scopeRow?.scope}
                storageKey="recovery-lab-coverage"
              >
                {scopeRow && (
                  <DetailList
                    items={[
                      { label: "Scope", value: scopeRow.scope, mono: true },
                      { label: "Included", value: scopeRow.included },
                      { label: "Untested", value: scopeRow.excluded || "—" },
                      ...(scopeRow.reason ? [{ label: "Reason", value: scopeRow.reason }] : []),
                    ]}
                  />
                )}
              </RowDrawer>
            </MonitorPanel>

            <MonitorPanel
              title={
                <button
                  type="button"
                  className="lab-commands-toggle"
                  aria-expanded={showCommands}
                  onClick={() => setShowCommands((v) => !v)}
                >
                  <ChevronRight aria-hidden="true" />
                  Inspect exact transmitted commands · {run.commands.length}
                </button>
              }
            >
              {showCommands ? (
                <pre className="monitor-pre lab-commands">
                  {run.commands.join("\n") || "No supported portable records."}
                </pre>
              ) : undefined}
            </MonitorPanel>
          </div>
        ) : (
          <MonitorPanel title="Rehearse before it matters">
            <MonitorEmpty icon={<FlaskConical />} title="Rehearse before it matters.">
              A snapshot is a starting point, not proof you can recover. Prepare a rehearsal to see
              the portable coverage before you authorize any lab run.
            </MonitorEmpty>
          </MonitorPanel>
        )}
      </div>

      <MonitorDialog
        open={create}
        onOpenChange={setCreate}
        title="Prepare a recovery rehearsal"
        description="Preparation reads an existing local snapshot. It does not contact the router or send config to the runner."
        footer={
          <>
            <MonitorButton variant="ghost" onClick={() => setCreate(false)}>
              Cancel
            </MonitorButton>
            <span className="flex-1" />
            <MonitorButton
              variant="primary"
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
            </MonitorButton>
          </>
        }
      >
        <div className="lab-dialog flex flex-col gap-4">
          {(w.error || error) && (
            <MonitorNote tone="bad" role="alert">
              {w.error || error}
            </MonitorNote>
          )}
          {loading ? (
            <LoadingState label="Loading snapshots and runner capabilities" layout="form" />
          ) : (
            <>
              <Field
                label="Source snapshot"
                help={
                  inventory?.snapshots.length
                    ? undefined
                    : "No snapshots yet. Capture one from the Snapshots page first."
                }
              >
                <Select
                  label="Source snapshot"
                  value={snapshot}
                  onChange={setSnapshot}
                  placeholder="Choose a snapshot"
                  options={(inventory?.snapshots ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.label || s.id} · ${s.version ?? "version unknown"}`,
                  }))}
                />
              </Field>
              <Field label="Rehearsal type">
                <Select
                  label="Rehearsal type"
                  value={mode}
                  onChange={(v) => setMode(v as "restore" | "upgrade")}
                  options={[
                    { value: "restore", label: "Restore directly on target version" },
                    { value: "upgrade", label: "Restore source, then upgrade to target" },
                  ]}
                />
              </Field>
              <Field label="Target RouterOS version">
                {inventory?.runner ? (
                  <Select
                    label="Target RouterOS version"
                    value={version}
                    onChange={setVersion}
                    placeholder="Choose a pinned image"
                    options={inventory.runner.versions.map((v) => ({
                      value: v.version,
                      label: `${v.version} · ${v.architecture}`,
                    }))}
                  />
                ) : (
                  <TextInput
                    label="Target RouterOS version"
                    mono
                    placeholder="7.20.1"
                    value={version}
                    onChange={setVersion}
                  />
                )}
              </Field>
              <MonitorNote icon={<ShieldCheck aria-hidden="true" />}>
                The preview leaves out unsupported fields and scopes instead of claiming a full
                restore. Running it needs a separately configured isolated runner.
              </MonitorNote>
            </>
          )}
        </div>
      </MonitorDialog>

      <MonitorDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(undefined);
        }}
        width={620}
        title={confirm === "start" ? "Authorize this isolated rehearsal" : "Destroy this lab only"}
        description={
          confirm === "start"
            ? `Send ${run?.commands.length ?? 0} reviewed commands to runner ${run?.runnerId ?? "not configured"}. The disposable VM must have no production network access and a 15-minute TTL.`
            : "Only the disposable resources owned by this rehearsal are targeted. Saved evidence is kept; production routers are never contacted."
        }
        footer={
          <>
            <MonitorButton variant="ghost" onClick={() => setConfirm(undefined)}>
              Cancel
            </MonitorButton>
            <span className="flex-1" />
            <MonitorButton
              variant={confirm === "start" ? "primary" : "danger"}
              icon={
                confirm === "start" ? <Play aria-hidden="true" /> : <Trash2 aria-hidden="true" />
              }
              disabled={!consent || w.busy || !run}
              onClick={async () => {
                if (await w.action(`/${confirm}`, { id: run!.id, confirm: true }))
                  setConfirm(undefined);
              }}
            >
              {confirm === "start" ? "Start isolated rehearsal" : "Confirm lab cleanup"}
            </MonitorButton>
          </>
        }
      >
        <div className="lab-dialog flex flex-col gap-4">
          {w.error && (
            <MonitorNote tone="bad" role="alert">
              {w.error}
            </MonitorNote>
          )}
          {confirm === "start" && run && (
            <>
              <dl className="monitor-facts">
                <dt>Snapshot</dt>
                <dd className="mono">{run.snapshotId}</dd>
                <dt>Rehearsal</dt>
                <dd>{rehearsal(run)}</dd>
                <dt>Image</dt>
                <dd className="mono">{run.version} · pinned</dd>
                <dt>Fingerprint</dt>
                <dd className="mono" title={run.commandSha256}>
                  {run.commandSha256.slice(0, 16)}…
                </dd>
              </dl>
              <pre className="monitor-pre lab-transfer">{run.commands.join("\n")}</pre>
            </>
          )}
          <Checkbox
            tone="warn"
            checked={consent}
            onCheckedChange={setConsent}
            label={
              confirm === "start"
                ? "I reviewed the commands and approve this transfer to the configured isolated runner."
                : "I confirm cleanup of this rehearsal's disposable lab."
            }
          />
        </div>
      </MonitorDialog>
    </section>
  );
}
