import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CircleHelp,
  Clock,
  Layers,
  Network,
  Radio,
  RefreshCw,
  Router,
  Shield,
  Unplug,
} from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import type { FlowBranch, FlowPathResult } from "../../src/investigations/flow-path";
import { postJson } from "./api";
import { Checkbox } from "./components/ui/checkbox";
import { Select } from "./geist";
import { JsonView } from "./highlight";
import { tunnelInventory } from "./investigation-visual-model";

const field =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring";
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

function ExportBranch({ branch: b, device }: { branch: FlowBranch; device: string }): ReactNode {
  const vpn = b.egress && vpnTypes.has(b.egress.type);
  return (
    <div className="flow-export-branch" data-vpn={vpn ? "yes" : "no"}>
      <div className="flow-export-stations">
        <div className="flow-export-station">
          <Network className="size-5 text-chart-2" />
          <span>Reported ingress</span>
          <strong>
            {b.ingress?.name ?? (b.inputIf ? `ifIndex ${b.inputIf}` : "Not exported")}
          </strong>
          <small>{b.ingress?.type ?? "Name unresolved"}</small>
        </div>
        <ArrowRight className="flow-export-arrow" aria-hidden="true" />
        <div className="flow-export-station">
          <Router className="size-5" />
          <span>Exporting router</span>
          <strong>{device}</strong>
          <small>
            {b.records} matching export record{b.records === 1 ? "" : "s"}
          </small>
        </div>
        <ArrowRight className="flow-export-arrow" aria-hidden="true" />
        <div className="flow-export-station flow-export-exit">
          {vpn ? (
            <Shield className="size-5 text-chart-5" />
          ) : b.outputIf ? (
            <Layers className="size-5 text-chart-2" />
          ) : (
            <CircleHelp className="size-5 text-warning" />
          )}
          <span>Reported exit</span>
          <strong>
            {b.egress?.name ?? (b.outputIf ? `ifIndex ${b.outputIf}` : "Not exported")}
          </strong>
          <small>{b.egress?.type ?? "Name unresolved"}</small>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        <span>
          {vpn
            ? "Exit maps to a VPN interface now · encryption / delivery unverified"
            : "Exported interface relationship · not a hop-by-hop packet trace"}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" /> Last reported {new Date(b.last).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

/** User-triggered passive export inspection; merely opening a saved case does no I/O. */
export function InvestigationFlowPath({
  investigation: c,
}: {
  investigation: Investigation;
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
    ...new Set(
      result?.forward.map(
        (b) => b.egress?.name ?? (b.outputIf ? `ifIndex ${b.outputIf}` : "Unknown exit"),
      ) ?? [],
    ),
  ];
  return (
    <section className="flow-export-panel" aria-label="Actual flow export evidence">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-chart-2">
            <Radio className="size-4" /> Flow evidence desk
          </p>
          <h4 className="text-lg font-semibold">Which exit did this flow report?</h4>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Inspect real NetFlow/IPFIX records, separately from the saved case above. No capture
            starts, no router settings change.
          </p>
        </div>
        <span className="rounded-full border border-chart-2/30 px-2.5 py-1 text-[10px] text-chart-2">
          PASSIVE · LAST 5 MIN
        </span>
      </header>
      <form
        className="space-y-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void request("flow-path");
        }}
      >
        <fieldset disabled={busy} className="grid gap-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="grid gap-2 text-xs">
              Client IPv4
              <input
                className={field}
                required
                value={client}
                onChange={(e) => {
                  setClient(e.target.value);
                  setCandidates([]);
                  setCandidateNote("");
                  change();
                }}
                placeholder="10.10.10.247"
              />
            </label>
            <button
              className="self-end rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50"
              type="button"
              disabled={!ipv4(client)}
              onClick={() => void request("client-flows")}
            >
              <RefreshCw className="mr-2 inline size-3" />
              Find recent flows
            </button>
          </div>
          {candidateNote && <p className="text-[11px] text-muted-foreground">{candidateNote}</p>}
          {candidates.length > 0 && (
            <div
              className="max-h-44 overflow-y-auto rounded-lg border border-border"
              aria-label="Recent exported client flows"
            >
              {candidates.map((item) => (
                <button
                  type="button"
                  key={`${item.destination}:${item.source_port}:${item.destination_port}:${item.protocol}`}
                  className="flex w-full flex-wrap justify-between gap-2 border-b border-border p-3 text-left text-xs last:border-0 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setDestination(item.destination);
                    setSourcePort(String(item.source_port));
                    setDestinationPort(String(item.destination_port));
                    setProtocol(item.protocol);
                    change();
                  }}
                >
                  <span className="font-mono">
                    :{item.source_port} → {item.destination}:{item.destination_port}
                  </span>
                  <span className="text-muted-foreground">
                    {item.protocol.toUpperCase()} · {new Date(item.last).toLocaleTimeString()}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-2 text-xs">
              Actual destination IPv4
              <input
                className={field}
                required
                value={destination}
                placeholder={`IP used for ${c.target}`}
                onChange={(e) => {
                  setDestination(e.target.value);
                  change();
                }}
              />
            </label>
            <label className="grid gap-2 text-xs">
              Protocol
              <Select
                value={protocol}
                onValueChange={(v) => {
                  setProtocol(v);
                  change();
                }}
                options={[
                  { value: "tcp", label: "TCP" },
                  { value: "udp", label: "UDP / QUIC" },
                ]}
              />
            </label>
            <label className="grid gap-2 text-xs">
              Client source port
              <input
                className={field}
                type="number"
                min={1}
                max={65535}
                required
                value={sourcePort}
                placeholder="Choose a recent flow or enter its port"
                onChange={(e) => {
                  setSourcePort(e.target.value);
                  change();
                }}
              />
            </label>
            <label className="grid gap-2 text-xs">
              Destination port
              <input
                className={field}
                type="number"
                min={1}
                max={65535}
                required
                value={destinationPort}
                onChange={(e) => {
                  setDestinationPort(e.target.value);
                  change();
                }}
              />
            </label>
          </div>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-xs">
              Resolve interface names · {selected.length}/8 selected
            </summary>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Candidates from this case. Selection only controls read-only name lookup, never
              routing. Unselected exits retain their numeric ifIndex.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {names.map((name) => (
                <label
                  key={name}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border p-2 text-xs has-[[data-state=checked]]:border-chart-5/40"
                >
                  <Checkbox
                    checked={selected.includes(name)}
                    disabled={busy || (!selected.includes(name) && selected.length >= 8)}
                    onCheckedChange={(checked) => {
                      setSelected((s) =>
                        checked === true ? [...s, name] : s.filter((n) => n !== name),
                      );
                      change();
                    }}
                  />
                  <span className="break-all">{name}</span>
                </label>
              ))}
            </div>
          </details>
          <button
            type="submit"
            disabled={!ipv4(client) || !ipv4(destination)}
            className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Radio className={`size-4 ${busy ? "animate-pulse motion-reduce:animate-none" : ""}`} />
            {busy ? "Reading evidence…" : "Check exported path"}
            <ArrowRight className="size-4" />
          </button>
        </fieldset>
      </form>
      {error && (
        <p
          role="alert"
          className="mx-5 mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {result && (
        <div className="space-y-4 border-t border-border p-5" aria-live="polite">
          <div
            className={`rounded-xl border p-4 ${result.forward.length ? "border-chart-2/40 bg-chart-2/5" : "border-warning/30 bg-warning/5"}`}
          >
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {result.forward.length
                ? "Exporter-reported exit · not a capture"
                : "Path remains unknown"}
            </p>
            <h5 className="mt-2 break-words text-lg font-semibold">
              {exits.length ? exits.join(" / ") : "No matching flow export"}
            </h5>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {result.tuple.client}:{result.tuple.source_port} → {result.tuple.destination}:
              {result.tuple.destination_port} · {result.tuple.protocol.toUpperCase()}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Checked {new Date(result.checkedAt).toLocaleString()} ·{" "}
              {result.collectorRunning ? "collector listening" : "collector stopped"} ·{" "}
              {result.exporter}
            </p>
          </div>
          {result.forward.map((b) => (
            <ExportBranch key={`${b.inputIf}:${b.outputIf}`} branch={b} device={result.device} />
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-dashed border-border p-4">
              <Unplug className="mb-2 size-4 text-warning" />
              <h5 className="text-xs font-medium">Destination delivery: unverified</h5>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                An exported exit does not prove the VPN peer received the data, or identify an exact
                blocking hop.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <ArrowRight className="mb-2 size-4 rotate-180 text-chart-2" />
              <h5 className="text-xs font-medium">
                Return-flow exports: {result.reverse.length ? "reported" : "not found"}
              </h5>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Exact reverse tuple only. NAT can change the tuple; no automatic translation or
                end-to-end success is inferred.
              </p>
            </div>
          </div>
          {result.reverse.length > 0 && (
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-xs">Inspect reported return path</summary>
              <div className="mt-3 space-y-3">
                {result.reverse.map((b) => (
                  <ExportBranch
                    key={`${b.inputIf}:${b.outputIf}`}
                    branch={b}
                    device={result.device}
                  />
                ))}
              </div>
            </details>
          )}
          <details className="rounded-xl border border-border p-4" open={!result.forward.length}>
            <summary className="cursor-pointer text-xs font-medium">Coverage & next steps</summary>
            <ul className="mt-3 list-disc space-y-2 pl-4 text-[11px] leading-relaxed text-muted-foreground">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
              {result.limited && (
                <li>Limited to 500 records per direction. Additional paths may be missing.</li>
              )}
              {result.rejected > 0 && (
                <li>
                  {result.rejected} records rejected because timestamps or counters were invalid.
                </li>
              )}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              If no exporter is connected, configure Traffic Flow and its trusted collector
              separately.{" "}
              <a className="text-chart-2 underline" href="#flows">
                Open Flows
              </a>
              . This action never enables export automatically.
            </p>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-xs">
              Matching JSON evidence · up to 20 records per direction
            </summary>
            <div className="mt-3">
              <JsonView value={result.evidence} maxHeight={320} />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
