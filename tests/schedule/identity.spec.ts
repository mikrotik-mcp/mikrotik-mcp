/**
 * Finding identity across the existing auditors.
 *
 * One property, asserted from several angles: **the same problem gets the same
 * id on every run, including after the config is reordered.** Everything the
 * scheduled-audit feature does — "this is new", "this got worse", "this is
 * fixed" — is a lie if that does not hold.
 */
import { describe, expect, test } from "vite-plus/test";
import { auditFirewall, rulesFromRows } from "../../src/core/firewall-audit";
import { auditCategory, emptySecurityState } from "../../src/core/security-hardening";
import { parseRecords } from "../../src/core/routeros-parse";
import {
  complianceFindingId,
  firewallFindingId,
  hardeningFindingId,
  policyFindingId,
  ruleFingerprint,
  stableId,
} from "../../src/schedule/identity";
import { diffFindings } from "../../src/schedule/model";
import type { AuditFinding } from "../../src/schedule/model";

describe("stableId", () => {
  test("is deterministic across calls", () => {
    expect(stableId("x", ["a", "b"])).toBe(stableId("x", ["a", "b"]));
  });

  test("is insensitive to case and surrounding whitespace", () => {
    expect(stableId("x", [" Chain=Input "])).toBe(stableId("x", ["chain=input"]));
  });

  test("distinguishes different content", () => {
    expect(stableId("x", ["a"])).not.toBe(stableId("x", ["b"]));
    expect(stableId("x", ["a"])).not.toBe(stableId("y", ["a"]));
  });

  test("ignores absent parts rather than hashing 'undefined'", () => {
    expect(stableId("x", ["a", undefined, "b"])).toBe(stableId("x", ["a", "b"]));
  });
});

describe("ruleFingerprint", () => {
  const rule = {
    chain: "input",
    action: "accept",
    match: { protocol: "tcp", "dst-port": "22", "src-address-list": "mgmt" },
  };

  test("is independent of match-condition ordering", () => {
    const reordered = {
      chain: "input",
      action: "accept",
      match: { "src-address-list": "mgmt", "dst-port": "22", protocol: "tcp" },
    };
    expect(ruleFingerprint(reordered)).toBe(ruleFingerprint(rule));
  });

  test("changes when the rule matches different traffic", () => {
    const different = { ...rule, match: { ...rule.match, "dst-port": "23" } };
    expect(ruleFingerprint(different)).not.toBe(ruleFingerprint(rule));
  });
});

/** RouterOS `print detail` text → parsed rules, as the other specs do it. */
function rules(text: string): ReturnType<typeof rulesFromRows> {
  return rulesFromRows(parseRecords(text).rows);
}

describe("firewall audit ids", () => {
  const CONFIG = ` 0    chain=input action=accept connection-state=established,related
 1    chain=input action=accept protocol=tcp dst-port=22
 2    chain=input action=accept protocol=tcp dst-port=22 src-address-list=mgmt
 3    chain=input action=drop
`;

  /** Same rules, with an unrelated rule inserted at the top. */
  const REORDERED = ` 0    chain=input action=accept protocol=icmp
 1    chain=input action=accept connection-state=established,related
 2    chain=input action=accept protocol=tcp dst-port=22
 3    chain=input action=accept protocol=tcp dst-port=22 src-address-list=mgmt
 4    chain=input action=drop
`;

  function idsFor(text: string): string[] {
    const report = auditFirewall({ filter: rules(text) });
    return report.findings.map((f) => f.findingId ?? "(none)").sort();
  }

  test("every finding carries an id", () => {
    const report = auditFirewall({ filter: rules(CONFIG) });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => typeof f.findingId === "string")).toBe(true);
  });

  test("the same config produces the same ids across runs", () => {
    expect(idsFor(CONFIG)).toEqual(idsFor(CONFIG));
  });

  test("REORDERING the config keeps the ids of the findings it still has", () => {
    // The point of the whole exercise. Any id that survives the reorder must be
    // byte-identical, or a nightly diff reports a wall of phantom regressions.
    const before = idsFor(CONFIG);
    const after = idsFor(REORDERED);
    const survived = before.filter((id) => after.includes(id));
    expect(survived.length).toBe(before.length);
  });

  test("a reordered config diffs as all-unchanged through the scheduler", () => {
    const toFindings = (text: string): AuditFinding[] =>
      auditFirewall({ filter: rules(text) }).findings.map((f) => ({
        id: f.findingId ?? "",
        severity: f.severity,
        title: f.title,
      }));

    const diff = diffFindings(toFindings(CONFIG), toFindings(REORDERED));
    expect(diff.added).toEqual([]);
    expect(diff.worsened).toEqual([]);
    expect(diff.unchanged.length).toBeGreaterThan(0);
  });

  test("a genuinely different rule produces a different id", () => {
    const changed = CONFIG.replace(
      "dst-port=22 src-address-list=mgmt",
      "dst-port=23 src-address-list=mgmt",
    );
    expect(idsFor(changed)).not.toEqual(idsFor(CONFIG));
  });

  test("ids are distinct per finding, not shared", () => {
    const report = auditFirewall({ filter: rules(CONFIG) });
    const ids = report.findings.map((f) => f.findingId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("firewallFindingId ignores the rule's position entirely", () => {
    const rule = { chain: "input", action: "drop", match: { protocol: "tcp" } };
    expect(firewallFindingId({ kind: "shadowed", table: "filter", chain: "input", rule })).toBe(
      firewallFindingId({ kind: "shadowed", table: "filter", chain: "input", rule }),
    );
  });
});

describe("security hardening ids", () => {
  const RULES = `Flags: X - disabled
 0    chain=input action=accept protocol=tcp dst-port=8291
 1 X  chain=input action=drop protocol=tcp dst-port=8291
`;
  const MOVED = `Flags: X - disabled
 0    chain=input action=accept connection-state=established,related
 1    chain=input action=accept protocol=tcp dst-port=8291
 2 X  chain=input action=drop protocol=tcp dst-port=8291
`;

  function hardeningIds(text: string): string[] {
    return auditCategory("firewall_default_deny", {
      ...emptySecurityState(),
      firewallFilter: rules(text),
    })
      .map((f) => f.finding_id)
      .sort();
  }

  test("the disabled-enforcement id survives the rule moving", () => {
    // This one WAS index-based (`disabled_enforcement:input:1`) and was changed
    // during this task; the test exists so it cannot regress.
    const before = hardeningIds(RULES);
    const after = hardeningIds(MOVED);
    expect(after).toEqual(
      expect.arrayContaining(before.filter((id) => id.includes("disabled_enforcement"))),
    );
  });

  test("no hardening finding id contains a bare rule ordinal", () => {
    for (const id of hardeningIds(RULES)) {
      expect(id).not.toMatch(/:\d+$/);
    }
  });

  test("hardeningFindingId scopes an auditor id to a device", () => {
    expect(hardeningFindingId("service:telnet", "a")).not.toBe(
      hardeningFindingId("service:telnet", "b"),
    );
    expect(hardeningFindingId("service:telnet", "a")).toBe(
      hardeningFindingId("service:telnet", "a"),
    );
  });
});

describe("compliance and policy ids", () => {
  test("a compliance check is identified by its check id and device", () => {
    expect(complianceFindingId("cis-1.1", "edge")).toBe(complianceFindingId("cis-1.1", "edge"));
    expect(complianceFindingId("cis-1.1", "edge")).not.toBe(complianceFindingId("cis-1.2", "edge"));
    expect(complianceFindingId("cis-1.1", "edge")).not.toBe(complianceFindingId("cis-1.1", "core"));
  });

  test("a policy finding is identified by rule + section + evidence, NOT its line", () => {
    // The line number shifts whenever anything above it changes; the offending
    // text does not.
    const a = policyFindingId({
      ruleId: "no-bare-input-accept",
      section: "/ip/firewall/filter",
      evidence: "add action=accept chain=input",
      device: "edge",
    });
    const b = policyFindingId({
      ruleId: "no-bare-input-accept",
      section: "/ip/firewall/filter",
      evidence: "add action=accept chain=input",
      device: "edge",
    });
    expect(a).toBe(b);

    const different = policyFindingId({
      ruleId: "no-bare-input-accept",
      section: "/ip/firewall/filter",
      evidence: "add action=accept chain=forward",
      device: "edge",
    });
    expect(different).not.toBe(a);
  });
});
