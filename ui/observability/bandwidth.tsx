/**
 * Tunnel bandwidth, after the approved Signal boards: saved tests, throughput
 * history per test, retained runs, the test form in a drawer and a confirm
 * before any traffic starts.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import type {
  BandwidthInventory,
  BandwidthJob,
  BandwidthPreflight,
  BandwidthRun,
  BandwidthState,
} from "../../src/bandwidth/types";
import { api, postJson } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSwitch,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { ThroughputChart } from "./bandwidth-chart";
import type { ThroughputPoint } from "./bandwidth-chart";
import { FormCheck, FormField, FormSelect } from "./path-fields";
import "./monitoring.css";
import "./bandwidth.css";

type Draft = Omit<BandwidthJob, "nextRunAt">;
const emptyJob: Draft = {
  id: "",
  name: "",
  source: "",
  destination: "",
  sourceInterface: "",
  sourceAddress: "",
  destinationAddress: "",
  protocol: "tcp",
  direction: "both",
  durationSeconds: 10,
  localTxBps: 10000000,
  remoteTxBps: 10000000,
  localUdpTxSize: 1500,
  remoteUdpTxSize: 1500,
  randomData: false,
  connectionCount: 1,
  reportIntervalSeconds: 1,
  intervalSeconds: 300,
  enabled: false,
};

const WINDOWS = [
  { value: "1", label: "1 h" },
  { value: "24", label: "24 h" },
  { value: "168", label: "7 d" },
  { value: "all", label: "All" },
];

const RUN_TONE: Record<BandwidthRun["status"], Tone> = {
  ok: "good",
  running: "brand",
  failed: "bad",
  interrupted: "warn",
};

/** Preserve unsuccessful or absent observations as gaps, including in comparisons. */
export function bandwidthMeasurement(
  run: BandwidthRun | undefined,
  key: "txBps" | "rxBps",
): number | null {
  const value = run?.[key];
  return run?.status === "ok" && typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value / 1000000
    : null;
}
/** Summarize retained evidence without treating failures or absent rates as measured zero. */
export function bandwidthStatistics(runs: BandwidthRun[], key: "txBps" | "rxBps") {
  const values = runs.map((run) => bandwidthMeasurement(run, key)).filter((v) => v !== null);
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    max: values.length ? Math.max(...values) : null,
  };
}
/** Mbps without the unit; a dash for missing evidence, never zero. */
function mbps(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 });
}
/** "14:00". */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
/** "17 Nov": the boards write dates day first. */
function dayMonth(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })}`;
}
/** "14:00" today, "17 Nov, 14:00" before. */
function stamp(at: number, now: number): string {
  const day = new Date(at).toDateString() === new Date(now).toDateString();
  if (day) return clock(at);
  return `${dayMonth(at)}, ${clock(at)}`;
}
const DIRECTION_TEXT: Record<BandwidthJob["direction"], string> = {
  both: "both directions",
  transmit: "transmit from the source",
  receive: "receive at the source",
};

/** Cancel obsolete router selections and expose only inventory for the current device. */
function useBandwidthInventory(device: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    device: string;
    attempt: number;
    data?: BandwidthInventory;
    error?: string;
  }>();
  useEffect(() => {
    if (!device) return;
    const controller = new AbortController();
    void api<BandwidthInventory>(
      `/api/bandwidth/options?device=${encodeURIComponent(device)}`,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setResult({ device, attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({
            device,
            attempt,
            error: error instanceof Error ? error.message : "Inventory could not be loaded.",
          });
      });
    return () => controller.abort();
  }, [device, attempt]);
  const current = result?.device === device && result.attempt === attempt ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!device && !current,
    retry: () => setAttempt((value) => value + 1),
  };
}

/** Manage bounded tunnel tests without silently probing routers or generating traffic. */
export function BandwidthView(): ReactNode {
  const [state, setState] = useState<BandwidthState>();
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const [confirmation, setConfirmation] = useState<{ kind: "run" | "delete"; job: BandwidthJob }>();
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyJob, id: crypto.randomUUID() }));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [preflight, setPreflight] = useState<BandwidthPreflight>();
  const sourceInventory = useBandwidthInventory(drawerOpen ? draft.source : "");
  const destinationInventory = useBandwidthInventory(drawerOpen ? draft.destination : "");
  const sourceAddresses =
    sourceInventory.data?.addresses.filter(
      (address) => address.interface === draft.sourceInterface,
    ) ?? [];
  const usableSource = sourceInventory.data?.interfaces.some(
    (iface) => iface.name === draft.sourceInterface && iface.running && !iface.disabled,
  );
  const endpointsReady =
    !!usableSource &&
    sourceAddresses.some((address) => address.address === draft.sourceAddress) &&
    !!destinationInventory.data?.addresses.some(
      (address) => address.address === draft.destinationAddress,
    );
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState("24");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const actionLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let controller: AbortController | undefined;
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      try {
        const result = await api<BandwidthState>("/api/bandwidth", controller.signal);
        if (mounted.current) {
          setState(result);
          setObservedAt(Date.now());
          setPollError("");
        }
      } catch (e) {
        if (mounted.current && !controller.signal.aborted)
          setPollError(e instanceof Error ? e.message : "Could not load saved bandwidth history.");
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      controller?.abort();
    };
  }, []);
  /** Invalidate readiness whenever the test changes; readiness describes one exact draft. */
  function patch(change: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...change }));
    setPreflight(undefined);
    setAck(false);
  }
  /** Serialise explicit actions so double clicks cannot start duplicate traffic. */
  async function action(work: () => Promise<void>, report = setError) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setFormError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) report(e instanceof Error ? e.message : "Bandwidth operation failed.");
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  /** Shared POST helpers preserve validation errors, so check their error envelope here. */
  async function post<T>(path: string, body: unknown): Promise<T> {
    const result = await postJson<T & { error?: string }>(`/api/bandwidth/${path}`, body);
    if (result.error) throw new Error(result.error);
    return result;
  }
  async function refresh() {
    const result = await api<BandwidthState>("/api/bandwidth");
    if (mounted.current) setState(result);
  }
  function edit(job?: BandwidthJob) {
    setPreflight(undefined);
    setAck(false);
    setEditing(!!job);
    setError("");
    setFormError("");
    setAdvancedOpen(false);
    if (job) {
      const { nextRunAt: _next, ...saved } = job;
      setDraft(saved);
    } else setDraft({ ...emptyJob, id: crypto.randomUUID() });
    setDrawerOpen(true);
  }
  function save() {
    if (!ack || !endpointsReady) return;
    void action(async () => {
      await post("save", { job: draft, acknowledgeImpact: true });
      await refresh();
      setEditing(true);
      setAck(false);
      setDrawerOpen(false);
      setNotice(`Saved ${draft.name}.`);
    }, setFormError);
  }

  const runs = state?.runs ?? [];
  const jobs = state?.jobs ?? [];
  const filtered = runs
    .filter(
      (r) =>
        (!selected.length || selected.includes(r.job.id)) &&
        (hours === "all" || r.startedAt >= observedAt - Number(hours) * 3600000),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  const tests = new Map<string, string>();
  for (const job of jobs) tests.set(job.id, job.name);
  for (const run of runs)
    if (!tests.has(run.job.id)) tests.set(run.job.id, `${run.job.name} (deleted)`);
  const visibleTests = [...tests].filter(([id]) => !selected.length || selected.includes(id));

  // Header and KPI figures, from retained runs only.
  const byTime = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const lastGood = byTime.filter((r) => bandwidthMeasurement(r, "txBps") !== null).at(-1);
  const lastGoodTx = bandwidthMeasurement(lastGood, "txBps");
  const day = runs.filter((r) => r.startedAt >= observedAt - 86400000);
  const dayMeasured = day.filter((r) => r.status === "ok").length;
  const dayFailed = day.filter((r) => r.status === "failed" || r.status === "interrupted");
  const failedNames = [...new Set(dayFailed.map((r) => r.job.name))];
  const lastGoodSpark = lastGood
    ? byTime
        .filter((r) => r.job.id === lastGood.job.id)
        .map((r) => bandwidthMeasurement(r, "txBps"))
        .filter((v): v is number => v !== null)
        .slice(-8)
    : [];

  const from =
    hours === "all"
      ? Math.min(observedAt, ...filtered.map((r) => r.startedAt))
      : observedAt - Number(hours) * 3600000;
  const span = observedAt - from;
  const axis = Array.from({ length: 7 }, (_, i) => {
    if (i === 6) return "now";
    const at = from + (span * i) / 6;
    return span > 36 * 3600000 ? dayMonth(at) : clock(at);
  });

  const heading = !state ? undefined : (
    <>
      {jobs.length === 0
        ? "No saved tests yet."
        : `${jobs.length} saved ${jobs.length === 1 ? "test" : "tests"}.`}{" "}
      {lastGoodTx !== null ? (
        <>
          <span className="s">{mbps(lastGoodTx)} Mbps</span> on the last good run.
        </>
      ) : (
        "No good run yet."
      )}
    </>
  );

  const runJob = confirmation?.kind === "run" ? confirmation.job : undefined;
  const deleteJob = confirmation?.kind === "delete" ? confirmation.job : undefined;
  function confirm() {
    if (!confirmation) return;
    const { kind, job } = confirmation;
    void action(async () => {
      await post(kind, {
        id: job.id,
        ...(kind === "run" ? { acknowledgeImpact: true } : {}),
      });
      await refresh();
      if (kind === "delete" && draft.id === job.id) {
        setEditing(false);
        setDraft({ ...emptyJob, id: crypto.randomUUID() });
      }
      setConfirmation(undefined);
      setNotice(
        kind === "run"
          ? `Started ${job.name}. Follow saved history for the result.`
          : `Deleted ${job.name}. Its history stays.`,
      );
    });
  }

  const inventoryLines = (
    [
      ["Source", draft.source, sourceInventory],
      ["Destination", draft.destination, destinationInventory],
    ] as const
  ).flatMap(([label, device, inventory]) =>
    !device
      ? []
      : inventory.loading
        ? [
            <span key={label} role="status" className="monitor-hint">
              Loading {label.toLowerCase()} inventory…
            </span>,
          ]
        : inventory.error
          ? [
              <span key={label} role="alert" className="monitor-err">
                {label}: {inventory.error}
              </span>,
            ]
          : inventory.data && !inventory.data.addresses.length
            ? [
                <span key={label} className="monitor-hint text-warning">
                  {label === "Source"
                    ? "No usable source IPv4 addresses. Interfaces without an enabled address cannot be selected."
                    : "No usable destination IPv4 addresses. Configure the router separately before creating a test."}
                </span>,
              ]
            : [],
  );
  const inventoryFailed = !!sourceInventory.error || !!destinationInventory.error;

  return (
    <div className="bw-page">
      <PageIntro
        eyebrow="Tunnel bandwidth"
        heading={heading}
        lead={`Save bounded tests, compare source TX and RX, and review retained history. History refreshes every 5 seconds without touching a router. Concurrency: ${state?.concurrency ?? "…"}.`}
        actions={
          <MonitorButton
            variant="primary"
            icon={<Plus aria-hidden="true" />}
            disabled={busy}
            onClick={() => edit()}
          >
            New test
          </MonitorButton>
        }
      />
      <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
        <b>Tests generate traffic.</b> They can disrupt service or load the CPU. Source interface
        and address describe the expected main IPv4 route; the path is not forced. This page never
        changes the bandwidth server or firewall.
      </MonitorNote>
      {(error || pollError) && (
        <MonitorNote tone="bad" role="alert">
          {error || pollError}
        </MonitorNote>
      )}
      {notice && (
        <MonitorNote tone="good" role="status">
          {notice}
        </MonitorNote>
      )}
      {!state && (
        <MonitorNote role="status">
          {pollError
            ? "Saved tests unavailable. Retrying every 5 seconds."
            : "Loading saved tests and history…"}
        </MonitorNote>
      )}
      {state && (
        <>
          <MetricStrip label="Bandwidth summary" minCell={200}>
            <Metric
              label="Saved tests"
              value={<Ticker value={jobs.length} format={(n) => String(Math.round(n))} />}
              hint={`${jobs.filter((j) => j.enabled).length} on a schedule`}
            />
            <Metric
              label="Runs in 24 h"
              value={<Ticker value={day.length} format={(n) => String(Math.round(n))} />}
              hint={`${dayMeasured} measured`}
            />
            <Metric
              label="Failed or interrupted"
              value={<Ticker value={dayFailed.length} format={(n) => String(Math.round(n))} />}
              hint={failedNames.length ? failedNames.join(", ") : "None in 24 h"}
              tone={dayFailed.length ? "bad" : "default"}
            />
            <Metric
              label="Latest source TX"
              value={
                lastGoodTx === null ? (
                  "—"
                ) : (
                  <>
                    {mbps(lastGoodTx)}
                    <small>Mbps</small>
                  </>
                )
              }
              hint={
                lastGood
                  ? `${lastGood.job.name} · ${stamp(lastGood.startedAt, observedAt)}`
                  : "No measured run yet"
              }
              spark={lastGoodSpark}
            />
          </MetricStrip>

          <section className="bw-tests" aria-label="Saved bandwidth tests">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold text-foreground">Saved tests</h2>
              <span className="monitor-hint">
                Run asks you to confirm the traffic impact first.
              </span>
            </div>
            {!jobs.length ? (
              <div className="glass">
                <MonitorEmpty
                  icon={<Plus />}
                  title="No saved tests"
                  action={
                    <MonitorButton
                      size="sm"
                      icon={<Plus aria-hidden="true" />}
                      onClick={() => edit()}
                    >
                      New test
                    </MonitorButton>
                  }
                >
                  Create a test, check readiness, then run it when you choose.
                </MonitorEmpty>
              </div>
            ) : (
              <div className="bw-test-grid">
                {jobs.map((job) => {
                  const latest = byTime.filter((r) => r.job.id === job.id).at(-1);
                  const running = runs.some((r) => r.job.id === job.id && r.status === "running");
                  return (
                    <article key={job.id} className="glass bw-test">
                      <div className="flex items-center gap-2">
                        <b className="min-w-0 flex-1 truncate font-mono text-[13px] font-bold text-foreground">
                          {job.name}
                        </b>
                        {latest && (
                          <StatusBadge
                            tone={RUN_TONE[latest.status]}
                            pulse={latest.status === "running"}
                          >
                            {latest.status === "ok"
                              ? `ok · ${clock(latest.startedAt)}`
                              : latest.status}
                          </StatusBadge>
                        )}
                      </div>
                      <span className="truncate font-mono text-[12px] text-fg-secondary">
                        {job.source} → {job.destination}
                      </span>
                      <span className="truncate font-mono text-[12px] text-muted-foreground">
                        {job.sourceInterface} · {job.sourceAddress} → {job.destinationAddress}
                      </span>
                      <span className="text-[13px] text-fg-secondary">
                        {job.protocol.toUpperCase()} · {job.direction} · {job.durationSeconds} s ·{" "}
                        {job.enabled ? (
                          <span className="text-success">
                            Every {job.intervalSeconds} s; next {clock(job.nextRunAt)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Schedule disabled</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5 pt-1">
                        {running ? (
                          <MonitorButton
                            size="sm"
                            className="bw-running"
                            icon={<Play aria-hidden="true" />}
                            disabled
                            aria-label={`Run ${job.name}`}
                          >
                            Running…
                          </MonitorButton>
                        ) : (
                          <MonitorButton
                            size="sm"
                            variant="primary"
                            icon={<Play aria-hidden="true" />}
                            disabled={busy}
                            aria-label={`Run ${job.name}`}
                            onClick={() => setConfirmation({ kind: "run", job })}
                          >
                            Run
                          </MonitorButton>
                        )}
                        <MonitorButton
                          size="sm"
                          icon={<Pencil aria-hidden="true" />}
                          disabled={busy}
                          aria-label={`Edit ${job.name}`}
                          onClick={() => edit(job)}
                        >
                          Edit
                        </MonitorButton>
                        {job.enabled && (
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Disable ${job.name}`}
                            onClick={() =>
                              void action(async () => {
                                const { nextRunAt: _next, ...saved } = job;
                                await post("save", {
                                  job: { ...saved, enabled: false },
                                  acknowledgeImpact: true,
                                });
                                await refresh();
                                setNotice(`Disabled ${job.name}.`);
                              })
                            }
                          >
                            Disable
                          </MonitorButton>
                        )}
                        <span className="flex-1" />
                        <MonitorButton
                          size="sm"
                          variant="ghost"
                          icon={<Trash2 aria-hidden="true" />}
                          disabled={busy}
                          aria-label={`Delete ${job.name}`}
                          title="Delete"
                          onClick={() => setConfirmation({ kind: "delete", job })}
                        />
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <MonitorPanel
        title="Throughput history and comparison"
        description="TX leaves the source router; RX arrives at it. Failed or missing results are gaps, never zero. Different protocols, durations or caps are not like-for-like."
        extra={
          <Segmented label="History window" value={hours} options={WINDOWS} onChange={setHours} />
        }
        aria-label="Bandwidth throughput history"
      >
        <div className="flex flex-col gap-3.5">
          {tests.size > 0 && (
            <div role="group" aria-label="Tests" className="flex flex-wrap items-center gap-4">
              <span className="monitor-label">Tests</span>
              {[...tests].map(([id, name]) => (
                <FormCheck
                  key={id}
                  label={name}
                  checked={selected.includes(id)}
                  onChange={(checked) =>
                    setSelected((s) => (checked ? [...s, id] : s.filter((v) => v !== id)))
                  }
                >
                  {name}
                </FormCheck>
              ))}
              <span className="monitor-hint">None selected shows all.</span>
            </div>
          )}
          {!filtered.length && (
            <MonitorEmpty compact title="No retained runs match this selection and time window." />
          )}
          {visibleTests.map(([id, name]) => {
            const testRuns = filtered.filter((r) => r.job.id === id);
            // A test with no run in the window has nothing to chart.
            if (!testRuns.length) return null;
            const latest = testRuns.at(-1);
            const successes = testRuns.filter((r) => r.status === "ok").length;
            const failures = testRuns.filter(
              (r) => r.status === "failed" || r.status === "interrupted",
            ).length;
            const points: ThroughputPoint[] = testRuns.map((r) => ({
              at: r.startedAt,
              tx: bandwidthMeasurement(r, "txBps"),
              rx: bandwidthMeasurement(r, "rxBps"),
              failed: r.status === "failed" || r.status === "interrupted",
            }));
            return (
              <article key={id} className="flex flex-col gap-3.5">
                <b className="font-mono text-[13px] font-bold text-foreground">{name}</b>
                <div className="bw-history">
                  <div className="flex min-w-0 flex-col gap-3.5">
                    <ThroughputChart
                      points={points}
                      from={from}
                      to={observedAt}
                      labels={axis}
                      drawKey={`${id}-${hours}`}
                    />
                    <span className="monitor-legend">
                      <span>
                        <i className="bg-sig" />
                        Source TX Mbps
                      </span>
                      <span>
                        <i className="bg-brand" />
                        Source RX Mbps
                      </span>
                      <span>
                        <i className="bg-destructive" />
                        failed run · gap, not zero
                      </span>
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <div className="glass flex flex-col gap-1 px-3.5 py-3">
                      <span className="monitor-hint">
                        Latest ·{" "}
                        {latest
                          ? `${stamp(latest.startedAt, observedAt)} · ${latest.status}`
                          : "no run"}
                      </span>
                      <span className="bw-latest tabular-nums">
                        {mbps(bandwidthMeasurement(latest, "txBps"))} <small>Mbps TX</small> ·{" "}
                        {mbps(bandwidthMeasurement(latest, "rxBps"))} <small>RX</small>
                      </span>
                      <span className="monitor-hint">
                        Successful {successes} · failed or interrupted {failures} · running{" "}
                        {testRuns.length - successes - failures}
                      </span>
                    </div>
                    <div className="glass overflow-hidden">
                      <table className="bw-table bw-stats">
                        <caption>Selected window · source view, Mbps</caption>
                        <thead>
                          <tr className="monitor-thead">
                            {["Direction", "Runs", "Min", "Mean", "Max"].map((h) => (
                              <th scope="col" key={h}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(["txBps", "rxBps"] as const).map((key) => {
                            const stats = bandwidthStatistics(testRuns, key);
                            return (
                              <tr key={key} className="monitor-row">
                                <th scope="row">Source {key === "txBps" ? "TX" : "RX"}</th>
                                <td>{stats.count}</td>
                                <td>{mbps(stats.min)}</td>
                                <td>{mbps(stats.mean)}</td>
                                <td>{mbps(stats.max)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </MonitorPanel>

      {filtered.length > 0 && (
        <MonitorPanel title="Retained runs" description="Source view, Mbps. Newest first." flush>
          <div className="overflow-x-auto">
            <table className="bw-table bw-runs">
              <thead>
                <tr className="monitor-thead">
                  {["Test", "Started", "Status", "Source TX", "Source RX", "Loss", "Result"].map(
                    (h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {[...filtered].reverse().map((r) => (
                  <tr
                    key={r.id}
                    className="monitor-row"
                    data-selected={r.status === "running" || undefined}
                    data-failed={r.status === "failed" || undefined}
                  >
                    <th scope="row" className="p truncate font-mono text-[12px]">
                      {r.job.name}
                    </th>
                    <td className="font-mono text-[12px] text-muted-foreground">
                      {stamp(r.startedAt, observedAt)}
                    </td>
                    <td>
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <StatusDot tone={RUN_TONE[r.status]} />
                        <span className="truncate">
                          {r.status} · {r.trigger}
                        </span>
                      </span>
                    </td>
                    <td className="tabular-nums">{mbps(bandwidthMeasurement(r, "txBps"))}</td>
                    <td className="tabular-nums">{mbps(bandwidthMeasurement(r, "rxBps"))}</td>
                    <td className="tabular-nums">
                      {r.status === "ok"
                        ? (r.lostPackets ?? "Missing")
                        : r.status === "running"
                          ? "—"
                          : "Missing"}
                    </td>
                    <td
                      className={
                        r.status === "failed"
                          ? "truncate text-destructive"
                          : r.status === "interrupted"
                            ? "truncate text-warning"
                            : r.status === "running"
                              ? "truncate text-muted-foreground"
                              : "truncate"
                      }
                      title={r.message}
                    >
                      {r.message || (r.status === "running" ? "Collecting" : "Completed")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </MonitorPanel>
      )}

      <MonitorDialog
        variant="drawer"
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setDrawerOpen(false);
        }}
        dismissible={false}
        closeDisabled={busy}
        title={editing ? "Edit test" : "New test"}
        description="Readiness uses live reads. Saving never configures either router."
        footer={
          <>
            <MonitorButton variant="ghost" disabled={busy} onClick={() => setDrawerOpen(false)}>
              Cancel
            </MonitorButton>
            <span className="flex-1" />
            <MonitorButton
              type="submit"
              form="bw-test-form"
              variant="primary"
              icon={<Check aria-hidden="true" />}
              disabled={busy || !ack || !endpointsReady}
            >
              Save test
            </MonitorButton>
          </>
        }
      >
        <form
          id="bw-test-form"
          className="monitor-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
            <legend className="sr-only">Bandwidth test definition</legend>
            {formError && (
              <MonitorNote tone="bad" role="alert">
                {formError}
              </MonitorNote>
            )}
            <FormField label="Name">
              <input
                required
                className="monitor-input font-mono text-[12px]"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </FormField>
            <div className="bw-pair">
              <FormField label="Source router">
                <FormSelect
                  mono
                  label="Source router"
                  value={draft.source}
                  options={(state?.devices ?? []).map((d) => ({ value: d, label: d }))}
                  onChange={(source) => patch({ source, sourceInterface: "", sourceAddress: "" })}
                />
              </FormField>
              <FormField label="Destination router">
                <FormSelect
                  mono
                  label="Destination router"
                  value={draft.destination}
                  options={(state?.devices ?? []).map((d) => ({ value: d, label: d }))}
                  onChange={(destination) => patch({ destination, destinationAddress: "" })}
                />
              </FormField>
            </div>
            <div className="bw-pair">
              <FormField label="Expected source interface">
                <FormSelect
                  mono
                  label="Expected source interface"
                  value={draft.sourceInterface}
                  disabled={busy || sourceInventory.loading || !sourceInventory.data}
                  options={(sourceInventory.data?.interfaces ?? []).map((iface) => {
                    const hasAddress = sourceInventory.data!.addresses.some(
                      (address) => address.interface === iface.name,
                    );
                    const reason = iface.disabled
                      ? "disabled"
                      : !iface.running
                        ? "not running"
                        : !hasAddress
                          ? "no usable IPv4 address"
                          : "";
                    return {
                      value: iface.name,
                      label: `${iface.name}${reason ? ` — ${reason}` : ""}`,
                      disabled: !!reason,
                    };
                  })}
                  onChange={(sourceInterface) => patch({ sourceInterface, sourceAddress: "" })}
                />
              </FormField>
              <FormField label="Expected source IPv4">
                <FormSelect
                  mono
                  label="Expected source IPv4"
                  value={draft.sourceAddress}
                  disabled={busy || !usableSource || !sourceAddresses.length}
                  options={[...new Set(sourceAddresses.map((a) => a.address))].map((a) => ({
                    value: a,
                    label: a,
                  }))}
                  onChange={(sourceAddress) => patch({ sourceAddress })}
                />
              </FormField>
            </div>
            <div className="monitor-fl">
              <FormField label="Destination IPv4 (explicit)">
                <FormSelect
                  mono
                  label="Destination IPv4 (explicit)"
                  value={draft.destinationAddress}
                  disabled={
                    busy ||
                    destinationInventory.loading ||
                    !destinationInventory.data?.addresses.length
                  }
                  options={[
                    ...new Map(
                      destinationInventory.data?.addresses.map((address) => [
                        address.address,
                        {
                          value: address.address,
                          label: address.address,
                        },
                      ]) ?? [],
                    ).values(),
                  ]}
                  onChange={(destinationAddress) => patch({ destinationAddress })}
                />
              </FormField>
              <span className="monitor-hint">
                Interfaces and addresses read from both routers · cached 30 s.{" "}
                <button
                  type="button"
                  className="bw-link"
                  disabled={busy || sourceInventory.loading || destinationInventory.loading}
                  onClick={() => {
                    if (draft.source) sourceInventory.retry();
                    if (draft.destination) destinationInventory.retry();
                  }}
                >
                  {inventoryFailed ? "Retry inventory" : "Refresh inventory"}
                </button>
              </span>
              {inventoryLines}
            </div>
            <div className="bw-pair">
              <FormField label="Protocol" group>
                <Segmented
                  label="Protocol"
                  value={draft.protocol}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                  ]}
                  onChange={(protocol) => patch({ protocol })}
                />
              </FormField>
              <FormField label="Direction from source" group>
                <Segmented
                  label="Direction from source"
                  value={draft.direction}
                  options={[
                    { value: "transmit", label: "transmit" },
                    { value: "receive", label: "receive" },
                    { value: "both", label: "both" },
                  ]}
                  onChange={(direction) => patch({ direction })}
                />
              </FormField>
            </div>
            <div className="bw-pair">
              {(
                [
                  {
                    key: "durationSeconds",
                    label: "Duration · seconds",
                    min: 5,
                    max: 60,
                    hint: "5 to 60",
                  },
                  {
                    key: "intervalSeconds",
                    label: "Schedule interval · seconds",
                    min: 300,
                    max: 604800,
                  },
                  {
                    key: "localTxBps",
                    label: "Source TX limit · bits/s",
                    min: 1,
                    max: 100000000000,
                  },
                  {
                    key: "remoteTxBps",
                    label: "Remote TX limit · bits/s",
                    min: 1,
                    max: 100000000000,
                  },
                ] as const
              ).map((field) => (
                <FormField
                  key={field.key}
                  label={field.label}
                  hint={"hint" in field ? field.hint : undefined}
                >
                  <input
                    type="number"
                    required
                    step={1}
                    min={field.min}
                    max={field.max}
                    className="monitor-input font-mono text-[12px]"
                    value={draft[field.key]}
                    onChange={(e) => patch({ [field.key]: e.target.valueAsNumber })}
                  />
                </FormField>
              ))}
            </div>
            <div className="glass overflow-hidden">
              <button
                type="button"
                className="bw-disclosure"
                aria-expanded={advancedOpen}
                aria-controls="bw-advanced"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <ChevronRight aria-hidden="true" data-open={advancedOpen || undefined} />
                <span className="flex-1">Packet sizes, connections, reporting and payload</span>
              </button>
              <div
                id="bw-advanced"
                hidden={!advancedOpen}
                onInvalidCapture={() => setAdvancedOpen(true)}
                className="flex flex-col gap-3 border-t border-line px-[18px] pt-3 pb-4"
              >
                <p className="monitor-hint">
                  Packet sizes apply to UDP; connection count applies to TCP. Values are kept while
                  this section is closed.
                </p>
                <FormField label="Test ID (automatic)">
                  <input
                    value={draft.id}
                    readOnly
                    className="monitor-input font-mono text-[12px] text-muted-foreground"
                  />
                </FormField>
                <div className="bw-pair">
                  {(
                    [
                      {
                        key: "localUdpTxSize",
                        label: "Source UDP TX size · bytes",
                        min: 28,
                        max: 64000,
                      },
                      {
                        key: "remoteUdpTxSize",
                        label: "Remote UDP TX size · bytes",
                        min: 28,
                        max: 64000,
                      },
                      { key: "connectionCount", label: "TCP connection count", min: 1, max: 255 },
                      {
                        key: "reportIntervalSeconds",
                        label: "Report interval · seconds",
                        min: 0.02,
                        max: 5,
                      },
                    ] as const
                  ).map((field) => (
                    <FormField key={field.key} label={field.label}>
                      <input
                        type="number"
                        required
                        step={field.key === "reportIntervalSeconds" ? 0.001 : 1}
                        min={field.min}
                        max={field.max}
                        className="monitor-input font-mono text-[12px]"
                        value={draft[field.key]}
                        onChange={(e) => patch({ [field.key]: e.target.valueAsNumber })}
                      />
                    </FormField>
                  ))}
                </div>
                <FormCheck
                  checked={draft.randomData}
                  disabled={busy}
                  label="Generate random data"
                  onChange={(randomData) => patch({ randomData })}
                >
                  Generate random data
                </FormCheck>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex">
                <MonitorSwitch
                  label="Enable recurring traffic"
                  checked={draft.enabled}
                  disabled={busy}
                  onChange={(enabled) => patch({ enabled })}
                />
              </span>
              <span className="text-[13px] text-foreground">
                Enable recurring traffic
                <span className="monitor-hint block">
                  Off by default. Runs every {draft.intervalSeconds} s once saved.
                </span>
              </span>
            </div>
            <div className="glass flex flex-col gap-1.5 px-3.5 py-3" role="status">
              <span className="flex items-center gap-2">
                <b
                  className={
                    !preflight
                      ? "text-[13px] font-bold text-muted-foreground"
                      : preflight.ready
                        ? "text-[13px] font-bold text-success"
                        : "text-[13px] font-bold text-destructive"
                  }
                >
                  {!preflight
                    ? "Not checked yet"
                    : preflight.ready
                      ? "Ready at last check"
                      : "Not ready"}
                </b>
                <span className="flex-1" />
                <MonitorButton
                  size="sm"
                  icon={<RefreshCw aria-hidden="true" />}
                  disabled={
                    busy ||
                    !draft.source ||
                    !draft.destination ||
                    !draft.destinationAddress ||
                    !draft.sourceAddress ||
                    !draft.sourceInterface
                  }
                  onClick={() =>
                    void action(async () => {
                      setPreflight(await post<BandwidthPreflight>("preflight", { job: draft }));
                    }, setFormError)
                  }
                >
                  Check readiness
                </MonitorButton>
              </span>
              {preflight?.checks.map((c, i) => (
                <span key={i} className="bw-check" data-ok={c.ok || undefined}>
                  {c.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                  <span className="sr-only">{c.ok ? "Pass" : "Fail"}: </span>
                  {c.message || c.name}
                </span>
              ))}
              {preflight?.warning && <span className="monitor-hint">{preflight.warning}</span>}
            </div>
            <FormCheck
              checked={ack}
              disabled={busy}
              label="I acknowledge the traffic impact"
              onChange={setAck}
            >
              I acknowledge the traffic impact
            </FormCheck>
          </fieldset>
        </form>
      </MonitorDialog>

      <MonitorDialog
        open={!!runJob}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(undefined);
        }}
        closeDisabled={busy}
        width={520}
        title="Run bandwidth test?"
        description="Traffic starts as soon as you confirm. Follow saved history for the result."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Play aria-hidden="true" />}
              disabled={busy}
              onClick={confirm}
            >
              Acknowledge impact and run
            </MonitorButton>
          </>
        }
      >
        {runJob && (
          <div className="monitor-dialog-body flex flex-col gap-3.5">
            <dl className="monitor-facts">
              <dt>Test</dt>
              <dd className="font-mono text-[12px] text-foreground">{runJob.name}</dd>
              <dt>Path</dt>
              <dd className="font-mono text-[12px]">
                {runJob.source} → {runJob.destination} · {runJob.sourceInterface}
              </dd>
              <dt>Traffic</dt>
              <dd>
                {runJob.protocol.toUpperCase()} for {runJob.durationSeconds} s,{" "}
                {DIRECTION_TEXT[runJob.direction]}
              </dd>
              <dt>Source TX limit</dt>
              <dd className="font-mono text-[12px]">
                {runJob.localTxBps.toLocaleString("en-US")} bps
              </dd>
              <dt>Remote TX limit</dt>
              <dd className="font-mono text-[12px]">
                {runJob.remoteTxBps.toLocaleString("en-US")} bps
              </dd>
            </dl>
            <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />}>
              <b>This can disrupt service.</b> The expected path is not forced; policy routing and
              firewall rules may send traffic elsewhere.
            </MonitorNote>
          </div>
        )}
      </MonitorDialog>

      <MonitorDialog
        open={!!deleteJob}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(undefined);
        }}
        closeDisabled={busy}
        width={520}
        title="Delete test definition?"
        description="Retained run history stays available."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Trash2 aria-hidden="true" />}
              disabled={busy}
              onClick={confirm}
            >
              Delete definition
            </MonitorButton>
          </>
        }
      >
        {deleteJob && (
          <p className="monitor-dialog-body text-[13px] text-fg-secondary">
            Remove <b className="font-mono text-[12px] text-foreground">{deleteJob.name}</b>. No
            router changes.
          </p>
        )}
      </MonitorDialog>
    </div>
  );
}
