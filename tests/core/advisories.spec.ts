/**
 * Unit tests for the RouterOS advisory matcher. Pure — no device I/O.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  ADVISORIES,
  affectedRange,
  compareRosVersions,
  matchAdvisories,
  matchDevice,
  parseRosVersion,
} from "../../src/core/advisories";
import type { Advisory, DeviceFacts, ServiceFact } from "../../src/core/advisories";

function v(s: string) {
  const p = parseRosVersion(s);
  if (!p) throw new Error(`unparseable fixture version: ${s}`);
  return p;
}

function svc(over: Partial<ServiceFact> & { name: string }): ServiceFact {
  return { disabled: false, allowedFrom: [], ...over };
}

function facts(over: Partial<DeviceFacts> = {}): DeviceFacts {
  return {
    device: "edge",
    version: "7.15.3 (stable)",
    services: [svc({ name: "winbox" }), svc({ name: "ssh" })],
    packages: [{ name: "routeros", enabled: true }],
    ...over,
  };
}

/** A minimal advisory so range/exposure logic is tested without the real dataset. */
const FIXTURE: Advisory = {
  id: "TEST-0001",
  title: "Test advisory",
  severity: "critical",
  cvss: 9.0,
  published: "2024-01-01",
  summary: "s",
  affected: [{ fixedIn: "7.10" }],
  exposure: { services: ["winbox"] },
  remediation: "r",
  references: [],
};

describe("parseRosVersion", () => {
  test("parses plain and channel-suffixed versions", () => {
    expect(parseRosVersion("7.15.3")).toMatchObject({ major: 7, minor: 15, patch: 3 });
    expect(parseRosVersion("6.48.6 (long-term)")).toMatchObject({ major: 6, minor: 48, patch: 6 });
    // A missing patch is 0, not undefined — otherwise 7.11 vs 7.11.0 would differ.
    expect(parseRosVersion("7.11")).toMatchObject({ major: 7, minor: 11, patch: 0 });
  });

  test("parses pre-releases", () => {
    expect(parseRosVersion("7.16beta2")).toMatchObject({
      major: 7,
      minor: 16,
      pre: "beta",
      preNum: 2,
    });
    expect(parseRosVersion("7.14rc3")).toMatchObject({ pre: "rc", preNum: 3 });
  });

  test("returns undefined for junk rather than throwing", () => {
    expect(parseRosVersion("")).toBeUndefined();
    expect(parseRosVersion("unknown")).toBeUndefined();
  });
});

describe("compareRosVersions", () => {
  test("orders by major, minor, then patch", () => {
    expect(compareRosVersions(v("6.49.7"), v("7.1"))).toBeLessThan(0);
    expect(compareRosVersions(v("7.15.3"), v("7.15.10"))).toBeLessThan(0);
    expect(compareRosVersions(v("7.15.3"), v("7.15.3"))).toBe(0);
  });

  test("a pre-release sorts before its release", () => {
    expect(compareRosVersions(v("7.11beta3"), v("7.11"))).toBeLessThan(0);
    expect(compareRosVersions(v("7.11rc1"), v("7.11beta9"))).toBeGreaterThan(0);
  });
});

describe("affectedRange", () => {
  test("flags a version below the fix on the same branch", () => {
    expect(affectedRange(v("7.9"), [{ fixedIn: "7.10" }])).toBeDefined();
    expect(affectedRange(v("7.10"), [{ fixedIn: "7.10" }])).toBeUndefined();
  });

  test("never matches a range from a different major branch", () => {
    // The bug this guards: 7.x is numerically above 6.49.7, but a v6-only fix
    // must not be read as "7.x is patched" NOR as "7.x is affected".
    expect(affectedRange(v("7.1"), [{ fixedIn: "6.49.7" }])).toBeUndefined();
    expect(affectedRange(v("6.48.0"), [{ fixedIn: "6.49.7" }, { fixedIn: "7.11" }])).toBeDefined();
  });

  test("honours an introduced floor", () => {
    const ranges = [{ introduced: "6.45", fixedIn: "6.49.7" }];
    expect(affectedRange(v("6.44"), ranges)).toBeUndefined();
    expect(affectedRange(v("6.46"), ranges)).toBeDefined();
  });

  test("a pre-release of the fixed version is still affected", () => {
    expect(affectedRange(v("7.11beta3"), [{ fixedIn: "7.11" }])).toBeDefined();
  });
});

describe("matchDevice — exposure ranking", () => {
  test("an enabled unrestricted service is the worst case", () => {
    const r = matchDevice(facts({ version: "7.9" }), [FIXTURE]);
    expect(r.findings[0].exposure).toBe("unrestricted");
    expect(r.findings[0].fixedIn).toBe("7.10");
  });

  test("an address restriction downgrades the exposure and the score", () => {
    const open = matchDevice(facts({ version: "7.9" }), [FIXTURE]).findings[0];
    const limited = matchDevice(
      facts({ version: "7.9", services: [svc({ name: "winbox", allowedFrom: ["10.0.0.0/8"] })] }),
      [FIXTURE],
    ).findings[0];
    expect(limited.exposure).toBe("restricted");
    expect(limited.score).toBeLessThan(open.score);
  });

  test("a disabled affected service is mitigated, not clean", () => {
    const r = matchDevice(
      facts({ version: "7.9", services: [svc({ name: "winbox", disabled: true })] }),
      [FIXTURE],
    );
    // Still reported — the device IS running vulnerable code — but ranked last.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].exposure).toBe("mitigated");
  });

  test("missing service data is 'unknown', never 'mitigated'", () => {
    // A collection failure must not look like a clean bill of health.
    const r = matchDevice(facts({ version: "7.9", services: [] }), [FIXTURE]);
    expect(r.findings[0].exposure).toBe("unknown");
  });

  test("an advisory needing a manual check reports what to confirm", () => {
    const manual: Advisory = {
      ...FIXTURE,
      exposure: { manualCheck: "confirm IPv6 RA acceptance" },
    };
    const f = matchDevice(facts({ version: "7.9" }), [manual]).findings[0];
    expect(f.exposure).toBe("unknown");
    expect(f.manualCheck).toBe("confirm IPv6 RA acceptance");
  });

  test("an unreadable version yields no findings and says so", () => {
    const r = matchDevice(facts({ version: "" }), [FIXTURE]);
    expect(r.versionParsed).toBe(false);
    expect(r.findings).toEqual([]);
  });
});

describe("matchAdvisories — fleet", () => {
  test("ranks reachable findings above mitigated ones across devices", () => {
    const report = matchAdvisories(
      [
        facts({
          device: "safe",
          version: "7.9",
          services: [svc({ name: "winbox", disabled: true })],
        }),
        facts({ device: "exposed", version: "7.9" }),
      ],
      [FIXTURE],
    );
    expect(report.findings[0].device).toBe("exposed");
    expect(report.findings[1].device).toBe("safe");
  });

  test("devices with an unreadable version are surfaced, not silently dropped", () => {
    const report = matchAdvisories([facts({ device: "mystery", version: "n/a" })], [FIXTURE]);
    expect(report.unreadable).toEqual(["mystery"]);
    expect(report.summary.total).toBe(0);
  });
});

describe("bundled dataset", () => {
  test("every advisory has parseable, branch-consistent ranges", () => {
    for (const adv of ADVISORIES) {
      expect(adv.affected.length).toBeGreaterThan(0);
      for (const r of adv.affected) {
        expect(parseRosVersion(r.fixedIn), `${adv.id} fixedIn`).toBeDefined();
        if (r.introduced) {
          const from = parseRosVersion(r.introduced)!;
          const fixed = parseRosVersion(r.fixedIn)!;
          expect(compareRosVersions(from, fixed), `${adv.id} range order`).toBeLessThan(0);
        }
      }
      expect(adv.references.length, `${adv.id} references`).toBeGreaterThan(0);
    }
  });

  test("a current release is clean against the bundled set", () => {
    // Guards the direction that matters: a false POSITIVE on an up-to-date
    // device would train operators to ignore the audit.
    const r = matchDevice(facts({ version: "7.20.1 (stable)" }));
    expect(r.findings).toEqual([]);
  });

  test("a long-abandoned v6 release trips the known Winbox advisories", () => {
    const r = matchDevice(facts({ version: "6.40.1" }));
    const ids = r.findings.map((f) => f.advisory.id);
    expect(ids).toContain("CVE-2018-14847");
    expect(ids).toContain("CVE-2023-30799");
  });
});
