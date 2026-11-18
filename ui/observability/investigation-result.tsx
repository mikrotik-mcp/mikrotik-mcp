import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  Layers,
  LockKeyhole,
  Pause,
  Play,
  Server,
} from "lucide-react";
import type { Investigation, CaseEvidence } from "../../src/investigations/model";
import { JsonView } from "./highlight";
import { pingObservation, tunnelInventory } from "./investigation-visual-model";
import { InvestigationJourney } from "./investigation-journey";
import { InvestigationFlowPath } from "./investigation-flow-path";
import { MonitorButton, MonitorNote, MonitorPanel, StatusBadge } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./components/ui/sonner";
import { DetailBlock, DetailList, RowDrawer, RowMenu, RowMore } from "./kit";
import "./monitoring.css";
import "./investigations.css";
import "./investigation-rows.css";

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

/** "17 Nov 2026, 13:42" */
export function snapshotTime(at: number): string {
  return new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EvidenceRow({
  evidence: e,
  extra,
  showDevice,
  open,
  onOpen,
}: {
  evidence: CaseEvidence;
  extra: boolean;
  showDevice: boolean;
  open: boolean;
  onOpen: () => void;
}): ReactNode {
  const unknown = e.state === "unknown";
  const name = sourceNames[e.source] ?? e.source;
  return (
    <RowMenu
      title={name}
      sub={`${e.device} · ${e.state}`}
      onOpen={onOpen}
      cells={{
        source: { value: name },
        summary: { value: e.summary },
        records: { value: String(e.rows.length) },
        state: { value: e.state },
      }}
      copies={[
        { label: "Evidence ID", value: e.id },
        { label: "Records as JSON", value: () => JSON.stringify(e.rows, null, 2), hint: "" },
      ]}
    >
      <div
        id={`evidence-${e.id}`}
        role="button"
        tabIndex={0}
        aria-label={`${name} on ${e.device}, ${e.state}`}
        aria-expanded={open}
        data-extra={extra || undefined}
        data-selected={open || undefined}
        className="monitor-row inv-ev-grid inv-ev-row"
        onClick={onOpen}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onOpen();
          }
        }}
      >
        <span data-col="source" className="p inv-trunc">
          {name}
          {showDevice && <span className="inv-ev-dev"> · {e.device}</span>}
        </span>
        <span
          data-col="summary"
          className={`inv-ev-hide inv-ev-sum inv-trunc ${unknown ? "inv-warn" : "inv-mut"}`}
        >
          {e.summary}
        </span>
        <span data-col="records" className="inv-ev-hide inv-mono inv-mut inv-trunc">
          {e.rows.length}
          {e.truncated ? " · truncated" : ""}
        </span>
        <span data-col="state">
          <StatusBadge tone={unknown ? "warn" : "default"} dot={false}>
            {e.state}
          </StatusBadge>
        </span>
        <RowMore />
      </div>
    </RowMenu>
  );
}

/** One evidence source: what it found, when it was read, and the recorded JSON. */
function EvidenceDrawer({
  evidence: e,
  index,
  total,
  onPick,
  onClose,
}: {
  evidence: CaseEvidence;
  index: number;
  total: number;
  onPick: (i: number) => void;
  onClose: () => void;
}): ReactNode {
  const unknown = e.state === "unknown";
  const name = sourceNames[e.source] ?? e.source;
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Evidence details: ${name}`}
      storageKey="investigation-evidence"
      rowKey={e.id}
      nav={{
        index,
        total,
        onPrev: index > 0 ? () => onPick(index - 1) : undefined,
        onNext: index < total - 1 ? () => onPick(index + 1) : undefined,
      }}
      status={{ tone: unknown ? "warn" : "ok", label: e.state }}
      title={name}
      meta={e.device}
    >
      <p className="inv-hint">{e.summary}</p>
      <DetailList
        items={[
          { label: "Router", value: e.device, mono: true },
          {
            label: "Read",
            value: (
              <span className="flex items-center gap-1.5">
                <Clock aria-hidden="true" className="size-3" />
                {new Date(e.startedAt).toLocaleTimeString()} –{" "}
                {new Date(e.finishedAt).toLocaleTimeString()}
              </span>
            ),
            mono: true,
          },
          {
            label: "Records",
            value: `${e.rows.length}${e.truncated ? " · truncated" : ""}`,
            mono: true,
          },
        ]}
      />
      <DetailBlock label="Recorded JSON">
        <JsonView value={e.rows} maxHeight={360} />
      </DetailBlock>
    </RowDrawer>
  );
}

const tunnelTone = (state: string): Tone =>
  state === "running"
    ? "good"
    : state === "disabled" || state === "not-running"
      ? "warn"
      : "default";

/** The saved case: header, journey, flow export check, probe, evidence and tunnels. */
export function InvestigationResult({
  investigation: c,
}: {
  investigation: Investigation;
}): ReactNode {
  const [motion, setMotion] = useState(true);
  const [allEvidence, setAllEvidence] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const tunnels = tunnelInventory(c);
  const unknown = c.evidence.filter((e) => e.state === "unknown").length;
  const probe = pingObservation(
    c.evidence.find((e) => e.device === c.device && e.source === "router-ping"),
  );
  const deviceNames = [...new Set([c.device, ...c.devices, ...c.evidence.map((e) => e.device)])];
  const ordered = deviceNames.flatMap((d) => c.evidence.filter((e) => e.device === d));
  const openIndex = openEvidence == null ? -1 : ordered.findIndex((e) => e.id === openEvidence);
  const copyId = (): void => {
    if (!navigator.clipboard) {
      toast.error("Copy is not available in this browser.");
      return;
    }
    void navigator.clipboard.writeText(c.id).then(
      () => toast.success("Case ID copied"),
      () => toast.error("Could not copy the case ID."),
    );
  };
  const stats: [number, string, string, boolean][] = [
    [c.evidence.length, "Evidence sources", "Sources", false],
    [unknown, "Unavailable sources", "Unavailable", unknown > 0],
    [tunnels.length, "Recorded tunnels", "Tunnels", false],
  ];
  return (
    <article className="inv-col inv-result">
      <section className="glass inv-case-head inv-o1" aria-label="Case">
        <div className="inv-case-top">
          <div className="inv-case-title">
            <p className="inv-eyebrow">Investigation workspace</p>
            <h2>{c.service}</h2>
            <span className="inv-case-route inv-mono inv-mut">
              <span>{c.client}</span>
              <ChevronRight aria-hidden="true" />
              <span className="inv-arrow-text">{" → "}</span>
              <span className="break-all">{c.target}</span>
            </span>
          </div>
          <span className="inv-badge-icon">
            <StatusBadge tone="warn" dot={false}>
              <CircleHelp aria-hidden="true" />
              Client health unverified
            </StatusBadge>
          </span>
        </div>
        <div className="inv-stats">
          {stats.map(([value, long, short, warn]) => (
            <div key={long} className="inv-stat" data-tone={warn ? "warn" : undefined}>
              <b>{value}</b>
              <span className="inv-hint">
                <span className="inv-long">{long}</span>
                <span className="inv-short">{short}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="monitor-foot inv-case-foot">
          <Clock aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Snapshot of evidence · {snapshotTime(c.createdAt)} · not live telemetry
          </span>
          <MonitorButton
            variant="ghost"
            size="sm"
            icon={<Copy aria-hidden="true" />}
            onClick={copyId}
          >
            Copy case ID
          </MonitorButton>
        </div>
      </section>

      <InvestigationJourney key={c.id} investigation={c} className="inv-o2" />
      <InvestigationFlowPath key={`flow-${c.id}`} investigation={c} className="inv-o4" />

      <MonitorNote
        className="inv-o5"
        tone={probe.state === "reply" ? "good" : probe.state === "loss" ? "warn" : undefined}
        icon={<Activity aria-hidden="true" />}
      >
        <b>{probe.text}.</b> Separate router-originated probe; it does not confirm this client’s
        route, VPN or application.
      </MonitorNote>

      <MonitorPanel
        className="inv-o3 inv-evidence"
        flush
        title={
          <>
            <span className="inv-long">Evidence explorer</span>
            <span className="inv-short">Evidence</span>
          </>
        }
        description={
          <span className="inv-long">
            Grouped by router. Open a source to read its recorded JSON and timing.
          </span>
        }
      >
        <div data-collapsed={allEvidence ? undefined : true} className="inv-evidence">
          <div className="monitor-thead inv-ev-grid inv-ev-row inv-ev-hide-row">
            <span>Source</span>
            <span className="inv-ev-hide">Summary</span>
            <span className="inv-ev-hide">Records</span>
            <span>State</span>
            <span />
          </div>
          {deviceNames.map((device) => (
            <div key={device} role="group" aria-label={device}>
              <div className="monitor-row inv-ev-device">
                <span className="inv-mono inv-mut">
                  <Server aria-hidden="true" />
                  {device}
                </span>
              </div>
              {c.evidence
                .filter((e) => e.device === device)
                .map((e) => (
                  <EvidenceRow
                    key={e.id}
                    evidence={e}
                    showDevice={device !== c.device}
                    extra={ordered.indexOf(e) >= 6}
                    open={openEvidence === e.id}
                    onOpen={() => setOpenEvidence(e.id)}
                  />
                ))}
            </div>
          ))}
          {ordered.length > 6 && (
            <div className="monitor-foot inv-ev-foot">
              {c.evidence.length} sources · {unknown} unavailable
              <span className="flex-1" />
              <button
                type="button"
                aria-expanded={allEvidence}
                onClick={() => setAllEvidence((v) => !v)}
              >
                {allEvidence ? "Show fewer" : "Show all"}
              </button>
            </div>
          )}
        </div>
      </MonitorPanel>
      {openIndex >= 0 && (
        <EvidenceDrawer
          evidence={ordered[openIndex]!}
          index={openIndex}
          total={ordered.length}
          onPick={(i) => setOpenEvidence(ordered[i]!.id)}
          onClose={() => setOpenEvidence(null)}
        />
      )}

      <MonitorPanel
        className="inv-o6"
        title={`All recorded tunnels · ${tunnels.length}`}
        description="Inventory from this case, not the selected path. Running does not prove a VPN handshake or use by this client."
        extra={
          tunnels.length > 0 && (
            <MonitorButton
              variant="ghost"
              size="sm"
              aria-pressed={!motion}
              icon={motion ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              onClick={() => setMotion((m) => !m)}
            >
              {motion ? "Pause motion" : "Resume motion"}
            </MonitorButton>
          )
        }
      >
        {tunnels.length > 0 ? (
          <div className="inv-tunnels" data-motion={motion ? "on" : "off"}>
            {tunnels.map((t, i) => {
              const tone = tunnelTone(t.state);
              const Icon = t.encrypted ? LockKeyhole : Layers;
              return (
                <div key={`${t.evidenceId}:${t.name}:${i}`} className="glass inv-tunnel">
                  <div className="inv-tunnel-top">
                    <span
                      aria-hidden="true"
                      className="inv-tunnel-icon"
                      data-tone={tone}
                      style={{ animationDelay: `${(i % 4) * -0.6}s` }}
                    >
                      <Icon />
                    </span>
                    <span className="inv-tunnel-name">
                      <span className="inv-mono">{t.name}</span>
                      <span className="inv-hint">
                        {t.protocol} · {t.device}
                      </span>
                    </span>
                    <StatusBadge tone={tone} dot={false}>
                      {t.state === "unknown" ? "state unknown" : t.state}
                    </StatusBadge>
                  </div>
                  <span className="inv-hint">
                    {t.encrypted
                      ? "Encrypted protocol · session not verified"
                      : "Encapsulation · encryption not established"}
                  </span>
                  <details className="inv-refs">
                    <summary>
                      <ChevronRight aria-hidden="true" />
                      {t.routes.length} route references · not flow proof
                    </summary>
                    <div>
                      <JsonView value={t.routes} maxHeight={180} />
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        ) : (
          <MonitorNote>
            No tunnel interfaces in this case. That does not mean the router has no VPN: IPsec
            policies, handshakes and truncated interface lists are not covered.
          </MonitorNote>
        )}
        {c.evidence.some((e) => e.source === "interfaces" && e.truncated) && (
          <p className="inv-hint inv-warn mt-2">
            Interface evidence is truncated, so this list is incomplete.
          </p>
        )}
      </MonitorPanel>
    </article>
  );
}
