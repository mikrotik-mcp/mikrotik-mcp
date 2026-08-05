/**
 * Known-vulnerability matching for RouterOS.
 *
 * `firmware_check` answers "is there a newer version?". This answers the
 * question that actually drives an upgrade decision: **does a published
 * advisory affect THIS device, and is the affected surface reachable?**
 *
 * The join is the whole point. A Winbox privilege-escalation CVE on a router
 * whose Winbox service is disabled — or restricted to a management subnet — is
 * not the same finding as one on a router with 8291 open to the world, and
 * ranking both at raw CVSS buries the one that matters. So every advisory
 * carries an `exposure` predicate evaluated against the device's live service
 * table and package list, and findings come back ranked by *effective* risk.
 *
 * This module is pure — no SSH, no Bun, no clock. It takes a
 * {@link DeviceFacts} snapshot and returns findings, so it is unit-tested
 * directly against fixtures and imported freely by tools and the dashboard.
 */

// ── Version handling ────────────────────────────────────────────────────────

/** A parsed RouterOS version: `7.15.3`, `6.49.10`, `7.16beta2`, `7.14rc3`. */
export interface RosVersion {
  major: number;
  minor: number;
  patch: number;
  /** `beta` / `rc` / `alpha` when the build is a pre-release, else undefined. */
  pre?: string;
  /** Pre-release ordinal (`beta2` → 2). */
  preNum: number;
  /** The original string, for display. */
  raw: string;
}

/**
 * Parse a RouterOS version string. Tolerant by design: RouterOS reports
 * versions with a trailing channel in several places (`6.48.6 (long-term)`,
 * `7.15.3 (stable)`), and a strict parser would simply fail to protect those
 * devices. Returns undefined only when there is no leading `<major>.<minor>`.
 */
export function parseRosVersion(input: string): RosVersion | undefined {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?\s*(alpha|beta|rc)?\s*(\d+)?/i.exec(input);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4]?.toLowerCase(),
    preNum: m[5] === undefined ? 0 : Number(m[5]),
    raw: input.trim(),
  };
}

/**
 * Compare two RouterOS versions: negative if `a` is older. A pre-release sorts
 * BEFORE the release it leads to — `7.11beta3` is older than `7.11`, which is
 * what makes "fixed in 7.11" correctly still flag a 7.11beta3 device.
 */
export function compareRosVersions(a: RosVersion, b: RosVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const rank = (v: RosVersion): number => (v.pre ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.pre && b.pre && a.pre !== b.pre) {
    const order = ["alpha", "beta", "rc"];
    return order.indexOf(a.pre) - order.indexOf(b.pre);
  }
  return a.preNum - b.preNum;
}

// ── Advisory model ──────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * One affected version range. `fixedIn` also selects the RELEASE BRANCH: a
 * range fixed in `6.49.7` never applies to a v7 device. RouterOS ships v6
 * long-term and v6 stable in parallel, so an advisory usually carries one range
 * per branch and a device matches at most one.
 */
export interface AffectedRange {
  /** First affected version. Omit when every earlier release is affected. */
  introduced?: string;
  /** First FIXED version. A device strictly below this (same branch) is affected. */
  fixedIn: string;
}

/**
 * Extra conditions required for the vulnerability to be reachable at all. All
 * present conditions must hold. Absent conditions mean "always reachable".
 */
export interface ExposurePredicate {
  /**
   * IP service names (`/ip service`) that expose the flaw — matching if ANY is
   * enabled. This is what separates "patch tonight" from "patch this quarter".
   */
  services?: string[];
  /** Required RouterOS packages (matching if ANY is installed and enabled). */
  packages?: string[];
  /**
   * A configuration condition the matcher cannot verify from services/packages
   * alone (e.g. "IPv6 RA accepted on an untrusted interface"). Reported to the
   * operator as something to confirm rather than silently assumed true.
   */
  manualCheck?: string;
}

export interface Advisory {
  /** CVE id where one exists, else a stable internal id. */
  id: string;
  title: string;
  severity: Severity;
  /** CVSS v3 base score as published, when known. */
  cvss?: number;
  /** Publication date, ISO `YYYY-MM-DD`. */
  published: string;
  summary: string;
  affected: AffectedRange[];
  exposure?: ExposurePredicate;
  remediation: string;
  references: string[];
}

// ── Device facts ────────────────────────────────────────────────────────────

/** One row of `/ip service print detail`. */
export interface ServiceFact {
  name: string;
  disabled: boolean;
  port?: number;
  /**
   * The `address` restriction — the subnets allowed to reach the service. An
   * EMPTY list means unrestricted, which is the dangerous default.
   */
  allowedFrom: string[];
}

/** One row of `/system package print`. */
export interface PackageFact {
  name: string;
  enabled: boolean;
}

/** Everything the matcher needs about one device. Collected by the tool layer. */
export interface DeviceFacts {
  /** Device config key, for multi-device reporting. */
  device?: string;
  /** `/system resource` version string, e.g. `7.15.3 (stable)`. */
  version: string;
  /** Board name, for display only. */
  board?: string;
  services: ServiceFact[];
  packages: PackageFact[];
}

// ── Curated advisory dataset ────────────────────────────────────────────────

/**
 * When the bundled dataset was last reviewed. Surfaced in every report so a
 * clean result is never mistaken for "checked against today's advisories".
 */
export const ADVISORY_DATASET_DATE = "2026-08-05";

/**
 * A curated set of well-documented RouterOS advisories.
 *
 * Deliberately conservative: it carries entries that are public, stable and
 * precisely version-bounded, because a wrong `fixedIn` is worse than a missing
 * entry — it tells someone they are safe when they are not. It is a floor, not
 * a substitute for MikroTik's own advisory feed, and every report says so.
 */
export const ADVISORIES: Advisory[] = [
  {
    id: "CVE-2018-14847",
    title: "Winbox unauthenticated directory traversal (credential disclosure)",
    severity: "critical",
    cvss: 9.1,
    published: "2018-08-02",
    summary:
      "The Winbox service allows an unauthenticated remote attacker to read arbitrary files, " +
      "including the user database, yielding valid credentials for the router. Weaponised at " +
      "scale by VPNFilter and the Hajime botnet, and still one of the most commonly found " +
      "MikroTik exposures on the public internet.",
    affected: [{ fixedIn: "6.42.1" }, { fixedIn: "6.40.9" }],
    exposure: { services: ["winbox"] },
    remediation:
      "Upgrade to 6.42.1+ (or 6.40.9+ on long-term), then rotate EVERY local credential — a " +
      "device that was reachable while vulnerable must be assumed to have leaked its user " +
      "database. Restrict /ip service winbox to a management subnet regardless of version.",
    references: [
      "https://nvd.nist.gov/vuln/detail/CVE-2018-14847",
      "https://blog.mikrotik.com/security/winbox-vulnerability.html",
    ],
  },
  {
    id: "CVE-2019-3924",
    title: "Unauthenticated in-band network scan via Winbox agent",
    severity: "high",
    cvss: 7.5,
    published: "2019-02-20",
    summary:
      "An unauthenticated attacker can make the router proxy TCP/UDP requests on their behalf, " +
      "turning it into a pivot for scanning and reaching hosts on networks the attacker cannot " +
      "route to directly — including the router's own LAN-side management services.",
    affected: [{ fixedIn: "6.43.12" }, { fixedIn: "6.42.12" }],
    exposure: { services: ["winbox"] },
    remediation:
      "Upgrade to 6.43.12+ (6.42.12+ on the older branch) and restrict Winbox to trusted " +
      "source addresses via /ip service set winbox address=<mgmt-subnet>.",
    references: ["https://nvd.nist.gov/vuln/detail/CVE-2019-3924"],
  },
  {
    id: "CVE-2020-11881",
    title: "SMB service remote denial of service",
    severity: "high",
    cvss: 7.5,
    published: "2020-04-21",
    summary:
      "A malformed request to the RouterOS SMB service triggers an out-of-bounds condition that " +
      "crashes the service and can reboot the device, giving an unauthenticated attacker a " +
      "repeatable remote outage.",
    affected: [{ fixedIn: "6.45.7" }],
    exposure: {
      services: ["smb"],
      manualCheck:
        "SMB is configured under /ip smb rather than /ip service — confirm whether it is enabled " +
        "and, if so, which interfaces it listens on.",
    },
    remediation:
      "Upgrade to 6.45.7+ and disable SMB entirely (/ip smb set enabled=no) unless the router is " +
      "deliberately serving files.",
    references: ["https://nvd.nist.gov/vuln/detail/CVE-2020-11881"],
  },
  {
    id: "CVE-2023-30799",
    title: "Winbox authenticated privilege escalation to super-admin",
    severity: "critical",
    cvss: 9.1,
    published: "2023-07-19",
    summary:
      "An attacker holding any valid credential can escalate to a hidden 'super-admin' role and " +
      "take full control of the device, including running arbitrary code. Because RouterOS ships " +
      "with a well-known default account, the required credential is frequently trivial to " +
      "obtain — which is why this was tracked as remotely exploitable in practice.",
    affected: [{ fixedIn: "6.49.7" }, { fixedIn: "6.48.6" }],
    exposure: { services: ["winbox", "www", "www-ssl"] },
    remediation:
      "Upgrade to 6.49.7+ (6.48.6+ long-term). Remove or rename the default admin account, " +
      "enforce strong passwords, and restrict Winbox/WebFig to a management subnet.",
    references: [
      "https://nvd.nist.gov/vuln/detail/CVE-2023-30799",
      "https://vulncheck.com/blog/mikrotik-foisted-revisited",
    ],
  },
  {
    id: "CVE-2023-32154",
    title: "IPv6 Router Advertisement pre-authentication RCE",
    severity: "critical",
    cvss: 9.8,
    published: "2023-05-11",
    summary:
      "The RouterOS router-advertisement daemon uses attacker-supplied data without validating " +
      "it, letting an unauthenticated attacker on an adjacent IPv6 segment run arbitrary code as " +
      "root. No credentials and no prior access to the device are required.",
    affected: [{ fixedIn: "7.11" }],
    exposure: {
      manualCheck:
        "Reachability depends on whether the device ACCEPTS router advertisements on an " +
        "untrusted segment — check /ipv6 settings accept-router-advertisements and which " +
        "interfaces face untrusted networks.",
    },
    remediation:
      "Upgrade to RouterOS 7.11+. Until then, disable IPv6 RA acceptance on untrusted interfaces " +
      "(/ipv6 settings set accept-router-advertisements=no) or disable the ipv6 package if unused.",
    references: [
      "https://nvd.nist.gov/vuln/detail/CVE-2023-32154",
      "https://www.zerodayinitiative.com/advisories/ZDI-23-710/",
    ],
  },
];

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * How reachable an affected surface is. Drives ranking — a `critical` advisory
 * behind a disabled service outranks nothing, and a `high` one on an
 * internet-facing port outranks a `critical` that is fully mitigated.
 */
export type Exposure =
  | "unrestricted" // affected service enabled with NO address restriction
  | "restricted" // affected service enabled but limited to specific subnets
  | "mitigated" // every affected service is disabled / package absent
  | "unknown"; // needs the operator to confirm a condition we cannot read

export interface Finding {
  advisory: Advisory;
  device?: string;
  /** The device version that matched, parsed. */
  version: string;
  exposure: Exposure;
  /** Enabled services that expose this advisory, with their restrictions. */
  exposedServices: ServiceFact[];
  /** Populated when `exposure` is `unknown` — what the operator must confirm. */
  manualCheck?: string;
  /** Effective rank: severity weighted by reachability. Higher is worse. */
  score: number;
  /** The version this device should reach to clear the finding. */
  fixedIn: string;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
};

const EXPOSURE_WEIGHT: Record<Exposure, number> = {
  unrestricted: 3,
  restricted: 1.5,
  unknown: 1.2,
  mitigated: 0.25,
};

/**
 * Does `version` fall inside any of the advisory's affected ranges?
 *
 * Branch-aware: the range's `fixedIn` major must equal the device's major, so a
 * v7 router is never reported against a v6-only fix. Returns the matching
 * range's `fixedIn` so the caller can tell the operator where to land.
 */
export function affectedRange(
  version: RosVersion,
  ranges: AffectedRange[],
): AffectedRange | undefined {
  for (const range of ranges) {
    const fixed = parseRosVersion(range.fixedIn);
    if (!fixed || fixed.major !== version.major) continue;
    if (compareRosVersions(version, fixed) >= 0) continue;
    if (range.introduced) {
      const from = parseRosVersion(range.introduced);
      if (from && compareRosVersions(version, from) < 0) continue;
    }
    return range;
  }
  return undefined;
}

/** Evaluate an advisory's exposure predicate against one device's facts. */
function evaluateExposure(
  facts: DeviceFacts,
  predicate: ExposurePredicate | undefined,
): { exposure: Exposure; services: ServiceFact[]; manualCheck?: string } {
  if (!predicate) return { exposure: "unrestricted", services: [] };

  if (predicate.packages && predicate.packages.length > 0) {
    const wanted = new Set(predicate.packages.map((p) => p.toLowerCase()));
    const present = facts.packages.some((p) => p.enabled && wanted.has(p.name.toLowerCase()));
    // An empty package list means we could not read them — do NOT call that
    // mitigated, or a collection failure would silently clear real findings.
    if (!present && facts.packages.length > 0) {
      return { exposure: "mitigated", services: [] };
    }
  }

  let services: ServiceFact[] = [];
  if (predicate.services && predicate.services.length > 0) {
    const wanted = new Set(predicate.services.map((s) => s.toLowerCase()));
    const matching = facts.services.filter((s) => wanted.has(s.name.toLowerCase()));
    services = matching.filter((s) => !s.disabled);
    // Same reasoning as packages: only claim "mitigated" from data we actually
    // have. No service rows at all means unknown, not safe.
    if (services.length === 0 && matching.length > 0) {
      return { exposure: "mitigated", services: [] };
    }
    if (services.length === 0) {
      return { exposure: "unknown", services: [], manualCheck: predicate.manualCheck };
    }
  }

  if (predicate.manualCheck) {
    return { exposure: "unknown", services, manualCheck: predicate.manualCheck };
  }
  // A service with no address restriction is reachable from anywhere the route
  // allows — that is the finding that gets someone paged.
  const unrestricted = services.length === 0 || services.some((s) => s.allowedFrom.length === 0);
  return { exposure: unrestricted ? "unrestricted" : "restricted", services };
}

/**
 * Match one device's facts against an advisory set.
 *
 * Pure and total — an unparseable version yields no findings rather than
 * throwing, because a device we cannot read a version from must not silently
 * become "clean". Callers should surface that separately (see
 * {@link matchAdvisories}'s `unreadable`).
 */
export function matchDevice(
  facts: DeviceFacts,
  advisories: Advisory[] = ADVISORIES,
): { findings: Finding[]; versionParsed: boolean } {
  const version = parseRosVersion(facts.version);
  if (!version) return { findings: [], versionParsed: false };

  const findings: Finding[] = [];
  for (const advisory of advisories) {
    const range = affectedRange(version, advisory.affected);
    if (!range) continue;
    const { exposure, services, manualCheck } = evaluateExposure(facts, advisory.exposure);
    findings.push({
      advisory,
      device: facts.device,
      version: version.raw,
      exposure,
      exposedServices: services,
      manualCheck,
      score: Math.round(SEVERITY_WEIGHT[advisory.severity] * EXPOSURE_WEIGHT[exposure] * 10) / 10,
      fixedIn: range.fixedIn,
    });
  }
  // Worst first; ties broken by CVSS then id so the order is deterministic.
  findings.sort(
    (a, b) =>
      b.score - a.score ||
      (b.advisory.cvss ?? 0) - (a.advisory.cvss ?? 0) ||
      a.advisory.id.localeCompare(b.advisory.id),
  );
  return { findings, versionParsed: true };
}

export interface FleetReport {
  findings: Finding[];
  /** Devices whose version string could not be parsed — reported, not hidden. */
  unreadable: string[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
}

/** Match a whole fleet, keeping per-device attribution and one ranked list. */
export function matchAdvisories(
  facts: DeviceFacts[],
  advisories: Advisory[] = ADVISORIES,
): FleetReport {
  const findings: Finding[] = [];
  const unreadable: string[] = [];
  for (const f of facts) {
    const r = matchDevice(f, advisories);
    if (!r.versionParsed) unreadable.push(f.device ?? "(unnamed)");
    findings.push(...r.findings);
  }
  findings.sort(
    (a, b) =>
      b.score - a.score ||
      (b.advisory.cvss ?? 0) - (a.advisory.cvss ?? 0) ||
      a.advisory.id.localeCompare(b.advisory.id),
  );
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
  for (const f of findings) summary[f.advisory.severity]++;
  return { findings, unreadable, summary };
}
