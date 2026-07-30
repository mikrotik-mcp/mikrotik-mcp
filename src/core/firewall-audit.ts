/**
 * Firewall audit engine — makes a RouterOS ruleset legible.
 *
 * Pure analysis over already-parsed `print detail` rows (no device I/O, so it's
 * unit-tested directly). It detects the classic, security-critical mistakes:
 *
 *   • shadowed / unreachable rules — a later rule a terminal earlier rule already
 *     catches everything for (set-containment over match conditions, with real
 *     CIDR containment for addresses);
 *   • overly-broad `accept` rules that match all traffic in a chain;
 *   • a missing default-drop (RouterOS's default policy is ACCEPT);
 *   • duplicate NAT/filter rules;
 *   • dead rules with zero packet hits since the counters last reset.
 *
 * Each finding carries a plain-language explanation, a suggested fix, and an
 * optional one-click action (tool + args) the MCP App view can invoke.
 *
 * Address/CIDR parsing, validation and containment use the battle-tested
 * `ipaddr.js` library (correct for both IPv4 and IPv6).
 */
import * as ipaddr from "ipaddr.js";
import { firewallFindingId } from "../schedule/identity";

export type Severity = "high" | "medium" | "low";

export type FindingKind =
  | "no-firewall"
  | "shadowed"
  | "broad-accept"
  | "missing-default-drop"
  | "duplicate"
  | "dead-rule";

/** A normalised firewall rule, parsed from one `print detail` row. */
export interface FirewallRule {
  /** 0-based ordinal in its table (the `#` column; usable as a rule_id). */
  index: number;
  chain: string;
  action: string;
  disabled: boolean;
  dynamic: boolean;
  comment?: string;
  packets?: number;
  bytes?: number;
  /** Packet-matching conditions only (chain/action/admin fields removed). */
  match: Record<string, string>;
  /** Transform target for NAT/mangle (to-addresses/to-ports/marks), for dup checks. */
  transform: Record<string, string>;
  raw: Record<string, string>;
}

export interface OneClickAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export interface AuditFinding {
  kind: FindingKind;
  severity: Severity;
  /** Which ruleset this concerns. */
  table: "filter" | "nat" | "mangle";
  chain: string;
  /** Primary offending rule ordinal (when rule-specific). */
  ruleIndex?: number;
  /** A related rule (e.g. the shadowing rule). */
  relatedIndex?: number;
  /**
   * Content-derived identity, stable across runs and across reorders.
   *
   * `ruleIndex` is a POSITION and shifts whenever anything above it changes, so
   * it cannot be the identity of a finding tracked over time — scheduled audits
   * diff by this id, and an index-based one would report every reorder as a full
   * set of new findings (docs/tasks/09 §2). Assigned by `auditFirewall`.
   */
  findingId?: string;
  title: string;
  detail: string;
  suggestion: string;
  action?: OneClickAction;
}

export interface AuditReport {
  riskScore: number;
  grade: string;
  counts: { high: number; medium: number; low: number; total: number };
  ruleCount: number;
  findings: AuditFinding[];
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Fields that are NOT packet-match conditions. */
const NON_MATCH = new Set([
  "#",
  "flags",
  "comment",
  "action",
  "chain",
  "bytes",
  "packets",
  "log",
  "log-prefix",
  "jump-target",
  ".id",
  ".nextid",
  "disabled",
  "dynamic",
  "invalid",
]);

/** Transform/target fields (NAT/mangle) — compared for duplicate detection, not matching. */
const TRANSFORM_KEYS = new Set([
  "to-addresses",
  "to-ports",
  "to-address",
  "to-port",
  "address-list",
  "new-connection-mark",
  "new-packet-mark",
  "new-routing-mark",
  "new-dscp",
  "new-mss",
  "new-priority",
  "new-ttl",
  "jump-target",
]);

/**
 * Conditions whose match is non-deterministic (rate/time/payload based): a rule
 * carrying any of these can't be proven to match every packet, so it must never
 * be treated as a *shadower* of a later rule.
 */
const NONDETERMINISTIC = new Set([
  "limit",
  "dst-limit",
  "random",
  "nth",
  "psd",
  "connection-bytes",
  "connection-rate",
  "rate",
  "time",
  "content",
  "layer7-protocol",
  "tls-host",
]);

const TERMINAL = new Set(["accept", "drop", "reject", "tarpit"]);
const ADDRESS_KEYS = new Set(["src-address", "dst-address"]);
const CATCH_ALL_ADDR = new Set(["0.0.0.0/0", "::/0"]);

/** Parse `print detail` rows (from `parseRecords`) into normalised rules. */
export function rulesFromRows(rows: Record<string, string>[]): FirewallRule[] {
  return rows.map((r, i) => {
    const flags = r.flags ?? "";
    const match: Record<string, string> = {};
    const transform: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!v || NON_MATCH.has(k)) continue;
      if (TRANSFORM_KEYS.has(k)) transform[k] = v;
      else match[k] = v;
    }
    const num = (s: string | undefined): number | undefined => {
      if (s == null) return undefined;
      const n = Number(s.replace(/\s/g, ""));
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      index: r["#"] != null && /^\d+$/.test(r["#"]) ? Number(r["#"]) : i,
      chain: r.chain ?? "?",
      action: r.action ?? "?",
      disabled: flags.includes("X"),
      dynamic: flags.includes("D"),
      comment: r.comment,
      packets: num(r.packets),
      bytes: num(r.bytes),
      match,
      transform,
      raw: r,
    };
  });
}

// ── containment ──────────────────────────────────────────────────────────────

type Addr = ReturnType<typeof ipaddr.parse>;

/** Parse an IP or CIDR literal into `[address, prefixBits]`; null when invalid. */
function toCidr(value: string): [Addr, number] | null {
  try {
    if (value.includes("/")) return ipaddr.parseCIDR(value);
    const addr = ipaddr.parse(value);
    return [addr, addr.kind() === "ipv6" ? 128 : 32];
  } catch {
    return null;
  }
}

/**
 * True when address/CIDR `a` fully contains `b` (a is broader-or-equal). Backed
 * by `ipaddr.js`, so correct for IPv4 and IPv6. Anything that isn't a plain
 * IP/CIDR literal (an address range, an address-list name, a `!`-negation)
 * yields false, keeping the shadowing check conservative — no false positives.
 */
export function cidrContains(a: string, b: string): boolean {
  const A = toCidr(a);
  const B = toCidr(b);
  if (!A || !B) return false;
  const [aAddr, aBits] = A;
  const [bAddr, bBits] = B;
  if (aAddr.kind() !== bAddr.kind()) return false;
  if (aBits > bBits) return false; // a is narrower than b → cannot contain it
  try {
    return bAddr.match(aAddr, aBits);
  } catch {
    return false;
  }
}

/** Does condition value `aVal` cover `bVal` on dimension `key`? */
function covers(key: string, aVal: string, bVal: string): boolean {
  if (aVal === bVal) return true;
  if (ADDRESS_KEYS.has(key)) return cidrContains(aVal, bVal);
  return false;
}

/**
 * Cross-key pairs: `in-interface` ↔ `in-interface-list` (and `out-` variants).
 * When rule A constrains one and rule B constrains the other, we can still
 * determine coverage if we know which interfaces belong to which lists.
 */
const INTERFACE_LIST_PAIRS: [string, string][] = [
  ["in-interface-list", "in-interface"],
  ["out-interface-list", "out-interface"],
];

/** Module-level list membership, set before each audit run. */
let _ifaceLists: Map<string, Set<string>> | undefined;

/**
 * Check whether A's interface-list condition covers B's concrete interface
 * (or vice versa), using the resolved membership map.
 *
 * Returns `true` if A's condition provably matches every packet B's condition
 * matches, `false` if it provably doesn't, and `undefined` when we can't tell
 * (no membership data, or the pair doesn't apply).
 */
function interfaceListCovers(
  aKey: string,
  aVal: string,
  bKey: string,
  bVal: string,
): boolean | undefined {
  if (!_ifaceLists) return undefined;

  for (const [listKey, ifaceKey] of INTERFACE_LIST_PAIRS) {
    // A has an interface-list condition, B has a concrete interface.
    if (aKey === listKey && bKey === ifaceKey) {
      const negated = aVal.startsWith("!");
      const listName = negated ? aVal.slice(1) : aVal;
      const members = _ifaceLists.get(listName);
      if (!members) return undefined; // unknown list
      const isMember = members.has(bVal);
      return negated ? !isMember : isMember;
    }
  }
  return undefined;
}

/** True when rule A's packet set ⊇ rule B's (A matches everything B matches). */
function aCoversB(a: FirewallRule, b: FirewallRule): boolean {
  for (const [k, v] of Object.entries(a.match)) {
    const bv = b.match[k];
    if (bv !== undefined) {
      if (!covers(k, v, bv)) return false;
      continue;
    }
    // B doesn't have the same key — check cross-key interface-list/interface pairs.
    let crossCovered = false;
    for (const [bk, bval] of Object.entries(b.match)) {
      const result = interfaceListCovers(k, v, bk, bval);
      if (result === true) {
        crossCovered = true;
        break;
      }
    }
    if (!crossCovered) return false;
  }
  return true;
}

/** A rule matches every packet (no conditions, or only catch-all addresses). */
function matchesAll(rule: FirewallRule): boolean {
  for (const [k, v] of Object.entries(rule.match)) {
    if (ADDRESS_KEYS.has(k) && CATCH_ALL_ADDR.has(v)) continue;
    return false;
  }
  return true;
}

function hasNondeterministic(rule: FirewallRule): boolean {
  return Object.keys(rule.match).some((k) => NONDETERMINISTIC.has(k));
}

// ── reporting helpers ────────────────────────────────────────────────────────

/** A short human summary of a rule's matchers, e.g. `tcp dst-port=443 → 10.0.0.0/8`. */
function matchSummary(rule: FirewallRule): string {
  const order = [
    "protocol",
    "src-address",
    "src-port",
    "dst-address",
    "dst-port",
    "in-interface",
    "out-interface",
    "in-interface-list",
    "out-interface-list",
    "connection-state",
    "src-address-list",
    "dst-address-list",
  ];
  const parts = order.filter((k) => rule.match[k]).map((k) => `${k}=${rule.match[k]}`);
  return parts.length ? parts.join(" ") : "any";
}

function disableAction(table: AuditFinding["table"], index: number): OneClickAction | undefined {
  const tool =
    table === "filter" ? "disable_filter_rule" : table === "nat" ? "disable_nat_rule" : undefined;
  return tool
    ? { tool, args: { rule_id: String(index) }, label: `Disable rule ${index}` }
    : undefined;
}

// ── checks ───────────────────────────────────────────────────────────────────

/** Shadowing + broad-accept + missing-default-drop + duplicate + dead, for filter. */
function auditFilter(rules: FirewallRule[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const active = rules.filter((r) => !r.disabled && !r.dynamic);

  // No firewall at all → device is wide open.
  if (rules.length === 0) {
    findings.push({
      kind: "no-firewall",
      severity: "high",
      table: "filter",
      chain: "input",
      title: "No firewall configured",
      detail:
        "No firewall filter rules are configured. RouterOS's default policy is ACCEPT, " +
        "so the device currently allows all input and forwarded traffic.",
      suggestion:
        "Add a baseline ruleset: accept established/related, drop invalid, accept what you need, then drop everything else.",
    });
    return findings;
  }

  // Per-chain shadowing + broad accept.
  const chains = [...new Set(active.map((r) => r.chain))];
  for (const chain of chains) {
    const chainRules = active.filter((r) => r.chain === chain);
    for (let j = 0; j < chainRules.length; j++) {
      const b = chainRules[j];
      // Broad accept (matches everything in the chain).
      if (b.action === "accept" && matchesAll(b)) {
        const sev: Severity = chain === "output" ? "low" : "high";
        findings.push({
          kind: "broad-accept",
          severity: sev,
          table: "filter",
          chain,
          ruleIndex: b.index,
          title: "Overly broad accept",
          detail: `Rule ${b.index} accepts ALL traffic in the ${chain} chain (no real match conditions), bypassing every rule after it.`,
          suggestion: `Scope rule ${b.index} to the specific source/port it should allow, or remove it.`,
          action: disableAction("filter", b.index),
        });
      }
      // Shadowed by an earlier terminal rule.
      for (let i = 0; i < j; i++) {
        const a = chainRules[i];
        if (!TERMINAL.has(a.action) || hasNondeterministic(a)) continue;
        if (aCoversB(a, b)) {
          findings.push({
            kind: "shadowed",
            severity: "medium",
            table: "filter",
            chain,
            ruleIndex: b.index,
            relatedIndex: a.index,
            title: "Unreachable rule",
            detail:
              `Rule ${b.index} (${b.action} ${matchSummary(b)}) can never match — rule ${a.index} ` +
              `already ${a.action}s ${matchesAll(a) ? "all traffic" : matchSummary(a)} earlier in the ${chain} chain.`,
            suggestion: `Remove rule ${b.index}, or move it above rule ${a.index} if it was meant to take effect first.`,
            action: disableAction("filter", b.index),
          });
          break; // report the first shadower only
        }
      }
    }

    // Missing default-drop on the security-critical chains.
    if ((chain === "input" || chain === "forward") && chainRules.length > 0) {
      const hasDrop = chainRules.some(
        (r) => (r.action === "drop" || r.action === "reject") && matchesAll(r),
      );
      if (!hasDrop) {
        findings.push({
          kind: "missing-default-drop",
          severity: "high",
          table: "filter",
          chain,
          title: "No default-drop",
          detail: `The ${chain} chain has no catch-all drop, so anything not explicitly accepted is ACCEPTED (RouterOS default policy).`,
          suggestion: `Append a 'drop all' rule at the end of the ${chain} chain.`,
        });
      }
    }
  }

  findings.push(...duplicateFindings(active, "filter"));
  findings.push(...deadFindings(active, "filter"));
  return findings;
}

/** Duplicate + dead checks for NAT/mangle. */
function auditTransform(rules: FirewallRule[], table: "nat" | "mangle"): AuditFinding[] {
  const active = rules.filter((r) => !r.disabled && !r.dynamic);
  return [...duplicateFindings(active, table), ...deadFindings(active, table)];
}

function ruleKey(r: FirewallRule): string {
  const m = Object.entries(r.match)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const t = Object.entries(r.transform)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${r.chain}|${r.action}|${m}|${t}`;
}

function duplicateFindings(active: FirewallRule[], table: AuditFinding["table"]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const seen = new Map<string, FirewallRule>();
  for (const r of active) {
    const key = ruleKey(r);
    const first = seen.get(key);
    if (first) {
      findings.push({
        kind: "duplicate",
        severity: "medium",
        table,
        chain: r.chain,
        ruleIndex: r.index,
        relatedIndex: first.index,
        title: "Duplicate rule",
        detail: `Rule ${r.index} in the ${r.chain} chain is identical to rule ${first.index} (same match and action) — it is redundant.`,
        suggestion: `Remove the duplicate rule ${r.index}.`,
        action: disableAction(table, r.index),
      });
    } else {
      seen.set(key, r);
    }
  }
  return findings;
}

function deadFindings(active: FirewallRule[], table: AuditFinding["table"]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const r of active) {
    if (r.packets === 0) {
      findings.push({
        kind: "dead-rule",
        severity: "low",
        table,
        chain: r.chain,
        ruleIndex: r.index,
        title: "No hits since boot",
        detail: `Rule ${r.index} (${r.chain} ${r.action}) has matched 0 packets since the counters last reset — it may be unused (or the device rebooted recently).`,
        suggestion: `Confirm rule ${r.index} is still needed; remove it if obsolete.`,
      });
    }
  }
  return findings;
}

// ── scoring + entry point ────────────────────────────────────────────────────

const WEIGHT: Record<Severity, number> = { high: 20, medium: 8, low: 2 };

function grade(score: number): string {
  if (score === 0) return "clean";
  if (score < 15) return "good";
  if (score < 40) return "fair";
  if (score < 75) return "poor";
  return "critical";
}

/** Run the full audit over a parsed ruleset. */
export function auditFirewall(input: {
  filter?: FirewallRule[];
  nat?: FirewallRule[];
  mangle?: FirewallRule[];
  /** Resolved interface list membership: list name → set of interface names. */
  interfaceLists?: Map<string, Set<string>>;
}): AuditReport {
  // Install the membership map so aCoversB can use it for cross-key checks.
  _ifaceLists = input.interfaceLists;
  const findings: AuditFinding[] = [];
  if (input.filter) findings.push(...auditFilter(input.filter));
  if (input.nat) findings.push(...auditTransform(input.nat, "nat"));
  if (input.mangle) findings.push(...auditTransform(input.mangle, "mangle"));

  // Identify each finding by WHAT it is about, not where the rule sits. Done
  // here rather than at each push site so no future finding can forget it.
  const byTable = { filter: input.filter, nat: input.nat, mangle: input.mangle };
  for (const finding of findings) {
    const table = byTable[finding.table] ?? [];
    finding.findingId = firewallFindingId({
      kind: finding.kind,
      table: finding.table,
      chain: finding.chain,
      rule: table.find((r) => r.index === finding.ruleIndex),
      related: table.find((r) => r.index === finding.relatedIndex),
    });
  }

  // Sort by severity (high → low), then table, then rule index.
  const sevRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      a.table.localeCompare(b.table) ||
      (a.ruleIndex ?? -1) - (b.ruleIndex ?? -1),
  );

  const counts = { high: 0, medium: 0, low: 0, total: findings.length };
  let raw = 0;
  for (const f of findings) {
    counts[f.severity]++;
    raw += WEIGHT[f.severity];
  }
  const riskScore = Math.min(100, raw);
  const ruleCount =
    (input.filter?.length ?? 0) + (input.nat?.length ?? 0) + (input.mangle?.length ?? 0);

  return { riskScore, grade: grade(riskScore), counts, ruleCount, findings };
}

/** A plain-text report for text-only hosts. */
export function renderReport(report: AuditReport, device: string): string {
  const head =
    `FIREWALL AUDIT — ${device}\n\n` +
    `Risk score: ${report.riskScore}/100 (${report.grade})\n` +
    `${report.ruleCount} rule(s) analysed · ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low\n`;
  if (report.findings.length === 0) {
    return `${head}\nNo issues found — the ruleset looks clean. ✓`;
  }
  const body = report.findings
    .map((f, i) => {
      const tag = f.severity.toUpperCase().padEnd(6);
      return `${i + 1}. [${tag}] ${f.title} (${f.table}/${f.chain})\n   ${f.detail}\n   → ${f.suggestion}`;
    })
    .join("\n\n");
  return `${head}\n${body}`;
}
