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
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
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
import { DetailBlock, DetailList, RowDrawer, RowMenu, RowMore, TextArea, tipProps } from "./kit";
import type { Tone as KitTone, TipCard } from "./kit";
import { TONE_COLOR } from "./signal-charts";
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

const KIT_TONE: Record<Tone, KitTone> = {
  default: "off",
  good: "ok",
  warn: "warn",
  bad: "bad",
  brand: "acc",
};

/** "/ip/ssh:12": where a finding sits in the exported config. */
const where = (f: PolicyFinding): string => `${f.section}${f.line ? `:${f.line}` : ""}`;

/** Enter on a focused row opens its details. */
const enterOpens =
  (open: () => void) =>
  (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

/** The reason, the offending config line and the fix: the finding drawer's body. */
function FindingDetail({ finding }: { finding: PolicyFinding }): ReactNode {
  return (
    <div className="sec-drawer-stack sec-fd-detail">
      <p>{finding.reason}</p>
      {finding.evidence && (
        <DetailBlock label="Config" aside={where(finding)}>
          <pre className="monitor-pre">{finding.evidence}</pre>
        </DetailBlock>
      )}
      {finding.remediation && (
        <span className="sec-mono sec-fd-fix">
          <span className="sec-ok">Fix:</span> {finding.remediation}
        </span>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  open,
  onOpen,
}: {
  finding: PolicyFinding;
  open: boolean;
  onOpen: () => void;
}): ReactNode {
  return (
    <RowMenu
      title={finding.ruleId}
      sub={`${finding.severity} · ${finding.device} · ${where(finding)}`}
      onOpen={onOpen}
      cells={{
        severity: { value: finding.severity, kind: "risk" },
        rule: { value: finding.ruleId, kind: "id" },
        device: { value: finding.device ?? "", kind: "router" },
      }}
      copies={[
        { label: "Rule ID", value: finding.ruleId },
        ...(finding.evidence ? [{ label: "Config line", value: finding.evidence, hint: "" }] : []),
      ]}
      row={finding}
    >
      <div
        className="monitor-row sec-fd-cols sec-inc-row"
        data-selected={open || undefined}
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={enterOpens(onOpen)}
      >
        <button
          type="button"
          className="sec-caret"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details: ${finding.ruleId} on ${finding.device}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <ChevronRight aria-hidden="true" />
        </button>
        <span data-col="severity">
          <StatusBadge tone={severityTone(finding.severity)} dot={false}>
            {finding.severity}
          </StatusBadge>
        </span>
        <span data-col="rule" className="sec-col">
          <span className="sec-mono p">{finding.ruleId}</span>
          <span className="sec-trunc sec-mut text-[12px]">
            {finding.description ?? finding.reason}
          </span>
        </span>
        <span data-col="device" className="sec-col items-end">
          <span className="sec-mono sec-tx2 sec-trunc">{finding.device}</span>
          <span className="sec-mono sec-faint sec-trunc">{where(finding)}</span>
        </span>
        <RowMore />
      </div>
    </RowMenu>
  );
}

/** rules × routers: a systemic gap versus one broken router. */
function FleetMatrix({
  reports,
  openRule,
  onOpenRule,
  onOpenFinding,
}: {
  reports: PolicyRunReport[];
  openRule: string | null;
  onOpenRule: (ruleId: string) => void;
  onOpenFinding: (finding: PolicyFinding) => void;
}): ReactNode {
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
        <span />
      </div>
      {ruleIds.map((ruleId) => {
        const fails = withData.filter((r) => failed(r, ruleId)).length;
        return (
          <RowMenu
            key={ruleId}
            title={ruleId}
            sub={`fails on ${fails} of ${plural(withData.length, "router")}`}
            onOpen={() => onOpenRule(ruleId)}
            cells={{ rule: { value: ruleId, kind: "id" } }}
            copies={[{ label: "Rule ID", value: ruleId }]}
          >
            <div
              className="monitor-row sec-matrix-cols sec-matrix-row sec-inc-row kit-tips"
              style={cols}
              data-selected={openRule === ruleId || undefined}
              tabIndex={0}
              onClick={() => onOpenRule(ruleId)}
              onKeyDown={enterOpens(() => onOpenRule(ruleId))}
            >
              <span data-col="rule" className="sec-mono sec-tx2 sec-trunc">
                {ruleId}
              </span>
              {withData.map((report) => {
                const finding = cell(report, ruleId);
                const status = finding?.status ?? "pass";
                const failing = finding?.status === "fail" ? finding : undefined;
                return (
                  <span
                    key={report.device}
                    className="sec-cell"
                    data-status={status}
                    {...tipProps((): TipCard => ({
                      title: ruleId,
                      sub: report.device,
                      led: status === "fail" ? "bad" : status === "pass" ? "ok" : "off",
                      rows: [
                        {
                          label: "Result",
                          value:
                            status === "fail"
                              ? "fail"
                              : status === "pass"
                                ? "pass"
                                : "not applicable",
                        },
                        ...(finding ? [{ label: "Reason", value: finding.reason }] : []),
                        ...(finding?.section ? [{ label: "Where", value: where(finding) }] : []),
                      ],
                      action: failing
                        ? {
                            label: "Open finding",
                            onClick: () =>
                              onOpenFinding({
                                ...failing,
                                device: failing.device ?? report.device,
                              }),
                          }
                        : undefined,
                    }))}
                  />
                );
              })}
              <RowMore />
            </div>
          </RowMenu>
        );
      })}
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
      <TextArea
        label="Rule file"
        mono
        rows={9}
        value={text}
        onChange={setText}
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
  /** The finding (by key) or matrix rule open in the drawer. */
  const [detail, setDetail] = useState<{ kind: "finding" | "rule"; key: string } | null>(null);

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
      historyLabels: rows
        .slice(0, 12)
        .map((r) => stamp(r.ts))
        .reverse(),
      previous: rows[1],
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
  // Findings in the order the list shows them, for the drawer's next / previous.
  const shownFindings = bySeverity.flatMap((x) => x.items);
  const findingKey = (f: PolicyFinding): string => `${f.device}-${f.ruleId}-${f.line ?? 0}`;

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
            {latest.map(({ device, current, history, historyLabels, previous }) => {
              const tone = scoreTone(current.score);
              const delta = previous ? current.score - previous.score : 0;
              return (
                <div key={device} className="glass sec-comp-card">
                  <Ring
                    value={current.score}
                    size={72}
                    stroke={6}
                    tone={tone}
                    label="compliance"
                    tip={{
                      title: device,
                      sub: stamp(current.ts),
                      rows: [
                        {
                          label: "Score",
                          value: `${Math.round(current.score)}%`,
                          color: TONE_COLOR[tone],
                        },
                        { label: "Pass", value: current.passed },
                        { label: "Fail", value: current.failed },
                        { label: "Not applicable", value: current.notApplicable },
                      ],
                      foot: previous
                        ? {
                            label: `vs ${stamp(previous.ts)}`,
                            value: `${delta >= 0 ? "+" : ""}${Math.round(delta)} pts`,
                            tone: delta > 0 ? "up" : delta < 0 ? "down" : undefined,
                          }
                        : undefined,
                    }}
                  />
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
                        labels={historyLabels}
                        name="Score"
                        format={(v) => `${Math.round(v)}%`}
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
              <FleetMatrix
                reports={reports}
                openRule={detail?.kind === "rule" ? detail.key : null}
                onOpenRule={(ruleId) => setDetail({ kind: "rule", key: ruleId })}
                onOpenFinding={(f) => setDetail({ kind: "finding", key: findingKey(f) })}
              />
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
                      <FindingRow
                        key={findingKey(f)}
                        finding={f}
                        open={detail?.kind === "finding" && detail.key === findingKey(f)}
                        onOpen={() => setDetail({ kind: "finding", key: findingKey(f) })}
                      />
                    ))}
                  </div>
                ))
              )}
            </MonitorPanel>
          )}
          <Validator />
        </div>
      </section>
      <PolicyDrawer
        detail={detail}
        onMove={setDetail}
        onClose={() => setDetail(null)}
        findings={shownFindings}
        findingKey={findingKey}
        reports={reports}
      />
    </div>
  );
}

/** Rules that failed somewhere, in the matrix's order. */
function matrixRules(reports: PolicyRunReport[]): string[] {
  const withData = reports.filter((r) => r.findings);
  return [...new Set(withData.flatMap((r) => (r.findings ?? []).map((f) => f.ruleId)))]
    .filter((id) =>
      withData.some((r) => (r.findings ?? []).some((f) => f.ruleId === id && f.status === "fail")),
    )
    .sort();
}

function PolicyDrawer({
  detail,
  onMove,
  onClose,
  findings,
  findingKey,
  reports,
}: {
  detail: { kind: "finding" | "rule"; key: string } | null;
  onMove: (d: { kind: "finding" | "rule"; key: string }) => void;
  onClose: () => void;
  findings: PolicyFinding[];
  findingKey: (f: PolicyFinding) => string;
  reports: PolicyRunReport[];
}): ReactNode {
  if (!detail) return null;
  const keys = detail.kind === "finding" ? findings.map(findingKey) : matrixRules(reports);
  const index = keys.indexOf(detail.key);
  if (index < 0) return null;
  const nav = {
    index,
    total: keys.length,
    onPrev: index > 0 ? () => onMove({ kind: detail.kind, key: keys[index - 1]! }) : undefined,
    onNext:
      index < keys.length - 1
        ? () => onMove({ kind: detail.kind, key: keys[index + 1]! })
        : undefined,
  };
  if (detail.kind === "finding") {
    const f = findings[index]!;
    return (
      <RowDrawer
        open
        onClose={onClose}
        label={`Finding details: ${f.ruleId}`}
        storageKey="policies"
        rowKey={detail.key}
        nav={nav}
        status={{ tone: KIT_TONE[severityTone(f.severity)], label: f.severity }}
        title={<span className="sec-mono">{f.ruleId}</span>}
        meta={`${f.device} · ${where(f)}`}
        chips={f.description ? <span className="monitor-chip">{f.description}</span> : undefined}
      >
        <FindingDetail finding={f} />
      </RowDrawer>
    );
  }
  const ruleId = detail.key;
  const withData = reports.filter((r) => r.findings);
  const rows = withData.map((r) => {
    const all = (r.findings ?? []).filter((f) => f.ruleId === ruleId);
    const fail = all.find((f) => f.status === "fail");
    return { device: r.device, finding: fail ?? all[0] };
  });
  const fails = rows.filter((r) => r.finding?.status === "fail").length;
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Rule details: ${ruleId}`}
      storageKey="policies"
      rowKey={`rule:${ruleId}`}
      nav={nav}
      status={{ tone: "bad", label: `fails on ${fails} of ${plural(withData.length, "router")}` }}
      title={<span className="sec-mono">{ruleId}</span>}
    >
      <DetailList
        items={rows.map((r) => ({
          label: <span className="sec-mono">{r.device}</span>,
          value:
            r.finding == null
              ? "pass"
              : r.finding.status === "fail"
                ? `fail · ${r.finding.reason}`
                : r.finding.status === "pass"
                  ? "pass"
                  : "not applicable",
        }))}
      />
    </RowDrawer>
  );
}
