import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  CircleHelp,
  History,
  Plus,
  RefreshCw,
  Route,
  Router,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api, postJson } from "./api";
import { Select } from "./geist";
import { Checkbox } from "./components/ui/checkbox";
import { JsonView } from "./highlight";
import type { RoundTripResult, PathLeg, PathStatus } from "../../src/paths/types";
import { blankStep, buildTripInput, returnSteps } from "./round-trip-form";
import type { PathStep, RouterChoice, TripForm } from "./round-trip-form";

const field =
  "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2.5 text-xs focus-visible:outline-2 focus-visible:outline-ring";
const button =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring";
const labels: Record<PathStatus, string> = {
  modelled: "Allowed in the model",
  blocked: "Blocked in the model",
  unknown: "Cannot determine",
};
const colors: Record<PathStatus, string> = {
  modelled: "text-chart-2",
  blocked: "text-destructive",
  unknown: "text-warning",
};

function Leg({ title, leg }: { title: string; leg: PathLeg }): ReactNode {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-5">
      <h3 className="flex flex-wrap justify-between gap-2 font-semibold">
        {title}
        <span className={`text-xs ${colors[leg.status]}`}>{labels[leg.status]}</span>
      </h3>
      {!leg.hops.length && (
        <p className="mt-4 text-xs text-muted-foreground">
          The outbound path did not complete reliably, so a valid reply cannot be assumed. The
          return path was not evaluated.
        </p>
      )}
      <ol className="mt-4 grid gap-3">
        {leg.hops.map((h, i) => (
          <li
            key={`${h.device}-${i}`}
            className="rounded-xl border border-border bg-background p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong className="flex items-center gap-2 text-sm">
                <Router className="size-4" />
                {h.device}
              </strong>
              <span className={`text-[10px] ${colors[h.status]}`}>{labels[h.status]}</span>
            </div>
            <p className="mt-3 font-mono text-xs text-muted-foreground">
              {h.ingress} → {h.egress}
            </p>
            <p className="mt-3 text-xs leading-relaxed">{h.reason}</p>
            {h.trace && (
              <details className="mt-3 border-t border-border pt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Technical evidence (optional)
                </summary>
                <div className="mt-3">
                  <JsonView value={h.trace} maxHeight={300} />
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Guided offline input. Loading choices never captures snapshots or contacts a router. */
export function RoundTripView(): ReactNode {
  const [choices, setChoices] = useState<RouterChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [interfaces, setInterfaces] = useState<
    Record<string, { values: string[]; error?: string }>
  >({});
  const [form, setForm] = useState<TripForm>(() => ({
    forward: [blankStep()],
    reverse: [],
    mirror: true,
    src: "",
    dst: "",
    protocol: "tcp",
    srcPort: "49152",
    dstPort: "443",
    maxAge: 900,
    maxSkew: 120,
  }));
  const [result, setResult] = useState<RoundTripResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    loadId = useRef(0);
  const update = (patch: Partial<TripForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
    setError("");
  };
  async function load(): Promise<void> {
    const id = ++loadId.current;
    setLoading(true);
    setLoadError("");
    setResult(null);
    try {
      const data = await api<{ devices: RouterChoice[] }>("/api/round-trip/options");
      if (!Array.isArray(data.devices)) throw new Error("Invalid response");
      if (alive.current && id === loadId.current) setChoices(data.devices);
    } catch {
      if (alive.current && id === loadId.current)
        setLoadError(
          "Could not load saved configurations. Retry, or reload the upgraded server if this page was just updated.",
        );
    } finally {
      if (alive.current && id === loadId.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    // Defer initial refresh so loading state is not synchronously reset by the effect.
    void Promise.resolve().then(() => {
      if (alive.current) return load();
    });
    return () => {
      alive.current = false;
    };
  }, []);
  async function loadInterfaces(device: string, id: string): Promise<void> {
    const key = `${device}/${id}`;
    if (!id || interfaces[key]?.values.length) return;
    try {
      const data = await api<{ interfaces: string[] }>(
        `/api/round-trip/options?device=${encodeURIComponent(device)}&id=${encodeURIComponent(id)}`,
      );
      if (!Array.isArray(data.interfaces)) throw new Error("Invalid response");
      if (alive.current) setInterfaces((all) => ({ ...all, [key]: { values: data.interfaces } }));
    } catch {
      if (alive.current)
        setInterfaces((all) => ({
          ...all,
          [key]: {
            values: [],
            error: "Could not load interface choices. Select another capture and retry.",
          },
        }));
    }
  }
  function stepChange(
    direction: "forward" | "reverse",
    key: string,
    patch: Partial<PathStep>,
  ): void {
    update({ [direction]: form[direction].map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }
  function move(direction: "forward" | "reverse", at: number, delta: number): void {
    const steps = [...form[direction]];
    [steps[at], steps[at + delta]] = [steps[at + delta], steps[at]];
    update({ [direction]: steps });
  }
  function editor(direction: "forward" | "reverse"): ReactNode {
    const steps = form[direction];
    return (
      <div className="grid gap-3">
        {steps.map((s, i) => {
          const snaps = choices.find((c) => c.device === s.device)?.snapshots ?? [];
          const snapshot = snaps.find((c) => c.id === s.snapshotId);
          const list = interfaces[`${s.device}/${s.snapshotId}`];
          const opts = [
            {
              value: "",
              label: !s.snapshotId
                ? "Choose a saved configuration first"
                : !list
                  ? "Loading interfaces…"
                  : "Select an interface",
            },
            ...(list?.values ?? []).map((name) => ({ value: name, label: name })),
          ];
          return (
            <div key={s.key} className="rounded-xl border border-border bg-background/60 p-4">
              <div className="mb-4 flex items-center justify-between gap-2">
                <strong className="flex items-center gap-2 text-xs">
                  <span className="flex size-6 items-center justify-center rounded-full border border-chart-2/30 text-chart-2">
                    {i + 1}
                  </span>
                  <Router className="size-4" />
                  {s.device || "Choose a router"}
                </strong>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Move ${direction} router ${i + 1} earlier`}
                    disabled={busy || i === 0}
                    className={button}
                    onClick={() => move(direction, i, -1)}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${direction} router ${i + 1} later`}
                    disabled={busy || i === steps.length - 1}
                    className={button}
                    onClick={() => move(direction, i, 1)}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${direction} router ${i + 1}`}
                    disabled={busy || steps.length === 1}
                    className={button}
                    onClick={() => update({ [direction]: steps.filter((h) => h.key !== s.key) })}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2 text-xs">
                  Router
                  <Select
                    disabled={busy}
                    value={s.device}
                    options={[
                      { value: "", label: "Select a router" },
                      ...choices.map((c) => ({ value: c.device, label: c.device })),
                    ]}
                    onValueChange={(device) =>
                      stepChange(direction, s.key, {
                        device,
                        snapshotId: "",
                        ingress: "",
                        egress: "",
                      })
                    }
                  />
                </label>
                <label className="grid gap-2 text-xs">
                  Saved configuration
                  <Select
                    disabled={busy || !s.device}
                    value={s.snapshotId}
                    options={[
                      {
                        value: "",
                        label: snaps.length ? "Select a capture date" : "No saved configurations",
                      },
                      ...snaps.map((c) => ({
                        value: c.id,
                        label: `${c.label || "Configuration"} · ${new Date(c.ts).toLocaleString()}`,
                      })),
                    ]}
                    onValueChange={(snapshotId) => {
                      stepChange(direction, s.key, { snapshotId, ingress: "", egress: "" });
                      void loadInterfaces(s.device, snapshotId);
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xs">
                  Entry · where the packet arrives
                  <Select
                    disabled={busy || !list?.values.length}
                    value={s.ingress}
                    options={opts}
                    onValueChange={(ingress) => stepChange(direction, s.key, { ingress })}
                  />
                </label>
                <label className="grid gap-2 text-xs">
                  Exit · where you expect it to leave
                  <Select
                    disabled={busy || !list?.values.length}
                    value={s.egress}
                    options={opts}
                    onValueChange={(egress) => stepChange(direction, s.key, { egress })}
                  />
                </label>
              </div>
              {s.device && !snaps.length && (
                <p className="mt-3 text-xs text-warning">
                  Capture a configuration for this router in{" "}
                  <a href="#snapshots" className="underline">
                    Snapshots
                  </a>
                  , then refresh choices here.
                </p>
              )}
              {snapshot && Date.now() - snapshot.ts > form.maxAge * 1000 && (
                <p className="mt-3 text-xs text-warning">
                  This capture is older than the allowed age. Choose a fresh capture or review the
                  evidence limits below.
                </p>
              )}
              {list?.error && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {list.error}
                </p>
              )}
              {list && !list.error && !list.values.length && (
                <p className="mt-3 text-xs text-warning">
                  No usable interfaces in this capture. Choose another snapshot.
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className={`${button} w-fit`}
          disabled={busy || steps.length >= 8}
          onClick={() => update({ [direction]: [...steps, blankStep()] })}
        >
          <Plus className="size-3" />
          Add another router
        </button>
      </div>
    );
  }
  async function analyze(): Promise<void> {
    if (busy) return;
    setError("");
    setResult(null);
    try {
      const input = buildTripInput(form, choices);
      for (const s of [...form.forward, ...(form.mirror ? [] : form.reverse)]) {
        const names = interfaces[`${s.device}/${s.snapshotId}`]?.values;
        if (!names?.includes(s.ingress) || !names.includes(s.egress))
          throw new Error(
            `${s.device}: select entry and exit interfaces from the chosen saved configuration.`,
          );
      }
      setBusy(true);
      const response = await postJson<RoundTripResult & { error?: string }>(
        `/api/round-trip?device=${encodeURIComponent(input.forward[0].device)}`,
        input,
      );
      if (response.error || !response.provenance)
        throw new Error(response.error ?? "No analysis returned");
      if (alive.current) setResult(response);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Path analysis failed");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  let preview: unknown;
  try {
    preview = buildTripInput(form, choices);
  } catch {
    preview = undefined;
  }
  return (
    <section className="grid gap-5">
      <header className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="grid gap-5 p-6 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[.18em] text-chart-2">
              <Route className="size-4" />
              Round-trip lab · configuration rehearsal
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">
              Can the reply find its way back?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              A connection needs two paths: the request to the destination and the reply to the
              client. Compare routing and firewall decisions in saved configurations, without
              sending traffic or changing your network.
            </p>
          </div>
          <div className="rounded-xl border border-chart-2/20 bg-chart-2/5 p-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold">
              <CircleHelp className="size-4" />
              When should I use this?
            </h3>
            <ul className="mt-3 space-y-3 text-xs leading-relaxed text-muted-foreground">
              <li>Find why a request could pass but its reply might be blocked.</li>
              <li>Check the expected path between a branch and a server network.</li>
              <li>Compare outbound and return paths before making changes.</li>
            </ul>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 border-t border-border px-6 py-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-3 text-chart-2" />
            No router changes
          </span>
          <span>Saved configuration only</span>
          <span>Not a live VPN or connectivity test</span>
        </div>
      </header>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void analyze();
        }}
      >
        <fieldset disabled={busy} className="grid gap-5">
          <section className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold">
              <span className="mr-2 text-chart-2">01</span>Describe the connection
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Use the IPs you want to model. No JSON or snapshot IDs required.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-xs">
                Client IPv4
                <input
                  required
                  className={field}
                  placeholder="192.168.88.20"
                  value={form.src}
                  onChange={(e) => update({ src: e.target.value })}
                />
              </label>
              <label className="grid gap-2 text-xs">
                Destination IPv4
                <input
                  required
                  className={field}
                  placeholder="10.20.0.10"
                  value={form.dst}
                  onChange={(e) => update({ dst: e.target.value })}
                />
              </label>
              <label className="grid gap-2 text-xs">
                Connection type
                <Select
                  disabled={busy}
                  value={form.protocol}
                  options={[
                    { value: "tcp", label: "TCP · websites and applications" },
                    { value: "udp", label: "UDP · DNS, calls and QUIC" },
                    { value: "icmp", label: "ICMP · model a ping (no packets sent)" },
                  ]}
                  onValueChange={(v) => update({ protocol: v as TripForm["protocol"] })}
                />
              </label>
              {form.protocol !== "icmp" && (
                <>
                  <label className="grid gap-2 text-xs">
                    Destination port
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      className={field}
                      value={form.dstPort}
                      onChange={(e) => update({ dstPort: e.target.value })}
                    />
                    <small className="text-muted-foreground">HTTPS 443 · HTTP 80 · DNS 53</small>
                  </label>
                  <label className="grid gap-2 text-xs">
                    Client source port
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      className={field}
                      value={form.srcPort}
                      onChange={(e) => update({ srcPort: e.target.value })}
                    />
                    <small className="text-muted-foreground">
                      49152 is a hypothetical test port, not a detected flow. Use the actual port
                      for a specific connection.
                    </small>
                  </label>
                </>
              )}
            </div>
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">
                <span className="mr-2 text-chart-2">02</span>Build the outbound path
              </h3>
              <button
                type="button"
                className={button}
                disabled={busy || loading}
                onClick={() => void load()}
              >
                <RefreshCw className="size-3" />
                {loading ? "Loading…" : "Refresh choices"}
              </button>
            </div>
            <p className="mb-5 mt-2 text-xs leading-relaxed text-muted-foreground">
              Start at the client-side router, then add routers in the order traffic should cross.
              You declare the links; the lab does not discover physical connections.
            </p>
            {loadError && (
              <p role="alert" className="mb-4 text-xs text-destructive">
                {loadError}
              </p>
            )}
            {!loading && !loadError && !choices.length && (
              <p className="mb-4 text-xs text-warning">
                No accessible router choices. Check access scope and saved configurations.
              </p>
            )}
            {editor("forward")}
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold">
              <span className="mr-2 text-chart-5">03</span>Set the return path
            </h3>
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
              <Checkbox
                disabled={busy}
                checked={form.mirror}
                onCheckedChange={(checked) =>
                  update({
                    mirror: checked === true,
                    reverse: checked === true ? form.reverse : returnSteps(form.forward),
                  })
                }
              />
              <span>
                <strong className="block text-xs">
                  Assume the reply follows the same routers in reverse
                </strong>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  Entry and exit are swapped automatically. This is a test assumption, not an
                  observed route. Uncheck to describe a different path.
                </span>
              </span>
            </label>
            {form.mirror ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-4 text-xs">
                {returnSteps(form.forward).map((s, i) => (
                  <span key={s.key} className="flex items-center gap-2">
                    {i > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
                    <span className="rounded-lg border border-border bg-background px-3 py-2">
                      <strong className="block">{s.device || "Choose an outbound router"}</strong>
                      <small className="mt-1 block text-muted-foreground">
                        {s.ingress || "Entry"} → {s.egress || "Exit"}
                      </small>
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-4">{editor("reverse")}</div>
            )}
          </section>
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer text-xs font-medium">
              Evidence limits & technical preview (optional)
            </summary>
            <p className="mt-3 text-xs text-muted-foreground">
              Defaults: captures no older than 15 minutes, at most 2 minutes apart. Increasing
              limits does not make older evidence current.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2 text-xs">
                Maximum snapshot age (seconds)
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={86400}
                  value={form.maxAge}
                  onChange={(e) => update({ maxAge: Number(e.target.value) })}
                />
              </label>
              <label className="grid gap-2 text-xs">
                Maximum capture gap (seconds)
                <input
                  className={field}
                  type="number"
                  min={0}
                  max={3600}
                  value={form.maxSkew}
                  onChange={(e) => update({ maxSkew: Number(e.target.value) })}
                />
              </label>
            </div>
            {preview ? (
              <div className="mt-4">
                <JsonView value={preview} maxHeight={260} />
              </div>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">
                Complete the form with eligible captures to preview the generated request.
              </p>
            )}
          </details>
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-5">
            <button
              disabled={busy || loading || Boolean(loadError) || !choices.length}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <ArrowLeftRight className="size-4" />
              {busy ? "Checking saved configurations…" : "Check both directions"}
            </button>
            <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground">
              NAT, unsupported features or incomplete evidence may prevent a conclusion. “Cannot
              determine” does not mean your network is broken.
            </p>
          </div>
        </fieldset>
      </form>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {result && (
        <div className="grid gap-5" aria-live="polite">
          <section className="rounded-xl border border-border bg-card p-5">
            <h3 className={`text-lg font-semibold ${colors[result.status]}`}>
              {labels[result.status]}
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Declared paths are {result.asymmetric ? "different" : "mirrored"}. Live delivery
              remains unverified.
            </p>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer">What this result assumes</summary>
              <ul className="mt-2 list-disc space-y-2 pl-4">
                {result.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          </section>
          <div className="grid gap-5 xl:grid-cols-2">
            <Leg title="Request → destination" leg={result.forward} />
            <Leg title="Reply → client" leg={result.reverse} />
          </div>
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer text-xs font-medium">
              <History className="mr-2 inline size-4" />
              Saved configurations used
            </summary>
            <div className="mt-3 grid gap-3">
              {result.provenance.map((p) => (
                <div key={p.device} className="min-w-0 text-xs">
                  <strong>{p.device}</strong> · {new Date(p.capturedAt).toLocaleString()}
                  <p className="mt-1 break-all font-mono text-muted-foreground">
                    {p.snapshotId} · SHA {p.sha}
                  </p>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
