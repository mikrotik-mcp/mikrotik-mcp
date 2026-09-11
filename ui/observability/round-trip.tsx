import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeftRight, Route } from "lucide-react";
import { postJson } from "./api";
import type { RoundTripResult, PathLeg } from "../../src/paths/types";

const example = JSON.stringify(
  {
    snapshots: [
      { device: "branch", id: "replace-with-snapshot-id" },
      { device: "edge", id: "replace-with-snapshot-id" },
    ],
    forward: [
      { device: "branch", ingress: "lan", egress: "transit" },
      { device: "edge", ingress: "transit", egress: "servers" },
    ],
    reverse: [
      { device: "edge", ingress: "servers", egress: "transit" },
      { device: "branch", ingress: "transit", egress: "lan" },
    ],
    packet: {
      srcAddress: "192.0.2.10",
      dstAddress: "198.51.100.10",
      protocol: "tcp",
      srcPort: 49152,
      dstPort: 443,
    },
    maxAgeSeconds: 900,
    maxSkewSeconds: 120,
  },
  null,
  2,
);

function Leg({ label, leg }: { label: string; leg: PathLeg }): ReactNode {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="flex items-center justify-between gap-3 font-semibold">
        {label}
        <span className="font-mono text-xs uppercase text-muted-foreground">{leg.status}</span>
      </h3>
      {!leg.hops.length && (
        <p className="mt-4 text-sm text-muted-foreground">
          Not evaluated: no trustworthy outbound tuple to reverse.
        </p>
      )}
      <ol className="mt-4 grid gap-3">
        {leg.hops.map((h, i) => (
          <li key={`${h.device}-${i}`} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>
                {i + 1}. {h.device}
              </strong>
              <span className="font-mono text-xs uppercase">{h.status}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {h.ingress} → {h.egress}
            </p>
            <p className="mt-3 text-sm">{h.reason}</p>
            {h.trace && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Routing, firewall and NAT evidence
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                  {JSON.stringify(h.trace, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Explicit topology input prevents silently inventing links from similar interface/address names. */
export function RoundTripView(): ReactNode {
  const [text, setText] = useState(example);
  const [result, setResult] = useState<RoundTripResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function analyze(): Promise<void> {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const input = JSON.parse(text);
      const device = input.forward?.[0]?.device;
      if (typeof device !== "string" || !device)
        throw new Error("Specify the first forward device.");
      const response = await postJson<RoundTripResult & { error?: string }>(
        `/api/round-trip?device=${encodeURIComponent(device)}`,
        input,
      );
      if (response.error || !response.provenance)
        throw new Error(response.error ?? "No analysis returned");
      setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Path analysis failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-5">
      <header className="rounded-xl border border-border bg-card p-6">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Route className="size-5 text-primary" />
          Round-trip path lab
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Model both directions across exact snapshots. This does not send packets, change routers,
          infer physical links or verify endpoint availability.
        </p>
      </header>
      <form
        className="grid gap-4 rounded-xl border border-border bg-card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void analyze();
        }}
      >
        <label htmlFor="round-trip-input" className="font-medium">
          Explicit path specification
        </label>
        <p id="round-trip-help" className="text-sm text-muted-foreground">
          Replace the example router names and snapshot IDs with your own. Use Snapshots to select
          captures. Each direction lists ingress and egress at every router; NAT and unsupported
          constructs stop with UNKNOWN.
        </p>
        <textarea
          id="round-trip-input"
          aria-describedby="round-trip-help"
          spellCheck={false}
          rows={16}
          maxLength={8192}
          disabled={busy}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          className="w-full rounded-lg border border-border bg-background p-4 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          disabled={busy}
          className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <ArrowLeftRight className="size-4" />
          {busy ? "Analysing snapshots…" : "Analyse round trip"}
        </button>
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
        <>
          <div role="status" className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold">
              {result.status.toUpperCase()} · live delivery unverified
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Declared path: {result.asymmetric ? "asymmetric" : "symmetric"}. Return conntrack is
              conditional, not observed.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {result.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <Leg label="Forward · new connection" leg={result.forward} />
            <Leg label="Return · conditional established connection" leg={result.reverse} />
          </div>
          <section className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold">Evidence provenance</h3>
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
          </section>
        </>
      )}
    </section>
  );
}
