import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  CircleHelp,
  Clock,
  Code2,
  Database,
  Layers,
  LockKeyhole,
  Network,
  Pause,
  Play,
  Radar,
  Router,
  Shield,
  ShieldAlert,
  Waypoints,
} from "lucide-react";
import type { Investigation, CaseEvidence } from "../../src/investigations/model";
import { JsonView } from "./highlight";
import { pingObservation, tunnelInventory } from "./investigation-visual-model";
import { InvestigationJourney } from "./investigation-journey";
import { InvestigationFlowPath } from "./investigation-flow-path";
import "./investigation-result.css";

const sourceNames: Record<string, string> = {
  dhcp: "DHCP identity",
  arp: "ARP neighbours",
  "bridge-host": "Bridge attachment",
  vlan: "VLAN membership",
  interfaces: "Interfaces & tunnels",
  routes: "Routing context",
  filter: "Firewall filter",
  nat: "NAT translations",
  "ip-addresses": "Interface addresses",
  mangle: "Mangle / routing marks",
  "routing-rules": "Policy routing rules",
  dns: "DNS configuration",
  "router-ping": "Router ICMP probe",
};

function EvidenceCard({ evidence }: { evidence: CaseEvidence }): ReactNode {
  const Icon =
    evidence.source === "interfaces"
      ? Network
      : evidence.source === "routes"
        ? Waypoints
        : ["filter", "nat"].includes(evidence.source)
          ? Shield
          : evidence.source === "router-ping"
            ? Activity
            : Database;
  return (
    <details
      id={`evidence-${evidence.id}`}
      className="group min-w-0 overflow-hidden rounded-xl border border-border bg-card open:border-primary/25"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {sourceNames[evidence.source] ?? evidence.source}
          </span>
          <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
            {evidence.rows.length} records{evidence.truncated ? " · truncated" : ""}
          </span>
        </span>
        <span
          className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-wide ${evidence.state === "unknown" ? "border-warning/30 text-warning" : "border-border text-muted-foreground"}`}
        >
          {evidence.state}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="space-y-3 border-t border-border bg-background/40 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{evidence.summary}</p>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="size-3" />
          {new Date(evidence.startedAt).toLocaleTimeString()} —{" "}
          {new Date(evidence.finishedAt).toLocaleTimeString()}
        </p>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          <Code2 className="size-3" />
          Recorded JSON
        </div>
        <JsonView value={evidence.rows} maxHeight={360} />
      </div>
    </details>
  );
}

/** Historical context plus a separate, explicitly user-triggered export evidence panel. */
export function InvestigationResult({
  investigation: c,
}: {
  investigation: Investigation;
}): ReactNode {
  const [motion, setMotion] = useState(true);
  const tunnels = tunnelInventory(c);
  const unknown = c.evidence.filter((e) => e.state === "unknown").length;
  const routerProbe = pingObservation(
    c.evidence.find((e) => e.device === c.device && e.source === "router-ping"),
  );
  const deviceNames = [...new Set([c.device, ...c.devices, ...c.evidence.map((e) => e.device)])];
  return (
    <article className="investigation-result min-w-0 space-y-5" data-motion={motion ? "on" : "off"}>
      <header className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div className="min-w-0">
            <p className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Radar className="size-4 text-chart-2" />
              Investigation workspace
            </p>
            <h3 className="break-words text-2xl font-semibold tracking-tight">{c.service}</h3>
            <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
              <span>{c.client}</span>
              <ArrowRight className="size-3" />
              <span className="break-all">{c.target}</span>
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
            <CircleHelp className="size-3.5" />
            Client health unverified
          </span>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border bg-background/40 text-center">
          {[
            [String(c.evidence.length), "Evidence sources"],
            [String(unknown), "Unavailable sources"],
            [String(tunnels.length), "Recorded tunnels"],
          ].map(([value, label]) => (
            <div key={label} className="px-2 py-4">
              <p className="font-mono text-xl font-semibold">{value}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <p className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
          Snapshot of evidence · {new Date(c.createdAt).toLocaleString()} · Not live telemetry
        </p>
      </header>

      <InvestigationFlowPath key={`flow-${c.id}`} investigation={c} />
      <InvestigationJourney key={c.id} investigation={c} />

      <aside className="rounded-xl border border-border bg-background/50 p-4">
        <p className="flex items-center gap-2 text-xs font-medium">
          <Activity className="size-4 text-muted-foreground" />
          {routerProbe.text}
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Separate router-originated probe · does not confirm this client’s route, VPN or
          application.
        </p>
      </aside>

      <details className="rounded-2xl border border-border bg-card p-5">
        <summary className="cursor-pointer text-sm font-semibold">
          All recorded tunnels · {tunnels.length} · inventory, not the selected path
        </summary>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Shield className="size-4 text-chart-5" />
            Protocol inventory
          </h4>
          <button
            type="button"
            onClick={() => setMotion((m) => !m)}
            aria-pressed={motion}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            {motion ? <Pause className="size-3" /> : <Play className="size-3" />}
            {motion ? "Pause motion" : "Enable motion"}
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Interfaces recorded in this case. Icons animate decoratively, not as packet counters.
          Running does not prove a VPN handshake or use by this client.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {tunnels.map((t, i) => {
            const Icon = t.encrypted ? LockKeyhole : Layers;
            const tone =
              t.state === "running"
                ? "text-chart-2 border-chart-2/30"
                : t.state === "disabled" || t.state === "not-running"
                  ? "text-warning border-warning/30"
                  : "text-muted-foreground border-border";
            return (
              <div
                key={`${t.evidenceId}:${t.name}:${i}`}
                className="min-w-0 overflow-hidden rounded-xl border border-border bg-background"
              >
                <div
                  className="relative flex h-24 items-center justify-center overflow-hidden border-b border-border bg-muted/20"
                  aria-hidden="true"
                >
                  <svg
                    viewBox="0 0 280 90"
                    preserveAspectRatio="none"
                    className="absolute inset-0 h-full w-full text-border"
                  >
                    <path
                      d="M0 65C75 65 60 20 140 20S205 65 280 65M0 77C75 77 60 32 140 32S205 77 280 77M0 53C75 53 60 8 140 8S205 53 280 53"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                  </svg>
                  <span
                    className={`tunnel-emblem relative flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm ${tone}`}
                    style={{ animationDelay: `${(i % 4) * -0.6}s` }}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="absolute bottom-2 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                    {t.protocol}
                  </span>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h5 className="break-all font-mono text-xs font-semibold">{t.name}</h5>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone}`}>
                      {t.state === "unknown" ? "State unknown" : t.state}
                    </span>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Router className="size-3" />
                    {t.device}
                  </p>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {t.encrypted
                      ? "Encrypted protocol · session not verified"
                      : "Encapsulation · encryption not established"}
                  </p>
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      {t.routes.length} explicit route references · not flow proof
                    </summary>
                    <div className="mt-3">
                      <JsonView value={t.routes} maxHeight={180} />
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
        {!tunnels.length && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-dashed border-border p-4">
            <ShieldAlert className="size-5 shrink-0 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              No typed tunnel interfaces are present in the saved evidence. This does not mean the
              router has no VPNs; IPsec policies, peer handshakes and omitted/truncated interfaces
              are not covered.
            </p>
          </div>
        )}
        {c.evidence.some((e) => e.source === "interfaces" && e.truncated) && (
          <p className="mt-3 text-xs text-warning">
            Interface evidence is truncated; this inventory is incomplete.
          </p>
        )}
      </details>

      <section className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <Database className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Evidence explorer</h4>
        </div>
        {deviceNames.map((device) => (
          <div key={device} className="space-y-2">
            <p className="flex items-center gap-2 px-1 py-2 font-mono text-xs text-muted-foreground">
              <Router className="size-3.5" />
              {device}
            </p>
            {c.evidence
              .filter((e) => e.device === device)
              .map((e) => (
                <EvidenceCard key={e.id} evidence={e} />
              ))}
          </div>
        ))}
      </section>
      <section className="rounded-2xl border border-border bg-card p-5">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <Radar className="size-4 text-chart-2" />
          Close the evidence gaps
        </h4>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Next experiments · not performed automatically
        </p>
        <ol className="mt-4 space-y-3">
          {c.nextTests.map((t, i) => (
            <li key={t} className="flex items-start gap-3 text-xs leading-relaxed">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background font-mono text-[10px] text-muted-foreground">
                {i + 1}
              </span>
              <span className="pt-0.5 text-muted-foreground">{t}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
