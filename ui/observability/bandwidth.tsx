import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";
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
  BandwidthInventory,
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
  values = [],
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  values?: string[];
  options?: { value: string; label: string; disabled?: boolean }[];
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
          {(options ?? values.map((value) => ({ value, label: value, disabled: false }))).map(
            (option) => (
              <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </label>
  );
}
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
  const [editing, setEditing] = useState(false);
  const [preflight, setPreflight] = useState<BandwidthPreflight>();
  const sourceInventory = useBandwidthInventory(draft.source);
  const destinationInventory = useBandwidthInventory(draft.destination);
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
    setPreflight(undefined);
    setAck(false);
    setEditing(!!job);
    setError("");
    if (job) {
      const { nextRunAt: _next, ...saved } = job;
      setDraft(saved);
    } else setDraft({ ...emptyJob, id: crypto.randomUUID() });
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
          if (!ack || !endpointsReady) return;
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
            Name
            <Input required value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <Choice
            label="Source router"
            value={draft.source}
            values={state?.devices ?? []}
            onChange={(source) => {
              patch({ source, sourceInterface: "", sourceAddress: "" });
            }}
          />
          <Choice
            label="Destination router"
            value={draft.destination}
            values={state?.devices ?? []}
            onChange={(destination) => patch({ destination, destinationAddress: "" })}
          />
          <Choice
            label="Expected source interface"
            value={draft.sourceInterface}
            disabled={busy || sourceInventory.loading || !sourceInventory.data}
            options={sourceInventory.data?.interfaces.map((iface) => {
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
          <Choice
            label="Expected source IPv4"
            value={draft.sourceAddress}
            values={[...new Set(sourceAddresses.map((address) => address.address))]}
            disabled={busy || !usableSource || !sourceAddresses.length}
            onChange={(sourceAddress) => patch({ sourceAddress })}
          />
          <Choice
            label="Destination IPv4 (explicit)"
            value={draft.destinationAddress}
            options={[
              ...new Map(
                destinationInventory.data?.addresses.map((address) => [
                  address.address,
                  { value: address.address, label: `${address.address} — ${address.interface}` },
                ]) ?? [],
              ).values(),
            ]}
            disabled={
              busy || destinationInventory.loading || !destinationInventory.data?.addresses.length
            }
            onChange={(destinationAddress) => patch({ destinationAddress })}
          />
          <div className="space-y-2 text-sm md:col-span-2">
            <p className="text-muted-foreground">
              Selecting a router reads its interfaces and IPv4 addresses. Inventory is cached for 30
              seconds; every test still performs fresh preflight.
            </p>
            {(
              [
                ["Source", draft.source, sourceInventory],
                ["Destination", draft.destination, destinationInventory],
              ] as const
            ).map(
              ([label, device, inventory]) =>
                device && (
                  <div key={label} className="flex flex-wrap items-center gap-2">
                    {inventory.loading ? (
                      <span role="status">Loading {label.toLowerCase()} inventory…</span>
                    ) : inventory.error ? (
                      <span role="alert">
                        {label}: {inventory.error}
                      </span>
                    ) : (
                      inventory.data && (
                        <span className="text-muted-foreground">
                          {label}: {inventory.data.interfaces.length} interfaces ·{" "}
                          {inventory.data.addresses.length} usable IPv4 addresses
                        </span>
                      )
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || inventory.loading}
                      onClick={inventory.retry}
                    >
                      {inventory.error
                        ? `Retry ${label.toLowerCase()} inventory`
                        : `Refresh ${label.toLowerCase()} inventory`}
                    </Button>
                  </div>
                ),
            )}
            {sourceInventory.data && !sourceInventory.data.addresses.length && (
              <p>
                No usable source IPv4 addresses. Interfaces without an enabled address cannot be
                selected.
              </p>
            )}
            {destinationInventory.data && !destinationInventory.data.addresses.length && (
              <p>
                No usable destination IPv4 addresses. Configure the router separately before
                creating a test.
              </p>
            )}
          </div>
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
            ] as const
          ).map((field) => (
            <label key={field.key} className="grid gap-2 text-sm">
              {field.label}
              <Input
                type="number"
                required
                step={1}
                min={field.min}
                max={field.max}
                value={draft[field.key]}
                onChange={(e) => patch({ [field.key]: e.target.valueAsNumber })}
              />
            </label>
          ))}
          <Collapsible.Root
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-lg border bg-muted/20 md:col-span-2"
          >
            <Collapsible.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between p-4 text-left"
                disabled={busy}
              >
                <span className="grid gap-1">
                  <span className="font-medium">Advanced Options</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Packet sizes, connections, reporting and payload
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content
              forceMount
              hidden={!advancedOpen}
              onInvalidCapture={() => setAdvancedOpen(true)}
              className="border-t p-4"
            >
              <p className="mb-4 text-sm text-muted-foreground">
                Packet sizes apply to UDP; connection count applies to TCP. Saved values are kept
                when this section is collapsed.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-2 text-sm md:col-span-2">
                  Test ID (automatic)
                  <Input value={draft.id} readOnly className="font-mono text-xs" />
                </label>
                {(
                  [
                    {
                      key: "localUdpTxSize",
                      label: "Source UDP TX size (bytes)",
                      min: 28,
                      max: 64000,
                    },
                    {
                      key: "remoteUdpTxSize",
                      label: "Remote UDP TX size (bytes)",
                      min: 28,
                      max: 64000,
                    },
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
                <label className="flex items-center gap-2 text-sm md:col-span-2">
                  <Checkbox
                    checked={draft.randomData}
                    disabled={busy}
                    onCheckedChange={(checked) => patch({ randomData: checked === true })}
                    aria-label="Generate random data"
                  />
                  Generate random data
                </label>
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.enabled}
              disabled={busy}
              aria-label="Enable recurring traffic (off by default)"
              onCheckedChange={(checked) => patch({ enabled: checked === true })}
            />
            Enable recurring traffic (off by default)
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-2">
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
          <Checkbox
            checked={ack}
            aria-label="I acknowledge the traffic impact"
            disabled={busy}
            onCheckedChange={(checked) => setAck(checked === true)}
            required
          />
          I acknowledge the traffic impact
          {draft.enabled ? " of enabling this recurring test" : "; this definition stays disabled"}.
        </label>
        <Button type="submit" disabled={busy || !ack || !endpointsReady}>
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
              <Checkbox
                checked={selected.includes(id)}
                aria-label={name}
                onCheckedChange={(checked) =>
                  setSelected((s) => (checked === true ? [...s, id] : s.filter((v) => v !== id)))
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
