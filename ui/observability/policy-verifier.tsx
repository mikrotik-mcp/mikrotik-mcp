import { useState } from "react";
import type { ReactNode } from "react";
import { Shield } from "lucide-react";
import type { VerificationReport } from "../../src/sim/verify";
import { postJson } from "./api";
import { MonitorButton, MonitorPanel, MonitorSelect, StatusBadge } from "./monitoring-ui";

const STATUS: Record<
  VerificationReport["status"],
  { tone: "good" | "bad" | "warn"; label: string }
> = {
  proved: { tone: "good", label: "Proved within scope" },
  violated: { tone: "bad", label: "Counterexample found" },
  unknown: { tone: "warn", label: "Unknown — not proved" },
};

/** Proves a filter-chain property over a whole address and port scope. Simulator board, bottom right. */
export function PolicyVerifier(): ReactNode {
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
  const status = result ? STATUS[result.status] : null;
  return (
    <MonitorPanel
      title="Policy verifier"
      extra={
        <StatusBadge quiet dot={false}>
          Offline · filter only
        </StatusBadge>
      }
    >
      <fieldset disabled={busy} className="sim-fieldset">
        <span className="monitor-hint text-[13px]">
          Check every address and port in a scope, not just one packet. A violation shows the first
          counterexample.
        </span>
        <div className="sim-verify-grid">
          {(
            [
              ["source", "Source network or range"],
              ["destination", "Destination network or range"],
              ["source_ports", "Source ports"],
              ["destination_ports", "Destination ports"],
              ["in_interface", "Ingress interface"],
              ["out_interface", "Egress interface"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="monitor-fl">
              <span className="monitor-label">{label}</span>
              <input
                className="monitor-input sim-input"
                value={form[key]}
                spellCheck={false}
                onChange={(e) => update(key, e.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="sim-verify-selects">
          {(
            [
              ["chain", "Filter chain", ["forward", "input", "output"]],
              ["protocol", "Protocol", ["tcp", "udp"]],
              ["connection_state", "Declared state", ["new", "established", "related", "invalid"]],
              ["expect", "Required verdict", ["drop", "reject", "accept"]],
            ] as const
          ).map(([key, label, options]) => (
            <div key={key} className="monitor-fl">
              <span className="monitor-label">{label}</span>
              <div className="sim-select-full">
                <MonitorSelect
                  label={label}
                  value={form[key]}
                  onChange={(value) => update(key, value)}
                  options={options.map((value) => ({ value, label: value }))}
                />
              </div>
            </div>
          ))}
        </div>
        <label className="monitor-fl">
          <span className="monitor-label">Static RouterOS export</span>
          <textarea
            className="monitor-input min-h-[60px]"
            placeholder={"/ip firewall filter\nadd chain=forward action=drop"}
            value={form.config_text}
            maxLength={200000}
            spellCheck={false}
            onChange={(e) => update("config_text", e.target.value)}
          />
          <span className="monitor-hint">
            Use a full export without secrets. No router is contacted.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <MonitorButton
            variant="primary"
            icon={<Shield aria-hidden="true" />}
            disabled={busy || !form.config_text.trim()}
            onClick={() => void run()}
          >
            {busy ? "Verifying…" : "Verify address space"}
          </MonitorButton>
        </div>
        {error && (
          <p role="alert" className="monitor-err">
            {error}
          </p>
        )}
        {result && status && (
          <section aria-live="polite" className="monitor-note sim-result" data-tone={status.tone}>
            <span className="sim-result-head">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              <span className="flex-1" />
              <span className="sim-mono text-muted-foreground">
                {result.checked.toLocaleString()} / {result.cells.toLocaleString()} cells
              </span>
            </span>
            <span>{result.reason}</span>
            {result.witness && (
              <span className="sim-mono break-all text-foreground">
                {result.witness.srcAddress}:{result.witness.srcPort} → {result.witness.dstAddress}:
                {result.witness.dstPort} · {result.witness.protocol}
              </span>
            )}
            {result.trace?.length ? (
              <ol className="sim-trav">
                {result.trace.map((step, index) => (
                  <li key={index} className="sim-step">
                    <span className="sim-step-where">
                      {step.chain} #{step.index} · line {step.line} · {step.action}
                    </span>
                    <span className="sim-step-note">{step.note}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            <span className="monitor-hint">{result.scope}</span>
          </section>
        )}
      </fieldset>
    </MonitorPanel>
  );
}
