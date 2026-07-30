/**
 * Stable finding identity. PURE.
 *
 * The whole regression feature depends on one property: **the same problem gets
 * the same id on every run.** If it does not, a config reorder reads as a
 * page-full of new findings, the nightly notification becomes noise, and someone
 * mutes it — which is worse than never having built it.
 *
 * So an id is derived from CONTENT — the rule that fired plus the subject it
 * fired about — never from a row index. A firewall rule that moves from position
 * 3 to position 5 is the same rule; a rule whose match conditions changed is a
 * different one.
 */
import { createHash } from "node:crypto";

/**
 * A short, stable hash of the parts that identify a finding.
 *
 * Parts are normalised and joined, so the same finding hashes identically across
 * runs and across processes — the id has to survive a restart, not just a loop.
 */
export function stableId(prefix: string, parts: (string | number | undefined)[]): string {
  const material = parts
    .filter((p) => p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase())
    .join(" | ");
  const digest = createHash("sha256").update(material, "utf8").digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

/**
 * Canonical text for a firewall rule's identity.
 *
 * Sorted `key=value` pairs of the MATCH conditions plus chain and action —
 * deliberately not the ordinal, the comment, or the packet counters. Two rules
 * that match the same traffic in the same way ARE the same rule for the purpose
 * of tracking a finding over time, wherever they sit in the list.
 */
export function ruleFingerprint(rule: {
  chain: string;
  action: string;
  match: Record<string, string>;
}): string {
  const conditions = Object.entries(rule.match)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(" ");
  return `${rule.chain}/${rule.action}${conditions ? ` ${conditions}` : ""}`;
}

/** Identity for a firewall-audit finding. */
export function firewallFindingId(input: {
  kind: string;
  table: string;
  chain: string;
  rule?: { chain: string; action: string; match: Record<string, string> };
  related?: { chain: string; action: string; match: Record<string, string> };
}): string {
  return stableId("fw", [
    input.kind,
    input.table,
    input.chain,
    input.rule ? ruleFingerprint(input.rule) : undefined,
    input.related ? ruleFingerprint(input.related) : undefined,
  ]);
}

/** Identity for a compliance check result on one device. */
export function complianceFindingId(checkId: string, device?: string): string {
  return stableId("cc", [checkId, device]);
}

/**
 * Identity for a policy-engine finding.
 *
 * Includes the section and the offending record's own text — NOT its line
 * number, which shifts whenever anything above it changes.
 */
export function policyFindingId(input: {
  ruleId: string;
  section: string;
  evidence?: string;
  device?: string;
}): string {
  return stableId("pol", [input.ruleId, input.section, input.evidence, input.device]);
}

/** Identity for a hardening finding that already carries its own `finding_id`. */
export function hardeningFindingId(findingId: string, device?: string): string {
  return stableId("sh", [findingId, device]);
}
