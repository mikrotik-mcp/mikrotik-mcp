/**
 * Policies view: an organisation's own compliance rules, and how the fleet
 * scores against them. Laid out after the approved Sec-Policies board.
 *
 *   • **Compliance cards**: a score per router with a trend from the stored
 *     history. "We were at 96% last week" is the version people act on.
 *   • **Fleet matrix**: rules × routers. One glance separates "one broken
 *     router" from "a systemic gap", which a findings list cannot.
 *   • **Findings**: grouped by severity, each with the offending config line.
 *   • **Rules**: every loaded rule file; doubles as the documentation.
 *   • **Rule validator**: paste rule text and see schema errors, which is how
 *     rules actually get written.
 */
import "./monitoring.css";
import "./security.css";
import { LoadingState } from "./loading-state";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, Play } from "lucide-react";
import { api, postJson } from "./api";
import { toast } from "./toast-action";
import type {
  PolicyCatalog,
  PolicyFileInfo,
  PolicyFinding,
  PolicyResultRow,
  PolicyRunReport,
  PolicySeverity,
} from "./types";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  Ring,
  Sparkline,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import type { ChartTone } from "./signal-charts";

const SEVERITY_ORDER: PolicySeverity[] = ["critical", "high", "medium", "low", "info"];

/** Rule chips shown per file before the "+N" chip. */
const CHIPS_SHOWN = 4;

function severityTone(severity: string): Tone {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "default";
}

/** Teal from 90%, amber from 80%, pink below. */
function scoreTone(score: number): ChartTone {
  if (score >= 90) return "good";
  if (score >= 80) return "warn";
  return "bad";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function FindingRow({ finding }: { finding: PolicyFinding }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="monitor-row sec-fd-cols"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="sec-mut">
          {open ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-4" />
          )}
        </span>
        <span>
          <StatusBadge tone={severityTone(finding.severity)} dot={false}>
            {finding.severity}
          </StatusBadge>
        </span>
        <span className="sec-col">
          <span className="sec-mono p">{finding.ruleId}</span>
          <span className="sec-trunc sec-mut text-[12px]">
            {finding.description ?? finding.reason}
          </span>
        </span>
        <span className="sec-col items-end">
          <span className="sec-mono sec-tx2 sec-trunc">{finding.device}</span>
          <span className="sec-mono sec-faint sec-trunc">
            {finding.section}
            {finding.line ? `:${finding.line}` : ""}
          </span>
        </span>
      </button>
      {open && (
        <div className="sec-fd-open">
          <p>{finding.reason}</p>
          {finding.evidence && <pre className="monitor-pre">{finding.evidence}</pre>}
          {finding.remediation && (
            <span className="sec-mono sec-fd-fix">
              <span className="sec-ok">Fix:</span> {finding.remediation}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** rules × routers: a systemic gap versus one broken router. */
function FleetMatrix({ reports }: { reports: PolicyRunReport[] }): ReactNode {
  const withData = reports.filter((r) => r.findings);
  const failed = (r: PolicyRunReport, ruleId: string): boolean =>
    (r.findings ?? []).some((f) => f.ruleId === ruleId && f.status === "fail");
  const ruleIds = [...new Set(withData.flatMap((r) => (r.findings ?? []).map((f) => f.ruleId)))]
    .filter((id) => withData.some((r) => failed(r, id)))
    .sort();
  if (withData.length === 0 || ruleIds.length === 0) {
    return (
      <MonitorEmpty
        compact
        title={
          withData.length === 0
            ? "No router returned results."
            : "Every rule passes on every router."
        }
      />
    );
  }
  const cell = (report: PolicyRunReport, ruleId: string): PolicyFinding | undefined =>
    (report.findings ?? []).find((f) => f.ruleId === ruleId && f.status === "fail") ??
    (report.findings ?? []).find((f) => f.ruleId === ruleId);
  const cols = { "--cols": withData.length } as CSSProperties;
  return (
    <>
      <div className="monitor-thead sec-matrix-cols" style={cols}>
        <span>Rule</span>
        {withData.map((r) => (
          <span key={r.device} className="sec-mono sec-trunc" title={r.device}>
            {r.device}
          </span>
        ))}
      </div>
      {ruleIds.map((ruleId) => (
        <div key={ruleId} className="monitor-row sec-matrix-cols sec-matrix-row" style={cols}>
          <span className="sec-mono sec-tx2 sec-trunc">{ruleId}</span>
          {withData.map((report) => {
            const finding = cell(report, ruleId);
            const status = finding?.status ?? "pass";
            return (
              <span
                key={report.device}
                className="sec-cell"
                data-status={status}
                title={`${report.device}: ${finding?.reason ?? "pass"}`}
              />
            );
          })}
        </div>
      ))}
      <div className="monitor-foot">
        <span className="monitor-legend">
          <span>
            <i style={{ background: "var(--sig)" }} />
            pass
          </span>
          <span>
            <i style={{ background: "var(--destructive)" }} />
            fail
          </span>
          <span>
            <i style={{ background: "var(--line-2)" }} />
            not applicable
          </span>
        </span>
      </div>
    </>
  );
}

function RuleFile({ file, showRules }: { file: PolicyFileInfo; showRules: boolean }): ReactNode {
  const [all, setAll] = useState(false);
  const shown = all ? file.policies : file.policies.slice(0, CHIPS_SHOWN);
  const more = file.policies.length - shown.length;
  return (
    <div className="sec-file">
      <span className="sec-flex gap-2">
        <StatusDot tone={file.ok ? "good" : "bad"} />
        <span className="sec-mono sec-tx sec-trunc">{file.path}</span>
        {file.name && <span className="sec-mut sec-trunc">· {file.name}</span>}
        <span className="sec-sp" />
        <span className="sec-mut flex-none text-[12px]">
          {plural(file.policies.length, "rule")}
        </span>
      </span>
      {!file.ok &&
        file.issues.map((i) => (
          <span key={`${i.path}-${i.message}`} className="sec-errt sec-mono">
            {i.path}: {i.message}
          </span>
        ))}
      {showRules && file.ok && file.policies.length > 0 && (
        <div className="sec-file-rules">
          {shown.map((rule) => (
            <span
              key={rule.id}
              className="monitor-chip"
              title={`${rule.severity} · ${rule.description ?? rule.match.section}`}
            >
              {rule.id}
            </span>
          ))}
          {more > 0 && (
            <button
              type="button"
              className="monitor-chip cursor-pointer border-0"
              aria-label={`Show ${plural(more, "more rule")}`}
              onClick={() => setAll(true)}
            >
              +{more}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Validator(): ReactNode {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    issues: { path: string; message: string }[];
  } | null>(null);

  const validate = async (): Promise<void> => {
    const res = await postJson<{ ok: boolean; issues: { path: string; message: string }[] }>(
      "/api/policies/validate",
      { content: text },
    );
    setResult(res);
  };

  return (
    <MonitorPanel
      title="Rule validator"
      description="Paste a rule file to check it. Nothing is saved."
      className="sec-validator"
    >
      <textarea
        className="monitor-input"
        aria-label="Rule file"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={`version: 1\npolicies:\n  - id: ssh-strong-crypto\n    severity: high\n    match: { section: /ip/ssh, settings: true }\n    assert: { field: strong-crypto, equals: "yes" }`}
      />
      <div className="sec-validator-foot">
        {result?.ok && (
          <>
            <StatusDot tone="good" />
            <span className="sec-ok text-[13px]">Valid rule file.</span>
          </>
        )}
        {result && !result.ok && (
          <span className="sec-col">
            {result.issues.map((i) => (
              <span key={`${i.path}-${i.message}`} className="sec-errt sec-mono pl-0">
                {i.path}: {i.message}
              </span>
            ))}
          </span>
        )}
        <span className="sec-sp" />
        <MonitorButton
          icon={<Check aria-hidden="true" />}
          onClick={() => void validate()}
          disabled={text === ""}
        >
          Validate
        </MonitorButton>
      </div>
    </MonitorPanel>
  );
}

export function PoliciesView(): ReactNode {
  const [initialLoading, setInitialLoading] = useState(true);
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [results, setResults] = useState<PolicyResultRow[]>([]);
  const [reports, setReports] = useState<PolicyRunReport[]>([]);
  const [running, setRunning] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      api<PolicyCatalog>("/api/policies"),
      api<{ results: PolicyResultRow[] }>("/api/policies/results?limit=200"),
    ])
      .then(([cat, res]) => {
        setCatalog(cat);
        setResults(res.results);
      })
      .catch((e) => {
        toast.error(`Failed to load policies: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      const res = await postJson<{ reports: PolicyRunReport[]; error?: string }>(
        "/api/policies/run",
        {},
      );
      if (res.error) toast.error(res.error);
      setReports(res.reports ?? []);
      await load();
    } finally {
      setRunning(false);
    }
  };

  // Latest result per device, plus that device's score history for the sparkline.
  const devices = [...new Set(results.map((r) => r.device))];
  const latest = devices.map((device) => {
    const rows = results.filter((r) => r.device === device).sort((a, b) => b.ts - a.ts);
    return {
      device,
      current: rows[0],
      history: rows
        .slice(0, 12)
        .map((r) => r.score)
        .reverse(),
    };
  });

  const failing = reports.flatMap((r) =>
    (r.findings ?? [])
      .filter((f) => f.status === "fail")
      .map((f) => ({ ...f, device: f.device ?? r.device })),
  );
  const bySeverity = SEVERITY_ORDER.map((s) => ({
    severity: s,
    items: failing.filter((f) => f.severity === s),
  })).filter((x) => x.items.length > 0);

  if (initialLoading) return <LoadingState label="Loading workspace records" />;

  const invalid = catalog?.files.filter((f) => !f.ok).length ?? 0;
  const lastRun = results.reduce((t, r) => Math.max(t, r.ts), 0);
  const worst = [...latest]
    .filter((l) => l.current.failed > 0)
    .sort((a, b) => a.current.score - b.current.score)[0];
  const heading =
    latest.length === 0 ? (
      "No checks yet."
    ) : (
      <>
        {plural(latest.length, "router")} checked.{" "}
        {worst ? (
          <em>
            {worst.device} fails {plural(worst.current.failed, "rule")}.
          </em>
        ) : (
          <span className="s">Every rule passes.</span>
        )}
      </>
    );

  return (
    <div className="sec-page">
      <PageIntro
        eyebrow="Security · policies"
        heading={heading}
        tone={latest.length > 0 ? "good" : undefined}
        status={
          latest.length > 0 ? (
            <>
              Last run <b>{stamp(lastRun)}</b> · {plural(catalog?.ruleCount ?? 0, "rule")} from{" "}
              {plural(catalog?.files.length ?? 0, "file")}
            </>
          ) : undefined
        }
        lead="Your own compliance rules, written in YAML and checked against each router's exported config."
        actions={
          <MonitorButton
            variant="primary"
            icon={<Play aria-hidden="true" />}
            disabled={running}
            aria-busy={running || undefined}
            onClick={() => void run()}
          >
            Run check
          </MonitorButton>
        }
      />

      <MetricStrip label="Policy totals">
        <Metric label="Rules" value={catalog?.ruleCount ?? 0} hint="loaded" />
        <Metric label="Files" value={catalog?.files.length ?? 0} hint="rule files" />
        <Metric
          label="Invalid"
          value={invalid}
          hint="failed validation"
          tone={invalid > 0 ? "bad" : "default"}
        />
        <Metric label="Devices scored" value={latest.length} hint="with history" />
      </MetricStrip>

      <MonitorPanel title="Compliance" description="Score per router, with the last 12 checks.">
        {latest.length === 0 ? (
          <MonitorEmpty compact title="No checks recorded yet.">
            Run one here, or call <span className="sec-mono">run_policy_check</span> from the
            assistant.
          </MonitorEmpty>
        ) : (
          <div className="sec-comp">
            {latest.map(({ device, current, history }) => {
              const tone = scoreTone(current.score);
              return (
                <div key={device} className="glass sec-comp-card">
                  <Ring value={current.score} size={72} stroke={6} tone={tone} label="compliance" />
                  <span className="sec-col">
                    <span className="sec-mono sec-tx sec-trunc sec-comp-name">{device}</span>
                    <span className="sec-mut text-[12px]">
                      <span className="sec-ok">{current.passed} pass</span> ·{" "}
                      <span className={current.failed > 0 ? "sec-bad" : "sec-mut"}>
                        {current.failed} fail
                      </span>{" "}
                      · {current.notApplicable} n/a
                    </span>
                    {history.length > 1 ? (
                      <Sparkline
                        values={history}
                        width={120}
                        height={22}
                        tone={tone === "bad" ? "bad" : "good"}
                        className="block"
                      />
                    ) : (
                      <span className="sec-faint text-[12px]">no history</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </MonitorPanel>

      <section
        className="sec-grid items-start"
        style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)" }}
      >
        <div className="sec-stack">
          {reports.length > 0 && (
            <MonitorPanel
              title="Fleet matrix"
              description="Rules that failed somewhere, by router."
              flush
            >
              <FleetMatrix reports={reports} />
            </MonitorPanel>
          )}
          <MonitorPanel
            title="Rules"
            description="Loaded rule files and what they check."
            extra={
              <MonitorButton
                variant="ghost"
                size="sm"
                icon={
                  showRules ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />
                }
                aria-expanded={showRules}
                onClick={() => setShowRules(!showRules)}
              >
                {showRules ? "Hide" : "Show"}
              </MonitorButton>
            }
          >
            {catalog && catalog.duplicateIds.length > 0 && (
              <MonitorNote tone="warn" icon={<AlertTriangle aria-hidden="true" />} className="mb-2">
                Duplicate rule id across files (the first one wins):{" "}
                <span className="sec-mono">{catalog.duplicateIds.join(", ")}</span>
              </MonitorNote>
            )}
            {catalog?.files.map((file) => (
              <RuleFile key={file.path} file={file} showRules={showRules} />
            ))}
            {catalog && catalog.files.length === 0 && (
              <MonitorEmpty compact title="No rule files found.">
                Configured paths: {catalog.paths.join(", ") || "(none)"}.
              </MonitorEmpty>
            )}
          </MonitorPanel>
        </div>
        <div className="sec-stack">
          {reports.length > 0 && (
            <MonitorPanel
              title="Findings"
              description="Failures from the last run, worst first."
              extra={bySeverity.map((s) => (
                <StatusBadge key={s.severity} tone={severityTone(s.severity)} dot={false}>
                  {s.items.length} {s.severity}
                </StatusBadge>
              ))}
              flush
            >
              {failing.length === 0 ? (
                <MonitorEmpty compact title="No violations on the last run." />
              ) : (
                bySeverity.map((s) => (
                  <div key={s.severity}>
                    <div className="sec-ngl">
                      {s.severity} · {s.items.length}
                    </div>
                    {s.items.map((f) => (
                      <FindingRow key={`${f.device}-${f.ruleId}-${f.line ?? 0}`} finding={f} />
                    ))}
                  </div>
                ))
              )}
            </MonitorPanel>
          )}
          <Validator />
        </div>
      </section>
    </div>
  );
}
