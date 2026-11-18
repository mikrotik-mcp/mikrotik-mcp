import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Clock, Play, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import type {
  ContractCheckResult,
  ContractRun,
  ServiceContract,
} from "../../src/service-contracts/model";
import { api, postJson } from "./api";
import { num } from "./format";
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
  StatusDot,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import "./service-contracts.css";

type RunStatus = ContractRun["status"];

const STATUS_WORD: Record<RunStatus, string> = {
  pass: "Passing",
  fail: "Failing",
  unknown: "Unknown",
};
const RESULT_WORD: Record<ContractCheckResult["status"], string> = {
  pass: "Pass",
  fail: "Fail",
  unknown: "Unknown",
};
const TONE: Record<RunStatus, Tone> = { pass: "good", fail: "bad", unknown: "warn" };
const NOTE_TONE: Record<RunStatus, "good" | "warn" | "bad"> = {
  pass: "good",
  fail: "bad",
  unknown: "warn",
};
const TEXT: Record<RunStatus, string> = {
  pass: "text-success",
  fail: "text-destructive",
  unknown: "text-warning",
};

/** How many past runs the run strips show. */
const STRIP_RUNS = 20;

function maxLatency(c: ServiceContract): number {
  return Math.max(0, ...c.checks.map((k) => k.maxLatencyMs));
}

const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** The "Last run" KPI: the number, then the unit for its <small>. */
function elapsed(ts: number, now: number): [string, string] {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return ["<1", "min"];
  const m = Math.round(s / 60);
  if (m < 60) return [String(m), "min"];
  const h = Math.round(m / 60);
  if (h < 24) return [String(h), "h"];
  return [String(Math.round(h / 24)), "d"];
}

/** Endpoint checks only: a packet suite result is a simulation, not an endpoint. */
const isEndpoint = (k: ContractCheckResult): boolean => k.kind !== "simulation";

/** The note above the checks: what failed, when, and why. */
function runSummary(run: ContractRun, contract: ServiceContract): string {
  const endpoints = run.checks.filter(isEndpoint);
  const n = endpoints.length;
  const failed = run.checks.filter((k) => k.status === "fail");
  const unknown = run.checks.filter((k) => k.status === "unknown");
  const at = hhmm(run.startedAt);
  if (failed.length) {
    const first = failed[0];
    const limit = contract.checks.find((k) => k.target === first.target)?.maxLatencyMs;
    const why =
      limit != null && first.durationMs > limit
        ? `${first.target} was slower than the ${num(limit)} ms limit.`
        : `${first.target}: ${first.detail}.`;
    const failedEndpoints = failed.filter(isEndpoint).length;
    const head = failedEndpoints
      ? `${failedEndpoints} of ${plural(n, "endpoint")} failed at ${at}.`
      : `The packet suite failed at ${at}.`;
    return `${head} ${why}`;
  }
  if (unknown.length)
    return `${unknown.length} of ${plural(run.checks.length, "check")} gave no answer at ${at}.`;
  return `All ${plural(run.checks.length, "check")} passed at ${at}, in ${num(
    run.finishedAt - run.startedAt,
  )} ms.`;
}

/**
 * One bar per run, oldest first. Empty slots (fewer runs than the strip
 * holds) sit on the left as short faint bars.
 */
function RunStrip({
  runs,
  height,
  width,
  slots,
  className,
}: {
  runs: ContractRun[];
  height: number;
  width: number;
  slots?: number;
  className?: string;
}): ReactNode {
  const shown = runs.slice(0, STRIP_RUNS).reverse();
  const empty = Math.max(0, (slots ?? 0) - shown.length);
  const counts = (["pass", "fail", "unknown"] as const)
    .map((s) => [s, shown.filter((r) => r.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s === "pass" ? "passed" : s === "fail" ? "failed" : "unknown"}`);
  return (
    <span
      className={className ?? "sc-strip"}
      style={{ "--bar-h": `${height}px`, "--bar-w": `${width}px` } as CSSProperties}
      role="img"
      aria-label={
        shown.length
          ? `Last ${plural(shown.length, "run")}: ${counts.join(", ")}`
          : "No runs recorded"
      }
    >
      {Array.from({ length: empty }, (_, i) => (
        <i key={`empty-${i}`} data-status="none" />
      ))}
      {shown.map((r) => (
        <i
          key={r.id}
          data-status={r.status}
          title={`${STATUS_WORD[r.status]} · ${new Date(r.startedAt).toLocaleString()}`}
        />
      ))}
    </span>
  );
}

/** Keep service proof distinct from router reachability and historical successes. */
export function ServiceContractsView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
  const [defaultDevice, setDefaultDevice] = useState("");
  const [device, setDevice] = useState("");
  const [deviceLoad, setDeviceLoad] = useState<"loading" | "ready" | "error">("loading");
  const [contracts, setContracts] = useState<ServiceContract[]>([]);
  const [contractsLoaded, setContractsLoaded] = useState(false);
  const [targets, setTargets] = useState<{ name: string; kind: string }[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [latency, setLatency] = useState(2000);
  const [suite, setSuite] = useState("");
  // Recorded runs per contract id, newest first, as the history route returns them.
  const [history, setHistory] = useState<Record<string, ContractRun[]>>({});
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // When the history was last read; "Last run" counts from here.
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const query = `device=${encodeURIComponent(device)}`;

  useEffect(() => {
    let stopped = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (!stopped) {
          setDevices(r.devices.map((d) => d.name));
          setDefaultDevice(r.defaultDevice);
          setDevice(r.devices.some((item) => item.name === r.defaultDevice) ? r.defaultDevice : "");
          setDeviceLoad("ready");
        }
      })
      .catch(() => {
        if (!stopped) {
          setDeviceLoad("error");
          setError("Could not load configured devices.");
        }
      });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!device) return;
    let stopped = false;
    void Promise.all([
      api<{ contracts: ServiceContract[] }>(`/api/service-contracts?${query}`),
      api<{ targets: { name: string; kind: string }[] }>(`/api/service-contracts/targets?${query}`),
    ])
      .then(async ([c, t]) => {
        if (stopped) return;
        setContracts(c.contracts);
        setTargets(t.targets);
        setContractsLoaded(true);
        // The list shows each contract's last result, so read every history.
        // The route reads local storage only; it never probes.
        const runs = await Promise.all(
          c.contracts.map((item) =>
            api<{ runs: ContractRun[] }>(
              `/api/service-contracts/history?${query}&id=${encodeURIComponent(item.id)}`,
            )
              .then((h) => [item.id, h.runs] as const)
              .catch(() => [item.id, [] as ContractRun[]] as const),
          ),
        );
        if (!stopped) {
          setHistory(Object.fromEntries(runs));
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (!stopped) setError("Could not load contracts. Check device access and local storage.");
      });
    return () => {
      stopped = true;
    };
  }, [device, query, revision]);

  useStaggerIn(listRef, ".monitor-row", `${device}:${contracts.length}`);

  async function create(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await postJson<ServiceContract & { error?: string }>(
        `/api/service-contracts?${query}`,
        {
          name,
          checks: selectedTargets.map((target) => ({
            target,
            maxLatencyMs: latency,
            expectedStatus: [200],
          })),
          ...(suite.trim() ? { packetSuiteId: suite.trim() } : {}),
        },
      );
      if (result.error || !result.id) throw new Error(result.error ?? "No saved contract returned");
      setName("");
      setSelectedTargets([]);
      setSelected(result.id);
      setCreating(false);
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save contract");
    } finally {
      setBusy(false);
    }
  }

  async function show(id: string, run = false): Promise<void> {
    setBusy(true);
    setSelected(id);
    setError("");
    try {
      if (run) {
        const result = await postJson<ContractRun & { error?: string }>(
          `/api/service-contracts/run?${query}`,
          { id },
        );
        if (result.error || !result.id) throw new Error(result.error ?? "No check result returned");
      }
      const res = await api<{ runs: ContractRun[] }>(
        `/api/service-contracts/history?${query}&id=${encodeURIComponent(id)}`,
      );
      setHistory((h) => ({ ...h, [id]: res.runs }));
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read contract results");
    } finally {
      setBusy(false);
    }
  }

  // Keep a contract open: the picked one, else the first failing, else the first.
  const contract =
    contracts.find((c) => c.id === selected) ??
    contracts.find((c) => history[c.id]?.[0]?.status === "fail") ??
    contracts[0];
  const runs = (contract && history[contract.id]) ?? [];
  const latest = runs[0];
  const lastOf = (c: ServiceContract): ContractRun | undefined => history[c.id]?.[0];
  const passing = contracts.filter((c) => lastOf(c)?.status === "pass");
  const failing = contracts.filter((c) => lastOf(c)?.status === "fail");
  const endpoints = contracts.reduce((n, c) => n + c.checks.length, 0);
  const newest = contracts
    .map((c) => ({ c, run: lastOf(c) }))
    .filter((x): x is { c: ServiceContract; run: ContractRun } => !!x.run)
    .sort((a, b) => b.run.startedAt - a.run.startedAt)[0];
  const historyReady = contracts.every((c) => c.id in history);
  const lastRun = newest ? elapsed(newest.run.startedAt, now) : null;

  // The answer line: how many pass, and the failure that matters.
  let verdict: ReactNode;
  if (deviceLoad === "error") verdict = "Routers unavailable.";
  else if (deviceLoad === "ready" && !device)
    verdict = devices.length ? "Choose a router." : "No routers configured.";
  else if (!contractsLoaded || !historyReady) verdict = "Reading contracts…";
  else if (!contracts.length) verdict = "No contracts for this router.";
  else {
    const first = failing[0];
    const failRun = first && lastOf(first);
    verdict = (
      <>
        {passing.length === contracts.length
          ? `All ${plural(contracts.length, "contract")} pass.`
          : `${num(passing.length)} of ${plural(contracts.length, "contract")} pass.`}
        {failing.length === 1 && failRun && (
          <>
            {" "}
            <em>{first.name}</em> failed at {hhmm(failRun.startedAt)}.
          </>
        )}
        {failing.length > 1 && (
          <>
            {" "}
            <em>{plural(failing.length, "contract")}</em> failed.
          </>
        )}
      </>
    );
  }

  const matrix = contracts.length > 0 && historyReady && (
    <div className="glass sc-matrix">
      <div className="sc-matrix-head">
        <span className="monitor-label">Last {STRIP_RUNS} runs per contract</span>
        <span className="monitor-legend">
          <span>
            <i className="bg-sig" />
            pass
          </span>
          <span>
            <i className="bg-destructive" />
            fail
          </span>
          <span>
            <i className="bg-faint" />
            unknown
          </span>
        </span>
      </div>
      {contracts.map((c) => {
        const last = lastOf(c);
        return (
          <div key={c.id} className="sc-matrix-row">
            <span className="sc-matrix-name">
              <StatusDot tone={last ? TONE[last.status] : "default"} />
              <span className="truncate">{c.name}</span>
            </span>
            <RunStrip runs={history[c.id] ?? []} height={14} width={7} slots={STRIP_RUNS} />
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="sc-page">
      {deviceLoad === "loading" && (
        <LoadingState label="Loading service contracts" layout="cards" />
      )}
      <PageIntro
        eyebrow="Service Health · probes from the MCP host"
        verdict={verdict}
        lead="Say what must work, then prove it. Probes run from the MCP host, not from the client or the branch."
        aside={matrix || undefined}
        actions={
          <>
            <RouterPicker
              value={device}
              routers={devices}
              defaultRouter={defaultDevice}
              disabled={busy || deviceLoad !== "ready" || !devices.length}
              onChange={(value) => {
                setDevice(value);
                setContracts([]);
                setContractsLoaded(false);
                setTargets([]);
                setHistory({});
                setSelected("");
                setSelectedTargets([]);
                setError("");
              }}
            />
            <MonitorButton
              variant="primary"
              icon={<Plus aria-hidden="true" />}
              disabled={busy || !device}
              onClick={() => setCreating(true)}
            >
              New contract
            </MonitorButton>
          </>
        }
      />

      {error && !creating && (
        <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
          {error}
        </MonitorNote>
      )}

      {device && contractsLoaded && (
        <MetricStrip label="Contract summary" className="sc-kpis">
          <Metric
            label="Contracts"
            value={num(contracts.length)}
            hint={`${plural(endpoints, "endpoint")} in total`}
          />
          <Metric
            label="Passing"
            tone={passing.length ? "good" : "default"}
            value={historyReady ? num(passing.length) : "—"}
            hint="At the last run"
          />
          <Metric
            label="Failing"
            tone={failing.length ? "bad" : "default"}
            value={historyReady ? num(failing.length) : "—"}
            hint={
              failing.length ? (
                <span className="block truncate font-mono">
                  {failing.map((c) => c.name).join(", ")}
                </span>
              ) : (
                "None at the last run"
              )
            }
          />
          <Metric
            label="Last run"
            value={
              lastRun ? (
                <>
                  {lastRun[0]}
                  <small>{lastRun[1]}</small>
                </>
              ) : (
                "—"
              )
            }
            hint={newest ? `ago, ${newest.c.name}` : "No runs yet"}
          />
        </MetricStrip>
      )}

      {device && (
        <div className="sc-columns">
          <MonitorPanel title="Contracts" description="Pick one to see its evidence" flush>
            <div ref={listRef}>
              {!contracts.length ? (
                <MonitorEmpty
                  compact
                  icon={<ShieldCheck />}
                  title={contractsLoaded ? "No contracts for this router" : "Loading contracts"}
                  action={
                    contractsLoaded ? (
                      <MonitorButton
                        size="sm"
                        icon={<Plus aria-hidden="true" />}
                        disabled={busy}
                        onClick={() => setCreating(true)}
                      >
                        New contract
                      </MonitorButton>
                    ) : undefined
                  }
                >
                  {contractsLoaded
                    ? "Define a bounded service check to collect proof that it works."
                    : undefined}
                </MonitorEmpty>
              ) : (
                contracts.map((c) => {
                  const last = lastOf(c);
                  const on = c.id === contract?.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="monitor-row sc-contract-row"
                      data-selected={on || undefined}
                      aria-pressed={on}
                      onClick={() => setSelected(c.id)}
                    >
                      <span className="sc-contract-cell">
                        <span className="sc-contract-name">
                          <StatusDot tone={last ? TONE[last.status] : "default"} />
                          <span className="p truncate">{c.name}</span>
                        </span>
                        <span className="sc-contract-meta truncate">
                          {plural(c.checks.length, "endpoint")} · max {num(maxLatency(c))} ms
                          {c.packetSuiteId ? " · packet suite" : ""}
                        </span>
                      </span>
                      <span
                        className={
                          last ? `sc-word ${TEXT[last.status]}` : "sc-word text-muted-foreground"
                        }
                      >
                        {last ? STATUS_WORD[last.status] : c.id in history ? "Not run" : "…"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </MonitorPanel>

          {contract && (
            <ContractPanel
              contract={contract}
              runs={runs}
              latest={latest}
              kinds={Object.fromEntries(targets.map((t) => [t.name, t.kind]))}
              busy={busy}
              onHistory={() => {
                setHistoryOpen(true);
                void show(contract.id);
              }}
              onRun={() => void show(contract.id, true)}
            />
          )}
        </div>
      )}

      <MonitorDialog
        variant="drawer"
        open={creating}
        onOpenChange={(open) => !busy && setCreating(open)}
        dismissible={!busy}
        closeDisabled={busy}
        title="New contract"
        description={
          <>
            For <span className="font-mono">{device || "no router"}</span>. Saving never runs
            probes.
          </>
        }
        footer={
          <>
            <MonitorButton variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              type="submit"
              form="sc-new-contract"
              variant="primary"
              disabled={busy || !device || !selectedTargets.length}
            >
              Save contract
            </MonitorButton>
          </>
        }
      >
        <form
          id="sc-new-contract"
          className="monitor-dialog-body sc-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {error && (
            <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
              {error}
            </MonitorNote>
          )}
          <label className="monitor-fl">
            <span className="monitor-label">Contract name</span>
            <input
              className="monitor-input"
              value={name}
              maxLength={120}
              required
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="Branch checkout availability"
            />
          </label>
          <label className="monitor-fl">
            <span className="monitor-label">Maximum latency (ms)</span>
            <input
              className="monitor-input"
              type="number"
              min={1}
              max={10000}
              value={latency}
              required
              disabled={busy}
              onChange={(e) => setLatency(Number(e.target.value))}
            />
          </label>
          <fieldset className="monitor-fl">
            <legend className="monitor-label">Approved endpoints · choose up to ten</legend>
            {!targets.length ? (
              <p className="monitor-hint">
                No endpoints approved. Ask the administrator to set serviceProbes.targets with
                hostnames and allowed IP ranges. Arbitrary URLs are not allowed.
              </p>
            ) : (
              <div className="sc-targets">
                {targets.map((t) => (
                  <label key={t.name} className="monitor-check sc-target">
                    <input
                      type="checkbox"
                      aria-label={t.name}
                      checked={selectedTargets.includes(t.name)}
                      disabled={
                        busy || (!selectedTargets.includes(t.name) && selectedTargets.length >= 10)
                      }
                      onChange={(e) =>
                        setSelectedTargets((v) =>
                          e.target.checked ? [...v, t.name] : v.filter((n) => n !== t.name),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <span className="font-mono text-[12px] text-muted-foreground">{t.kind}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <label className="monitor-fl">
            <span className="monitor-label">Saved packet suite ID · optional</span>
            <input
              className="monitor-input"
              value={suite}
              disabled={busy}
              onChange={(e) => setSuite(e.target.value)}
              placeholder="Fresh-export simulation, not live packet proof"
            />
          </label>
          <p className="monitor-hint">
            HTTPS checks made here expect status 200; MCP supports other explicit codes. Scheduled
            runs are an administrator choice.
          </p>
        </form>
      </MonitorDialog>

      <MonitorDialog
        variant="drawer"
        width={520}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title={contract ? `${contract.name} history` : "History"}
        description={
          <>
            The latest {plural(runs.length, "recorded run")}. A past pass is not a current gate
            result.
            {contract && (
              <span className="mt-1 block font-mono text-[12px] break-all">ID {contract.id}</span>
            )}
          </>
        }
      >
        <div className="monitor-dialog-body sc-history">
          {busy && (
            <p role="status" className="text-[13px] text-muted-foreground">
              Reading history…
            </p>
          )}
          {!busy && !runs.length && (
            <MonitorEmpty compact title="No recorded results">
              Run checks to collect the first one.
            </MonitorEmpty>
          )}
          {runs.map((r) => (
            <article key={r.id} className="monitor-panel">
              <header className="monitor-panel-head">
                <StatusDot tone={TONE[r.status]} />
                <span className={`sc-word ${TEXT[r.status]}`}>{STATUS_WORD[r.status]}</span>
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()} · {num(r.finishedAt - r.startedAt)} ms
                </span>
              </header>
              {r.checks.map((k, i) => (
                <div key={`${k.target}-${i}`} className="monitor-row sc-history-row">
                  <StatusDot tone={TONE[k.status]} />
                  <span className="min-w-0">
                    <span className="block truncate font-mono">{k.target}</span>
                    <span className="block text-[12px] text-muted-foreground">{k.detail}</span>
                  </span>
                  <span className="text-right text-[12px] text-muted-foreground tabular-nums">
                    {num(k.durationMs)} ms
                  </span>
                </div>
              ))}
            </article>
          ))}
        </div>
      </MonitorDialog>
    </section>
  );
}

/** One check row: LED, endpoint and kind, result, time against the limit, detail. */
function CheckRow({
  target,
  kind,
  status,
  durationMs,
  limit,
  detail,
}: {
  target: string;
  kind: string;
  /** Leave out for a check that has not run. */
  status?: RunStatus;
  durationMs?: number;
  limit?: number;
  detail: string;
}): ReactNode {
  const timed = status != null && durationMs != null && durationMs > 0 && kind !== "simulation";
  const over = timed && limit != null && durationMs > limit;
  const width = timed && limit ? Math.min(100, (durationMs / limit) * 100) : 0;
  // A packet suite result is a simulation: its LED is the neutral accent.
  const tone: Tone =
    status == null
      ? "default"
      : kind === "simulation" && status !== "fail"
        ? "brand"
        : TONE[status];
  return (
    <div className="monitor-row sc-check-grid" data-failed={status === "fail" || undefined}>
      <StatusDot tone={tone} />
      <span className="sc-endpoint">
        <span className="p truncate" title={target}>
          <span className="font-mono">{target}</span>
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{kind}</span>
      </span>
      <span className={status ? `font-medium ${TEXT[status]}` : "text-muted-foreground"}>
        {status ? RESULT_WORD[status] : "Not run"}
      </span>
      <span className="monitor-meter">
        <span className="monitor-bar">
          <span data-tone={over ? "bad" : "good"} style={{ width: `${width}%` }} />
        </span>
        <span className="sc-ms">{timed ? `${num(durationMs)} ms` : "—"}</span>
      </span>
      <span className="truncate text-[12px] text-muted-foreground" title={detail}>
        {detail}
      </span>
    </div>
  );
}

/** The selected contract: its last result, each check, and the recent run strip. */
function ContractPanel({
  contract,
  runs,
  latest,
  kinds,
  busy,
  onHistory,
  onRun,
}: {
  contract: ServiceContract;
  runs: ContractRun[];
  latest: ContractRun | undefined;
  /** Target name to probe kind, from the approved target list. */
  kinds: Record<string, string>;
  busy: boolean;
  onHistory: () => void;
  onRun: () => void;
}): ReactNode {
  const rowsRef = useRef<HTMLDivElement>(null);
  useStaggerIn(rowsRef, ".monitor-row", latest?.id ?? contract.id);
  const strip = runs.slice(0, STRIP_RUNS);
  const count = (s: RunStatus): number => strip.filter((r) => r.status === s).length;
  const counts = [
    `${num(count("pass"))} passed`,
    `${num(count("fail"))} failed`,
    ...(count("unknown") ? [`${num(count("unknown"))} unknown`] : []),
  ];
  // "all today" when every run that did not pass happened today.
  const today = new Date().toDateString();
  const misses = strip.filter((r) => r.status !== "pass");
  const allToday =
    misses.length > 0 && misses.every((r) => new Date(r.startedAt).toDateString() === today);
  const stripText = `Last ${plural(strip.length, "run")} · ${counts.join(" · ")}${
    allToday ? ", all today" : ""
  }`;
  const limitOf = (target: string): number | undefined =>
    contract.checks.find((k) => k.target === target)?.maxLatencyMs;
  const noteTone = latest ? NOTE_TONE[latest.status] : undefined;

  return (
    <MonitorPanel
      title={contract.name}
      description={`${plural(contract.checks.length, "endpoint")} must answer within ${num(
        maxLatency(contract),
      )} ms from the MCP host${contract.packetSuiteId ? ", plus a packet suite" : ""}`}
      extra={
        <>
          <MonitorButton
            variant="ghost"
            size="sm"
            icon={<Clock aria-hidden="true" />}
            disabled={busy}
            onClick={onHistory}
          >
            History
          </MonitorButton>
          <MonitorButton
            size="sm"
            icon={<Play aria-hidden="true" />}
            disabled={busy}
            onClick={onRun}
          >
            Run checks
          </MonitorButton>
        </>
      }
      flush
    >
      <div className="sc-note">
        <MonitorNote
          role="status"
          tone={busy ? undefined : noteTone}
          icon={
            busy ? (
              <StatusDot tone="good" pulse />
            ) : latest?.status === "pass" ? undefined : latest ? (
              <TriangleAlert aria-hidden="true" />
            ) : undefined
          }
        >
          {busy ? (
            <>
              <b>Running.</b> Each endpoint can take a few seconds.
            </>
          ) : latest ? (
            <>
              <b>{STATUS_WORD[latest.status]}.</b> {runSummary(latest, contract)}
            </>
          ) : (
            <>
              <b>Not run yet.</b> Run checks to collect proof. History does not replace a fresh
              check.
            </>
          )}
        </MonitorNote>
      </div>

      <div ref={rowsRef}>
        <div className="monitor-thead sc-check-grid">
          <span />
          <span>Endpoint</span>
          <span>Result</span>
          <span>Time vs limit</span>
          <span>Detail</span>
        </div>
        {latest
          ? latest.checks.map((k, i) => (
              <CheckRow
                key={`${k.target}-${i}`}
                target={k.target}
                kind={k.kind}
                status={k.status}
                durationMs={k.durationMs}
                limit={limitOf(k.target)}
                detail={k.detail}
              />
            ))
          : contract.checks.map((k, i) => (
              <CheckRow
                key={`${k.target}-${i}`}
                target={k.target}
                kind={kinds[k.target] ?? "check"}
                detail={`Limit ${num(k.maxLatencyMs)} ms${
                  kinds[k.target] === "https" ? ` · expects ${k.expectedStatus.join(", ")}` : ""
                }`}
              />
            ))}
      </div>

      {strip.length > 0 && (
        <div className="monitor-foot sc-runs">
          <span className="monitor-label">Earlier runs</span>
          <RunStrip runs={runs} height={16} width={9} />
          <span className="flex-1" />
          <span>{stripText}</span>
        </div>
      )}
    </MonitorPanel>
  );
}
