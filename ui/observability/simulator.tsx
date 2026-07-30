/**
 * Simulator view — trace a hypothetical packet without touching the device.
 *
 * The verdict banner is the whole page in one glyph, so it has to be honest:
 * **`UNKNOWN` is styled as a warning, never as success.** A prediction the model
 * could not make must not look like one that succeeded — that is the failure
 * mode this entire feature is designed around.
 *
 *   • Packet builder with presets, because typing a six-field packet is friction.
 *   • Traversal as a vertical flow; each step names its chain, rule index and
 *     source line, so the reasoning can be checked rather than trusted.
 *   • Before/after for a proposed change, with the divergence step marked.
 *   • Reachability map — useful on its own and needs no packet.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot, Input } from "./geist";
import type { GeistType } from "./geist";
import { toast } from "./toast-action";
import type {
  SimChangePayload,
  SimPacketPayload,
  SimReachabilityRule,
  SimTrace,
  SimVerdict,
} from "./types";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const VERDICT_TYPE: Record<SimVerdict, GeistType> = {
  accept: "success",
  drop: "error",
  reject: "error",
  // Deliberately a warning: it is not a pass, and it must never read like one.
  unknown: "warning",
};

const VERDICT_CLASS: Record<SimVerdict, string> = {
  accept: "border-emerald-500/40 bg-emerald-500/10",
  drop: "border-red-500/40 bg-red-500/10",
  reject: "border-red-500/40 bg-red-500/10",
  unknown: "border-amber-500/50 bg-amber-500/10",
};

interface PacketForm {
  srcAddress: string;
  dstAddress: string;
  protocol: string;
  srcPort: string;
  dstPort: string;
  inInterface: string;
  connectionState: "new" | "established" | "related" | "invalid";
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

/** A labelled form field — `Input` itself is a bare input. */
function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Verdict({ trace }: { trace: SimTrace }): ReactNode {
  return (
    <div className={cn("rounded-md border p-3", VERDICT_CLASS[trace.verdict])}>
      <div className="flex items-center gap-2 text-lg font-semibold">
        <Dot type={VERDICT_TYPE[trace.verdict]} />
        {trace.verdict.toUpperCase()}
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          confidence: {trace.confidence}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{trace.summary}</p>
      {trace.verdict === "unknown" && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          This is not a pass. The model met something on the path it does not implement, so it
          declined to answer rather than guess.
        </p>
      )}
    </div>
  );
}

function Traversal({ trace, divergedAt }: { trace: SimTrace; divergedAt?: number }): ReactNode {
  return (
    <ol className="space-y-1">
      {trace.steps.map((s, i) => (
        <li
          key={`${s.chain}-${s.index}-${i}`}
          className={cn(
            "rounded-md border-l-2 py-1 pl-2 text-sm",
            i === divergedAt ? "border-l-amber-500 bg-amber-500/10" : "border-l-border",
          )}
        >
          <span className="font-mono text-xs text-muted-foreground">
            {i + 1}. {s.chain}
            {s.index >= 0 ? ` #${s.index}` : ""}
            {s.line > 0 ? ` (line ${s.line})` : ""}
          </span>
          <div>{s.note}</div>
          {s.raw && <div className="font-mono text-[11px] text-muted-foreground">{s.raw}</div>}
        </li>
      ))}
      {trace.nat.length > 0 && (
        <li className="rounded-md bg-muted/30 py-1 pl-2 text-sm">
          {trace.nat.map((n) => (
            <div key={`${n.stage}-${n.rule}`} className="font-mono text-xs">
              {n.stage} #{n.rule} (line {n.line}): {n.note}
            </div>
          ))}
        </li>
      )}
      {trace.unmodelled.length > 0 && (
        <li className="rounded-md border border-amber-500/40 py-1 pl-2 text-xs text-amber-600 dark:text-amber-400">
          not modelled on this path:{" "}
          {trace.unmodelled.map((u) => `${u.what}${u.line ? ` (line ${u.line})` : ""}`).join("; ")}
        </li>
      )}
    </ol>
  );
}

export function SimulatorView(): ReactNode {
  const [form, setForm] = useState<PacketForm>(PRESETS[0].packet);
  const [changes, setChanges] = useState("");
  const [trace, setTrace] = useState<SimPacketPayload | null>(null);
  const [change, setChange] = useState<SimChangePayload | null>(null);
  const [rules, setRules] = useState<SimReachabilityRule[]>([]);
  const [busy, setBusy] = useState(false);

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

  const loadReachability = useCallback(async () => {
    try {
      const res = await api<{ rules: SimReachabilityRule[] }>("/api/sim/reachability");
      setRules(res.rules ?? []);
    } catch {
      // The page is useful without it; the packet tracer does not depend on it.
    }
  }, []);

  useEffect(() => {
    void loadReachability();
  }, [loadReachability]);

  const dead = rules.filter((r) => r.unreachable);

  return (
    <div className="space-y-4">
      <Panel
        title="Packet"
        extra={
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button key={p.label} size="sm" type="secondary" onClick={() => setForm(p.packet)}>
                {p.label}
              </Button>
            ))}
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Source">
            <Input value={form.srcAddress} onChange={(e) => set("srcAddress", e.target.value)} />
          </Field>
          <Field label="Destination">
            <Input value={form.dstAddress} onChange={(e) => set("dstAddress", e.target.value)} />
          </Field>
          <Field label="Protocol">
            <Input value={form.protocol} onChange={(e) => set("protocol", e.target.value)} />
          </Field>
          <Field label="In interface">
            <Input value={form.inInterface} onChange={(e) => set("inInterface", e.target.value)} />
          </Field>
          <Field label="Src port">
            <Input value={form.srcPort} onChange={(e) => set("srcPort", e.target.value)} />
          </Field>
          <Field label="Dst port">
            <Input value={form.dstPort} onChange={(e) => set("dstPort", e.target.value)} />
          </Field>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Connection state (declared)</span>
            <select
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={form.connectionState}
              onChange={(e) => set("connectionState", e.target.value)}
            >
              {["new", "established", "related", "invalid"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button onClick={() => void run()} loading={busy}>
              Trace
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Connection state is <strong>declared</strong>, not inferred — this model has no
          connection-tracking table. Nothing is sent to the device.
        </p>
      </Panel>

      {trace && (
        <>
          <Panel title={`Verdict — ${trace.source}`}>
            <Verdict trace={trace.result} />
            <div className="mt-3">
              <Traversal trace={trace.result} />
            </div>
          </Panel>

          {(trace.coverage.unmodelled.length > 0 ||
            trace.coverage.dynamicRouteSources.length > 0) && (
            <Panel title="Config coverage">
              {trace.coverage.dynamicRouteSources.length > 0 && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  This device runs {trace.coverage.dynamicRouteSources.join(", ")} — routes learned
                  at runtime are not in an export, so a missing route here is not proof the device
                  lacks one.
                </p>
              )}
              {trace.coverage.unmodelled.length > 0 && (
                <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                  {trace.coverage.unmodelled.slice(0, 20).map((u, i) => (
                    <li key={`${u.what}-${u.line}-${i}`}>
                      {u.what} — line {u.line} {u.detail ? `· ${u.detail}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </>
      )}

      <Panel
        title="Proposed change"
        extra={
          <Button size="sm" type="secondary" onClick={() => void runChange()} loading={busy}>
            Simulate change
          </Button>
        }
      >
        <Textarea
          value={changes}
          onChange={(e) => setChanges(e.target.value)}
          rows={4}
          placeholder={
            "/ip firewall filter\nadd action=drop chain=forward dst-port=443 protocol=tcp"
          }
          className="font-mono text-xs"
        />
        {change && (
          <div className="mt-3">
            <div
              className={cn(
                "mb-3 rounded-md border p-2 text-sm",
                change.diff.changed ? "border-amber-500/50 bg-amber-500/10" : "border-border",
              )}
            >
              {change.diff.summary}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-sm font-medium">Before</h4>
                <Verdict trace={change.before} />
                <div className="mt-2">
                  <Traversal trace={change.before} divergedAt={change.diff.divergedAt} />
                </div>
              </div>
              <div>
                <h4 className="mb-2 text-sm font-medium">After</h4>
                <Verdict trace={change.after} />
                <div className="mt-2">
                  <Traversal trace={change.after} divergedAt={change.diff.divergedAt} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard k="Filter rules" v={String(rules.length)} sub="in the config" />
        <StatCard
          k="Unreachable"
          v={String(dead.length)}
          cls={dead.length > 0 ? "text-amber-500" : undefined}
          sub="can never match"
        />
      </div>

      <Panel
        title="Reachability"
        extra={
          <Button size="sm" type="secondary" onClick={() => void loadReachability()}>
            Refresh
          </Button>
        }
      >
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No filter rules read yet.</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {rules.map((r) => (
              <li
                key={`${r.chain}-${r.index}`}
                className={cn(
                  "flex items-start gap-2",
                  r.unreachable && "text-muted-foreground line-through",
                  r.disabled && "opacity-50",
                )}
                title={r.why}
              >
                <Badge type={r.unreachable ? "warning" : "secondary"}>
                  {r.chain} #{r.index}
                </Badge>
                <span className="flex-1 truncate">{r.raw}</span>
                {r.unreachable && (
                  <span className="text-amber-500">shadowed by #{r.shadowedBy}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
