/**
 * The policy schema, evaluator and report — every predicate, both ways, plus the
 * semantics that decide whether a compliance score means anything: a rule
 * matching zero records is NOT a pass, a missing field fails a value predicate,
 * and `any_of` short-circuits on the branch that actually passed.
 *
 * Rule files are written as JSON here — a strict subset of YAML, so these are
 * valid rule files, and the pure engine stays testable on the Node runner where
 * `Bun.YAML` does not exist.
 */
import { describe, expect, test } from "vite-plus/test";
import { evaluatePolicies, evaluatePolicy, matchRecords } from "../../src/policy/evaluate";
import { parseExport } from "../../src/policy/parse";
import { explainFinding, renderJson, renderMarkdown, renderSarif } from "../../src/policy/report";
import { validatePolicyDocument, validatePolicyText } from "../../src/policy/schema";
import type { Policy } from "../../src/policy/schema";

const CONFIG = parseExport(`# 2026-07-29 10:30:05 by RouterOS 7.14.3
/ip settings
set rp-filter=strict tcp-syncookies=yes
/ip ssh
set strong-crypto=yes
/ip firewall filter
add action=accept chain=input connection-state=established,related
add action=accept chain=input src-address-list=management
add action=accept chain=input
add action=drop chain=input comment="default deny"
/ip service
set telnet disabled=yes
set www disabled=no
`);

/** Build a valid policy through the schema, so every fixture is schema-checked. */
function policy(partial: Record<string, unknown>): Policy {
  const result = validatePolicyDocument({
    version: 1,
    policies: [{ id: "test-rule", ...partial }],
  });
  if (!result.ok)
    throw new Error(`fixture is not a valid policy: ${JSON.stringify(result.issues)}`);
  return result.file!.policies[0];
}

// ── Schema ──────────────────────────────────────────────────────────────────

describe("schema", () => {
  test("accepts the documented rule shape", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        {
          id: "wan-rpf-required",
          severity: "high",
          description: "Every WAN interface must have reverse-path filtering on.",
          match: { section: "/ip/settings", settings: true },
          assert: { field: "rp-filter", in: ["strict", "loose"] },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.file?.policies[0]).toMatchObject({
      id: "wan-rpf-required",
      on_empty: "not-applicable",
    });
  });

  test("rejects duplicate rule ids — ids are how findings are tracked", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        { id: "dupe", match: { section: "/ip/ssh" }, assert: { field: "a", present: true } },
        { id: "dupe", match: { section: "/ip/dns" }, assert: { field: "b", present: true } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("duplicate rule id 'dupe'");
    expect(result.issues[0].path).toBe("policies.1.id");
  });

  test("rejects an id that is not kebab-case", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        { id: "Not Valid", match: { section: "/ip" }, assert: { field: "a", present: true } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("kebab-case");
  });

  test("rejects two predicates in one leaf", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        {
          id: "two-predicates",
          match: { section: "/ip/ssh" },
          assert: { field: "strong-crypto", equals: "yes", present: true },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("exactly one");
  });

  test("rejects an unknown key rather than ignoring it", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        { id: "typo", match: { section: "/ip/ssh" }, assert: { feild: "x", present: true } },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("caps regex length — an unbounded pattern is a ReDoS vector", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        {
          id: "long-regex",
          match: { section: "/ip/ssh" },
          assert: { field: "x", matches: "a".repeat(500) },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("at most 200");
  });

  test("rejects an invalid regex at parse time, not at evaluation", () => {
    const result = validatePolicyDocument({
      version: 1,
      policies: [
        { id: "bad-regex", match: { section: "/ip/ssh" }, assert: { field: "x", matches: "([a-" } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("valid regular expression");
  });

  test("requires version 1 and at least one policy", () => {
    expect(validatePolicyDocument({ version: 2, policies: [] }).ok).toBe(false);
    expect(validatePolicyDocument({ version: 1, policies: [] }).ok).toBe(false);
  });

  test("a malformed rule FILE is rejected with a usable message", () => {
    const result = validatePolicyText("{ this is not json");
    expect(result.ok).toBe(false);
    expect(result.issues[0].path).toBe("(root)");
    expect(result.issues[0].message).toMatch(/not valid (YAML or )?JSON/);
  });

  test("a valid JSON rule file text parses", () => {
    const result = validatePolicyText(
      JSON.stringify({
        version: 1,
        policies: [
          {
            id: "ok",
            match: { section: "/ip/ssh" },
            assert: { field: "strong-crypto", equals: "yes" },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

// ── Matching ────────────────────────────────────────────────────────────────

describe("matching", () => {
  test("`where` narrows to records with those exact fields", () => {
    const p = policy({
      match: { section: "/ip/firewall/filter", where: { chain: "input", action: "accept" } },
      assert: { field: "chain", equals: "input" },
    });
    expect(matchRecords(p, CONFIG)).toHaveLength(3);
  });

  test("`settings: true` merges a section's set lines into one record", () => {
    const p = policy({
      match: { section: "/ip/settings", settings: true },
      assert: { field: "rp-filter", in: ["strict", "loose"] },
    });
    const records = matchRecords(p, CONFIG);
    expect(records).toHaveLength(1);
    expect(records[0].fields).toMatchObject({ "rp-filter": "strict", "tcp-syncookies": "yes" });
  });

  test("a section the export lacks matches nothing", () => {
    const p = policy({
      match: { section: "/ppp/secret" },
      assert: { field: "service", equals: "any" },
    });
    expect(matchRecords(p, CONFIG)).toEqual([]);
  });
});

// ── Predicates ──────────────────────────────────────────────────────────────

describe("predicates", () => {
  const check = (assertion: Record<string, unknown>, where?: Record<string, string>) =>
    evaluatePolicy(
      policy({
        match: { section: "/ip/firewall/filter", ...(where ? { where } : {}) },
        assert: assertion,
      }),
      CONFIG,
    );

  test("equals passes and fails", () => {
    expect(check({ field: "chain", equals: "input" }).every((f) => f.status === "pass")).toBe(true);
    expect(check({ field: "chain", equals: "forward" }).every((f) => f.status === "fail")).toBe(
      true,
    );
  });

  test("not_equals passes and fails", () => {
    expect(check({ field: "chain", not_equals: "forward" }).every((f) => f.status === "pass")).toBe(
      true,
    );
    expect(check({ field: "chain", not_equals: "input" }).every((f) => f.status === "fail")).toBe(
      true,
    );
  });

  test("present and absent", () => {
    const present = check({ field: "action", present: true });
    expect(present.every((f) => f.status === "pass")).toBe(true);
    const absent = check({ field: "nonexistent", absent: true });
    expect(absent.every((f) => f.status === "pass")).toBe(true);
    expect(check({ field: "action", absent: true }).every((f) => f.status === "fail")).toBe(true);
  });

  test("in and not_in", () => {
    expect(
      check({ field: "action", in: ["accept", "drop"] }).every((f) => f.status === "pass"),
    ).toBe(true);
    expect(
      check({ field: "action", not_in: ["accept", "drop"] }).every((f) => f.status === "fail"),
    ).toBe(true);
  });

  test("contains matches a member of a comma-separated list", () => {
    const findings = check(
      { field: "connection-state", contains: "established" },
      { "connection-state": "established,related" },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
  });

  test("contains fails when the member is absent", () => {
    const findings = check(
      { field: "connection-state", contains: "invalid" },
      { "connection-state": "established,related" },
    );
    expect(findings[0].status).toBe("fail");
    expect(findings[0].reason).toContain("must contain 'invalid'");
  });

  test("matches is ANCHORED — a partial match does not pass", () => {
    const anchored = check({ field: "action", matches: "acc" }, { action: "accept" });
    expect(anchored[0].status).toBe("fail");
    const full = check({ field: "action", matches: "acc.*" }, { action: "accept" });
    expect(full[0].status).toBe("pass");
  });

  test("a MISSING field fails every value predicate, it is not skipped", () => {
    // The bare `accept` rule has no src-address-list.
    const findings = check({ field: "src-address-list", equals: "management" });
    const bare = findings.filter((f) => f.status === "fail");
    expect(bare.length).toBeGreaterThan(0);
    expect(bare[0].reason).toContain("actual: absent");
  });

  test("a numeric predicate value compares as a string", () => {
    const model = parseExport(
      `/ip firewall filter\nadd chain=input action=drop connection-limit=5`,
    );
    const findings = evaluatePolicy(
      policy({
        match: { section: "/ip/firewall/filter" },
        assert: { field: "connection-limit", equals: 5 },
      }),
      model,
    );
    expect(findings[0].status).toBe("pass");
  });
});

// ── Combinators ─────────────────────────────────────────────────────────────

describe("combinators", () => {
  const scopedAccept = {
    match: { section: "/ip/firewall/filter", where: { chain: "input", action: "accept" } },
    assert: {
      any_of: [
        { field: "src-address-list", present: true },
        { field: "in-interface-list", present: true },
        { field: "connection-state", contains: "established" },
      ],
    },
  };

  test("any_of passes a record satisfying ONE branch, fails the record satisfying none", () => {
    const findings = evaluatePolicy(policy(scopedAccept), CONFIG);
    expect(findings).toHaveLength(3);
    expect(findings.filter((f) => f.status === "pass")).toHaveLength(2);
    const failure = findings.find((f) => f.status === "fail");
    expect(failure?.reason).toContain("none of:");
    // The bare `add action=accept chain=input` is the third rule in the export.
    expect(failure?.line).toBe(9);
  });

  test("any_of short-circuits and names the branch that passed", () => {
    const findings = evaluatePolicy(policy(scopedAccept), CONFIG).filter(
      (f) => f.status === "pass",
    );
    expect(findings[0].reason).toBe("connection-state must contain 'established'");
    expect(findings[1].reason).toBe("src-address-list must be present");
  });

  test("all_of fails on the first unsatisfied condition and says which", () => {
    const findings = evaluatePolicy(
      policy({
        match: { section: "/ip/ssh", settings: true },
        assert: {
          all_of: [
            { field: "strong-crypto", equals: "yes" },
            { field: "forwarding-enabled", equals: "no" },
          ],
        },
      }),
      CONFIG,
    );
    expect(findings[0].status).toBe("fail");
    expect(findings[0].reason).toContain("forwarding-enabled");
    expect(findings[0].reason).toContain("absent");
  });

  test("all_of passes when every condition holds", () => {
    const findings = evaluatePolicy(
      policy({
        match: { section: "/ip/settings", settings: true },
        assert: {
          all_of: [
            { field: "rp-filter", equals: "strict" },
            { field: "tcp-syncookies", equals: "yes" },
          ],
        },
      }),
      CONFIG,
    );
    expect(findings[0].status).toBe("pass");
  });

  test("none_of fails when a forbidden condition matches", () => {
    const findings = evaluatePolicy(
      policy({
        match: { section: "/ip/service", settings: true },
        assert: { none_of: [{ field: "disabled", equals: "no" }] },
      }),
      CONFIG,
    );
    expect(findings[0].status).toBe("fail");
    expect(findings[0].reason).toContain("must not");
  });

  test("none_of passes when nothing forbidden is present", () => {
    const findings = evaluatePolicy(
      policy({
        match: { section: "/ip/firewall/filter", where: { action: "drop" } },
        assert: { none_of: [{ field: "chain", equals: "forward" }] },
      }),
      CONFIG,
    );
    expect(findings[0].status).toBe("pass");
  });
});

// ── count ───────────────────────────────────────────────────────────────────

describe("count", () => {
  const counted = (count: Record<string, number>, where?: Record<string, string>) =>
    evaluatePolicy(
      policy({
        match: { section: "/ip/firewall/filter", ...(where ? { where } : {}) },
        assert: { count },
      }),
      CONFIG,
    );

  test("min is satisfied at the boundary", () => {
    expect(counted({ min: 4 })[0].status).toBe("pass");
    expect(counted({ min: 5 })[0].status).toBe("fail");
  });

  test("max is satisfied at the boundary", () => {
    expect(counted({ max: 4 })[0].status).toBe("pass");
    expect(counted({ max: 3 })[0].status).toBe("fail");
  });

  test("exactly is exact", () => {
    expect(counted({ exactly: 4 })[0].status).toBe("pass");
    expect(counted({ exactly: 3 })[0].status).toBe("fail");
  });

  test("a count rule over an EMPTY set still produces a verdict", () => {
    const findings = evaluatePolicy(
      policy({ match: { section: "/ppp/secret" }, assert: { count: { min: 1 } } }),
      CONFIG,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].reason).toContain("found 0");
  });

  test("a count rule yields ONE finding regardless of set size", () => {
    expect(counted({ min: 1 })).toHaveLength(1);
  });
});

// ── Empty matches ───────────────────────────────────────────────────────────

describe("a rule matching zero records", () => {
  const empty = {
    match: { section: "/interface/wireguard" },
    assert: { field: "x", present: true },
  };

  test("is NOT-APPLICABLE by default, never a pass", () => {
    const findings = evaluatePolicy(policy(empty), CONFIG);
    expect(findings[0].status).toBe("not-applicable");
    expect(findings[0].reason).toContain("does not apply");
  });

  test("`on_empty: fail` makes an absent section a violation", () => {
    const findings = evaluatePolicy(policy({ ...empty, on_empty: "fail" }), CONFIG);
    expect(findings[0].status).toBe("fail");
  });

  test("`on_empty: pass` is available but must be explicit", () => {
    expect(evaluatePolicy(policy({ ...empty, on_empty: "pass" }), CONFIG)[0].status).toBe("pass");
  });

  test("not-applicable rules are excluded from the score, both halves", () => {
    const report = evaluatePolicies(
      [
        policy({
          id: "a",
          match: { section: "/ip/ssh", settings: true },
          assert: { field: "strong-crypto", equals: "yes" },
        }),
        policy({ id: "b", ...empty }),
      ].map((p, i) => ({ ...p, id: i === 0 ? "rule-a" : "rule-b" })),
      CONFIG,
    );
    expect(report.summary).toMatchObject({
      total: 2,
      passed: 1,
      failed: 0,
      notApplicable: 1,
      score: 100,
    });
  });
});

// ── Reports ─────────────────────────────────────────────────────────────────

describe("reports", () => {
  const RULES: Policy[] = [
    policy({
      id: "no-bare-input-accept",
      severity: "critical",
      description: "An input-chain accept must be scoped.",
      remediation: "Add src-address-list or in-interface-list to the rule.",
      match: { section: "/ip/firewall/filter", where: { chain: "input", action: "accept" } },
      assert: {
        any_of: [
          { field: "src-address-list", present: true },
          { field: "connection-state", contains: "established" },
        ],
      },
    }),
    policy({
      id: "ssh-strong-crypto",
      severity: "high",
      match: { section: "/ip/ssh", settings: true },
      assert: { field: "strong-crypto", equals: "yes" },
    }),
  ].map((p, i) => ({ ...p, id: i === 0 ? "no-bare-input-accept" : "ssh-strong-crypto" }));

  const report = evaluatePolicies(RULES, CONFIG, { device: "edge-01", ts: 1_700_000_000_000 });

  test("the score counts RULES, not findings", () => {
    // One rule fails (on one of three records), one passes → 50%.
    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1, score: 50 });
    expect(report.summary.bySeverity.critical).toBe(1);
  });

  test("markdown leads with the verdict and shows the offending line", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("POLICY CHECK — edge-01: 50%");
    expect(md).toContain("`no-bare-input-accept`");
    expect(md).toContain("add action=accept chain=input");
    expect(md).toContain("**Fix:** Add src-address-list");
  });

  test("markdown says so when nothing failed", () => {
    const clean = evaluatePolicies([RULES[1]], CONFIG);
    expect(renderMarkdown(clean)).toContain("No violations.");
  });

  test("json round-trips and sorts failures first", () => {
    const parsed = JSON.parse(renderJson(report)) as {
      summary: { score: number };
      findings: { status: string }[];
    };
    expect(parsed.summary.score).toBe(50);
    expect(parsed.findings[0].status).toBe("fail");
  });

  test("sarif carries one rule descriptor and a located result", () => {
    const sarif = JSON.parse(renderSarif(report, { artifact: "edge-01.rsc" })) as {
      version: string;
      runs: {
        tool: { driver: { rules: { id: string; defaultConfiguration: { level: string } }[] } };
        results: {
          ruleId: string;
          level: string;
          locations: {
            physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
          }[];
        }[];
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules[0].defaultConfiguration.level).toBe("error");
    expect(sarif.runs[0].results[0].ruleId).toBe("no-bare-input-accept");
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      "edge-01.rsc",
    );
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(9);
  });

  test("explainFinding renders the rule, the evidence and the fix", () => {
    const failure = report.findings.find((f) => f.status === "fail")!;
    const text = explainFinding(failure);
    expect(text).toContain("no-bare-input-accept — FAIL");
    expect(text).toContain("/ip/firewall/filter (line 9)");
    expect(text).toContain("Offending configuration:");
    expect(text).toContain("Fix: Add src-address-list");
  });

  test("a report admits when the export was not fully parsed", () => {
    const model = parseExport(`/ip ssh\nset strong-crypto=yes\ngarbage line here`);
    const partial = evaluatePolicies([RULES[1]], model);
    expect(partial.unparsedLines).toBe(1);
    expect(renderMarkdown(partial)).toContain("could not be parsed");
  });
});
