/**
 * Vulnerabilities view, after the approved Sec-Vulns board: published RouterOS
 * advisories matched to the version each router runs, then ranked by whether
 * the affected service is on and reachable.
 *
 * Reads `/api/advisories`, backed by the same pure analyzer the MCP tools use
 * (`src/core/advisories.ts`), so the page can never disagree with a tool call.
 */
import "./monitoring.css";
import "./security.css";
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  HelpCircle,
  Info,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { Checkbox, DetailList, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import type { TipCard } from "./kit";
import type { ChartTone } from "./signal-charts";
import { ExposurePath, ScoreRing } from "./security-charts";

type Severity = "critical" | "high" | "medium" | "low";
type Exposure = "unrestricted" | "restricted" | "mitigated" | "unknown";

interface Finding {
  advisory: {
    id: string;
    title: string;
    severity: Severity;
    cvss?: number;
    summary: string;
    remediation: string;
    references: string[];
  };
  device?: string;
  version: string;
  exposure: Exposure;
  exposedServices: { name: string; port?: number; allowedFrom: string[] }[];
  manualCheck?: string;
  score: number;
  fixedIn: string;
}
interface AdvisoryReport {
  findings: Finding[];
  unreadable: string[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
  datasetDate: string;
  datasetSize: number;
  devices: {
    device?: string;
    version: string;
    board?: string;
    enabledServices: number;
    unrestrictedServices: number;
  }[];
  error?: string;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const EXPOSURE_TEXT: Record<Exposure, string> = {
  unrestricted: "Reachable from anywhere · no source restriction",
  restricted: "Restricted to specific addresses",
  mitigated: "Mitigated · service not enabled",
  unknown: "Needs a check by hand",
};
/** The KPI hint words for each exposure. */
const EXPOSURE_SHORT: Record<Exposure, string> = {
  unrestricted: "reachable from anywhere",
  restricted: "restricted",
  mitigated: "mitigated",
  unknown: "to check by hand",
};
const EXPOSURE_TONE: Record<Exposure, ChartTone> = {
  unrestricted: "bad",
  restricted: "warn",
  mitigated: "muted",
  unknown: "warn",
};
const EXPOSURE_CLASS: Record<Exposure, string> = {
  unrestricted: "sec-bad",
  restricted: "sec-warn",
  mitigated: "sec-faint",
  unknown: "sec-warn",
};

function severityTone(severity: string): Tone {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "default";
}

/** "1 restricted, 1 mitigated" for one severity's findings. */
function exposureHint(findings: Finding[]): string {
  if (findings.length === 0) return "none matched";
  const counts = new Map<Exposure, number>();
  for (const f of findings) counts.set(f.exposure, (counts.get(f.exposure) ?? 0) + 1);
  if (counts.size === 1) {
    const [[exposure, n]] = [...counts];
    return n === 1 ? EXPOSURE_SHORT[exposure] : `${n} ${EXPOSURE_SHORT[exposure]}`;
  }
  return [...counts].map(([exposure, n]) => `${n} ${EXPOSURE_SHORT[exposure]}`).join(", ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function datasetDay(value: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function FindingCard({ finding }: { finding: Finding }): ReactNode {
  const { advisory } = finding;
  const tone = EXPOSURE_TONE[finding.exposure];
  return (
    <section
      className="glass sec-finding"
      data-mitigated={finding.exposure === "mitigated" || undefined}
    >
      <div className="sec-finding-score">
        <ScoreRing score={finding.score} tone={tone} />
        <span className="sec-mono sec-faint">risk</span>
      </div>
      <div className="sec-finding-main">
        <span className="sec-card-line sec-card-foot">
          <StatusBadge tone={severityTone(advisory.severity)} dot={false}>
            {advisory.severity}
          </StatusBadge>
          <span className="sec-finding-id">{advisory.id}</span>
          {advisory.cvss != null && <span className="sec-mono sec-mut">CVSS {advisory.cvss}</span>}
          {finding.device != null && <span className="monitor-chip">{finding.device}</span>}
        </span>
        <h3>{advisory.title}</h3>
        <p>{advisory.summary}</p>
        {finding.manualCheck != null && (
          <MonitorNote tone="warn" icon={<HelpCircle aria-hidden="true" />}>
            <b>Confirm by hand:</b> {finding.manualCheck}
          </MonitorNote>
        )}
        {advisory.references.length > 0 && (
          <div className="sec-refs">
            {advisory.references.map((r) => (
              <a key={r} href={r} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" />
                {hostOf(r)}
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="sec-finding-side">
        <div className="monitor-fl">
          <span className="monitor-label">Exposure</span>
          <span className={`${EXPOSURE_CLASS[finding.exposure]} text-[13px] font-medium`}>
            {EXPOSURE_TEXT[finding.exposure]}
          </span>
          {finding.exposure !== "mitigated" &&
            finding.exposedServices.map((s) => (
              <ExposurePath
                key={`${s.name}:${s.port ?? ""}`}
                from={s.allowedFrom.length > 0 ? s.allowedFrom.join(", ") : "ANY"}
                service={`${s.name}${s.port != null ? `:${s.port}` : ""}`}
                tone={s.allowedFrom.length > 0 ? "warn" : "bad"}
              />
            ))}
        </div>
        <div className="monitor-fl">
          <span className="monitor-label">Version</span>
          <span className="sec-version">
            running <span className="sec-mono">{finding.version}</span> → fixed in{" "}
            <b>{finding.fixedIn}</b>
          </span>
        </div>
        <div className="monitor-note sec-fix">
          <span>
            <b>Fix:</b> {advisory.remediation}
          </span>
        </div>
      </div>
    </section>
  );
}

/** Published CVEs matched to the running version and ranked by real exposure. */
export function AdvisoryView(): ReactNode {
  const [data, setData] = useState<AdvisoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [fleet, setFleet] = useState(false);
  const [showMitigated, setShowMitigated] = useState(false);
  /** The router row open in the drawer. */
  const [openDevice, setOpenDevice] = useState<number | null>(null);

  const load = useCallback(() => {
    void api<AdvisoryReport>(`/api/advisories${fleet ? "?all=1" : ""}`)
      .then((d) => {
        setError(d.error ?? null);
        if (!d.error) setData(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [fleet]);
  const [loadedFleet, setLoadedFleet] = useState(fleet);
  if (loadedFleet !== fleet) {
    setLoadedFleet(fleet);
    setBusy(true);
    setError(null);
    setData(null);
  }
  const reload = () => {
    setBusy(true);
    setError(null);
    load();
  };
  useEffect(() => load(), [load]);

  const all = data?.findings ?? [];
  const findings = all.filter((f) => showMitigated || f.exposure !== "mitigated");
  const bySeverity = (s: Severity): Finding[] => all.filter((f) => f.advisory.severity === s);
  const open = all.filter((f) => f.exposure === "unrestricted").length;

  const heading =
    data == null ? undefined : all.length === 0 ? (
      <span className="s">No advisories match.</span>
    ) : (
      <>
        {all.length} {all.length === 1 ? "advisory matches" : "advisories match"}.{" "}
        {open === 0 ? (
          <span className="s">None is open to anyone.</span>
        ) : (
          <em>{open === 1 ? "One is open to anyone." : `${open} are open to anyone.`}</em>
        )}
      </>
    );

  return (
    <div className="sec-page">
      <PageIntro
        eyebrow="Security · known vulnerabilities"
        heading={heading ?? "Known vulnerabilities"}
        lead="Published RouterOS advisories matched to the version each router runs, then ranked by whether the affected service is on and reachable."
        actions={
          <div className="sec-checks">
            <Checkbox checked={fleet} onCheckedChange={setFleet} label="Whole fleet" />
            <span className="w-1.5" aria-hidden="true" />
            <Checkbox
              checked={showMitigated}
              onCheckedChange={setShowMitigated}
              label="Show mitigated"
            />
            <MonitorButton
              icon={<RefreshCw aria-hidden="true" />}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={reload}
            >
              Refresh
            </MonitorButton>
          </div>
        }
      />

      {error != null ? (
        <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
          Could not reach the device: {error}
        </MonitorNote>
      ) : data == null ? (
        <LoadingState label="Loading security posture" layout="cards" />
      ) : (
        <>
          <MetricStrip label="Advisories by severity">
            {SEVERITIES.map((s) => {
              const n = bySeverity(s).length;
              const tone: Tone =
                s === "critical"
                  ? n > 0
                    ? "bad"
                    : "good"
                  : s === "high" && n > 0
                    ? "bad"
                    : s === "medium" && n > 0
                      ? "warn"
                      : "default";
              return (
                <Metric
                  key={s}
                  label={s[0].toUpperCase() + s.slice(1)}
                  value={n}
                  hint={exposureHint(bySeverity(s))}
                  tone={tone}
                />
              );
            })}
          </MetricStrip>

          <MonitorPanel
            title="Routers checked"
            description="Version, board and how many services are on. Unrestricted means no source-address limit."
            flush
          >
            {data.devices.map((d, i) => {
              const name = d.device ?? "default";
              const restricted = d.enabledServices - d.unrestrictedServices;
              const matched = all.filter((f) => (f.device ?? "default") === name).length;
              return (
                <RowMenu
                  key={name}
                  title={name}
                  sub={`RouterOS ${d.version || "(unreadable)"} · ${d.board ?? "no board"}`}
                  onOpen={() => setOpenDevice(i)}
                  cells={{
                    device: { value: name, kind: "router" },
                    version: { value: d.version },
                    board: { value: d.board ?? "" },
                    services: {
                      value: `${d.enabledServices} on, ${d.unrestrictedServices} unrestricted`,
                    },
                  }}
                  copies={[{ label: "Router name", value: name }]}
                  row={d}
                >
                  <div
                    className="monitor-row sec-dev-cols sec-inc-row"
                    data-selected={openDevice === i || undefined}
                    tabIndex={0}
                    onClick={() => setOpenDevice(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.target === e.currentTarget) {
                        e.preventDefault();
                        setOpenDevice(i);
                      }
                    }}
                  >
                    <StatusDot tone={d.unrestrictedServices > 0 ? "warn" : "good"} />
                    <span data-col="device" className="sec-mono p sec-trunc">
                      {name}
                    </span>
                    <span data-col="version" className="sec-mono sec-tx">
                      RouterOS {d.version || "(unreadable)"}
                    </span>
                    <span data-col="board" className="sec-mut sec-trunc">
                      {d.board ?? "—"}
                    </span>
                    <span
                      data-col="services"
                      className="monitor-meter"
                      {...tipProps((): TipCard => ({
                        title: name,
                        sub: "services",
                        led: d.unrestrictedServices > 0 ? "warn" : "ok",
                        rows: [
                          { label: "On", value: d.enabledServices },
                          { label: "Restricted", value: restricted, color: "var(--success)" },
                          {
                            label: "Unrestricted",
                            value: d.unrestrictedServices,
                            color: "var(--warning)",
                          },
                        ],
                        foot: { label: "Advisories matched", value: matched },
                      }))}
                    >
                      <span className="monitor-bar">
                        <span
                          data-tone="good"
                          style={{
                            width: `${
                              d.enabledServices > 0 ? (restricted / d.enabledServices) * 100 : 0
                            }%`,
                          }}
                        />
                      </span>
                      <span>{d.enabledServices} on</span>
                      <span className={d.unrestrictedServices > 0 ? "sec-warn" : "sec-mut"}>
                        {d.unrestrictedServices} unrestricted
                      </span>
                    </span>
                    <RowMore />
                  </div>
                </RowMenu>
              );
            })}
            {data.unreadable.length > 0 && (
              <div className="monitor-foot sec-warn">
                <AlertTriangle aria-hidden="true" className="size-4 flex-none" />
                <span>
                  Could not read a version from{" "}
                  <span className="sec-mono">{data.unreadable.join(", ")}</span>.{" "}
                  {data.unreadable.length === 1 ? "It was" : "They were"} not audited: treat{" "}
                  {data.unreadable.length === 1 ? "it" : "them"} as unknown, not clean.
                </span>
              </div>
            )}
          </MonitorPanel>

          {findings.length === 0 ? (
            <MonitorPanel title="Advisories">
              <MonitorEmpty
                compact
                icon={<ShieldCheck />}
                title="No matching advisories under the current filters."
              />
            </MonitorPanel>
          ) : (
            <div className="sec-findings">
              {findings.map((f, i) => (
                <FindingCard key={`${f.device ?? ""}${f.advisory.id}${i}`} finding={f} />
              ))}
            </div>
          )}

          {openDevice != null && data.devices[openDevice] && (
            <DeviceDrawer
              device={data.devices[openDevice]}
              findings={all}
              index={openDevice}
              total={data.devices.length}
              onMove={setOpenDevice}
              onClose={() => setOpenDevice(null)}
            />
          )}

          <MonitorNote icon={<Info aria-hidden="true" />}>
            Dataset reviewed <b>{datasetDay(data.datasetDate)}</b> · {data.datasetSize} advisories.
            A clean result means nothing in this dataset matched, not that no vulnerability exists.
            Check the vendor security notices for anything newer.
          </MonitorNote>
        </>
      )}
    </div>
  );
}

/** One router from "Routers checked", with the advisories matched to it. */
function DeviceDrawer({
  device: d,
  findings,
  index,
  total,
  onMove,
  onClose,
}: {
  device: AdvisoryReport["devices"][number];
  findings: Finding[];
  index: number;
  total: number;
  onMove: (i: number) => void;
  onClose: () => void;
}): ReactNode {
  const name = d.device ?? "default";
  const matched = findings.filter((f) => (f.device ?? "default") === name);
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Router details: ${name}`}
      storageKey="vulns"
      rowKey={name}
      nav={{
        index,
        total,
        onPrev: index > 0 ? () => onMove(index - 1) : undefined,
        onNext: index < total - 1 ? () => onMove(index + 1) : undefined,
      }}
      status={
        d.unrestrictedServices > 0
          ? { tone: "warn", label: `${d.unrestrictedServices} unrestricted` }
          : { tone: "ok", label: "No unrestricted services" }
      }
      title={<span className="sec-mono">{name}</span>}
      meta={`RouterOS ${d.version || "(unreadable)"} · ${d.board ?? "no board"}`}
    >
      <DetailList
        items={[
          { label: "Version", value: d.version || "(unreadable)", mono: true },
          { label: "Board", value: d.board ?? "—" },
          { label: "Services on", value: d.enabledServices },
          { label: "Restricted", value: d.enabledServices - d.unrestrictedServices },
          { label: "Unrestricted", value: d.unrestrictedServices },
          {
            label: "Advisories",
            value:
              matched.length === 0
                ? "none matched"
                : matched.map((f) => `${f.advisory.id} (${f.advisory.severity})`).join(", "),
            mono: matched.length > 0,
          },
        ]}
      />
    </RowDrawer>
  );
}
