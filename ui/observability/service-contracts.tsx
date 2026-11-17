import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Play, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
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
const TEXT: Record<RunStatus, string> = {
  pass: "text-success",
  fail: "text-destructive",
  unknown: "text-warning",
};

/** How many past runs the "Earlier runs" strip shows. */
const STRIP_RUNS = 20;

function maxLatency(c: ServiceContract): number {
  return Math.max(0, ...c.checks.map((k) => k.maxLatencyMs));
}

const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** "6 min" for the KPI value; the caller adds "ago". */
function elapsed(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "<1 min";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** One line under the banner: what failed, when, and how long it took. */
function runSummary(run: ContractRun): string {
  const n = run.checks.length;
  const failed = run.checks.filter((k) => k.status === "fail").length;
  const unknown = run.checks.filter((k) => k.status === "unknown").length;
  const when = `at ${hhmm(run.startedAt)} · total ${num(run.finishedAt - run.startedAt)} ms`;
  if (failed) return `${failed} of ${plural(n, "check")} failed ${when}`;
  if (unknown) return `${unknown} of ${plural(n, "check")} gave no answer ${when}`;
  return `All ${plural(n, "check")} passed ${when}`;
}

/** Keep service proof distinct from router reachability and historical successes. */
export function ServiceContractsView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
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

  const routerPicker = (
    <label htmlFor="service-contract-router" className="sc-router">
      <span className="sc-label">Router</span>
      <Select
        value={device}
        disabled={busy || deviceLoad !== "ready" || !devices.length}
        onValueChange={(value) => {
          setDevice(value);
          setContracts([]);
          setContractsLoaded(false);
          setTargets([]);
          setHistory({});
          setSelected("");
          setSelectedTargets([]);
          setError("");
        }}
      >
        <SelectTrigger
          id="service-contract-router"
          className="sc-select"
          aria-busy={deviceLoad === "loading"}
        >
          <SelectValue
            className="sc-select-value"
            placeholder={
              deviceLoad === "loading"
                ? "Loading routers…"
                : deviceLoad === "error"
                  ? "Routers unavailable"
                  : devices.length
                    ? "Select a router"
                    : "No routers configured"
            }
          />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {devices.map((d) => (
            <SelectItem key={d} value={d}>
              {d}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );

  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
      {deviceLoad === "loading" && (
        <LoadingState label="Loading service contracts" layout="cards" />
      )}
      <PageIntro
        controls={
          <div className="sc-intro-controls">
            {routerPicker}
            <MonitorButton
              variant="inverse"
              icon={<Plus aria-hidden="true" strokeWidth={1.5} />}
              disabled={busy || !device}
              onClick={() => setCreating(true)}
            >
              New contract
            </MonitorButton>
          </div>
        }
      >
        Say what must work, then prove it. Probes run from the MCP host, not from the client or the
        branch.
      </PageIntro>

      {error && !creating && (
        <p role="alert" className="monitor-note text-destructive" data-tone="bad">
          {error}
        </p>
      )}

      {device && contractsLoaded && (
        <MetricStrip label="Contract summary" minCell={180}>
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
            value={newest ? elapsed(newest.run.startedAt, now) : "—"}
            hint={newest ? `ago, ${newest.c.name}` : "No runs yet"}
          />
        </MetricStrip>
      )}

      {device && (
        <div className="sc-columns">
          <MonitorPanel
            title="Contracts"
            description="Pick one to see its evidence"
            className="sc-list"
            flush
          >
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
                        icon={<Plus aria-hidden="true" strokeWidth={1.5} />}
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
                      <span className="min-w-0">
                        <span className="sc-contract-name">
                          <StatusDot tone={last ? TONE[last.status] : "default"} />
                          <span className="truncate">{c.name}</span>
                        </span>
                        <span className="sc-contract-meta">
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

      <Sheet open={creating} onOpenChange={(open) => !busy && setCreating(open)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>New contract</SheetTitle>
            <SheetDescription>
              For <span className="font-mono">{device || "no router"}</span>. Saving never runs
              probes.
            </SheetDescription>
          </SheetHeader>
          <form
            className="grid gap-4 px-4 pb-6"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            {error && (
              <p role="alert" className="monitor-note text-destructive" data-tone="bad">
                {error}
              </p>
            )}
            <label className="grid gap-1.5 text-[12px] font-medium">
              Contract name
              <Input
                value={name}
                maxLength={120}
                required
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder="Branch checkout availability"
              />
            </label>
            <label className="grid gap-1.5 text-[12px] font-medium">
              Maximum latency (ms)
              <Input
                type="number"
                min={1}
                max={10000}
                value={latency}
                required
                disabled={busy}
                onChange={(e) => setLatency(Number(e.target.value))}
              />
            </label>
            <fieldset>
              <legend className="mb-2 text-[12px] font-medium">
                Approved endpoints · choose up to ten
              </legend>
              {!targets.length ? (
                <p className="monitor-note text-muted-foreground">
                  No endpoints approved. Ask the administrator to set serviceProbes.targets with
                  hostnames and allowed IP ranges. Arbitrary URLs are not allowed.
                </p>
              ) : (
                <div className="sc-targets">
                  {targets.map((t) => (
                    <label key={t.name} className="sc-target">
                      <Checkbox
                        aria-label={t.name}
                        checked={selectedTargets.includes(t.name)}
                        disabled={
                          busy ||
                          (!selectedTargets.includes(t.name) && selectedTargets.length >= 10)
                        }
                        onCheckedChange={(checked) =>
                          setSelectedTargets((v) =>
                            checked === true ? [...v, t.name] : v.filter((n) => n !== t.name),
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
            <label className="grid gap-1.5 text-[12px] font-medium">
              Saved packet suite ID · optional
              <Input
                value={suite}
                disabled={busy}
                onChange={(e) => setSuite(e.target.value)}
                placeholder="Fresh-export simulation, not live packet proof"
              />
            </label>
            <p className="text-[12px] text-muted-foreground">
              HTTPS checks made here expect status 200; MCP supports other explicit codes. Scheduled
              runs are an administrator choice.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="secondary"
                disabled={busy || !device || !selectedTargets.length}
              >
                Save contract
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{contract ? `${contract.name} history` : "History"}</SheetTitle>
            <SheetDescription>
              The latest {plural(runs.length, "recorded run")}. A past pass is not a current gate
              result.
              {contract && (
                <span className="mt-1 block font-mono text-[12px] break-all">ID {contract.id}</span>
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-4 pb-6">
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
        </SheetContent>
      </Sheet>
    </section>
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
  const strip = runs.slice(0, STRIP_RUNS).reverse();
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
  const stripLabel = `Last ${plural(strip.length, "run")}: ${counts.join(", ")}`;

  return (
    <MonitorPanel
      title={contract.name}
      description={`${plural(contract.checks.length, "endpoint")} must answer within ${num(
        maxLatency(contract),
      )} ms from the MCP host${contract.packetSuiteId ? ", plus a packet suite" : ""}`}
      className="sc-detail"
      extra={
        <>
          <MonitorButton variant="ghost" size="sm" disabled={busy} onClick={onHistory}>
            History
          </MonitorButton>
          <MonitorButton
            size="sm"
            icon={<Play aria-hidden="true" strokeWidth={1.5} />}
            disabled={busy}
            onClick={onRun}
          >
            Run checks
          </MonitorButton>
        </>
      }
      flush
    >
      <div className="sc-banner" data-tone={latest ? TONE[latest.status] : undefined}>
        <StatusDot tone={latest ? TONE[latest.status] : "default"} pulse={busy} />
        <span className="sc-banner-word">
          {busy ? "Running" : latest ? STATUS_WORD[latest.status] : "Not run yet"}
        </span>
        <span role="status" className="sc-banner-text">
          {busy
            ? "Each endpoint can take a few seconds."
            : latest
              ? runSummary(latest)
              : "Run checks to collect proof. History does not replace a fresh check."}
        </span>
      </div>

      <div ref={rowsRef}>
        <div className="monitor-thead sc-check-grid">
          <span />
          <span>Endpoint</span>
          <span>Result</span>
          <span className="text-right">Time</span>
          <span className="sc-check-detail">Detail</span>
        </div>
        {latest
          ? latest.checks.map((k, i) => (
              <div
                key={`${k.target}-${i}`}
                className="monitor-row sc-check-grid"
                data-failed={k.status === "fail" || undefined}
              >
                <StatusDot tone={TONE[k.status]} />
                <span className="sc-mono truncate" title={k.target}>
                  {k.target}
                </span>
                <span className={`sc-word ${TEXT[k.status]}`}>{RESULT_WORD[k.status]}</span>
                <span className="text-right text-fg-secondary tabular-nums">
                  {num(k.durationMs)} ms
                </span>
                <span className="sc-check-detail truncate text-[12px] text-muted-foreground">
                  {k.detail}
                </span>
              </div>
            ))
          : contract.checks.map((k, i) => (
              <div key={`${k.target}-${i}`} className="monitor-row sc-check-grid">
                <StatusDot />
                <span className="sc-mono truncate" title={k.target}>
                  {k.target}
                </span>
                <span className="sc-word text-muted-foreground">Not run</span>
                <span className="text-right text-fg-secondary">—</span>
                <span className="sc-check-detail truncate text-[12px] text-muted-foreground">
                  {kinds[k.target] ?? "check"} · limit {num(k.maxLatencyMs)} ms
                  {kinds[k.target] === "https" ? ` · expects ${k.expectedStatus.join(", ")}` : ""}
                </span>
              </div>
            ))}
      </div>

      {strip.length > 0 && (
        <div className="sc-runs">
          <span className="sc-label">Earlier runs</span>
          <div className="sc-runs-bars" role="img" aria-label={stripLabel}>
            {strip.map((r) => (
              <span
                key={r.id}
                data-status={r.status}
                title={`${STATUS_WORD[r.status]} · ${new Date(r.startedAt).toLocaleString()}`}
              />
            ))}
          </div>
          <span className="text-[12px] text-muted-foreground">{stripText}</span>
        </div>
      )}
    </MonitorPanel>
  );
}
