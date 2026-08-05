/**
 * Known-vulnerability audit — published RouterOS advisories joined against what
 * this device actually runs and actually exposes.
 *
 * Collection only. Every judgement lives in the pure matcher
 * (`src/core/advisories.ts`), so the ranking logic is tested offline against
 * fixtures rather than against a router.
 */
import { z } from "zod";
import {
  ADVISORIES,
  ADVISORY_DATASET_DATE,
  matchAdvisories,
  parseRosVersion,
} from "../core/advisories";
import type { DeviceFacts, Finding, PackageFact, ServiceFact, Severity } from "../core/advisories";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { parseRecords } from "../core/routeros-parse";
import { isEmpty, looksLikeError } from "../core/routeros";
import { listDevices } from "../core/runtime";
import { createContext } from "../core/context";

/** Run a command, returning "" instead of throwing so one gap can't fail the audit. */
async function safe(cmd: string, ctx: ToolContext): Promise<string> {
  try {
    const out = await executeMikrotikCommand(cmd, ctx);
    return looksLikeError(out) || isEmpty(out) ? "" : out;
  } catch {
    return "";
  }
}

const isYes = (v: string | undefined): boolean => v === "yes" || v === "true";

/**
 * Collect the facts one device contributes to the audit.
 *
 * Three cheap reads. `/ip service` carries the `address` restriction that
 * decides whether a finding is "patch tonight" or "patch this quarter", which
 * is why the audit reads it rather than inferring exposure from the version.
 */
export async function collectDeviceFacts(device: string | undefined): Promise<DeviceFacts> {
  const ctx = createContext(undefined, device);
  const [resource, services, packages] = await Promise.all([
    safe("/system resource print", ctx),
    safe("/ip service print detail", ctx),
    safe("/system package print detail", ctx),
  ]);

  const resRow = parseRecords(resource).rows[0] ?? {};
  const svc: ServiceFact[] = parseRecords(services).rows.map((r) => ({
    name: r.name ?? "",
    disabled: isYes(r.disabled) || (r.flags ?? "").includes("X"),
    port: r.port ? Number(r.port) : undefined,
    // RouterOS prints `address=""` when unrestricted and a comma-separated
    // list otherwise. An empty list is the dangerous default, so it must map
    // to an empty array rather than to `[""]`.
    allowedFrom: (r.address ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
  const pkgs: PackageFact[] = parseRecords(packages).rows.map((r) => ({
    name: r.name ?? "",
    enabled: !(isYes(r.disabled) || (r.flags ?? "").includes("X")),
  }));

  return {
    device,
    version: resRow.version ?? "",
    board: resRow["board-name"] ?? undefined,
    services: svc.filter((s) => s.name),
    packages: pkgs.filter((p) => p.name),
  };
}

const EXPOSURE_LABEL: Record<string, string> = {
  unrestricted: "REACHABLE — service enabled with no source-address restriction",
  restricted: "limited — service enabled but restricted to specific addresses",
  mitigated: "mitigated — the affected service/package is not enabled",
  unknown: "unconfirmed — needs a manual check (see below)",
};

function renderFinding(f: Finding, index: number): string {
  const lines: string[] = [];
  const dev = f.device ? ` [${f.device}]` : "";
  lines.push(
    `${index}. ${f.advisory.id} — ${f.advisory.title}${dev}`,
    `   severity: ${f.advisory.severity.toUpperCase()}${
      f.advisory.cvss ? ` (CVSS ${f.advisory.cvss})` : ""
    }   effective risk score: ${f.score}`,
    `   exposure: ${EXPOSURE_LABEL[f.exposure] ?? f.exposure}`,
    `   running ${f.version} → fixed in ${f.fixedIn}`,
  );
  if (f.exposedServices.length > 0) {
    const svc = f.exposedServices
      .map(
        (s) =>
          `${s.name}${s.port ? `:${s.port}` : ""}${
            s.allowedFrom.length > 0 ? ` (from ${s.allowedFrom.join(", ")})` : " (from ANY address)"
          }`,
      )
      .join(", ");
    lines.push(`   exposed via: ${svc}`);
  }
  if (f.manualCheck) lines.push(`   confirm: ${f.manualCheck}`);
  lines.push(`   ${f.advisory.summary}`);
  lines.push(`   FIX: ${f.advisory.remediation}`);
  lines.push(`   refs: ${f.advisory.references.join(" ")}`);
  return lines.join("\n");
}

const DATASET_NOTE =
  `Advisory dataset reviewed ${ADVISORY_DATASET_DATE} (${ADVISORIES.length} entries, curated ` +
  "and conservatively version-bounded). A clean result means nothing in THIS dataset matches — " +
  "it is not a statement about every published RouterOS vulnerability. Cross-check " +
  "https://mikrotik.com/download/changelogs and the vendor's security notices for anything newer.";

export const advisoryTools: ToolModule = [
  defineTool({
    name: "audit_known_vulnerabilities",
    title: "Audit Device Against Known RouterOS Advisories",
    annotations: READ,
    description:
      "Cross-references the RouterOS version this device runs against published security " +
      "advisories (CVEs), then RANKS each match by whether the affected surface is actually " +
      "reachable — reading `/ip service` to see if the vulnerable service is enabled and whether " +
      "it is restricted to a management subnet. This is the difference between 'you are behind on " +
      "patches' and 'this specific hole is open to the internet right now'. Returns each matching " +
      "advisory with its severity, CVSS, effective risk score, exposure, the exact version that " +
      "fixes it, and the remediation steps. Read-only — reads `/system resource`, `/ip service` " +
      "and `/system package`, changes nothing. Use `firmware_check` for 'is there a newer " +
      "release'; use this for 'does it matter'. Set `all_devices` to audit the whole fleet at once.",
    inputSchema: {
      all_devices: z
        .boolean()
        .optional()
        .describe("Audit every configured device instead of just the target device."),
      min_severity: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Only report findings at or above this severity."),
      include_mitigated: z
        .boolean()
        .optional()
        .describe(
          "Include advisories whose affected service is disabled (default false — these are " +
            "matches on version alone and are not currently reachable).",
        ),
    },
    async handler(a, ctx) {
      const targets: (string | undefined)[] = a.all_devices ? listDevices().names : [ctx.device];
      ctx.info(`Auditing ${targets.length} device(s) against ${ADVISORIES.length} advisories`);

      const facts = await Promise.all(targets.map((d) => collectDeviceFacts(d)));
      const report = matchAdvisories(facts);

      const rank: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
      let findings = report.findings;
      if (a.min_severity) {
        const floor = rank[a.min_severity as Severity];
        findings = findings.filter((f) => rank[f.advisory.severity] >= floor);
      }
      if (!a.include_mitigated) findings = findings.filter((f) => f.exposure !== "mitigated");

      const header: string[] = ["KNOWN-VULNERABILITY AUDIT", ""];
      for (const f of facts) {
        const v = parseRosVersion(f.version);
        header.push(
          `• ${f.device ?? "device"}: RouterOS ${v ? v.raw : "(version unreadable)"}${
            f.board ? ` on ${f.board}` : ""
          } — ${f.services.filter((s) => !s.disabled).length} enabled IP service(s)`,
        );
      }
      header.push("");

      if (report.unreadable.length > 0) {
        header.push(
          `⚠ Could not read a version from: ${report.unreadable.join(", ")}. These devices were ` +
            "NOT audited — treat them as unknown, not clean.",
          "",
        );
      }

      if (findings.length === 0) {
        return [
          ...header,
          "No matching advisories for the reported version(s) under the current filters.",
          "",
          DATASET_NOTE,
        ].join("\n");
      }

      const body = findings.map((f, i) => renderFinding(f, i + 1)).join("\n\n");
      const counts =
        `${report.summary.critical} critical · ${report.summary.high} high · ` +
        `${report.summary.medium} medium · ${report.summary.low} low`;
      return [
        ...header,
        `${findings.length} finding(s) shown — fleet totals: ${counts}`,
        "",
        body,
        "",
        DATASET_NOTE,
      ].join("\n");
    },
  }),

  defineTool({
    name: "list_security_advisories",
    title: "List the Bundled RouterOS Advisory Dataset",
    annotations: READ,
    noDevice: true,
    description:
      "Lists the RouterOS security advisories this server checks against, with their affected " +
      "version ranges, severity, CVSS, exposure conditions and remediation. Contacts NO device — " +
      "it is the reference dataset itself, useful for answering 'what does the audit actually " +
      "cover?' and for checking whether a specific CVE is in scope before trusting a clean audit " +
      "result. Use audit_known_vulnerabilities to evaluate these against a real device.",
    inputSchema: {
      id_filter: z.string().optional().describe("Match an advisory id (substring, e.g. `2023`)."),
    },
    handler(a) {
      const q = (a.id_filter ?? "").toLowerCase();
      const rows = ADVISORIES.filter(
        (adv) => !q || adv.id.toLowerCase().includes(q) || adv.title.toLowerCase().includes(q),
      );
      if (rows.length === 0) return `No advisory matches '${a.id_filter}'.`;
      const body = rows
        .map((adv) => {
          const ranges = adv.affected
            .map((r) => `${r.introduced ? `${r.introduced} ≤ v < ` : "v < "}${r.fixedIn}`)
            .join("  or  ");
          const cond = adv.exposure?.services
            ? `requires one of these services enabled: ${adv.exposure.services.join(", ")}`
            : (adv.exposure?.manualCheck ?? "no additional precondition");
          return [
            `${adv.id} — ${adv.title}`,
            `  severity: ${adv.severity.toUpperCase()}${adv.cvss ? ` (CVSS ${adv.cvss})` : ""}   published: ${adv.published}`,
            `  affected: ${ranges}`,
            `  exposure: ${cond}`,
            `  ${adv.summary}`,
            `  FIX: ${adv.remediation}`,
            `  refs: ${adv.references.join(" ")}`,
          ].join("\n");
        })
        .join("\n\n");
      return `ROUTEROS ADVISORY DATASET (${rows.length} of ${ADVISORIES.length})\n\n${body}\n\n${DATASET_NOTE}`;
    },
  }),
];
