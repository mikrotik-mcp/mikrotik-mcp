/**
 * Simulator view — trace a hypothetical packet without touching the device.
 *
 * The verdict box is the whole page in one word, so it has to be honest:
 * **`UNKNOWN` is styled as a warning, never as success.** A prediction the model
 * could not make must not look like one that succeeded — that is the failure
 * mode this entire feature is designed around.
 *
 *   • Packet builder with presets, because typing a six-field packet is friction.
 *   • Traversal as a vertical flow; each step names its chain, rule index and
 *     source line, so the reasoning can be checked rather than trusted.
 *   • Before/after for a proposed change, with the divergence step marked.
 *   • Reachability map — useful on its own and needs no packet.
 *
 * Layout follows the approved Simulator board.
 */
import "./monitoring.css";
import "./simulator.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Play, RefreshCw, TriangleAlert } from "lucide-react";
import { api, postJson } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
  useStaggerIn,
} from "./monitoring-ui";
import { PolicyVerifier } from "./policy-verifier";
import { TextArea, TextInput } from "./kit";
import { toast } from "./toast-action";
import type {
  SimChangePayload,
  SimPacketPayload,
  SimReachabilityRule,
  SimTrace,
  SimVerdict,
} from "./types";

// Deliberately a warning for `unknown`: it is not a pass, and it must never read like one.
const VERDICT_TONE: Record<SimVerdict, "good" | "bad" | "warn"> = {
  accept: "good",
  drop: "bad",
  reject: "bad",
  unknown: "warn",
};

type ConnState = "new" | "established" | "related" | "invalid";

interface PacketForm {
  srcAddress: string;
  dstAddress: string;
  protocol: string;
  srcPort: string;
  dstPort: string;
  inInterface: string;
  connectionState: ConnState;
}

const PRESETS: { label: string; packet: PacketForm }[] = [
  {
    label: "Web from LAN",
    packet: {
      srcAddress: "192.168.88.50",
      dstAddress: "8.8.8.8",
      protocol: "tcp",
      srcPort: "51234",
      dstPort: "443",
      inInterface: "bridge",
      connectionState: "new",
    },
  },
  {
    label: "SSH from WAN",
    packet: {
      srcAddress: "198.51.100.9",
      dstAddress: "203.0.113.10",
      protocol: "tcp",
      srcPort: "40000",
      dstPort: "22",
      inInterface: "ether1",
      connectionState: "new",
    },
  },
  {
    label: "DNS from LAN",
    packet: {
      srcAddress: "192.168.88.50",
      dstAddress: "1.1.1.1",
      protocol: "udp",
      srcPort: "33333",
      dstPort: "53",
      inInterface: "bridge",
      connectionState: "new",
    },
  },
  {
    label: "Reply inbound (established)",
    packet: {
      srcAddress: "8.8.8.8",
      dstAddress: "192.168.88.50",
      protocol: "tcp",
      srcPort: "443",
      dstPort: "51234",
      inInterface: "ether1",
      connectionState: "established",
    },
  },
];

const PROTOCOLS = ["tcp", "udp", "icmp", "gre", "ipsec-esp", "ipsec-ah", "ospf"];
const STATES: ConnState[] = ["new", "established", "related", "invalid"];

function toPacket(form: PacketForm): Record<string, unknown> {
  return {
    srcAddress: form.srcAddress,
    dstAddress: form.dstAddress,
    protocol: form.protocol,
    srcPort: form.srcPort === "" ? undefined : Number(form.srcPort),
    dstPort: form.dstPort === "" ? undefined : Number(form.dstPort),
    inInterface: form.inInterface,
    connectionState: form.connectionState,
  };
}

const samePacket = (a: PacketForm, b: PacketForm): boolean =>
  (Object.keys(a) as (keyof PacketForm)[]).every((k) => a[k] === b[k]);

/** A labelled text field with its value in mono. */
function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="monitor-fl">
      <span className="monitor-label">{label}</span>
      <TextInput mono label={label} value={value} spellCheck={false} onChange={onChange} />
    </label>
  );
}

/** The answer in one word, toned by what it means. */
function VerdictBox({ trace }: { trace: SimTrace }): ReactNode {
  const tone = VERDICT_TONE[trace.verdict];
  return (
    <div className="monitor-note sim-verdict" data-tone={tone}>
      <span className="sim-verdict-head">
        <StatusDot tone={tone} />
        <b>{trace.verdict.toUpperCase()}</b>
        <span className="flex-1" />
        <span className="monitor-hint">confidence: {trace.confidence}</span>
      </span>
      <span>{trace.summary}</span>
      {trace.verdict === "unknown" && (
        <span className="sim-verdict-unknown">
          This is not a pass. The model met something on the path it does not implement, so it
          declined to answer rather than guess.
        </span>
      )}
    </div>
  );
}

/** One row per rule the packet met. The deciding rule carries the verdict colour. */
function Traversal({
  trace,
  divergedAt,
  raw = true,
}: {
  trace: SimTrace;
  divergedAt?: number;
  raw?: boolean;
}): ReactNode {
  const last = trace.steps.length - 1;
  const decided = trace.verdict === "unknown" ? undefined : VERDICT_TONE[trace.verdict];
  return (
    <ol className="sim-trav">
      {trace.steps.map((s, i) => (
        <li
          key={`${s.chain}-${s.index}-${i}`}
          className="sim-step"
          data-tone={i === last ? decided : undefined}
          data-diverged={i === divergedAt || undefined}
          title={raw ? undefined : s.raw || undefined}
        >
          <span className="sim-step-where">
            {i + 1}. {s.chain}
            {s.index >= 0 ? ` #${s.index}` : ""}
            {s.line > 0 ? ` (line ${s.line})` : ""}
          </span>
          <span className="sim-step-note">{s.note}</span>
          {raw && s.raw && <span className="sim-step-raw">{s.raw}</span>}
        </li>
      ))}
    </ol>
  );
}

/** NAT rules on the path and what the model could not follow. */
function PathExtras({ trace }: { trace: SimTrace }): ReactNode {
  return (
    <>
      {trace.nat.length > 0 && (
        <div className="glass sim-nat">
          {trace.nat.map((n) => (
            <span key={`${n.stage}-${n.rule}`}>
              {n.stage} #{n.rule} (line {n.line}): {n.note}
            </span>
          ))}
        </div>
      )}
      {trace.unmodelled.length > 0 && (
        <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
          Not modelled on this path:{" "}
          {trace.unmodelled.map((u) => `${u.what}${u.line ? ` (line ${u.line})` : ""}`).join("; ")}
        </MonitorNote>
      )}
    </>
  );
}

function ChangeSummary({ change }: { change: SimChangePayload }): ReactNode {
  const { diff, before, after } = change;
  const step = diff.divergedAt !== undefined ? diff.divergedAt + 1 : undefined;
  if (diff.changed)
    return (
      <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
        <b>The verdict changes{step !== undefined ? ` at step ${step}` : ""}:</b> {before.verdict} →{" "}
        {after.verdict}.
      </MonitorNote>
    );
  return (
    <MonitorNote>
      {step !== undefined ? (
        <>
          <b>Same verdict, different path from step {step}.</b>{" "}
        </>
      ) : (
        <>
          <b>No change.</b>{" "}
        </>
      )}
      {after.verdict.toUpperCase()} either way.
    </MonitorNote>
  );
}

export function SimulatorView(): ReactNode {
  const [form, setForm] = useState<PacketForm>(PRESETS[0].packet);
  const [changes, setChanges] = useState("");
  const [trace, setTrace] = useState<SimPacketPayload | null>(null);
  const [change, setChange] = useState<SimChangePayload | null>(null);
  const [rules, setRules] = useState<SimReachabilityRule[]>([]);
  const [busy, setBusy] = useState(false);
  const traceRef = useRef<HTMLDivElement>(null);
  useStaggerIn(traceRef, ".sim-step", trace);

  const set = (key: keyof PacketForm, value: string): void =>
    setForm((f) => ({ ...f, [key]: value }) as PacketForm);

  const run = async (): Promise<void> => {
    setBusy(true);
    setChange(null);
    try {
      const res = await postJson<SimPacketPayload>("/api/sim/packet", { packet: toPacket(form) });
      if (res.error) toast.error(res.error);
      else setTrace(res);
    } finally {
      setBusy(false);
    }
  };

  const runChange = async (): Promise<void> => {
    if (changes.trim() === "") return;
    setBusy(true);
    try {
      const res = await postJson<SimChangePayload>("/api/sim/change", {
        packet: toPacket(form),
        changes,
      });
      if (res.error) toast.error(res.error);
      else setChange(res);
    } finally {
      setBusy(false);
    }
  };

  const loadReachability = useCallback(() => {
    return api<{ rules: SimReachabilityRule[] }>("/api/sim/reachability")
      .then((res) => {
        setRules(res.rules ?? []);
      })
      .catch(() => {
        // The page is useful without it; the packet tracer does not depend on it.
      });
  }, []);

  useEffect(() => {
    void loadReachability();
  }, [loadReachability]);

  const dead = rules.filter((r) => r.unreachable);
  const protocols = PROTOCOLS.includes(form.protocol) ? PROTOCOLS : [form.protocol, ...PROTOCOLS];
  const coverage = trace?.coverage;
  const showCoverage =
    coverage != null && (coverage.unmodelled.length > 0 || coverage.dynamicRouteSources.length > 0);

  const packet = (
    <MonitorPanel title="Packet">
      <div className="flex min-w-0 flex-col gap-[14px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <MonitorButton
              key={p.label}
              size="sm"
              variant={samePacket(form, p.packet) ? "primary" : "glass"}
              aria-pressed={samePacket(form, p.packet)}
              onClick={() => setForm(p.packet)}
            >
              {p.label}
            </MonitorButton>
          ))}
        </div>
        <div className="sim-fields">
          <Field label="Source" value={form.srcAddress} onChange={(v) => set("srcAddress", v)} />
          <Field
            label="Destination"
            value={form.dstAddress}
            onChange={(v) => set("dstAddress", v)}
          />
          <div className="monitor-fl">
            <span className="monitor-label">Protocol</span>
            <div className="sim-select-full">
              <MonitorSelect
                label="Protocol"
                value={form.protocol}
                onChange={(v) => set("protocol", v)}
                options={protocols.map((p) => ({ value: p, label: p }))}
              />
            </div>
          </div>
          <Field
            label="In interface"
            value={form.inInterface}
            onChange={(v) => set("inInterface", v)}
          />
          <Field label="Src port" value={form.srcPort} onChange={(v) => set("srcPort", v)} />
          <Field label="Dst port" value={form.dstPort} onChange={(v) => set("dstPort", v)} />
        </div>
        <div className="sim-state">
          <div className="monitor-fl">
            <span className="monitor-label">Connection state (declared)</span>
            <Segmented
              label="Connection state (declared)"
              value={form.connectionState}
              options={STATES.map((s) => ({ value: s, label: s }))}
              onChange={(v) => set("connectionState", v)}
            />
          </div>
          <MonitorButton
            variant="primary"
            icon={<Play aria-hidden="true" />}
            disabled={busy}
            onClick={() => void run()}
          >
            Trace
          </MonitorButton>
        </div>
        <span className="monitor-hint">
          Connection state is declared, not inferred: the model has no connection-tracking table.
          Nothing is sent to the device.
        </span>
      </div>
    </MonitorPanel>
  );

  const verdict = trace ? (
    <MonitorPanel title={`Verdict · ${trace.source}`}>
      <div ref={traceRef} className="flex min-w-0 flex-col gap-3">
        <VerdictBox trace={trace.result} />
        <Traversal trace={trace.result} />
        <PathExtras trace={trace.result} />
      </div>
    </MonitorPanel>
  ) : busy ? (
    <MonitorPanel title="Verdict">
      <LoadingState label="Simulating packet traversal" />
    </MonitorPanel>
  ) : (
    <MonitorPanel title="Verdict">
      <MonitorEmpty compact icon={<Play />} title="No trace yet">
        Pick a preset or fill in the packet, then press Trace.
      </MonitorEmpty>
    </MonitorPanel>
  );

  return (
    <div className="sim-page">
      <PageIntro
        eyebrow="Simulator"
        heading="Trace a packet before it exists."
        lead="Run a hypothetical packet through the saved configuration, preview a change, and find rules that can never match. No device is touched."
        actions={<StatusBadge tone="brand">Offline model · nothing sent</StatusBadge>}
      />

      <div className="sim-split">
        {packet}
        <div className="sim-col gap-[14px]">
          {verdict}
          {showCoverage && (
            <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
              <b>Config coverage.</b>{" "}
              {coverage.dynamicRouteSources.length > 0 && (
                <>
                  This device runs {coverage.dynamicRouteSources.join(", ")}. Routes learned at
                  runtime are not in an export, so a missing route here does not prove the device
                  lacks one.{" "}
                </>
              )}
              {coverage.unmodelled.length > 0 && (
                <>
                  Not modelled:{" "}
                  {coverage.unmodelled.slice(0, 20).map((u, i) => (
                    <span key={`${u.what}-${u.line}-${i}`}>
                      {i > 0 && " · "}
                      <span className="sim-mono" title={u.detail}>
                        {u.what} — line {u.line}
                      </span>
                    </span>
                  ))}
                </>
              )}
            </MonitorNote>
          )}
        </div>
      </div>

      <MonitorPanel
        title="Proposed change"
        description="Paste RouterOS commands. They are applied to a copy of the saved export, never to the router."
        extra={
          <MonitorButton
            size="sm"
            icon={<Play aria-hidden="true" />}
            disabled={busy || changes.trim() === ""}
            onClick={() => void runChange()}
          >
            Simulate change
          </MonitorButton>
        }
      >
        <div className="sim-change">
          <div className="flex min-w-0 flex-col gap-2.5">
            <TextArea
              mono
              label="Proposed change"
              value={changes}
              onChange={setChanges}
              rows={4}
              placeholder={
                "/ip firewall filter\nadd action=drop chain=forward dst-port=443 protocol=tcp"
              }
            />
            {change && <ChangeSummary change={change} />}
          </div>
          {change ? (
            <div className="sim-compare">
              {(
                [
                  ["Before", change.before],
                  ["After", change.after],
                ] as const
              ).map(([label, t]) => (
                <div key={label} className="flex min-w-0 flex-col gap-2">
                  <span className="monitor-label">{label}</span>
                  <VerdictBox trace={t} />
                  <Traversal trace={t} divergedAt={change.diff.divergedAt} raw={false} />
                </div>
              ))}
            </div>
          ) : (
            <MonitorEmpty compact icon={<Play />} title="No change simulated yet">
              Paste a change and press Simulate change to compare the verdict before and after.
            </MonitorEmpty>
          )}
        </div>
      </MonitorPanel>

      <div className="sim-pair">
        <MonitorPanel
          title="Reachability"
          description="Rules that an earlier rule always catches first."
          flush
          extra={
            <MonitorButton
              size="sm"
              variant="ghost"
              icon={<RefreshCw aria-hidden="true" />}
              onClick={() => void loadReachability()}
            >
              Refresh
            </MonitorButton>
          }
        >
          <div className="sim-reach-kpis">
            <MetricStrip label="Reachability">
              <Metric label="Filter rules" value={rules.length} hint="in the config" />
              <Metric
                label="Unreachable"
                value={dead.length}
                hint="can never match"
                tone={dead.length > 0 ? "warn" : "default"}
              />
            </MetricStrip>
          </div>
          {rules.length === 0 ? (
            <MonitorEmpty compact title="No filter rules read yet." />
          ) : (
            rules.map((r) => (
              <div
                key={`${r.chain}-${r.index}`}
                className="monitor-row sim-reach-row"
                data-shadowed={r.unreachable || undefined}
                data-disabled={r.disabled || undefined}
                title={r.why}
              >
                <span className="monitor-chip">
                  {r.chain} #{r.index}
                </span>
                <span className="sim-reach-raw">{r.raw}</span>
                <span className="sim-reach-why">
                  {r.unreachable ? `shadowed by #${r.shadowedBy}` : ""}
                </span>
              </div>
            ))
          )}
        </MonitorPanel>
        <PolicyVerifier />
      </div>
    </div>
  );
}
