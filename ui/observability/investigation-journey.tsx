import { useId, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  CircleHelp,
  EthernetPort,
  Globe,
  Layers,
  LockKeyhole,
  Monitor,
  ShieldQuestion,
  Split,
  Waypoints,
  Wifi,
} from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import { parseIp } from "../../src/sim/ip";
import { journeyModel } from "./investigation-journey-model";
import { JsonView } from "./highlight";
import { Select } from "./geist";

function Step({
  number,
  title,
  status,
  children,
}: {
  number: string;
  title: string;
  status: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="relative min-w-0 border-l border-border pb-6 pl-6 last:border-transparent last:pb-0">
      <span className="absolute -left-3 flex size-6 items-center justify-center rounded-full border border-border bg-card font-mono text-[10px] text-muted-foreground">
        {number}
      </span>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-xs font-semibold">{title}</h5>
        <span className="text-[10px] text-muted-foreground">{status}</span>
      </div>
      {children}
    </section>
  );
}

/** Show named ingress and conditional route branches, not a generic client-router-cloud diagram. */
export function InvestigationJourney({
  investigation: c,
}: {
  investigation: Investigation;
}): ReactNode {
  const fieldId = useId();
  const [destination, setDestination] = useState(parseIp(c.target) !== null ? c.target : "");
  const [table, setTable] = useState("main");
  const m = journeyModel(c, destination, table);
  const choices = [...new Set(["main", ...m.tables])];
  const branches = m.routes
    .filter((r) => r.table === table && r.match !== "no" && r.availability !== "inactive")
    .sort(
      (a, b) =>
        Number(b.best) - Number(a.best) ||
        (b.prefix ?? -1) - (a.prefix ?? -1) ||
        (a.distance ?? Infinity) - (b.distance ?? Infinity),
    );
  const excluded = m.routes.filter(
    (r) => r.table === table && (r.match === "no" || r.availability === "inactive"),
  );
  const routeHint = !m.destinationValid
    ? "Destination IP is missing — no route can be selected for this hostname."
    : !m.best.length
      ? "No unique ranked answer from these records — this is not proof of a dropped packet."
      : m.best.length > 1
        ? `${m.best.length} equal-ranked route records remain. Flow hashing / runtime state is unresolved.`
        : `Best recorded match in ${table}: ${m.best[0].row["dst-address"]} → ${m.best[0].interfaces.join(" / ") || m.best[0].row.gateway || "gateway unknown"}. Conditional on table and runtime state.`;
  const physicalLabel = m.physical.length ? m.physical.join(" / ") : "Physical port unknown";
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <header className="border-b border-border p-5">
        <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-chart-2">
          Follow this client's journey
        </p>
        <h4 className="flex items-center gap-2 text-base font-semibold">
          <Waypoints className="size-5 text-chart-2" />
          Where does this flow leave?
        </h4>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Ingress records → policy decision → route candidates → named exit. No packet capture or
          live delivery is implied.
        </p>
      </header>
      <div className="border-b border-border bg-background/50 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={fieldId} className="grid gap-1.5 text-[11px] font-medium">
            Destination IPv4 used by the client
            <input
              id={fieldId}
              value={destination}
              onChange={(e) => setDestination(e.target.value.trim())}
              placeholder={parseIp(c.target) === null ? `IP for ${c.target}` : "Destination IPv4"}
              aria-invalid={destination !== "" && !m.destinationValid}
              aria-describedby={`${fieldId}-help`}
              className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
          <label className="grid gap-1.5 text-[11px] font-medium">
            Assumed routing table
            <Select
              aria-label="Assumed routing table"
              className="w-full"
              value={table}
              onValueChange={setTable}
              options={choices.map((t) => ({
                value: t,
                label: `${t} · ${m.routes.filter((r) => r.table === t).length} records`,
              }))}
            />
          </label>
        </div>
        <p
          id={`${fieldId}-help`}
          className="mt-3 text-[11px] leading-relaxed text-muted-foreground"
        >
          Offline comparison only. Enter the actual destination IP, not a DNS guess. Choosing a
          table does not prove that policy routing sent this client's packet there.
        </p>
      </div>
      <div className="m-5 rounded-xl border border-warning/25 bg-warning/5 p-4" role="status">
        <p className="flex items-center gap-2 text-xs font-semibold text-warning">
          <CircleHelp className="size-4 shrink-0" />
          {routeHint}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Known attachment:{" "}
          <span className="font-mono text-foreground">
            {physicalLabel} → {m.logical.join(" / ") || "logical interface unknown"}
          </span>
          . Exact client-flow exit and blocking rule are not observed.
        </p>
      </div>
      <div className="px-8 pb-6">
        <Step number="1" title="Client enters the access router" status="Saved attachment records">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-4 text-xs">
            <span className="inline-flex items-center gap-2 font-mono">
              <Monitor className="size-4 text-chart-2" />
              {c.client}
            </span>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="inline-flex items-center gap-2 rounded-lg border border-chart-2/25 bg-chart-2/5 px-3 py-2 font-mono">
              {m.physical.some((p) => /wifi|wlan/i.test(p)) ? (
                <Wifi className="size-4 text-chart-2" />
              ) : (
                <EthernetPort className="size-4 text-chart-2" />
              )}
              {physicalLabel}
            </span>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="inline-flex items-center gap-2 font-mono">
              <Layers className="size-4 text-muted-foreground" />
              {m.logical.join(" / ") || "Unknown bridge / L3 ingress"}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {c.device} · Multiple port records are alternatives, not sequential hops. Current
            traffic is not measured.
          </p>
        </Step>
        <Step
          number="2"
          title="Which table and firewall path apply?"
          status="Decision not observed"
        >
          <div className="rounded-xl border border-dashed border-warning/30 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-warning">
              <ShieldQuestion className="size-4 shrink-0" />
              Policy / connection-state gap
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Mangle, routing rules, NAT and connection state can change this flow. A firewall rule
              in the case is not proof it matched the packet.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {m.policySources.map((s) => (
                <details
                  key={s.source}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background p-3"
                >
                  <summary className="cursor-pointer text-[11px]">
                    {s.source}:{" "}
                    {s.captured ? `${s.rows.length} records · not evaluated` : "not fully captured"}
                  </summary>
                  <div className="mt-2">
                    <JsonView value={s.rows} maxHeight={180} />
                  </div>
                </details>
              ))}
            </div>
          </div>
        </Step>
        <Step
          number="3"
          title={`Possible exits in table ${table}`}
          status={
            m.destinationValid ? "Ranked for supplied IP only" : "IP needed to compare prefixes"
          }
        >
          {m.routesIncomplete && (
            <p className="mb-3 text-xs text-warning">
              Route evidence is incomplete or unsupported; ranking is withheld.
            </p>
          )}
          {!branches.length && (
            <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
              No candidate in this saved table.{" "}
              {m.tables.filter((t) => t !== table).length
                ? `Other recorded tables: ${m.tables.filter((t) => t !== table).join(", ")}. Compare them explicitly above.`
                : "Capture updated routing evidence; missing rows are not proof of a drop."}
            </p>
          )}
          <div className="space-y-3">
            {branches.map((r) => {
              const tunnel = m.tunnels.find((t) => r.interfaces.includes(t.name));
              const Icon = tunnel ? (tunnel.encrypted ? LockKeyhole : Layers) : EthernetPort;
              const disabledExit = m.interfaces.filter(
                (iface) =>
                  r.interfaces.includes(iface.name) &&
                  (iface.disabled === "yes" ||
                    iface.disabled === "true" ||
                    (iface.flags ?? "").includes("X")),
              );
              return (
                <div
                  key={r.key}
                  className={`overflow-hidden rounded-xl border ${r.best ? "border-chart-2/40 bg-chart-2/5" : "border-border bg-background"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                    <span className="font-mono text-xs">
                      {r.row["dst-address"] || "Prefix unknown"}
                    </span>
                    <span
                      className={`text-[10px] ${r.best ? "text-chart-2" : "text-muted-foreground"}`}
                    >
                      {r.best
                        ? "Best recorded candidate · NOT observed"
                        : m.destinationValid
                          ? "Alternative / fallback record"
                          : "Unfiltered route record"}
                    </span>
                  </div>
                  <div className="p-4">
                    <div className="grid gap-2 sm:grid-cols-[1fr_20px_1fr] sm:items-center">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Next-hop gateway
                        </p>
                        <p className="mt-2 break-all font-mono text-xs">
                          {r.row["immediate-gw"] || r.row.gateway || "Not recorded"}
                        </p>
                      </div>
                      <ArrowRight className="hidden size-4 text-muted-foreground sm:block" />
                      <ArrowDown className="size-4 text-muted-foreground sm:hidden" />
                      <div
                        className={`rounded-lg border p-3 ${r.interfaces.length ? "border-chart-2/25 bg-background/60" : "border-dashed border-warning/25"}`}
                      >
                        <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                          <Icon className="size-4" />
                          {tunnel
                            ? `${tunnel.protocol} exit candidate`
                            : "Interface exit candidate"}
                        </p>
                        <p className="break-all font-mono text-xs">
                          {r.interfaces.join(" / ") || "Gateway → interface unresolved"}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                      <span>distance {r.distance ?? "?"}</span>
                      <span>route state {r.availability}</span>
                      <span>
                        link{" "}
                        {r.resolution === "subnet"
                          ? "inferred from address subnet"
                          : r.resolution === "explicit"
                            ? "explicit gateway reference"
                            : "incomplete"}
                      </span>
                    </div>
                    {disabledExit.length > 0 && (
                      <p className="mt-3 text-xs text-destructive">
                        Recorded disabled exit: {disabledExit.map((i) => i.name).join(", ")}. This
                        branch cannot be assumed usable; it does not prove this packet selected it.
                      </p>
                    )}
                    {r.resolution === "unknown" && (
                      <p className="mt-3 text-[11px] text-warning">
                        {m.addressEvidence
                          ? "No unambiguous gateway-to-interface mapping in these records."
                          : "This case needs interface addresses / resolved immediate gateways to name the exit."}
                      </p>
                    )}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        Why this branch? Show route evidence
                      </summary>
                      <div className="mt-2">
                        <JsonView value={r.row} maxHeight={200} />
                      </div>
                    </details>
                  </div>
                </div>
              );
            })}
          </div>
          {!!excluded.length && (
            <details className="mt-3 rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                {excluded.length} excluded records · inactive or destination prefix does not match
              </summary>
              <div className="mt-2">
                <JsonView
                  value={excluded.map((r) => ({
                    reason:
                      r.availability === "inactive"
                        ? "Recorded inactive/disabled"
                        : "Destination prefix mismatch",
                    route: r.row,
                  }))}
                  maxHeight={240}
                />
              </div>
            </details>
          )}
        </Step>
        <Step number="4" title="Destination and return path" status="Still unverified">
          <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-background p-4">
            <Globe className="size-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="break-all font-mono text-xs">
                {c.target}
                {destination ? ` · ${destination}` : ""}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Downstream hops, return routing and application response are absent. No exact
                blocking hop can be named from these configuration records alone.
              </p>
            </div>
          </div>
        </Step>
      </div>
      <footer className="border-t border-border bg-background/40 p-5">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <Split className="size-4 text-chart-2" />
          To turn candidates into an observed path
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Use the client's destination IP and protocol/ports, then correlate the same flow on
          ingress and egress with a separately approved, bounded capture. Nothing on this page
          starts a capture or changes a router.
        </p>
      </footer>
    </section>
  );
}
