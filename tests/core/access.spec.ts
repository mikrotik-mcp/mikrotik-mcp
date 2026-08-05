/**
 * Unit tests for caller-scoped access control. The evaluator is pure; the
 * session holder is exercised through its own install/reset seams.
 */
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  clearDenials,
  evaluateAccess,
  getAccessPolicy,
  globMatch,
  installAccessPolicy,
  narrowScope,
  narrowSession,
  recentDenials,
  recordDenial,
  resetSessionScope,
} from "../../src/core/access";
import type { AccessPolicy, AccessScope } from "../../src/core/access";

const NOW = 1_700_000_000_000;

function policy(scope: AccessScope, enabled = true): AccessPolicy {
  return { enabled, scope };
}

function ask(p: AccessPolicy, over: Partial<Parameters<typeof evaluateAccess>[1]> = {}) {
  return evaluateAccess(p, {
    tool: "create_filter_rule",
    risk: "WRITE",
    device: "edge",
    now: NOW,
    ...over,
  });
}

describe("globMatch", () => {
  test("matches * as a wildcard run", () => {
    expect(globMatch("list_*", "list_interfaces")).toBe(true);
    expect(globMatch("*_rule", "create_filter_rule")).toBe(true);
    expect(globMatch("*", "anything")).toBe(true);
  });

  test("is anchored at both ends", () => {
    // The bug this guards: an unanchored `list_*` would also match
    // `firewall_list_rules`, quietly widening every allow-list.
    expect(globMatch("list_*", "firewall_list_rules")).toBe(false);
    expect(globMatch("get_user", "get_user_group")).toBe(false);
  });

  test("treats regex metacharacters as literals", () => {
    expect(globMatch("get_a.b", "get_axb")).toBe(false);
    expect(globMatch("get_a.b", "get_a.b")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(globMatch("LIST_*", "list_interfaces")).toBe(true);
  });
});

describe("evaluateAccess", () => {
  test("a disabled policy allows everything", () => {
    expect(ask(policy({ maxRisk: "READ" }, false)).allowed).toBe(true);
  });

  test("enforces the risk ceiling", () => {
    expect(ask(policy({ maxRisk: "READ" })).allowed).toBe(false);
    expect(ask(policy({ maxRisk: "READ" }), { risk: "READ" }).allowed).toBe(true);
    expect(ask(policy({ maxRisk: "WRITE" })).allowed).toBe(true);
    expect(ask(policy({ maxRisk: "WRITE" }), { risk: "DESTRUCTIVE" }).allowed).toBe(false);
  });

  test("WRITE and WRITE_IDEMPOTENT share a rank", () => {
    // Idempotence makes a write safer to RETRY, not safer to make — an operator
    // allowing one plainly means both.
    expect(ask(policy({ maxRisk: "WRITE" }), { risk: "WRITE_IDEMPOTENT" }).allowed).toBe(true);
    expect(ask(policy({ maxRisk: "WRITE_IDEMPOTENT" }), { risk: "WRITE" }).allowed).toBe(true);
  });

  test("enforces the device allow-list and deny-list", () => {
    expect(ask(policy({ devices: ["lab"] })).allowed).toBe(false);
    expect(ask(policy({ devices: ["lab", "edge"] })).allowed).toBe(true);
    // Deny wins over allow.
    expect(ask(policy({ devices: ["edge"], denyDevices: ["edge"] })).allowed).toBe(false);
  });

  test("a no-device tool is unaffected by device rules", () => {
    expect(ask(policy({ devices: ["lab"] }), { device: undefined }).allowed).toBe(true);
  });

  test("enforces tool globs, deny winning over allow", () => {
    expect(ask(policy({ tools: ["list_*"] })).allowed).toBe(false);
    expect(ask(policy({ tools: ["create_*"] })).allowed).toBe(true);
    expect(ask(policy({ tools: ["create_*"], denyTools: ["create_filter_*"] })).allowed).toBe(
      false,
    );
  });

  test("enforces expiry against the supplied clock", () => {
    expect(ask(policy({ expiresAt: NOW - 1 })).allowed).toBe(false);
    expect(ask(policy({ expiresAt: NOW - 1 })).rule).toBe("expired");
    expect(ask(policy({ expiresAt: NOW + 1 })).allowed).toBe(true);
  });

  test("a denial names the rule and explains the boundary", () => {
    const d = ask(policy({ maxRisk: "READ", label: "unattended-loop" }));
    expect(d.rule).toBe("risk");
    expect(d.reason).toContain("READ");
    expect(d.reason).toContain("unattended-loop");
  });
});

describe("narrowScope — one-way narrowing", () => {
  test("takes the lower risk ceiling in both directions", () => {
    expect(narrowScope({ maxRisk: "DESTRUCTIVE" }, { maxRisk: "READ" }).maxRisk).toBe("READ");
    // The property that matters: asking for MORE cannot grant more.
    expect(narrowScope({ maxRisk: "READ" }, { maxRisk: "DANGEROUS" }).maxRisk).toBe("READ");
  });

  test("intersects device allow-lists", () => {
    expect(narrowScope({ devices: ["a", "b"] }, { devices: ["b", "c"] }).devices).toEqual(["b"]);
    // An empty base means "all", so the request narrows it.
    expect(narrowScope({}, { devices: ["b"] }).devices).toEqual(["b"]);
    // An empty request means "unchanged".
    expect(narrowScope({ devices: ["a"] }, {}).devices).toEqual(["a"]);
  });

  test("unions deny-lists so a denial can never be dropped", () => {
    const out = narrowScope({ denyTools: ["reset_*"] }, { denyTools: ["remove_*"] });
    expect(out.denyTools).toEqual(["reset_*", "remove_*"]);
  });

  test("takes the earlier expiry", () => {
    expect(narrowScope({ expiresAt: NOW + 1000 }, { expiresAt: NOW + 10 }).expiresAt).toBe(
      NOW + 10,
    );
    expect(narrowScope({ expiresAt: NOW + 10 }, { expiresAt: NOW + 1000 }).expiresAt).toBe(
      NOW + 10,
    );
  });

  test("an empty request changes nothing", () => {
    const base: AccessScope = { maxRisk: "WRITE", devices: ["a"], denyTools: ["x"] };
    expect(narrowScope(base, {})).toMatchObject(base);
  });
});

describe("session narrowing", () => {
  beforeEach(() => {
    resetSessionScope();
    installAccessPolicy({ enabled: false, scope: {} });
  });

  test("narrowing a permissive base turns enforcement ON", () => {
    // Otherwise "please restrict me" would be a no-op — the worst failure mode.
    expect(getAccessPolicy().enabled).toBe(false);
    narrowSession({ maxRisk: "READ" });
    const p = getAccessPolicy();
    expect(p.enabled).toBe(true);
    expect(p.scope.maxRisk).toBe("READ");
  });

  test("repeated narrowing only ever tightens", () => {
    narrowSession({ maxRisk: "WRITE" });
    narrowSession({ maxRisk: "DANGEROUS" });
    expect(getAccessPolicy().scope.maxRisk).toBe("WRITE");
    narrowSession({ maxRisk: "READ" });
    expect(getAccessPolicy().scope.maxRisk).toBe("READ");
  });

  test("a config reload cannot drop an active session narrowing", () => {
    narrowSession({ maxRisk: "READ", label: "session" });
    installAccessPolicy({ enabled: true, scope: { maxRisk: "DANGEROUS" } });
    expect(getAccessPolicy().scope.maxRisk).toBe("READ");
  });
});

describe("denial audit trail", () => {
  beforeEach(clearDenials);

  test("records newest-first and stays bounded", () => {
    for (let i = 0; i < 250; i++) {
      recordDenial({ ts: NOW + i, tool: `t${i}`, risk: "WRITE", rule: "risk", reason: "r" });
    }
    const all = recentDenials();
    expect(all.length).toBe(200);
    expect(all[0].tool).toBe("t249");
  });
});
