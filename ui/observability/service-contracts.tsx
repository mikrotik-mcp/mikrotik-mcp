import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ShieldCheck, Activity, Play } from "lucide-react";
import type { ContractRun, ServiceContract } from "../../src/service-contracts/model";
import { api, postJson } from "./api";

const control =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const button =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring";

/** Keep service proof distinct from router reachability and historical successes. */
export function ServiceContractsView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState("");
  const [contracts, setContracts] = useState<ServiceContract[]>([]);
  const [targets, setTargets] = useState<{ name: string; kind: string }[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [latency, setLatency] = useState(2000);
  const [suite, setSuite] = useState("");
  const [runs, setRuns] = useState<ContractRun[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const query = `device=${encodeURIComponent(device)}`;
  useEffect(() => {
    let stopped = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (!stopped) {
          setDevices(r.devices.map((d) => d.name));
          setDevice(r.defaultDevice);
        }
      })
      .catch(() => {
        if (!stopped) setError("Could not load configured devices.");
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
      .then(([c, t]) => {
        if (!stopped) {
          setContracts(c.contracts);
          setTargets(t.targets);
        }
      })
      .catch(() => {
        if (!stopped) setError("Could not load contracts. Check device access and local storage.");
      });
    return () => {
      stopped = true;
    };
  }, [device, query, revision]);
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
    setRuns([]);
    setError("");
    try {
      if (run) {
        const result = await postJson<ContractRun & { error?: string }>(
          `/api/service-contracts/run?${query}`,
          { id },
        );
        if (result.error || !result.id) throw new Error(result.error ?? "No check result returned");
      }
      const history = await api<{ runs: ContractRun[] }>(
        `/api/service-contracts/history?${query}&id=${encodeURIComponent(id)}`,
      );
      setRuns(history.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read contract results");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-border bg-card p-6">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldCheck className="size-5 text-primary" />
            Service health contracts
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Define what must work, then collect proof. These probes originate from the MCP host, not
            the client or branch.
          </p>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Owning router
          <select
            className={control}
            value={device}
            disabled={busy}
            onChange={(e) => {
              setDevice(e.target.value);
              setContracts([]);
              setRuns([]);
              setSelected("");
              setSelectedTargets([]);
              setError("");
            }}
          >
            {devices.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <form
        className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="grid gap-1 text-xs font-medium">
          Contract name
          <input
            className={control}
            value={name}
            maxLength={120}
            required
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="Branch checkout availability"
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Maximum latency (ms)
          <input
            className={control}
            type="number"
            min={1}
            max={10000}
            value={latency}
            required
            disabled={busy}
            onChange={(e) => setLatency(Number(e.target.value))}
          />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-xs font-medium">
            Approved endpoints · choose up to ten
          </legend>
          {!targets.length ? (
            <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              No endpoints approved. Ask the administrator to configure serviceProbes.targets with
              hostnames and permitted IP ranges. Arbitrary URLs are intentionally unavailable.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {targets.map((t) => (
                <label
                  key={t.name}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
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
                  {t.name}
                  <span className="font-mono text-xs text-muted-foreground">{t.kind}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label className="grid gap-1 text-xs font-medium">
          Saved packet suite ID · optional
          <input
            className={control}
            value={suite}
            disabled={busy}
            onChange={(e) => setSuite(e.target.value)}
            placeholder="Fresh-export simulation, not live packet proof"
          />
        </label>
        <div className="flex items-end">
          <button className={button} disabled={busy || !device || !selectedTargets.length}>
            Save contract
          </button>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Saving never runs probes. HTTPS checks created here expect status 200; MCP supports other
          explicit codes. Scheduled enrollment is an administrator choice.
        </p>
      </form>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Defined contracts</h3>
          {!contracts.length && (
            <p className="rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
              No contracts for this router. Define a bounded service check above.
            </p>
          )}
          {contracts.map((c) => (
            <article key={c.id} className="rounded-xl border border-border bg-card p-5">
              <h4 className="font-semibold">{c.name}</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.checks.length} endpoint checks{c.packetSuiteId ? " · packet suite" : ""}
              </p>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{c.id}</p>
              <div className="mt-4 flex gap-2">
                <button className={button} disabled={busy} onClick={() => void show(c.id, true)}>
                  <Play className="size-3" />
                  Run checks
                </button>
                <button className={control} disabled={busy} onClick={() => void show(c.id)}>
                  View history
                </button>
              </div>
            </article>
          ))}
        </section>
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4" />
            {selected ? "Recorded results" : "Evidence history"}
          </h3>
          {busy && (
            <p role="status" className="text-sm text-muted-foreground">
              Working… bounded probes may take several seconds per endpoint.
            </p>
          )}
          {!runs.length && (
            <p className="rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
              {selected
                ? "No recorded results to display."
                : "Select a contract. History does not replace a fresh check."}
            </p>
          )}
          {runs.map((r) => (
            <article key={r.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex justify-between gap-3">
                <b
                  className={
                    r.status === "pass"
                      ? "text-success"
                      : r.status === "fail"
                        ? "text-destructive"
                        : "text-warning"
                  }
                >
                  {r.status.toUpperCase()}
                </b>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Perspective: MCP host · {r.finishedAt - r.startedAt} ms total
              </p>
              <ul className="mt-4 divide-y divide-border">
                {r.checks.map((c, i) => (
                  <li key={`${c.target}-${i}`} className="py-3">
                    <div className="flex justify-between gap-2 text-sm">
                      <span>{c.target}</span>
                      <span className="font-mono text-xs">
                        {c.status} · {c.durationMs} ms
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      </div>
    </section>
  );
}
