/**
 * Where the policy tools keep the last few reports, and how they find the
 * bundled starter pack.
 *
 * `explain_policy_finding` and `export_policy_report` operate on "the check you
 * just ran", so a small in-process ring is all that is needed — the durable
 * history the dashboard trends lives in the results store instead.
 */
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths";
import type { PolicyReport } from "./evaluate";

/** How many recent reports to keep. Enough for a fleet sweep, bounded. */
const MAX_REPORTS = 25;

const reports: PolicyReport[] = [];

/** Remember a report, newest first, replacing any earlier one for that device. */
export function rememberReport(report: PolicyReport): void {
  const existing = reports.findIndex((r) => r.device === report.device);
  if (existing >= 0) reports.splice(existing, 1);
  reports.unshift(report);
  if (reports.length > MAX_REPORTS) reports.length = MAX_REPORTS;
}

/** Recent reports, newest first. */
export function recentReports(): PolicyReport[] {
  return reports;
}

export function clearReports(): void {
  reports.length = 0;
}

/**
 * The rule files shipped with the server. Resolved from the package root, so it
 * works in dev (`src/`), from `dist/`, and inside the `.mcpb` bundle alike.
 */
export function packagedPolicyPaths(): string[] {
  return [join(PROJECT_ROOT, "policies")];
}
