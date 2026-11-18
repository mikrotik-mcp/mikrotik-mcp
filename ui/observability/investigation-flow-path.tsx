import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, Info, Route, Search } from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import type { FlowBranch, FlowPathResult } from "../../src/investigations/flow-path";
import { postJson } from "./api";
import { JsonView } from "./highlight";
import { tunnelInventory } from "./investigation-visual-model";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import { Checkbox, NumberInput, TextInput } from "./kit";

const ipv4 = (value: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value.split(".").every((n) => Number(n) <= 255);
const vpnTypes = new Set([
  "wg",
  "wireguard",
  "ovpn-in",
  "ovpn-out",
  "sstp-in",
  "sstp-out",
  "l2tp-in",
  "l2tp-out",
  "pptp-in",
  "pptp-out",
]);
interface Candidate {
  destination: string;
  source_port: number;
  destination_port: number;
  protocol: "tcp" | "udp";
  last: number;
}

const ifaceName = (
  side: FlowBranch["ingress"],
  index: FlowBranch["inputIf"],
  fallback: string,
): string => side?.name ?? (index ? `ifIndex ${index}` : fallback);

/** The board's two interface boxes: reported ingress, then reported exit. */
function ExportBranch({ branch: b }: { branch: FlowBranch }): ReactNode {
  const vpn = !!b.egress && vpnTypes.has(b.egress.type);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="inv-ifaces">
        <div className="glass inv-iface">
          <StatusDot tone={b.ingress ? "good" : "default"} />
          <span>
            <span className="inv-iface-name">
              {ifaceName(b.ingress, b.inputIf, "Not exported")}
            </span>
            <span className="inv-hint">ingress · {b.ingress?.type ?? "name unresolved"}</span>
          </span>
        </div>
        <ChevronRight aria-hidden="true" />
        <div className="glass inv-iface">
          <StatusDot tone={vpn ? "brand" : b.egress ? "good" : "warn"} />
          <span>
            <span className="inv-iface-name">
              {ifaceName(b.egress, b.outputIf, "Not exported")}
            </span>
            <span className="inv-hint">egress · {b.egress?.type ?? "name unresolved"}</span>
          </span>
        </div>
      </div>
      <span className="inv-hint">
        {b.records} matching record{b.records === 1 ? "" : "s"} · last reported{" "}
        {new Date(b.last).toLocaleTimeString()}
      </span>
    </div>
  );
}

/** User-triggered passive export inspection; opening a saved case does no I/O. */
export function InvestigationFlowPath({
  investigation: c,
  className,
}: {
  investigation: Investigation;
  className?: string;
}): ReactNode {
  const [client, setClient] = useState(ipv4(c.client) ? c.client : "");
  const [destination, setDestination] = useState(ipv4(c.target) ? c.target : "");
  const [sourcePort, setSourcePort] = useState("");
  const [destinationPort, setDestinationPort] = useState("443");
  const [protocol, setProtocol] = useState("tcp");
  const names = [
    ...new Set(
      c.evidence
        .filter((e) => e.device === c.device && e.source === "interfaces")
        .flatMap((e) => e.rows.map((r) => r.name).filter(Boolean)),
    ),
  ];
  const [selected, setSelected] = useState<string[]>(
    tunnelInventory(c)
      .filter((t) => t.device === c.device)
      .map((t) => t.name)
      .slice(0, 8),
  );
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateNote, setCandidateNote] = useState("");
  const [result, setResult] = useState<FlowPathResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const request = async (kind: "client-flows" | "flow-path"): Promise<void> => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (kind === "client-flows") {
        setCandidates([]);
        setCandidateNote("");
        const response = await postJson<{
          error?: string;
          candidates?: Candidate[];
          limited?: boolean;
          collectorRunning?: boolean;
        }>(`/api/investigations/client-flows?device=${encodeURIComponent(c.device)}`, { client });
        if (current !== generation.current) return;
        if (response.error || !Array.isArray(response.candidates))
          throw new Error(
            response.error ??
              "Flow candidates are unavailable. The server may need reloading after upgrade.",
          );
        setCandidates(response.candidates);
        setCandidateNote(
          `${response.candidates.length} recent exported flows${response.limited ? " · list limited" : ""}${!response.collectorRunning ? " · collector stopped" : ""}. These IPs are not automatically associated with ${c.target}.`,
        );
      } else {
        const response = await postJson<FlowPathResult & { error?: string }>(
          `/api/investigations/flow-path?device=${encodeURIComponent(c.device)}`,
          {
            client,
            destination,
            source_port: Number(sourcePort),
            destination_port: Number(destinationPort),
            protocol,
            interface_names: selected,
          },
        );
        if (current !== generation.current) return;
        if (response.error || !Array.isArray(response.forward))
          throw new Error(
            response.error ??
              "Flow evidence is unavailable. Reload the upgraded server and try again.",
          );
        setResult(response);
      }
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "Flow inspection failed.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const change = (): void => {
    setResult(null);
    setError("");
  };
  const exits = [
    ...new Set(result?.forward.map((b) => ifaceName(b.egress, b.outputIf, "Unknown exit")) ?? []),
  ];
  const portField = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder?: string,
  ): ReactNode => (
    <div className="monitor-fl">
      <span className="monitor-label">{label}</span>
      <NumberInput
        label={label}
        allowEmpty
        min={1}
        max={65535}
        value={value === "" ? null : Number(value)}
        placeholder={placeholder}
        onChange={(n) => {
          set(n == null ? "" : String(n));
          change();
        }}
      />
    </div>
  );

  return (
    <MonitorPanel
      className={className}
      aria-label="Actual flow export evidence"
      title="Which exit did this flow report?"
      description="Real NetFlow/IPFIX records, separate from the saved case above."
      extra={
        <StatusBadge tone="brand" quiet={false}>
          Passive · last 5 min
        </StatusBadge>
      }
    >
      <div className="inv-flow">
        <form
          className="inv-flow-form"
          onSubmit={(event) => {
            event.preventDefault();
            void request("flow-path");
          }}
        >
          <fieldset disabled={busy} className="contents">
            <div className="inv-flow-find">
              <label className="monitor-fl">
                <span className="monitor-label">Client IPv4</span>
                <TextInput
                  mono
                  label="Client IPv4"
                  required
                  value={client}
                  onChange={(v) => {
                    setClient(v);
                    setCandidates([]);
                    setCandidateNote("");
                    change();
                  }}
                  placeholder="10.10.10.247"
                />
              </label>
              <MonitorButton
                icon={<Search aria-hidden="true" />}
                disabled={busy || !ipv4(client)}
                onClick={() => void request("client-flows")}
              >
                Find recent flows
              </MonitorButton>
            </div>
            {candidateNote && <p className="inv-hint">{candidateNote}</p>}
            {candidates.length > 0 && (
              <div className="inv-candidates" aria-label="Recent exported client flows">
                {candidates.map((item) => (
                  <button
                    type="button"
                    key={`${item.destination}:${item.source_port}:${item.destination_port}:${item.protocol}`}
                    className="monitor-row grid-cols-[minmax(0,1fr)_auto]"
                    onClick={() => {
                      setDestination(item.destination);
                      setSourcePort(String(item.source_port));
                      setDestinationPort(String(item.destination_port));
                      setProtocol(item.protocol);
                      change();
                    }}
                  >
                    <span className="inv-mono inv-trunc text-foreground">
                      :{item.source_port} → {item.destination}:{item.destination_port}
                    </span>
                    <span className="inv-hint">
                      {item.protocol.toUpperCase()} · {new Date(item.last).toLocaleTimeString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="inv-flow-fields">
              <label className="monitor-fl">
                <span className="monitor-label">Actual destination IPv4</span>
                <TextInput
                  mono
                  label="Actual destination IPv4"
                  required
                  value={destination}
                  placeholder={`IP used for ${c.target}`}
                  onChange={(v) => {
                    setDestination(v);
                    change();
                  }}
                />
              </label>
              <div className="monitor-fl inv-full">
                <span className="monitor-label">Protocol</span>
                <MonitorSelect
                  label="Protocol"
                  value={protocol}
                  onChange={(v) => {
                    setProtocol(v);
                    change();
                  }}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP / QUIC" },
                  ]}
                />
              </div>
              {portField("Client source port", sourcePort, setSourcePort, "From a recent flow")}
              {portField("Destination port", destinationPort, setDestinationPort)}
            </div>
            {names.length > 0 && (
              <details className="inv-refs">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  Interface names to resolve · {selected.length} / 8
                </summary>
                <div className="flex flex-col gap-2">
                  <p className="inv-hint">
                    Only changes which exported ifIndex values get a name. Unselected exits keep
                    their number.
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {names.map((name) => (
                      <Checkbox
                        key={name}
                        className="min-w-0"
                        label={<span className="inv-mono break-all">{name}</span>}
                        checked={selected.includes(name)}
                        disabled={busy || (!selected.includes(name) && selected.length >= 8)}
                        onCheckedChange={(on) => {
                          setSelected((s) => (on ? [...s, name] : s.filter((n) => n !== name)));
                          change();
                        }}
                      />
                    ))}
                  </div>
                </div>
              </details>
            )}
            <div className="inv-flow-run">
              <MonitorButton
                type="submit"
                variant="primary"
                icon={<Route aria-hidden="true" />}
                disabled={busy || !ipv4(client) || !ipv4(destination)}
              >
                {busy ? "Reading evidence…" : "Check exported path"}
              </MonitorButton>
              <span className="inv-hint">Read-only. No capture starts.</span>
            </div>
          </fieldset>
        </form>
        <div className="inv-flow-result" aria-live="polite">
          {error ? (
            <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
              {error}
            </MonitorNote>
          ) : !result ? (
            <MonitorEmpty compact icon={<Route />} title="No flow checked yet">
              Pick a recent flow or enter its ports, then check the exported path.
            </MonitorEmpty>
          ) : (
            <>
              <p className="inv-eyebrow" data-tone={result.forward.length ? undefined : "warn"}>
                {result.forward.length
                  ? "Exporter-reported exit · not a capture"
                  : "Path remains unknown"}
              </p>
              <b className="inv-exit">
                {exits.length ? exits.join(" / ") : "No matching flow export"}
              </b>
              <span className="inv-hint">
                <span className="inv-mono">
                  {result.tuple.client}:{result.tuple.source_port} → {result.tuple.destination}:
                  {result.tuple.destination_port} · {result.tuple.protocol.toUpperCase()}
                </span>{" "}
                · checked {new Date(result.checkedAt).toLocaleTimeString()} ·{" "}
                {result.collectorRunning ? "collector listening" : "collector stopped"} ·{" "}
                {result.exporter}
              </span>
              {result.forward.map((b) => (
                <ExportBranch key={`${b.inputIf}:${b.outputIf}`} branch={b} />
              ))}
              <MonitorNote icon={<Info aria-hidden="true" />}>
                <b>Destination delivery: unverified.</b> An exported exit does not prove the VPN
                peer received the data.
              </MonitorNote>
              {result.reverse.length ? (
                <MonitorNote icon={<Info aria-hidden="true" />}>
                  <b>Return flow reported.</b> Exact reverse tuple only; NAT can change it.
                </MonitorNote>
              ) : (
                <MonitorNote tone="warn" icon={<AlertTriangle aria-hidden="true" />}>
                  <b>Return flow not matched.</b> Exact reverse tuple only; NAT can change it.
                </MonitorNote>
              )}
              {result.reverse.length > 0 && (
                <details className="inv-refs">
                  <summary>
                    <ChevronRight aria-hidden="true" />
                    Reported return path
                  </summary>
                  <div className="flex flex-col gap-2">
                    {result.reverse.map((b) => (
                      <ExportBranch key={`${b.inputIf}:${b.outputIf}`} branch={b} />
                    ))}
                  </div>
                </details>
              )}
              <details className="inv-refs" open={!result.forward.length}>
                <summary>
                  <ChevronRight aria-hidden="true" />
                  Coverage and next steps
                </summary>
                <ul className="inv-hint flex list-disc flex-col gap-1 pl-4">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                  {result.limited && (
                    <li>Limited to 500 records per direction. Other paths may be missing.</li>
                  )}
                  {result.rejected > 0 && (
                    <li>{result.rejected} records rejected for bad timestamps or counters.</li>
                  )}
                  <li>
                    No exporter connected? Set up Traffic Flow and its collector on{" "}
                    <a className="text-brand underline" href="#flows">
                      Flows
                    </a>
                    . This check never turns export on.
                  </li>
                </ul>
              </details>
              <details className="inv-refs">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  Matching JSON · up to 20 records per direction
                </summary>
                <JsonView value={result.evidence} maxHeight={320} />
              </details>
            </>
          )}
        </div>
      </div>
    </MonitorPanel>
  );
}
