/**
 * Policies command — your own compliance rules and how the fleet scores against
 * them, mirroring the dashboard's Policies page.
 *
 * Findings grouped by severity with a device dropdown; the detail shows the rule,
 * the offending configuration line and the fix as Markdown. Severity is the
 * accessory colour, because when a list is long the only thing that has to be
 * readable at a glance is "how bad".
 *
 * Everything here is read-only: the policy engine never writes to a device, so
 * the only action that touches a router is Run check, which captures an export.
 */
import { Action, ActionPanel, Color, Detail, Icon, List, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { postJson, withToken } from "./lib/api";
import { showFailureToast } from "./lib/confirm";
import { useApi } from "./lib/hooks";
import type {
  PolicyCatalog,
  PolicyFinding,
  PolicyResultRow,
  PolicyRunReport,
  PolicySeverity,
} from "./lib/types";

const SEVERITY_ORDER: PolicySeverity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_COLOR: Record<PolicySeverity, Color> = {
  critical: Color.Red,
  high: Color.Orange,
  medium: Color.Yellow,
  low: Color.Blue,
  info: Color.SecondaryText,
};

function scoreColor(score: number): Color {
  if (score >= 95) return Color.Green;
  if (score >= 80) return Color.Yellow;
  return Color.Red;
}

function FindingDetail({ finding }: { finding: PolicyFinding }) {
  const md = [
    `# ${finding.ruleId}`,
    "",
    finding.description ?? "",
    "",
    `**${finding.severity.toUpperCase()}** · \`${finding.section}\`${finding.line ? ` line ${finding.line}` : ""}${
      finding.device ? ` · ${finding.device}` : ""
    }`,
    "",
    `## Why it failed`,
    "",
    finding.reason,
    finding.evidence ? `\n## Offending configuration\n\n\`\`\`\n${finding.evidence}\n\`\`\`` : "",
    finding.remediation ? `\n## Fix\n\n\`\`\`\n${finding.remediation}\n\`\`\`` : "",
    finding.tags.length > 0 ? `\n_Tags: ${finding.tags.join(", ")}_` : "",
  ].join("\n");

  return (
    <Detail
      markdown={md}
      navigationTitle={`Policy · ${finding.ruleId}`}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Remediation" content={finding.remediation ?? finding.reason} />
          <Action.CopyToClipboard title="Copy Rule ID" content={finding.ruleId} />
          <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#policies")} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const [device, setDevice] = useState<string>("all");
  const [reports, setReports] = useState<PolicyRunReport[]>([]);
  const [running, setRunning] = useState(false);

  const catalog = useApi<PolicyCatalog>("/api/policies");
  const results = useApi<{ results: PolicyResultRow[] }>("/api/policies/results?limit=200");

  const rows = results.data?.results ?? [];
  const devices = [...new Set(rows.map((r) => r.device))];

  // Prefer the findings from a check just run in this session; fall back to the
  // stored history, which keeps only failures.
  const fromRun = reports.flatMap((r) =>
    (r.findings ?? []).filter((f) => f.status === "fail").map((f) => ({ ...f, device: r.device })),
  );
  const latestPerDevice = devices.map(
    (d) => rows.filter((r) => r.device === d).sort((a, b) => b.ts - a.ts)[0],
  );
  const fromHistory = latestPerDevice.flatMap((r) =>
    r.findings.map((f) => ({ ...f, device: r.device })),
  );
  const findings = (fromRun.length > 0 ? fromRun : fromHistory).filter(
    (f) => device === "all" || f.device === device,
  );

  const run = async (): Promise<void> => {
    setRunning(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: "Running policy check…" });
    try {
      const res = await postJson<{ reports: PolicyRunReport[]; error?: string }>(
        "/api/policies/run",
        device === "all" ? {} : { devices: [device] },
      );
      if (res.error) throw new Error(res.error);
      setReports(res.reports ?? []);
      const failed = (res.reports ?? []).reduce((n, r) => n + (r.summary?.failed ?? 0), 0);
      toast.style = failed > 0 ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = failed > 0 ? `${failed} rule(s) failing` : "All rules pass";
      results.revalidate();
    } catch (e) {
      toast.hide();
      await showFailureToast(e, { title: "Policy check failed" });
    } finally {
      setRunning(false);
    }
  };

  const actions = (
    <ActionPanel>
      <Action title="Run Check" icon={Icon.Play} onAction={() => void run()} />
      <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#policies")} />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={() => {
          catalog.revalidate();
          results.revalidate();
        }}
      />
    </ActionPanel>
  );

  return (
    <List
      isLoading={catalog.isLoading || results.isLoading || running}
      searchBarPlaceholder="Filter findings…"
      searchBarAccessory={
        devices.length > 0 ? (
          <List.Dropdown tooltip="Device" value={device} onChange={setDevice}>
            <List.Dropdown.Item value="all" title="All devices" />
            {devices.map((d) => (
              <List.Dropdown.Item key={d} value={d} title={d} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      <List.Section title="Compliance" subtitle={`${catalog.data?.ruleCount ?? 0} rule(s) loaded`}>
        {latestPerDevice
          .filter((r) => device === "all" || r.device === device)
          .map((r) => (
            <List.Item
              key={r.device}
              icon={{ source: Icon.BullsEye, tintColor: scoreColor(r.score) }}
              title={r.device}
              subtitle={`${r.passed} pass · ${r.failed} fail · ${r.notApplicable} n/a`}
              accessories={[
                { tag: { value: `${r.score}%`, color: scoreColor(r.score) } },
                { date: new Date(r.ts) },
              ]}
              actions={actions}
            />
          ))}
        {latestPerDevice.length === 0 && (
          <List.Item
            icon={Icon.Play}
            title="Run a policy check"
            subtitle="No results recorded yet"
            actions={actions}
          />
        )}
      </List.Section>

      {SEVERITY_ORDER.map((severity) => {
        const forSeverity = findings.filter((f) => f.severity === severity);
        if (forSeverity.length === 0) return null;
        return (
          <List.Section key={severity} title={severity} subtitle={`${forSeverity.length}`}>
            {forSeverity.map((f, i) => (
              <List.Item
                key={`${f.device}-${f.ruleId}-${f.line ?? i}`}
                icon={{ source: Icon.ExclamationMark, tintColor: SEVERITY_COLOR[severity] }}
                title={f.ruleId}
                subtitle={f.description ?? f.reason}
                accessories={[
                  { text: f.device ?? "" },
                  { text: `${f.section}${f.line ? `:${f.line}` : ""}` },
                ]}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="Show Details"
                      icon={Icon.Sidebar}
                      target={<FindingDetail finding={f} />}
                    />
                    <Action title="Run Check" icon={Icon.Play} onAction={() => void run()} />
                    <Action.CopyToClipboard
                      title="Copy Remediation"
                      content={f.remediation ?? f.reason}
                    />
                    <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#policies")} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        );
      })}

      {findings.length === 0 && latestPerDevice.length > 0 && (
        <List.Section title="Findings">
          <List.Item
            icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
            title="No violations"
            subtitle="Every applicable rule passes"
            actions={actions}
          />
        </List.Section>
      )}
    </List>
  );
}
