import { useState } from "react";
import type { VerificationReport } from "../../src/sim/verify";
import { postJson } from "./api";
import { Panel } from "./atoms";
import { Badge, Button, Input, Select } from "./geist";
import { Textarea } from "@/components/ui/textarea";

export function PolicyVerifier() {
  const [form, setForm] = useState({
    config_text: "",
    source: "192.168.20.0/24",
    destination: "192.168.10.0/24",
    source_ports: "0-65535",
    destination_ports: "0-65535",
    in_interface: "bridge-guest",
    out_interface: "bridge-lan",
    chain: "forward",
    protocol: "tcp",
    connection_state: "new",
    expect: "drop",
  });
  const [result, setResult] = useState<VerificationReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key: keyof typeof form, value: string) => {
    setForm((old) => ({ ...old, [key]: value }));
    setResult(null);
    setError("");
  };
  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await postJson<VerificationReport & { error?: string }>(
        "/api/sim/verify",
        form,
      );
      if (response.error) setError(response.error);
      else setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Policy verifier" extra={<Badge type="secondary">Offline · filter only</Badge>}>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Check every address and port in a scope, not just one packet. A violation includes the first
        counterexample and the rules that decided it.
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-xs text-muted-foreground">
            Source network or range
            <Input value={form.source} onChange={(e) => update("source", e.target.value)} />
          </label>
          <label className="space-y-2 text-xs text-muted-foreground">
            Destination network or range
            <Input
              value={form.destination}
              onChange={(e) => update("destination", e.target.value)}
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ["source_ports", "Source ports"],
              ["destination_ports", "Destination ports"],
              ["in_interface", "Ingress interface"],
              ["out_interface", "Egress interface"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="space-y-2 text-xs text-muted-foreground">
              {label}
              <Input value={form[key]} onChange={(e) => update(key, e.target.value)} />
            </label>
          ))}
          {(
            [
              ["chain", "Filter chain", ["forward", "input", "output"]],
              ["protocol", "Protocol", ["tcp", "udp"]],
              ["connection_state", "Declared state", ["new", "established", "related", "invalid"]],
              ["expect", "Required verdict", ["drop", "reject", "accept"]],
            ] as const
          ).map(([key, label, options]) => (
            <label key={key} className="space-y-2 text-xs text-muted-foreground">
              {label}
              <Select
                value={form[key]}
                onValueChange={(value) => update(key, value)}
                options={options.map((value) => ({ value, label: value }))}
                aria-label={label}
              />
            </label>
          ))}
        </div>
        <label className="block space-y-2 text-xs text-muted-foreground">
          Static RouterOS export
          <Textarea
            className="min-h-36 font-mono text-xs"
            placeholder={"/ip firewall filter\nadd chain=forward action=drop"}
            value={form.config_text}
            maxLength={200000}
            onChange={(e) => update("config_text", e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">
            Use a complete export without secrets. Addresses are at filter entry, after destination
            NAT. No router is contacted. Unmodelled rules return Unknown.
          </p>
          <Button disabled={busy || !form.config_text.trim()} onClick={() => void run()}>
            {busy ? "Verifying…" : "Verify address space"}
          </Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      )}
      {result && (
        <section
          aria-live="polite"
          className="mt-5 space-y-3 rounded-lg border border-border bg-muted/20 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge
              type={
                result.status === "proved"
                  ? "success"
                  : result.status === "violated"
                    ? "error"
                    : "warning"
              }
            >
              {result.status === "proved"
                ? "Proved within scope"
                : result.status === "violated"
                  ? "Counterexample found"
                  : "Unknown — not proved"}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {result.checked} / {result.cells} cells
            </span>
          </div>
          <p className="text-sm">{result.reason}</p>
          <p className="text-xs text-muted-foreground">{result.scope}</p>
          {result.witness && (
            <p className="break-all rounded-md bg-background p-3 font-mono text-sm">
              {result.witness.srcAddress}:{result.witness.srcPort} → {result.witness.dstAddress}:
              {result.witness.dstPort} · {result.witness.protocol}
            </p>
          )}
          {result.trace?.length ? (
            <ol className="space-y-2 border-l-2 border-border pl-4">
              {result.trace.map((step, index) => (
                <li key={index} className="text-xs">
                  <span className="font-mono">
                    {step.chain} #{step.index} · line {step.line} · {step.action}
                  </span>
                  <p className="mt-1 text-muted-foreground">{step.note}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      )}
    </Panel>
  );
}
