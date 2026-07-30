/**
 * The decision to block — refusals first.
 *
 * This module can lock an operator out of their own router, or be turned into a
 * weapon aimed at a third party by an attacker who forges a source address. Its
 * guards are therefore tested before its happy path, and each guard is asserted
 * to survive a policy that explicitly asks for the opposite: a guard that can be
 * configured away is not a guard.
 */
import { describe, expect, test } from "vite-plus/test";
import { correlate } from "../../src/attack/correlate";
import type { Incident } from "../../src/attack/correlate";
import type { Signal } from "../../src/attack/detectors";
import {
  BLOCK_LIST,
  DEFAULT_POLICY,
  decide,
  isNeverBlock,
  isPlan,
  neverBlockSet,
} from "../../src/attack/respond";
import type { DecideInput, GuardContext, ResponsePolicy } from "../../src/attack/respond";

const NOW = Date.UTC(2026, 6, 30, 18, 0, 0);

const GUARDS: GuardContext = {
  deviceHosts: ["203.0.113.1"],
  managementSources: ["10.64.60.2"],
  infrastructure: ["203.0.113.254", "8.8.8.8"],
  configured: ["198.51.100.0/24"],
};

function signal(over: Partial<Signal> = {}): Signal {
  return {
    detector: "brute-force",
    device: "edge",
    source: "203.0.113.7",
    firstTs: NOW - 60_000,
    lastTs: NOW,
    count: 40,
    severity: "high",
    spoofable: false,
    summary: "40 failed logins",
    evidence: [],
    ...over,
  };
}

/** An incident built through the real correlator, not hand-made. */
function incident(signals: Partial<Signal>[] = [{}]): Incident {
  return correlate(
    signals.map((s) => signal(s)),
    { now: NOW },
  )[0];
}

/** Responding mode, so the guards are what refuses rather than the mode. */
const RESPOND: ResponsePolicy = {
  ...DEFAULT_POLICY,
  mode: "respond",
  minConfidence: "medium",
  autoRespondTo: ["brute-force", "credential-spray", "port-scan", "firewall-drop-storm"],
};

function ask(over: Partial<DecideInput> = {}) {
  return decide({
    incident: incident(),
    policy: RESPOND,
    guards: GUARDS,
    recentBlockCount: 0,
    ...over,
  });
}

describe("the never-block list", () => {
  test("is seeded from the deployment, not typed by hand", () => {
    const never = neverBlockSet(GUARDS);
    expect(never.has("203.0.113.1")).toBe(true); // a device
    expect(never.has("10.64.60.2")).toBe(true); // this server's own path
    expect(never.has("8.8.8.8")).toBe(true); // a resolver it depends on
  });

  test("covers CIDR entries, not just literals", () => {
    const never = neverBlockSet(GUARDS);
    expect(isNeverBlock("198.51.100.77", never)).toBe(true);
    expect(isNeverBlock("198.51.101.77", never)).toBe(false);
  });

  test("a malformed entry does not silently match everything", () => {
    expect(isNeverBlock("203.0.113.7", new Set(["not-an-address/99"]))).toBe(false);
  });

  test("protects this server's own management path even when asked to block it", () => {
    const d = ask({ incident: incident([{ source: "10.64.60.2" }]), manual: true, confirm: true });
    expect(d.action).toBe("watch");
    expect((d as { guard: boolean }).guard).toBe(true);
    expect(d.reason).toContain("protected");
  });

  test("protects a device's own address", () => {
    expect(ask({ incident: incident([{ source: "203.0.113.1" }]), manual: true }).action).toBe(
      "watch",
    );
  });

  test("protects the infrastructure it depends on", () => {
    expect(ask({ incident: incident([{ source: "8.8.8.8" }]), manual: true }).action).toBe("watch");
  });
});

describe("spoofable evidence", () => {
  test("is refused even in respond mode with the detector explicitly allowed", () => {
    // The whole point: otherwise a forged flood lets the attacker pick the
    // victim, and the responder does the damage.
    const d = ask({
      incident: incident([{ detector: "firewall-drop-storm", spoofable: true }]),
    });
    expect(d.action).toBe("watch");
    expect((d as { guard: boolean }).guard).toBe(true);
    expect(d.reason).toContain("forged");
  });

  test("is refused even when an operator asks for it by hand", () => {
    const d = ask({
      incident: incident([{ detector: "firewall-drop-storm", spoofable: true }]),
      manual: true,
      confirm: true,
    });
    expect(d.action).toBe("watch");
  });

  test("one spoofable signal alongside a real one does NOT block the response", () => {
    const d = ask({
      incident: incident([{ detector: "firewall-drop-storm", spoofable: true }, {}]),
      manual: true,
    });
    expect(isPlan(d)).toBe(true);
  });
});

describe("incidents with no attacker address", () => {
  test("a configuration change is evidence, not something to block", () => {
    const d = ask({
      incident: incident([{ detector: "post-compromise", source: "", severity: "critical" }]),
      manual: true,
    });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("not a connection to block");
  });
});

describe("permanence and expiry", () => {
  test("a timed block is the default, so a wrong one expires on its own", () => {
    const d = ask({ manual: true });
    expect(isPlan(d)).toBe(true);
    expect((d as { timeout: string }).timeout).toBe(DEFAULT_POLICY.blockTimeout);
  });

  test("a permanent block without confirm is refused", () => {
    const d = ask({ manual: true, timeout: "" });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("confirm=true");
  });

  test("a permanent block with confirm is allowed", () => {
    const d = ask({ manual: true, timeout: "", confirm: true });
    expect(isPlan(d)).toBe(true);
    expect((d as { timeout: string }).timeout).toBe("");
  });
});

describe("the rate cap", () => {
  test("refuses at the cap and says what was NOT blocked", () => {
    const d = ask({ recentBlockCount: DEFAULT_POLICY.maxBlocksPerHour, manual: true });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("was NOT blocked");
    expect(d.reason).toContain("spoofing you");
  });

  test("allows the one below the cap", () => {
    expect(
      isPlan(ask({ recentBlockCount: DEFAULT_POLICY.maxBlocksPerHour - 1, manual: true })),
    ).toBe(true);
  });

  test("the cap binds a manual call too — a human at 3am is not a reason to flood a router", () => {
    expect(ask({ recentBlockCount: 99, manual: true, confirm: true }).action).toBe("watch");
  });
});

describe("detect-only is the default", () => {
  test("the shipped policy changes nothing on a device", () => {
    const d = decide({
      incident: incident(),
      policy: DEFAULT_POLICY,
      guards: GUARDS,
      recentBlockCount: 0,
    });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("detection-only");
  });

  test("detect mode still lets an operator act by hand", () => {
    const d = decide({
      incident: incident(),
      policy: DEFAULT_POLICY,
      guards: GUARDS,
      recentBlockCount: 0,
      manual: true,
    });
    expect(isPlan(d)).toBe(true);
  });
});

describe("policy thresholds", () => {
  test("below the confidence floor, nothing happens automatically", () => {
    const d = ask({
      policy: { ...RESPOND, minConfidence: "confirmed" },
    });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("below the configured confirmed");
  });

  test("a detector not on the auto-respond list does not act", () => {
    // Two detectors, so it clears the confidence floor and the auto-respond
    // list is genuinely what refuses.
    const d = ask({
      incident: incident([{}, { detector: "credential-spray" }]),
      policy: { ...RESPOND, autoRespondTo: ["port-scan"] },
    });
    expect(d.action).toBe("watch");
    expect(d.reason).toContain("no detector here");
  });

  test("but a human can still act on it", () => {
    expect(
      isPlan(
        ask({
          incident: incident([{}, { detector: "credential-spray" }]),
          policy: { ...RESPOND, autoRespondTo: ["port-scan"] },
          manual: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("choosing the action", () => {
  test("a public source is blocked into the shared address list", () => {
    const d = ask({ manual: true });
    expect(d.action).toBe("block");
    expect((d as { list: string }).list).toBe(BLOCK_LIST);
  });

  test("a LAN source is quarantined instead — an address-list entry would not survive DHCP", () => {
    const d = ask({ incident: incident([{ source: "192.168.88.40" }]), manual: true });
    expect(d.action).toBe("quarantine");
  });

  test("a confirmed breach escalates to a human rather than blocking", () => {
    // Blocking the source does not un-breach the router.
    const d = ask({
      incident: incident([{ detector: "successful-after-fail", severity: "critical" }]),
      policy: { ...RESPOND, autoRespondTo: ["successful-after-fail"] },
    });
    expect(d.action).toBe("escalate");
    expect(d.reason).toContain("a human has to check the device");
  });

  test("the plan carries the incident's narrative as its reason", () => {
    const d = ask({ manual: true });
    expect((d as { reason: string }).reason).toContain("failed logins");
  });

  test("the plan names every device the source touched", () => {
    const d = ask({
      incident: incident([{ device: "a" }, { device: "b" }]),
      manual: true,
    });
    expect((d as { devices: string[] }).devices).toEqual(["a", "b"]);
  });
});

describe("every refusal explains itself", () => {
  test("no decision is ever silent", () => {
    const cases: DecideInput[] = [
      {
        incident: incident([{ source: "10.64.60.2" }]),
        policy: RESPOND,
        guards: GUARDS,
        recentBlockCount: 0,
      },
      {
        incident: incident([{ spoofable: true, detector: "firewall-drop-storm" }]),
        policy: RESPOND,
        guards: GUARDS,
        recentBlockCount: 0,
      },
      { incident: incident(), policy: DEFAULT_POLICY, guards: GUARDS, recentBlockCount: 0 },
      { incident: incident(), policy: RESPOND, guards: GUARDS, recentBlockCount: 99 },
      {
        incident: incident(),
        policy: RESPOND,
        guards: GUARDS,
        recentBlockCount: 0,
        manual: true,
        timeout: "",
      },
    ];
    for (const input of cases) {
      const d = decide(input);
      expect(d.reason.length).toBeGreaterThan(20);
    }
  });

  test("a guard refusal is marked as one, so the UI can say it is not a setting", () => {
    const guarded = ask({ incident: incident([{ source: "10.64.60.2" }]), manual: true });
    const policyChoice = decide({
      incident: incident(),
      policy: DEFAULT_POLICY,
      guards: GUARDS,
      recentBlockCount: 0,
    });
    expect((guarded as { guard: boolean }).guard).toBe(true);
    expect((policyChoice as { guard: boolean }).guard).toBe(false);
  });
});
