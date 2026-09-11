import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, ArrowRight, AlertCircle, Clock } from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import { api, postJson } from "./api";

type CaseSummary = Omit<Investigation, "evidence" | "nextTests"> & {
  evidenceCount: number;
  unknownCount: number;
};
const field =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** One case workspace: explicit scope, historical evidence and the next unperformed experiments. */
export function InvestigationsView(): ReactNode {
  const seed = new URLSearchParams(location.search);
  const [device, setDevice] = useState(seed.get("investigationDevice") ?? "");
  const [devices, setDevices] = useState<string[]>([]);
  const [client, setClient] = useState(seed.get("investigationClient") ?? "");
  const [target, setTarget] = useState("");
  const [service, setService] = useState("");
  const [vantages, setVantages] = useState<string[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selected, setSelected] = useState<Investigation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const endpoint = `/api/investigations?device=${encodeURIComponent(device)}`;
  useEffect(() => {
    let disposed = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (disposed) return;
        setDevices(r.devices.map((d) => d.name));
        setDevice((d) => d || r.defaultDevice);
      })
      .catch(() => {
        if (!disposed) setError("Could not load devices. Check the dashboard connection.");
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    const revision = ++generation.current;
    if (!device) return;
    let disposed = false;
    void api<{ cases: CaseSummary[] }>(endpoint)
      .then((r) => {
        if (!disposed && revision === generation.current) setCases(r.cases);
      })
      .catch(() => {
        if (!disposed && revision === generation.current)
          setError("Could not load case history for this device. Check access and local storage.");
      });
    return () => {
      disposed = true;
    };
  }, [device, endpoint]);
  async function create(): Promise<void> {
    const revision = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await postJson<Investigation & { error?: string }>(endpoint, {
        client,
        target,
        service,
        vantage_devices: vantages,
      });
      if (revision !== generation.current) return;
      if (result.error) throw new Error(result.error);
      if (!result.id)
        throw new Error("The server returned no saved case. Retry after checking storage.");
      setSelected(result);
      const history = await api<{ cases: CaseSummary[] }>(endpoint);
      if (revision === generation.current) setCases(history.cases);
    } catch (e) {
      if (revision === generation.current)
        setError(e instanceof Error ? e.message : "Investigation failed");
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string): Promise<void> {
    const revision = ++generation.current;
    setSelected(null);
    setError("");
    try {
      const result = await api<Investigation>(
        `/api/investigations/${encodeURIComponent(id)}?device=${encodeURIComponent(device)}`,
      );
      if (revision === generation.current) setSelected(result);
    } catch {
      if (revision === generation.current)
        setError("Could not open this case. Access is checked for every evidence device.");
    }
  }
  return (
    <section className="grid gap-6">
      <div className="rounded-xl border border-border bg-card p-5 sm:p-7">
        <div className="mb-5 flex items-start gap-3">
          <Search className="mt-1 size-5 text-primary" />
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Follow the evidence</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Investigate one client and service. Router configuration stays untouched.
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <label className="grid gap-1.5 text-xs font-medium">
            Access router
            <select
              className={field}
              value={device}
              disabled={busy}
              onChange={(e) => {
                generation.current++;
                setDevice(e.target.value);
                setSelected(null);
                setCases([]);
                setVantages([]);
                setError("");
              }}
              required
            >
              <option value="" disabled>
                Select a router
              </option>
              {devices.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Client IPv4 or MAC
            <input
              className={field}
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="192.168.88.20"
              required
              disabled={busy}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Destination hostname or IPv4
            <input
              className={field}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="payments.example.com"
              required
              disabled={busy}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Service label
            <input
              className={field}
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="Branch payment service"
              maxLength={120}
              required
              disabled={busy}
            />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-xs font-medium">
              Additional router perspectives · optional, up to two
            </legend>
            <div className="flex flex-wrap gap-4">
              {devices
                .filter((d) => d !== device)
                .map((d) => (
                  <label className="flex items-center gap-2 text-sm" key={d}>
                    <input
                      type="checkbox"
                      checked={vantages.includes(d)}
                      disabled={busy || (!vantages.includes(d) && vantages.length >= 2)}
                      onChange={(e) =>
                        setVantages((v) =>
                          e.target.checked ? [...v, d] : v.filter((x) => x !== d),
                        )
                      }
                    />
                    {d}
                  </label>
                ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={busy || !device}
            >
              {busy ? "Collecting evidence…" : "Create investigation"}
              <ArrowRight className="size-4" />
            </button>
            <span className="text-xs text-muted-foreground">
              Three ICMP probes per router. No client-side probe.
            </span>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Reading sources sequentially. Unsupported or unavailable sources remain unknown.
          </p>
        )}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Clock className="size-4" />
            Saved cases
          </h3>
          {!cases.length && (
            <p className="text-sm text-muted-foreground">
              No visible cases for this router. Create an investigation to preserve its evidence.
            </p>
          )}
          <div className="grid gap-2">
            {cases.map((c) => (
              <button
                key={c.id}
                disabled={busy}
                onClick={() => void open(c.id)}
                aria-pressed={selected?.id === c.id}
                className="rounded-lg border border-border p-3 text-left hover:bg-muted aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="block truncate text-sm font-medium">{c.service}</span>
                <span className="block font-mono text-xs text-muted-foreground">{c.client}</span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  {new Date(c.createdAt).toLocaleString()} · {c.unknownCount} unknown
                </span>
              </button>
            ))}
          </div>
        </aside>
        {selected ? (
          <article className="min-w-0 space-y-4">
            <header className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-lg font-semibold">{selected.service}</h3>
              <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                {selected.client} → {selected.target}
              </p>
              <p className="mt-3 flex items-center gap-2 text-sm text-warning">
                <AlertCircle className="size-4 shrink-0" />
                Client application health: unverified
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Historical evidence collected {new Date(selected.createdAt).toLocaleString()}.
                Router success does not prove client success.
              </p>
            </header>
            {selected.evidence.map((e) => (
              <details key={e.id} className="rounded-xl border border-border bg-card p-4">
                <summary className="cursor-pointer text-sm">
                  <span className="font-semibold">
                    {e.device} / {e.source}
                  </span>
                  <span className="ml-3 text-xs text-muted-foreground">
                    {e.state} · {e.rows.length} records{e.truncated ? " · truncated" : ""}
                  </span>
                </summary>
                <p className="mt-3 text-sm text-muted-foreground">{e.summary}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {new Date(e.startedAt).toLocaleTimeString()} —{" "}
                  {new Date(e.finishedAt).toLocaleTimeString()}
                </p>
                {e.rows.length > 0 && (
                  <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(e.rows, null, 2)}
                  </pre>
                )}
              </details>
            ))}
            <section className="rounded-xl border border-border bg-card p-5">
              <h4 className="text-sm font-semibold">Next experiments · not performed</h4>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                {selected.nextTests.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          </article>
        ) : (
          <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
            Select a saved case or collect new evidence. No device is queried just by opening this
            page.
          </div>
        )}
      </div>
    </section>
  );
}
