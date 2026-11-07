import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type {
  BandwidthJob,
  BandwidthPreflight,
  BandwidthRun,
  BandwidthState,
} from "../../src/bandwidth/types";
import { api, postJson } from "./api";
import { WorkspaceError, WorkspaceSafety } from "./operations-ui";

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
const chartConfig = {
  tx: { label: "Source TX Mbps", color: "var(--chart-1)" },
  rx: { label: "Source RX Mbps", color: "var(--chart-2)" },
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
/** Report measured zero distinctly from missing evidence. */
function rate(value: number | null): string {
  return value === null
    ? "Missing"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} Mbps`;
}
/** Reuse dashboard selects while keeping every control associated with its label. */
function Choice({
  label,
  value,
  values,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="grid gap-2 text-sm">
      {label}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {values.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
/** Manage bounded tunnel tests without silently probing routers or generating traffic. */
export function BandwidthView(): ReactNode {
  const [state, setState] = useState<BandwidthState>();
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const [confirmation, setConfirmation] = useState<{ kind: "run" | "delete"; job: BandwidthJob }>();
  const [draft, setDraft] = useState<Draft>({ ...emptyJob });
  const [editing, setEditing] = useState(false);
  const [preflight, setPreflight] = useState<BandwidthPreflight>();
  const [addresses, setAddresses] = useState<{ interface: string; address: string }[]>();
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState("24");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const sourceRevision = useRef(0);
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
  async function action(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Bandwidth operation failed.");
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
    sourceRevision.current++;
    setAddresses(undefined);
    setPreflight(undefined);
    setAck(false);
    setEditing(!!job);
    setError("");
    if (job) {
      const { nextRunAt: _next, ...saved } = job;
      setDraft(saved);
    } else setDraft({ ...emptyJob });
  }
  const filtered = (state?.runs ?? [])
    .filter(
      (r) =>
        (!selected.length || selected.includes(r.job.id)) &&
        (hours === "all" || r.startedAt >= observedAt - Number(hours) * 3600000),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  const tests = new Map<string, string>();
  for (const job of state?.jobs ?? []) tests.set(job.id, job.name);
  for (const run of state?.runs ?? [])
    if (!tests.has(run.job.id)) tests.set(run.job.id, `${run.job.name} (deleted)`);
  const visibleTests = [...tests].filter(([id]) => !selected.length || selected.includes(id));
  return (
    <div className="space-y-6">
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === "run" ? "Run bandwidth test?" : "Delete test definition?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === "run"
                ? `${confirmation.job.name}: generate ${confirmation.job.protocol.toUpperCase()} traffic for ${confirmation.job.durationSeconds}s (${confirmation.job.direction}), up to source TX ${confirmation.job.localTxBps} bps and remote TX ${confirmation.job.remoteTxBps} bps. This can disrupt service. The expected path is not forced.`
                : `${confirmation?.job.name ?? ""}: remove this saved definition. Retained run history stays available.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!confirmation) return;
                const { kind, job } = confirmation;
                void action(async () => {
                  await post(kind, {
                    id: job.id,
                    ...(kind === "run" ? { acknowledgeImpact: true } : {}),
                  });
                  await refresh();
                  if (kind === "delete" && draft.id === job.id) edit();
                  setNotice(
                    kind === "run"
                      ? `Started ${job.name}; follow saved history for the result.`
                      : `Deleted ${job.name}; history retained.`,
                  );
                });
              }}
            >
              {confirmation?.kind === "run" ? "Acknowledge impact & run" : "Delete definition"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <header className="space-y-2">
        <h2 className="text-xl font-semibold">Tunnel bandwidth</h2>
        <p className="text-sm text-muted-foreground">
          Save multiple bounded tests, compare source TX/RX and review retained history. History
          refreshes every 5 seconds without router I/O. Concurrency: {state?.concurrency ?? "…"}.
        </p>
      </header>
      <WorkspaceSafety>
        Tests generate traffic and can disrupt service or consume CPU. Source interface and address
        describe the expected main IPv4 route, not a binding. The path is not forced; policy routing
        and firewall rules may affect it. Runtime destination credentials are used; this page never
        changes the bandwidth server or firewall.
      </WorkspaceSafety>
      <WorkspaceError message={error || pollError} />
      {notice && <p role="status">{notice}</p>}
      {!state && (
        <p role="status">
          {pollError
            ? "Saved tests unavailable. Retrying every 5 seconds."
            : "Loading saved tests and history…"}
        </p>
      )}
      {state && (
        <section className="space-y-3" aria-label="Saved bandwidth tests">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Saved tests</h3>
            <Button variant="outline" disabled={busy} onClick={() => edit()}>
              New test
            </Button>
          </div>
          {!state.jobs.length && (
            <p className="text-muted-foreground">
              No saved tests. Create a disabled test below, check its expected route, then
              explicitly run it.
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {state.jobs.map((job) => (
              <article key={job.id} className="rounded-xl border border-border p-4 space-y-3">
                <h4 className="font-semibold">{job.name}</h4>
                <p className="text-sm">
                  {job.source} → {job.destination} · {job.sourceInterface} ·{" "}
                  {job.destinationAddress}
                </p>
                <p className="text-sm">
                  {job.protocol.toUpperCase()} · {job.direction} · {job.durationSeconds}s ·{" "}
                  {job.enabled
                    ? `Every ${job.intervalSeconds}s; next ${new Date(job.nextRunAt).toLocaleString()}`
                    : "Schedule disabled"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => edit(job)}>
                    Edit {job.name}
                  </Button>
                  {job.enabled && (
                    <Button
                      variant="outline"
                      disabled={busy}
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
                      Disable {job.name}
                    </Button>
                  )}
                  <Button
                    disabled={
                      busy || state.runs.some((r) => r.job.id === job.id && r.status === "running")
                    }
                    onClick={() => setConfirmation({ kind: "run", job })}
                  >
                    Run {job.name}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmation({ kind: "delete", job })}
                  >
                    Delete {job.name}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      <form
        className="rounded-xl border border-border p-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ack) return;
          void action(async () => {
            await post("save", { job: draft, acknowledgeImpact: true });
            await refresh();
            setEditing(true);
            setAck(false);
            setNotice(`Saved ${draft.name}.`);
          });
        }}
      >
        <h3 className="font-semibold">{editing ? "Edit test" : "Create test"}</h3>
        <fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
          <legend className="sr-only">Bandwidth test definition</legend>
          <label className="grid gap-2 text-sm">
            Stable test ID
            <Input
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="home-tunnel"
              value={draft.id}
              disabled={editing}
              onChange={(e) => patch({ id: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Name
            <Input required value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <Choice
            label="Source router"
            value={draft.source}
            values={state?.devices ?? []}
            onChange={(source) => {
              sourceRevision.current++;
              setAddresses(undefined);
              patch({ source, sourceInterface: "", sourceAddress: "" });
            }}
          />
          <Choice
            label="Destination router"
            value={draft.destination}
            values={state?.devices ?? []}
            onChange={(destination) => patch({ destination })}
          />
          <label className="grid gap-2 text-sm">
            Expected source interface
            <Input
              required
              value={draft.sourceInterface}
              onChange={(e) => patch({ sourceInterface: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Expected source IPv4
            <Input
              required
              pattern="([0-9]{1,3}\.){3}[0-9]{1,3}"
              value={draft.sourceAddress}
              onChange={(e) => patch({ sourceAddress: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Destination IPv4 (explicit)
            <Input
              required
              pattern="([0-9]{1,3}\.){3}[0-9]{1,3}"
              value={draft.destinationAddress}
              onChange={(e) => patch({ destinationAddress: e.target.value })}
            />
          </label>
          <Choice
            label="Protocol"
            value={draft.protocol}
            values={["tcp", "udp"]}
            onChange={(protocol) => patch({ protocol: protocol as Draft["protocol"] })}
          />
          <Choice
            label="Direction (from source)"
            value={draft.direction}
            values={["transmit", "receive", "both"]}
            onChange={(direction) => patch({ direction: direction as Draft["direction"] })}
          />
          {(
            [
              { key: "durationSeconds", label: "Duration (seconds)", min: 5, max: 60 },
              {
                key: "intervalSeconds",
                label: "Schedule interval (seconds)",
                min: 300,
                max: 604800,
              },
              {
                key: "localTxBps",
                label: "Source TX limit (bits/second)",
                min: 1,
                max: 100000000000,
              },
              {
                key: "remoteTxBps",
                label: "Remote TX / source RX limit (bits/second)",
                min: 1,
                max: 100000000000,
              },
              { key: "localUdpTxSize", label: "Source UDP TX size (bytes)", min: 28, max: 64000 },
              { key: "remoteUdpTxSize", label: "Remote UDP TX size (bytes)", min: 28, max: 64000 },
              { key: "connectionCount", label: "TCP connection count", min: 1, max: 255 },
              {
                key: "reportIntervalSeconds",
                label: "Report interval (seconds)",
                min: 0.02,
                max: 5,
              },
            ] as const
          ).map((field) => (
            <label key={field.key} className="grid gap-2 text-sm">
              {field.label}
              <Input
                type="number"
                required
                step={field.key === "reportIntervalSeconds" ? 0.001 : 1}
                min={field.min}
                max={field.max}
                value={draft[field.key]}
                onChange={(e) => patch({ [field.key]: e.target.valueAsNumber })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.randomData}
              onChange={(e) => patch({ randomData: e.target.checked })}
            />
            Generate random data
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enable recurring traffic (off by default)
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !draft.source}
            onClick={() =>
              void action(async () => {
                const revision = sourceRevision.current;
                const result = await api<{ addresses: { interface: string; address: string }[] }>(
                  `/api/bandwidth/options?device=${encodeURIComponent(draft.source)}`,
                );
                if (revision === sourceRevision.current) setAddresses(result.addresses);
              })
            }
          >
            Load live source addresses
          </Button>
          <Button
            type="button"
            variant="outline"
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
              })
            }
          >
            Check readiness (live reads)
          </Button>
        </div>
        {addresses && (
          <div className="space-y-2">
            <p className="text-sm">Live IPv4 addresses — select the expected route source:</p>
            {!addresses.length && <p>No live addresses returned.</p>}
            {addresses.map((a, index) => (
              <Button
                key={`${a.interface}-${a.address}-${index}`}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  patch({ sourceInterface: a.interface, sourceAddress: a.address.split("/")[0] })
                }
              >
                {a.interface}: {a.address}
              </Button>
            ))}
          </div>
        )}
        {preflight && (
          <div role="status" className="space-y-2">
            <strong>{preflight.ready ? "Ready at last check" : "Not ready"}</strong>
            <ul>
              {preflight.checks.map((c, i) => (
                <li key={i}>
                  {c.ok ? "Pass" : "Fail"} · {c.name}: {c.message}
                </li>
              ))}
            </ul>
            <p>{preflight.warning}</p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Readiness checks source address/interface, destination ownership, active main IPv4 route
          and expected interface/preferred source when present, plus bandwidth server and runtime
          authentication. It does not configure either router.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ack}
            disabled={busy}
            onChange={(e) => setAck(e.target.checked)}
            required
          />
          I acknowledge the traffic impact
          {draft.enabled ? " of enabling this recurring test" : "; this definition stays disabled"}.
        </label>
        <Button type="submit" disabled={busy || !ack || !draft.source || !draft.destination}>
          Save test
        </Button>
      </form>
      <section className="space-y-4" aria-label="Bandwidth throughput history">
        <h3 className="font-semibold">Throughput history & comparison</h3>
        <Choice
          label="History window"
          value={hours}
          values={["1", "24", "168", "all"]}
          onChange={setHours}
        />
        <p className="text-sm text-muted-foreground">
          Window in hours. TX leaves the source router; RX arrives at the source. Missing/failed
          results are gaps, never zero. Statistics use all retained runs per selected test within
          this window. Failed and missing measurements are excluded from rate statistics. Different
          protocols, durations or rate caps are not like-for-like comparisons; edited test settings
          can also differ between retained runs.
        </p>
        <fieldset className="flex flex-wrap gap-4">
          <legend>Select tests (none selected means all)</legend>
          {[...tests].map(([id, name]) => (
            <label key={id} className="flex gap-2 items-center text-sm">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(e) =>
                  setSelected((s) => (e.target.checked ? [...s, id] : s.filter((v) => v !== id)))
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
        {!filtered.length && (
          <p role="status">No retained runs match this selection and time window.</p>
        )}
        {visibleTests.map(([id, name]) => {
          const runs = filtered.filter((r) => r.job.id === id);
          const latest = runs.at(-1);
          const successes = runs.filter((r) => r.status === "ok").length;
          const failures = runs.filter(
            (r) => r.status === "failed" || r.status === "interrupted",
          ).length;
          return (
            <article key={id} className="rounded-xl border border-border p-4 space-y-2">
              <h4 className="font-semibold">{name}</h4>
              <p className="text-sm">
                Latest source TX: {rate(bandwidthMeasurement(latest, "txBps"))} · Source RX:{" "}
                {rate(bandwidthMeasurement(latest, "rxBps"))} ·{" "}
                {latest?.status ?? "No run in window"}
              </p>
              <p className="text-sm">
                Successful: {successes} · Failed/interrupted: {failures} · Running:{" "}
                {runs.length - successes - failures}
              </p>
              <table className="w-full text-left text-sm">
                <caption className="text-left">
                  Selected window statistics — source perspective
                </caption>
                <thead>
                  <tr>
                    {["Direction", "Measured runs", "Min", "Mean", "Max"].map((heading) => (
                      <th scope="col" key={heading}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(["txBps", "rxBps"] as const).map((key) => {
                    const stats = bandwidthStatistics(runs, key);
                    return (
                      <tr key={key}>
                        <th scope="row">Source {key === "txBps" ? "TX" : "RX"}</th>
                        <td>{stats.count}</td>
                        <td>{rate(stats.min)}</td>
                        <td>{rate(stats.mean)}</td>
                        <td>{rate(stats.max)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {runs.length > 0 && (
                <ChartContainer config={chartConfig} className="h-[220px] w-full aspect-auto">
                  <LineChart
                    accessibilityLayer
                    data={runs.map((r) => ({
                      at: r.startedAt,
                      tx: bandwidthMeasurement(r, "txBps"),
                      rx: bandwidthMeasurement(r, "rxBps"),
                    }))}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="at"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(t) => new Date(t).toLocaleTimeString()}
                    />
                    <YAxis unit=" Mbps" width={80} domain={[0, "auto"]} />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                        />
                      }
                    />
                    <Line
                      dataKey="tx"
                      stroke="var(--color-tx)"
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="rx"
                      stroke="var(--color-rx)"
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ChartContainer>
              )}
            </article>
          );
        })}
        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="text-left py-2">Retained runs — source perspective, Mbps</caption>
              <thead>
                <tr>
                  {["Test", "Started", "Status", "Source TX", "Source RX", "Loss", "Result"].map(
                    (h) => (
                      <th className="p-2" scope="col" key={h}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {[...filtered].reverse().map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <th scope="row" className="p-2">
                      {r.job.name}
                    </th>
                    <td className="p-2">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="p-2">
                      {r.status} · {r.trigger}
                    </td>
                    <td className="p-2">{rate(bandwidthMeasurement(r, "txBps"))}</td>
                    <td className="p-2">{rate(bandwidthMeasurement(r, "rxBps"))}</td>
                    <td className="p-2">
                      {r.status === "ok" ? (r.lostPackets ?? "Missing") : "Missing"}
                    </td>
                    <td className="p-2">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
