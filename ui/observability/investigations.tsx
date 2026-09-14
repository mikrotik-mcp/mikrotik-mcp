import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, ArrowRight, Clock, Network, Router } from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import { api, postJson } from "./api";
import { InvestigationClients } from "./investigation-clients";
import { Select } from "./geist";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { InvestigationResult } from "./investigation-result";

type CaseSummary = Omit<Investigation, "evidence" | "nextTests"> & {
  evidenceCount: number;
  unknownCount: number;
};
const field =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** One case workspace: explicit scope, historical evidence and the next unperformed experiments. */
export function InvestigationsView(): ReactNode {
  const vantageId = useId();
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
            if (busy || !device || !devices.includes(device)) return;
            void create();
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <label className="grid gap-1.5 text-xs font-medium">
            Access router
            <Select
              className="w-full"
              aria-label="Access router"
              value={device}
              disabled={busy || !devices.length}
              placeholder="Select a router"
              options={devices.map((name) => ({ value: name, label: name }))}
              onValueChange={(name) => {
                generation.current++;
                setDevice(name);
                setClient("");
                setSelected(null);
                setCases([]);
                setVantages([]);
                setError("");
              }}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Client IPv4 or MAC
            <input
              className={field}
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="Select below or enter IPv4 / MAC"
              required
              disabled={busy}
            />
          </label>
          <InvestigationClients
            key={device}
            device={device}
            value={client}
            disabled={busy}
            onSelect={setClient}
          />
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
          <fieldset
            aria-describedby={`${vantageId}-help`}
            className="min-w-0 rounded-xl border border-border bg-background/50 p-4 sm:col-span-2"
          >
            <legend className="sr-only">Additional router perspectives</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Network aria-hidden="true" className="size-4 text-muted-foreground" />
                Additional router perspectives
              </div>
              <span
                aria-live="polite"
                className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground"
              >
                {vantages.length} / 2 selected
              </span>
            </div>
            <p
              id={`${vantageId}-help`}
              className="mt-2 text-xs leading-relaxed text-muted-foreground"
            >
              Optional · Compare evidence from up to two other routers. Selecting a router does not
              contact it.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {devices
                .filter((d) => d !== device)
                .map((d) => {
                  const checked = vantages.includes(d);
                  const atLimit = !checked && vantages.length >= 2;
                  const disabled = busy || atLimit;
                  const id = `${vantageId}-${encodeURIComponent(d)}`;
                  return (
                    <label
                      key={d}
                      htmlFor={id}
                      className={`flex min-w-0 items-center gap-3 rounded-lg border p-3 transition-colors motion-reduce:transition-none focus-within:outline-2 focus-within:outline-ring ${
                        checked ? "border-primary/40 bg-muted" : "border-border bg-card"
                      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-primary/40 hover:bg-muted/70"}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${checked ? "border-primary/20 bg-background text-primary" : "border-border text-muted-foreground"}`}
                      >
                        <Router className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs font-medium" title={d}>
                          {d}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {checked
                            ? "Included in investigation"
                            : atLimit
                              ? "Two-router limit reached"
                              : "Add another perspective"}
                        </span>
                      </span>
                      <Checkbox
                        id={id}
                        aria-label={`Include ${d} as an additional router`}
                        checked={checked}
                        disabled={disabled}
                        className="shrink-0"
                        onCheckedChange={(next) =>
                          setVantages((current) => {
                            if (next !== true) return current.filter((name) => name !== d);
                            if (current.includes(d) || current.length >= 2) return current;
                            return [...current, d];
                          })
                        }
                      />
                    </label>
                  );
                })}
            </div>
            {!devices.some((d) => d !== device) && (
              <p className="mt-3 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                No additional routers available. You can investigate using the access router alone.
              </p>
            )}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={busy || !device}
            >
              {busy ? "Collecting evidence…" : "Create investigation"}
              <ArrowRight className="size-4" />
            </Button>
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
              <Button
                variant="ghost"
                key={c.id}
                disabled={busy}
                onClick={() => void open(c.id)}
                aria-pressed={selected?.id === c.id}
                className="grid h-auto justify-items-start gap-1 whitespace-normal rounded-lg border border-border p-3 text-left hover:bg-muted aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="block truncate text-sm font-medium">{c.service}</span>
                <span className="block font-mono text-xs text-muted-foreground">{c.client}</span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  {new Date(c.createdAt).toLocaleString()} · {c.unknownCount} unknown
                </span>
              </Button>
            ))}
          </div>
        </aside>
        {selected ? (
          <InvestigationResult investigation={selected} />
        ) : (
          <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
            Select a saved case or collect new evidence. The client picker reads DHCP/ARP records;
            investigation probes run only when you create a case.
          </div>
        )}
      </div>
    </section>
  );
}
