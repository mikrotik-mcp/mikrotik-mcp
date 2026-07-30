/**
 * Policy evaluation — PURE. `Policy[]` × parsed config → `Finding[]`.
 *
 * The closed predicate set from the schema, evaluated against the record model
 * from `./parse.ts`. No expressions, no code, no device: this is what makes a
 * policy check safe to run in CI against an export, and what makes every rule in
 * the starter pack a unit test rather than a promise.
 *
 * Three semantics worth stating, because they decide whether a compliance score
 * means anything:
 *
 * 1. **A rule matching zero records is NOT a pass.** It is `not-applicable`
 *    (`on_empty` can override). A rule about WAN interfaces on a router with no
 *    WAN is neither compliant nor violating, and scoring it as a pass is how
 *    "100% compliant" comes to mean "we checked nothing".
 * 2. **Every matched record is judged.** One rule over ten firewall rules can
 *    produce ten findings, each pointing at its own source line, because "the
 *    firewall is wrong somewhere" is not actionable.
 * 3. **Values compare as strings.** RouterOS exports strings (`yes`, `30m`,
 *    `1.1.1.1`), so `equals: yes` and `equals: "yes"` mean the same thing and
 *    numeric-looking values never surprise an author with `1 !== "1"`.
 */
import { normalizeSection, recordsOf, settingsOf } from "./parse";
import type { ConfigModel, ConfigRecord } from "./parse";
import type { Policy, PolicyAssert, PolicyLeaf, Severity } from "./schema";

export type FindingStatus = "pass" | "fail" | "not-applicable";

export interface Finding {
  ruleId: string;
  severity: Severity;
  status: FindingStatus;
  description?: string;
  remediation?: string;
  tags: string[];
  /** Device this was evaluated against, when known. */
  device?: string;
  section: string;
  /** Source line of the offending record, when a record was involved. */
  line?: number;
  /** The offending record's source text, for showing a human. */
  evidence?: string;
  /** Human-readable reason: what was expected and what was actually there. */
  reason: string;
}

export interface PolicyReport {
  device?: string;
  /** When the evaluation ran (epoch ms) — stamped by the caller. */
  ts?: number;
  findings: Finding[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    notApplicable: number;
    /** Failures by severity. */
    bySeverity: Record<Severity, number>;
    /**
     * Percent of APPLICABLE rules that passed, 0–100 (100 when nothing applied).
     * Not-applicable rules are excluded from both halves of the fraction — see
     * the module note.
     */
    score: number;
  };
  /** Lines the parser could not interpret, so a clean report can admit its limits. */
  unparsedLines: number;
}

function asString(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

/** Human-readable rendering of a leaf predicate, for the failure reason. */
function describeLeaf(leaf: PolicyLeaf): string {
  if (leaf.present !== undefined) return leaf.present ? "must be present" : "must be absent";
  if (leaf.absent !== undefined) return leaf.absent ? "must be absent" : "must be present";
  if (leaf.equals !== undefined) return `must equal '${asString(leaf.equals)}'`;
  if (leaf.not_equals !== undefined) return `must not equal '${asString(leaf.not_equals)}'`;
  if (leaf.in) return `must be one of [${leaf.in.map((v) => asString(v)).join(", ")}]`;
  if (leaf.not_in) return `must not be one of [${leaf.not_in.map((v) => asString(v)).join(", ")}]`;
  if (leaf.contains !== undefined) return `must contain '${asString(leaf.contains)}'`;
  if (leaf.matches !== undefined) return `must match /^${leaf.matches}$/`;
  return "must satisfy the rule";
}

interface LeafOutcome {
  ok: boolean;
  /** The actual value, or undefined when the field is absent. */
  actual?: string;
}

/**
 * Evaluate one leaf against one record.
 *
 * A missing field fails every value predicate rather than being skipped: "the
 * field must equal X" is not satisfied by there being no field, and treating
 * absence as a pass is the single easiest way to write a rule that silently never
 * fires.
 */
function evaluateLeaf(leaf: PolicyLeaf, record: ConfigRecord): LeafOutcome {
  const actual = record.fields[leaf.field];
  const has = actual !== undefined;

  if (leaf.present !== undefined) return { ok: has === leaf.present, actual };
  if (leaf.absent !== undefined) return { ok: has === !leaf.absent, actual };
  if (!has) return { ok: false, actual: undefined };

  if (leaf.equals !== undefined) return { ok: actual === asString(leaf.equals), actual };
  if (leaf.not_equals !== undefined) return { ok: actual !== asString(leaf.not_equals), actual };
  if (leaf.in) return { ok: leaf.in.map(asString).includes(actual), actual };
  if (leaf.not_in) return { ok: !leaf.not_in.map(asString).includes(actual), actual };
  if (leaf.contains !== undefined) {
    // Comma-separated RouterOS lists (`connection-state=established,related`)
    // are the common case, so a member match counts as well as a substring.
    const needle = asString(leaf.contains);
    const members = actual.split(",").map((m) => m.trim());
    return { ok: members.includes(needle) || actual.includes(needle), actual };
  }
  if (leaf.matches !== undefined) {
    // Anchored: an unanchored pattern from an untrusted file is both a ReDoS
    // risk and the source of "why does this match everything" bugs.
    const anchored = new RegExp(`^(?:${leaf.matches})$`);
    return { ok: anchored.test(actual), actual };
  }
  return { ok: false, actual };
}

interface AssertOutcome {
  ok: boolean;
  reason: string;
}

/** Evaluate an assertion tree against one record. */
function evaluateAssert(assertion: PolicyAssert, record: ConfigRecord): AssertOutcome {
  if ("count" in assertion) {
    // Handled at the rule level; a count assertion is about the set, not a row.
    return { ok: true, reason: "count is evaluated over the matched set" };
  }

  if ("any_of" in assertion) {
    const parts = assertion.any_of.map((leaf) => ({ leaf, outcome: evaluateLeaf(leaf, record) }));
    // Short-circuit semantics: the first satisfied branch decides it, and the
    // reason names the branch that passed rather than dumping every branch.
    const passed = parts.find((p) => p.outcome.ok);
    if (passed) {
      return { ok: true, reason: `${passed.leaf.field} ${describeLeaf(passed.leaf)}` };
    }
    return {
      ok: false,
      reason: `none of: ${parts
        .map(
          (p) =>
            `${p.leaf.field} ${describeLeaf(p.leaf)} (actual: ${p.outcome.actual ?? "absent"})`,
        )
        .join(" | ")}`,
    };
  }

  if ("all_of" in assertion) {
    for (const leaf of assertion.all_of) {
      const outcome = evaluateLeaf(leaf, record);
      if (!outcome.ok) {
        return {
          ok: false,
          reason: `${leaf.field} ${describeLeaf(leaf)} (actual: ${outcome.actual ?? "absent"})`,
        };
      }
    }
    return { ok: true, reason: "every condition satisfied" };
  }

  if ("none_of" in assertion) {
    for (const leaf of assertion.none_of) {
      const outcome = evaluateLeaf(leaf, record);
      if (outcome.ok) {
        return {
          ok: false,
          reason: `${leaf.field} ${describeLeaf(leaf)} but must not (actual: ${outcome.actual ?? "absent"})`,
        };
      }
    }
    return { ok: true, reason: "no forbidden condition matched" };
  }

  const outcome = evaluateLeaf(assertion, record);
  return {
    ok: outcome.ok,
    reason: `${assertion.field} ${describeLeaf(assertion)}${outcome.ok ? "" : ` (actual: ${outcome.actual ?? "absent"})`}`,
  };
}

/** Records a rule applies to, after `section`, `settings` and `where`. */
export function matchRecords(policy: Policy, model: ConfigModel): ConfigRecord[] {
  const section = normalizeSection(policy.match.section);

  if (policy.match.settings === true) {
    const merged = settingsOf(model, section);
    return merged ? [merged] : [];
  }

  let records = recordsOf(model, section);
  const where = policy.match.where;
  if (where) {
    records = records.filter((record) =>
      Object.entries(where).every(([field, value]) => record.fields[field] === asString(value)),
    );
  }
  return records;
}

/** Evaluate one policy, producing one finding per judged record (or one for the set). */
export function evaluatePolicy(policy: Policy, model: ConfigModel, device?: string): Finding[] {
  const section = normalizeSection(policy.match.section);
  const records = matchRecords(policy, model);
  const base = {
    ruleId: policy.id,
    severity: policy.severity,
    description: policy.description,
    remediation: policy.remediation,
    tags: policy.tags,
    device,
    section,
  };

  // A `count` rule is about how many records matched, so it yields exactly one
  // finding regardless of the set size — including when the set is empty, which
  // is the whole point of `count: {min: 1}`.
  if ("count" in policy.assert) {
    const { min, max, exactly } = policy.assert.count;
    const n = records.length;
    const failures: string[] = [];
    if (exactly !== undefined && n !== exactly) failures.push(`expected exactly ${exactly}`);
    if (min !== undefined && n < min) failures.push(`expected at least ${min}`);
    if (max !== undefined && n > max) failures.push(`expected at most ${max}`);
    return [
      {
        ...base,
        status: failures.length === 0 ? "pass" : "fail",
        line: records[0]?.line,
        evidence: records[0]?.raw,
        reason:
          failures.length === 0
            ? `${n} matching record(s), within the required count`
            : `${failures.join(" and ")}, found ${n}`,
      },
    ];
  }

  if (records.length === 0) {
    // Not a pass. See the module note.
    const status: FindingStatus =
      policy.on_empty === "pass" ? "pass" : policy.on_empty === "fail" ? "fail" : "not-applicable";
    return [
      {
        ...base,
        status,
        reason:
          status === "not-applicable"
            ? `no records matched ${section}${policy.match.where ? " with the required fields" : ""} — rule does not apply to this device`
            : status === "fail"
              ? `no records matched ${section}, and this rule requires at least one`
              : `no records matched ${section}; the rule declares that acceptable`,
      },
    ];
  }

  return records.map((record) => {
    const outcome = evaluateAssert(policy.assert, record);
    return {
      ...base,
      status: outcome.ok ? ("pass" as const) : ("fail" as const),
      line: record.line,
      evidence: record.raw,
      reason: outcome.reason,
    };
  });
}

const EMPTY_SEVERITY: Record<Severity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
};

/**
 * Evaluate every policy and summarise.
 *
 * The score counts RULES, not findings: a rule that fails on eight of ten
 * firewall lines is one broken rule, and scoring by finding count would let a
 * single sloppy rule dominate a whole report.
 */
export function evaluatePolicies(
  policies: Policy[],
  model: ConfigModel,
  opts: { device?: string; ts?: number } = {},
): PolicyReport {
  const findings = policies.flatMap((policy) => evaluatePolicy(policy, model, opts.device));

  const perRule = new Map<string, { failed: boolean; applicable: boolean; severity: Severity }>();
  for (const finding of findings) {
    const entry = perRule.get(finding.ruleId) ?? {
      failed: false,
      applicable: false,
      severity: finding.severity,
    };
    if (finding.status === "fail") entry.failed = true;
    if (finding.status !== "not-applicable") entry.applicable = true;
    perRule.set(finding.ruleId, entry);
  }

  const bySeverity = { ...EMPTY_SEVERITY };
  let failed = 0;
  let passed = 0;
  let notApplicable = 0;
  for (const entry of perRule.values()) {
    if (!entry.applicable) {
      notApplicable++;
      continue;
    }
    if (entry.failed) {
      failed++;
      bySeverity[entry.severity]++;
    } else {
      passed++;
    }
  }

  const applicable = passed + failed;
  return {
    device: opts.device,
    ts: opts.ts,
    findings,
    summary: {
      total: perRule.size,
      passed,
      failed,
      notApplicable,
      bySeverity,
      score: applicable === 0 ? 100 : Math.round((passed / applicable) * 100),
    },
    unparsedLines: model.unparsed.length,
  };
}
