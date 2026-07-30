/**
 * Policies view — an organisation's own compliance rules, and how the fleet
 * scores against them.
 *
 *   • **Compliance score header** — per device, with a trend sparkline from the
 *     stored history. A score with no history says "we are at 82%"; a score with
 *     history says "we were at 96% last week", which is the version people act on.
 *   • **Fleet matrix** — rules × devices. One glance separates "one broken
 *     router" from "a systemic gap", which a per-device findings list cannot.
 *   • **Findings** — grouped by severity, each with the offending config line.
 *   • **Rule browser** — every loaded rule; doubles as the documentation.
 *   • **Validation panel** — paste rule text and see schema errors, which is how
 *     rules actually get authored.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { toast } from "./toast-action";
import type {
  PolicyCatalog,
  PolicyFinding,
  PolicyResultRow,
  PolicyRunReport,
  PolicySeverity,
} from "./types";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SEVERITY_ORDER: PolicySeverity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_TYPE: Record<PolicySeverity, GeistType> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "secondary",
  info: "secondary",
};

function scoreTone(score: number): string {
  if (score >= 95) return "text-emerald-500";
  if (score >= 80) return "text-amber-500";
  return "text-red-500";
}

/** Tiny inline sparkline — the score trend, oldest → newest. */
function Spark({ values }: { values: number[] }): ReactNode {
  if (values.length < 2) return <span className="text-xs text-muted-foreground">no history</span>;
  const w = 80;
  const h = 20;
  const max = 100;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-5 w-20" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function FindingRow({ finding }: { finding: PolicyFinding }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 text-left"
      >
        <Badge type={SEVERITY_TYPE[finding.severity]}>{finding.severity}</Badge>
        <span className="font-mono text-sm">{finding.ruleId}</span>
        <span className="flex-1 truncate text-sm text-muted-foreground">
          {finding.description ?? finding.reason}
        </span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {finding.section}
          {finding.line ? `:${finding.line}` : ""}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-2 text-sm">
          <p className="text-muted-foreground">{finding.reason}</p>
          {finding.evidence && (
            <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-xs">
              {finding.evidence}
            </pre>
          )}
          {finding.remediation && (
            <p>
              <span className="font-medium">Fix: </span>
              <span className="font-mono text-xs">{finding.remediation}</span>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** rules × devices heat grid — systemic gap versus one broken router. */
function FleetMatrix({ reports }: { reports: PolicyRunReport[] }): ReactNode {
  const withData = reports.filter((r) => r.findings);
  if (withData.length === 0) return null;

  const ruleIds = [
    ...new Set(withData.flatMap((r) => (r.findings ?? []).map((f) => f.ruleId))),
  ].sort();
  if (ruleIds.length === 0) {
    return <p className="text-sm text-muted-foreground">Every rule passes on every device.</p>;
  }

  const cell = (report: PolicyRunReport, ruleId: string): PolicyFinding | undefined =>
    (report.findings ?? []).find((f) => f.ruleId === ruleId && f.status === "fail") ??
    (report.findings ?? []).find((f) => f.ruleId === ruleId);

  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left font-medium">Rule</th>
            {withData.map((r) => (
              <th key={r.device} className="max-w-24 truncate p-1 text-left font-medium">
                {r.device}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ruleIds.map((ruleId) => (
            <tr key={ruleId}>
              <td className="whitespace-nowrap p-1 font-mono">{ruleId}</td>
              {withData.map((report) => {
                const finding = cell(report, ruleId);
                const status = finding?.status ?? "pass";
                return (
                  <td key={report.device} className="p-1">
                    <span
                      title={finding?.reason ?? "pass"}
                      className={cn(
                        "block h-4 w-full min-w-8 rounded-sm",
                        status === "fail" && "bg-red-500/60",
                        status === "pass" && "bg-emerald-500/40",
                        status === "not-applicable" && "bg-muted/50",
                      )}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
    <Panel
      title="Rule validator"
      extra={
        <Button size="sm" type="secondary" onClick={() => void validate()} disabled={text === ""}>
          Validate
        </Button>
      }
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={`version: 1\npolicies:\n  - id: ssh-strong-crypto\n    severity: high\n    match: { section: /ip/ssh, settings: true }\n    assert: { field: strong-crypto, equals: "yes" }`}
        className="font-mono text-xs"
      />
      {result && (
        <div className="mt-3 text-sm">
          {result.ok ? (
            <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <Dot type="success" /> Valid rule file.
            </p>
          ) : (
            <ul className="space-y-1 text-red-600 dark:text-red-400">
              {result.issues.map((i) => (
                <li key={`${i.path}-${i.message}`} className="font-mono text-xs">
                  {i.path}: {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

export function PoliciesView(): ReactNode {
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [results, setResults] = useState<PolicyResultRow[]>([]);
  const [reports, setReports] = useState<PolicyRunReport[]>([]);
  const [running, setRunning] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cat, res] = await Promise.all([
        api<PolicyCatalog>("/api/policies"),
        api<{ results: PolicyResultRow[] }>("/api/policies/results?limit=200"),
      ]);
      setCatalog(cat);
      setResults(res.results);
    } catch (e) {
      toast.error(`Failed to load policies: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  const failing = reports.flatMap((r) => (r.findings ?? []).filter((f) => f.status === "fail"));
  const bySeverity = SEVERITY_ORDER.map((s) => ({
    severity: s,
    count: failing.filter((f) => f.severity === s).length,
  })).filter((x) => x.count > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard k="Rules" v={String(catalog?.ruleCount ?? 0)} sub="loaded" />
        <StatCard k="Files" v={String(catalog?.files.length ?? 0)} sub="rule files" />
        <StatCard
          k="Invalid"
          v={String(catalog?.files.filter((f) => !f.ok).length ?? 0)}
          cls={(catalog?.files.filter((f) => !f.ok).length ?? 0) > 0 ? "text-red-500" : undefined}
          sub="failed validation"
        />
        <StatCard k="Devices scored" v={String(latest.length)} sub="with history" />
      </div>

      <Panel
        title="Compliance"
        extra={
          <Button size="sm" onClick={() => void run()} loading={running}>
            Run check
          </Button>
        }
      >
        {latest.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No checks recorded yet. Run one here, or call{" "}
            <span className="font-mono">run_policy_check</span> from the assistant.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {latest.map(({ device, current, history }) => (
              <li key={device} className="flex items-center gap-4 py-2">
                <span className="w-40 truncate font-medium">{device}</span>
                <span
                  className={cn("text-2xl font-semibold tabular-nums", scoreTone(current.score))}
                >
                  {current.score}%
                </span>
                <span className="text-xs text-muted-foreground">
                  {current.passed} pass · {current.failed} fail · {current.notApplicable} n/a
                </span>
                <span className="ml-auto text-muted-foreground">
                  <Spark values={history} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {reports.length > 0 && (
        <>
          <Panel
            title="Fleet matrix"
            extra={<span className="text-xs text-muted-foreground">rules × devices</span>}
          >
            <FleetMatrix reports={reports} />
          </Panel>

          <Panel
            title="Findings"
            extra={
              <div className="flex gap-2">
                {bySeverity.map((s) => (
                  <Badge key={s.severity} type={SEVERITY_TYPE[s.severity]}>
                    {s.count} {s.severity}
                  </Badge>
                ))}
              </div>
            }
          >
            {failing.length === 0 ? (
              <p className="text-sm text-muted-foreground">No violations on the last run.</p>
            ) : (
              <ul className="divide-y divide-border">
                {SEVERITY_ORDER.flatMap((severity) =>
                  failing
                    .filter((f) => f.severity === severity)
                    .map((f) => (
                      <FindingRow key={`${f.device}-${f.ruleId}-${f.line ?? 0}`} finding={f} />
                    )),
                )}
              </ul>
            )}
          </Panel>
        </>
      )}

      <Panel
        title="Rules"
        extra={
          <Button size="sm" type="secondary" onClick={() => setShowRules(!showRules)}>
            {showRules ? "Hide" : "Show"}
          </Button>
        }
      >
        {catalog && catalog.duplicateIds.length > 0 && (
          <p className="mb-2 text-sm text-amber-600 dark:text-amber-400">
            Duplicate rule id(s) across files (first definition wins):{" "}
            {catalog.duplicateIds.join(", ")}
          </p>
        )}
        {catalog?.files.map((file) => (
          <div key={file.path} className="mb-3">
            <div className="flex items-center gap-2 text-sm">
              <Dot type={file.ok ? "success" : "error"} />
              <span className="font-mono text-xs">{file.path}</span>
              {file.name && <span className="text-muted-foreground">— {file.name}</span>}
              <span className="ml-auto text-xs text-muted-foreground">
                {file.policies.length} rule(s)
              </span>
            </div>
            {!file.ok && (
              <ul className="mt-1 space-y-1 pl-4 text-xs text-red-600 dark:text-red-400">
                {file.issues.map((i) => (
                  <li key={`${i.path}-${i.message}`} className="font-mono">
                    {i.path}: {i.message}
                  </li>
                ))}
              </ul>
            )}
            {showRules && file.ok && (
              <ul className="mt-1 space-y-1 pl-4 text-xs">
                {file.policies.map((rule) => (
                  <li key={rule.id} className="flex items-start gap-2">
                    <Badge type={SEVERITY_TYPE[rule.severity]}>{rule.severity}</Badge>
                    <span className="font-mono">{rule.id}</span>
                    <span className="text-muted-foreground">
                      {rule.description ?? rule.match.section}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {catalog && catalog.files.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No rule files found. Configured paths: {catalog.paths.join(", ") || "(none)"}.
          </p>
        )}
      </Panel>

      <Validator />
    </div>
  );
}
