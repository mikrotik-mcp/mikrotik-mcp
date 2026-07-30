/**
 * Unit tests for the pure Security-Hardening engine + the tool-layer helper
 * functions. No device I/O — every fixture is realistic RouterOS `print detail`
 * text (parsed exactly as the live tool layer parses it) or a hand-built state.
 *
 * Fixtures mirror the field patterns the suite was commissioned from:
 *   • the "accept-then-disabled-drop" Winbox trap (4.1),
 *   • populated-but-unenforced scanner/DDoS lists next to a correctly enforced
 *     staged SSH blacklist ladder (4.2),
 *   • an already-hardened router that must yield ZERO findings (idempotency),
 *   • IPv6 latent (no address) vs. active (address assigned) exposure (4.4),
 *   • single- vs. dual-WAN rp-filter branches (4.3),
 *   • flat single-interface multi-subnet vs. VLAN-segmented topology (4.11),
 *   • malformed/partial export snippets (parser robustness).
 */
import { describe, expect, test } from "vite-plus/test";
import { rulesFromRows } from "../../src/core/firewall-audit";
import type { FirewallRule } from "../../src/core/firewall-audit";
import { parseRecords } from "../../src/core/routeros-parse";
import {
  analyzeChainDefaultDeny,
  auditCategory,
  buildListGraph,
  defaultRouteCount,
  effectivelyEnforced,
  emptySecurityState,
  matchesAll,
  renderHardeningReport,
  runSecurityHardeningAudit,
  servicePortRestricted,
} from "../../src/core/security-hardening";
import type { DeviceSecurityState, Finding } from "../../src/core/security-hardening";
import { orderFindingsForApply, selectFindings } from "../../src/tools/security-hardening";

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Parse RouterOS `print detail` text into normalised firewall rules. */
function fw(text: string): FirewallRule[] {
  return rulesFromRows(parseRecords(text).rows);
}

/** Parse RouterOS `print detail` text into raw rows. */
function detail(text: string): Record<string, string>[] {
  return parseRecords(text).rows;
}

/** Build a state, defaulting every slice, overriding just what a test needs. */
function state(overrides: Partial<DeviceSecurityState>): DeviceSecurityState {
  return { ...emptySecurityState(), ...overrides };
}

/** Collect finding_ids for terse assertions. */
function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.finding_id);
}

// A fully-hardened router: every auditor must return zero findings.
const HARDENED_FILTER = `
Flags: X - disabled, I - invalid, D - dynamic
 0    chain=input action=accept connection-state=established,related,untracked
 1    chain=input action=drop connection-state=invalid
 2    chain=input action=accept protocol=tcp dst-port=22 src-address-list=trusted
 3    chain=input action=drop
 4    chain=forward action=accept connection-state=established,related,untracked
 5    chain=forward action=drop connection-state=invalid
 6    chain=forward action=drop
`;

function hardenedState(): DeviceSecurityState {
  return state({
    firewallFilter: fw(HARDENED_FILTER),
    ipSettings: {
      "tcp-syncookies": "yes",
      "rp-filter": "strict",
      "accept-source-route": "no",
      "accept-redirects": "no",
    },
    ipv6Settings: { "disable-ipv6": "yes", forward: "no", "accept-redirects": "no" },
    routes: [{ "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" }],
    ssh: {
      "strong-crypto": "yes",
      "host-key-type": "ed25519",
      "always-allow-password-login": "no",
    },
    services: detail(`
 0 X  name=telnet port=23 address=""
 1    name=ssh port=22 address=192.168.0.0/16
 2 X  name=www port=80 address=""
`),
    userSettings: { "minimum-password-length": "12", "minimum-categories": "3" },
    users: detail(` 0  name=netadmin group=full disabled=no`),
    macServer: { "allowed-interface-list": "LAN" },
    macWinbox: { "allowed-interface-list": "LAN" },
    bandwidthServer: { enabled: "no" },
    romon: { enabled: "no" },
    discoverySettings: { "discover-interface-list": "LAN" },
    dns: { "allow-remote-requests": "no" },
    bridges: detail(` 0  name=bridge`),
    ipAddresses: detail(` 0  address=192.168.88.1/24 interface=bridge`),
  });
}

// ── Low-level helpers ───────────────────────────────────────────────────────

describe("matchesAll", () => {
  test("treats a rule with no match conditions as matching every packet", () => {
    const [r] = fw(` 0  chain=input action=drop`);
    expect(matchesAll(r)).toBe(true);
  });

  test("treats a catch-all 0.0.0.0/0 source as matching every packet", () => {
    const [r] = fw(` 0  chain=input action=drop src-address=0.0.0.0/0`);
    expect(matchesAll(r)).toBe(true);
  });

  test("does not treat a port-scoped rule as matching every packet", () => {
    const [r] = fw(` 0  chain=input action=drop protocol=tcp dst-port=22`);
    expect(matchesAll(r)).toBe(false);
  });
});

describe("defaultRouteCount", () => {
  test("counts a single active default route as one (single-WAN)", () => {
    expect(defaultRouteCount([{ "dst-address": "0.0.0.0/0" }])).toBe(1);
  });

  test("counts two active default routes as two (multi-WAN)", () => {
    expect(
      defaultRouteCount([
        { "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" },
        { "dst-address": "0.0.0.0/0", gateway: "2.2.2.2" },
      ]),
    ).toBe(2);
  });

  test("ignores a disabled default route", () => {
    expect(
      defaultRouteCount([
        { "dst-address": "0.0.0.0/0", flags: "X" },
        { "dst-address": "0.0.0.0/0" },
      ]),
    ).toBe(1);
  });

  test("ignores non-default routes", () => {
    expect(defaultRouteCount([{ "dst-address": "10.0.0.0/8" }])).toBe(0);
  });
});

// ── 4.1  Firewall default-deny ──────────────────────────────────────────────

describe("firewall_default_deny", () => {
  test("flags an input chain whose final rule is not an unconditional drop", () => {
    const s = state({
      firewallFilter: fw(`
 0  chain=input action=accept connection-state=established,related,untracked
 1  chain=input action=accept protocol=tcp dst-port=22
`),
    });
    const f = auditCategory("firewall_default_deny", s);
    expect(ids(f)).toContain("default_deny:input");
    const dd = f.find((x) => x.finding_id === "default_deny:input")!;
    expect(dd.severity).toBe("critical");
    expect(dd.confidence).toBe("proven");
    // Only the tail rules that are missing are generated; established accept is
    // already present so it is not re-added.
    expect(dd.fix!.some((c) => c.includes("connection-state=established"))).toBe(false);
    expect(dd.fix!.some((c) => c.includes("action=drop connection-state=invalid"))).toBe(true);
    expect(dd.fix!.at(-1)).toContain("action=drop");
  });

  test("flags an empty forward chain as having no enforced default-deny", () => {
    const s = state({ firewallFilter: fw(` 0  chain=input action=drop`) });
    const f = auditCategory("firewall_default_deny", s);
    expect(ids(f)).toContain("default_deny:forward");
  });

  test("emits the full tail (established accept + drop invalid + drop) for a bare chain", () => {
    const s = state({ firewallFilter: fw(` 0  chain=forward action=accept`) });
    const dd = auditCategory("firewall_default_deny", s).find(
      (x) => x.finding_id === "default_deny:forward",
    )!;
    expect(dd.fix).toHaveLength(3);
  });

  test("detects the accept-then-disabled-drop Winbox trap as a distinct critical finding", () => {
    const s = state({
      firewallFilter: fw(`
Flags: X - disabled
 0    chain=input action=accept connection-state=established,related,untracked
 1    chain=input action=drop connection-state=invalid
 2    chain=input action=accept protocol=tcp dst-port=8291 src-address-list=trusted
 3 X  chain=input action=drop protocol=tcp dst-port=8291
 4    chain=input action=drop
`),
    });
    const f = auditCategory("firewall_default_deny", s);
    const trap = f.find((x) => x.finding_id.startsWith("disabled_enforcement:input"))!;
    expect(trap).toBeDefined();
    expect(trap.severity).toBe("critical");
    expect(trap.fix![0]).toContain("enable");
    // The chain HAS a proper default-deny tail (rule 4), so the generic
    // no-default-deny finding must NOT also fire — the trap is a separate issue.
    expect(ids(f)).not.toContain("default_deny:input");
  });

  test("re-enable remediation for the disabled drop is a separate finding_id from inserting a tail", () => {
    const s = state({
      firewallFilter: fw(`
Flags: X - disabled
 0    chain=input action=accept protocol=tcp dst-port=8291
 1 X  chain=input action=drop protocol=tcp dst-port=8291
`),
    });
    const f = auditCategory("firewall_default_deny", s);
    // Both fire here: the trap (re-enable) AND no-default-deny (insert tail).
    // The id names what the rule MATCHES, not where it sits — an index-based id
    // would make every reorder look like a fresh critical finding to the
    // scheduled-audit diff (docs/tasks/09 §2).
    const trapId = "disabled_enforcement:input:chain=input action=drop protocol=tcp dst-port=8291";
    expect(ids(f)).toContain(trapId);
    expect(ids(f)).toContain("default_deny:input");
    const trap = f.find((x) => x.finding_id === trapId)!;
    const tail = f.find((x) => x.finding_id === "default_deny:input")!;
    expect(trap.fix![0]).toMatch(/^\/ip firewall filter enable/);
    expect(tail.fix!.some((c) => c.startsWith("/ip firewall filter add"))).toBe(true);
  });

  test("the disabled-drop finding_id survives the rule moving position", () => {
    // Same two rules, with an unrelated rule inserted above them. The finding is
    // about the same drop, so its id must not change.
    const moved = state({
      firewallFilter: fw(`
Flags: X - disabled
 0    chain=input action=accept connection-state=established,related
 1    chain=input action=accept protocol=tcp dst-port=8291
 2 X  chain=input action=drop protocol=tcp dst-port=8291
`),
    });
    expect(ids(auditCategory("firewall_default_deny", moved))).toContain(
      "disabled_enforcement:input:chain=input action=drop protocol=tcp dst-port=8291",
    );
  });

  test("does not flag a disabled drop that is NOT preceded by a matching accept", () => {
    const s = state({
      firewallFilter: fw(`
Flags: X - disabled
 0    chain=input action=accept connection-state=established,related,untracked
 1 X  chain=input action=drop protocol=tcp dst-port=8291
 2    chain=input action=drop
`),
    });
    const f = auditCategory("firewall_default_deny", s);
    expect(ids(f).some((i) => i.startsWith("disabled_enforcement"))).toBe(false);
  });

  test("reports no default-deny findings when both chains end in an unconditional drop", () => {
    const s = state({ firewallFilter: fw(HARDENED_FILTER) });
    expect(auditCategory("firewall_default_deny", s)).toHaveLength(0);
  });

  test("analyzeChainDefaultDeny reports established-accept and invalid-drop presence", () => {
    const a = analyzeChainDefaultDeny(
      fw(`
 0  chain=input action=accept connection-state=established,related,untracked
 1  chain=input action=drop connection-state=invalid
 2  chain=input action=drop
`),
    );
    expect(a.enabledDefaultDeny).toBe(true);
    expect(a.hasEstablishedAccept).toBe(true);
    expect(a.hasInvalidDrop).toBe(true);
  });
});

// ── 4.2  Address-list enforcement ───────────────────────────────────────────

const LADDER_AND_UNENFORCED = `
 0  chain=input action=add-src-to-address-list protocol=tcp dst-port=22 connection-state=new address-list=ssh_stage1 address-list-timeout=1m
 1  chain=input action=add-src-to-address-list protocol=tcp dst-port=22 connection-state=new src-address-list=ssh_stage1 address-list=ssh_stage2 address-list-timeout=1m
 2  chain=input action=add-src-to-address-list protocol=tcp dst-port=22 connection-state=new src-address-list=ssh_stage2 address-list=ssh_stage3 address-list-timeout=1m
 3  chain=input action=add-src-to-address-list protocol=tcp dst-port=22 connection-state=new src-address-list=ssh_stage3 address-list=ssh_blacklist address-list-timeout=1d
 4  chain=input action=drop src-address-list=ssh_blacklist
 5  chain=input action=add-src-to-address-list protocol=tcp psd=21,3s,3,1 address-list="port scanners" address-list-timeout=1d
 6  chain=input action=add-src-to-address-list protocol=tcp connection-limit=100,32 address-list=ddoser address-list-timeout=1h
`;

describe("address_list_enforcement", () => {
  test("flags a list that is populated by an add-rule but never matched by a drop", () => {
    const s = state({ firewallFilter: fw(LADDER_AND_UNENFORCED) });
    const f = auditCategory("address_list_enforcement", s);
    expect(ids(f)).toContain("unenforced_list:port scanners");
    expect(ids(f)).toContain("unenforced_list:ddoser");
  });

  test("does NOT flag any stage of a staged ladder whose final list is dropped", () => {
    const s = state({ firewallFilter: fw(LADDER_AND_UNENFORCED) });
    const flagged = ids(auditCategory("address_list_enforcement", s));
    for (const stage of ["ssh_stage1", "ssh_stage2", "ssh_stage3", "ssh_blacklist"]) {
      expect(flagged).not.toContain(`unenforced_list:${stage}`);
    }
  });

  test("the unenforced-list fix inserts a drop matching the list before the default-deny tail", () => {
    const s = state({ firewallFilter: fw(LADDER_AND_UNENFORCED) });
    const finding = auditCategory("address_list_enforcement", s).find(
      (x) => x.finding_id === "unenforced_list:ddoser",
    )!;
    expect(finding.fix![0]).toContain("action=drop");
    expect(finding.fix![0]).toContain("src-address-list=ddoser");
    expect(finding.fix![0]).toContain("place-before=");
  });

  test("recognises a directly-enforced list (drop matches it) as not a finding", () => {
    const s = state({
      firewallFilter: fw(`
 0  chain=input action=add-src-to-address-list protocol=tcp psd=21,3s,3,1 address-list=scanners
 1  chain=input action=drop src-address-list=scanners
`),
    });
    expect(ids(auditCategory("address_list_enforcement", s))).not.toContain(
      "unenforced_list:scanners",
    );
  });

  test("a drop with a NEGATED list match (!list) does not count as enforcing that list", () => {
    const g = buildListGraph(
      fw(`
 0  chain=input action=add-src-to-address-list psd=21,3s,3,1 address-list=scanners
 1  chain=input action=drop src-address-list=!scanners
`),
    );
    expect(effectivelyEnforced(g).has("scanners")).toBe(false);
  });

  test("adds a low-severity note when scan/DDoS detection lives entirely in filter, none in raw", () => {
    const s = state({ firewallFilter: fw(LADDER_AND_UNENFORCED), firewallRaw: [] });
    const note = auditCategory("address_list_enforcement", s).find(
      (x) => x.finding_id === "raw_table_usage:none",
    )!;
    expect(note).toBeDefined();
    expect(note.severity).toBe("low");
    expect(note.confidence).toBe("needs_live_verification");
  });

  test("does not add the raw-table note when raw rules already exist", () => {
    const s = state({
      firewallFilter: fw(LADDER_AND_UNENFORCED),
      firewallRaw: fw(` 0  chain=prerouting action=drop src-address-list=ssh_blacklist`),
    });
    expect(ids(auditCategory("address_list_enforcement", s))).not.toContain("raw_table_usage:none");
  });

  test("effectivelyEnforced resolves a multi-hop escalation chain transitively", () => {
    const g = buildListGraph(fw(LADDER_AND_UNENFORCED));
    const enforced = effectivelyEnforced(g);
    expect(enforced.has("ssh_stage1")).toBe(true);
    expect(enforced.has("ssh_blacklist")).toBe(true);
    expect(enforced.has("ddoser")).toBe(false);
  });
});

// ── 4.3  Kernel IP hardening ────────────────────────────────────────────────

describe("kernel_ip_hardening", () => {
  test("flags tcp-syncookies=no with a fix to enable it", () => {
    const s = state({ ipSettings: { "tcp-syncookies": "no" } });
    const f = auditCategory("kernel_ip_hardening", s).find(
      (x) => x.finding_id === "kernel:tcp-syncookies",
    )!;
    expect(f.fix![0]).toBe("/ip settings set tcp-syncookies=yes");
  });

  test("recommends rp-filter=strict on a single-WAN device", () => {
    const s = state({
      ipSettings: { "rp-filter": "no" },
      routes: [{ "dst-address": "0.0.0.0/0" }],
    });
    const f = auditCategory("kernel_ip_hardening", s).find(
      (x) => x.finding_id === "kernel:rp-filter",
    )!;
    expect(f.fix![0]).toBe("/ip settings set rp-filter=strict");
  });

  test("recommends rp-filter=loose on a multi-WAN device (asymmetric routing)", () => {
    const s = state({
      ipSettings: { "rp-filter": "no" },
      routes: [
        { "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" },
        { "dst-address": "0.0.0.0/0", gateway: "2.2.2.2" },
      ],
    });
    const f = auditCategory("kernel_ip_hardening", s).find(
      (x) => x.finding_id === "kernel:rp-filter",
    )!;
    expect(f.fix![0]).toBe("/ip settings set rp-filter=loose");
  });

  test("flags accept-source-route=yes as high severity", () => {
    const s = state({ ipSettings: { "accept-source-route": "yes" } });
    const f = auditCategory("kernel_ip_hardening", s).find(
      (x) => x.finding_id === "kernel:accept-source-route",
    )!;
    expect(f.severity).toBe("high");
    expect(f.fix![0]).toBe("/ip settings set accept-source-route=no");
  });

  test("flags accept-redirects=yes only on a multi-WAN device", () => {
    const single = state({
      ipSettings: { "accept-redirects": "yes" },
      routes: [{ "dst-address": "0.0.0.0/0" }],
    });
    expect(ids(auditCategory("kernel_ip_hardening", single))).not.toContain(
      "kernel:accept-redirects",
    );
    const dual = state({
      ipSettings: { "accept-redirects": "yes" },
      routes: [
        { "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" },
        { "dst-address": "0.0.0.0/0", gateway: "2.2.2.2" },
      ],
    });
    expect(ids(auditCategory("kernel_ip_hardening", dual))).toContain("kernel:accept-redirects");
  });

  test("flags the IPv6 accept-redirects equivalent", () => {
    const s = state({
      ipSettings: { "tcp-syncookies": "yes" },
      ipv6Settings: { "accept-redirects": "yes" },
    });
    expect(ids(auditCategory("kernel_ip_hardening", s))).toContain("kernel:ipv6-accept-redirects");
  });

  test("returns nothing when /ip settings was not readable (empty)", () => {
    expect(auditCategory("kernel_ip_hardening", state({}))).toHaveLength(0);
  });
});

// ── 4.4  IPv6 firewall baseline ─────────────────────────────────────────────

describe("ipv6_firewall_baseline", () => {
  test("marks the exposure needs_live_verification when no IPv6 address is assigned (latent)", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6Filter: [],
      ipv6AddressCount: 0,
    });
    const f = auditCategory("ipv6_firewall_baseline", s);
    expect(f.every((x) => x.confidence === "needs_live_verification")).toBe(true);
    expect(ids(f)).toContain("ipv6_baseline:bootstrap");
    expect(ids(f)).toContain("ipv6_baseline:disable");
  });

  test("marks the exposure proven when IPv6 addresses are assigned and no filter exists", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6Filter: [],
      ipv6AddressCount: 2,
    });
    const f = auditCategory("ipv6_firewall_baseline", s);
    expect(f.find((x) => x.finding_id === "ipv6_baseline:bootstrap")!.confidence).toBe("proven");
  });

  test("recommends disabling IPv6 (Option B) when zero addresses are in use", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6AddressCount: 0,
    });
    const disable = auditCategory("ipv6_firewall_baseline", s).find(
      (x) => x.finding_id === "ipv6_baseline:disable",
    )!;
    expect(disable.proposed).toContain("RECOMMENDED");
    expect(disable.fix![0]).toBe("/ipv6 settings set forward=no");
  });

  test("the two remediation options are mutually exclusive and labelled as such", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6AddressCount: 1,
    });
    const f = auditCategory("ipv6_firewall_baseline", s);
    expect(f).toHaveLength(2);
    expect(f.every((x) => (x.detail ?? "").includes("MUTUALLY EXCLUSIVE"))).toBe(true);
  });

  test("the bootstrap option keeps ICMPv6 and adds a default-deny per chain", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6AddressCount: 1,
    });
    const boot = auditCategory("ipv6_firewall_baseline", s).find(
      (x) => x.finding_id === "ipv6_baseline:bootstrap",
    )!;
    expect(boot.fix!.some((c) => c.includes("protocol=icmpv6"))).toBe(true);
    expect(
      boot.fix!.filter((c) => c.includes("action=drop") && !c.includes("connection-state")).length,
    ).toBe(2);
  });

  test("returns nothing when IPv6 is disabled and not forwarding", () => {
    const s = state({ ipv6Settings: { "disable-ipv6": "yes", forward: "no" } });
    expect(auditCategory("ipv6_firewall_baseline", s)).toHaveLength(0);
  });

  test("returns nothing when the IPv6 filter already has a default-deny on both chains", () => {
    const s = state({
      ipv6Settings: { "disable-ipv6": "no", forward: "yes" },
      ipv6Filter: fw(`
 0  chain=input action=accept connection-state=established,related,untracked
 1  chain=input action=drop
 2  chain=forward action=accept connection-state=established,related,untracked
 3  chain=forward action=drop
`),
      ipv6AddressCount: 2,
    });
    expect(auditCategory("ipv6_firewall_baseline", s)).toHaveLength(0);
  });
});

// ── 4.5  SSH hardening ──────────────────────────────────────────────────────

describe("ssh_hardening", () => {
  test("flags strong-crypto=no with an auto-fix", () => {
    const s = state({ ssh: { "strong-crypto": "no" } });
    const f = auditCategory("ssh_hardening", s).find((x) => x.finding_id === "ssh:strong-crypto")!;
    expect(f.severity).toBe("high");
    expect(f.fix![0]).toBe("/ip ssh set strong-crypto=yes");
  });

  test("flags a sub-2048-bit RSA host key as report-only (no auto-fix)", () => {
    const s = state({ ssh: { "host-key-type": "rsa", "host-key-size": "1024" } });
    const f = auditCategory("ssh_hardening", s).find((x) => x.finding_id === "ssh:host-key-size")!;
    expect(f.status).toBe("needs_manual_review");
    expect(f.fix).toBeUndefined();
  });

  test("flags always-allow-password-login=yes as needs_live_verification review", () => {
    const s = state({ ssh: { "always-allow-password-login": "yes" } });
    const f = auditCategory("ssh_hardening", s).find((x) => x.finding_id === "ssh:password-login")!;
    expect(f.confidence).toBe("needs_live_verification");
    expect(f.fix).toBeUndefined();
  });

  test("does not flag a 2048-bit RSA key", () => {
    const s = state({
      ssh: { "strong-crypto": "yes", "host-key-type": "rsa", "host-key-size": "2048" },
    });
    expect(ids(auditCategory("ssh_hardening", s))).not.toContain("ssh:host-key-size");
  });
});

// ── 4.6  IP service exposure ────────────────────────────────────────────────

describe("ip_service_exposure", () => {
  test("always flags an enabled telnet service and offers to disable it", () => {
    const s = state({ services: detail(` 0  name=telnet port=23 address=""`) });
    const f = auditCategory("ip_service_exposure", s).find(
      (x) => x.finding_id === "service:telnet",
    )!;
    expect(f.severity).toBe("high");
    expect(f.fix![0]).toBe("/ip service disable telnet");
  });

  test("flags an unrestricted service that no firewall rule scopes", () => {
    const s = state({ services: detail(` 0  name=www port=80 address=""`) });
    expect(ids(auditCategory("ip_service_exposure", s))).toContain("service:www");
  });

  test("does NOT flag a service whose port is firewall-restricted to a trusted list (Winbox case)", () => {
    const s = state({
      services: detail(` 0  name=winbox port=8291 address=""`),
      firewallFilter: fw(`
 0  chain=input action=accept protocol=tcp dst-port=8291 src-address-list=trusted
 1  chain=input action=drop protocol=tcp dst-port=8291
`),
    });
    expect(ids(auditCategory("ip_service_exposure", s))).not.toContain("service:winbox");
  });

  test("flags an enabled reverse-proxy with address='' as needs_live_verification", () => {
    const s = state({ services: detail(` 0  name=reverse-proxy port=443 address=""`) });
    const f = auditCategory("ip_service_exposure", s).find(
      (x) => x.finding_id === "service:reverse-proxy",
    )!;
    expect(f.confidence).toBe("needs_live_verification");
  });

  test("ignores a disabled service", () => {
    const s = state({
      services: detail(`
Flags: X - disabled
 0 X  name=www port=80 address=""
`),
    });
    expect(auditCategory("ip_service_exposure", s)).toHaveLength(0);
  });

  test("ignores a service that already carries a service-level address restriction", () => {
    const s = state({ services: detail(` 0  name=ssh port=22 address=192.168.0.0/16`) });
    expect(auditCategory("ip_service_exposure", s)).toHaveLength(0);
  });
});

describe("servicePortRestricted", () => {
  test("is true when an input rule scopes the port to a source address-list", () => {
    const rules = fw(
      ` 0  chain=input action=accept protocol=tcp dst-port=22 src-address-list=trusted`,
    );
    expect(servicePortRestricted("22", rules)).toBe(true);
  });

  test("is false when the matching rule carries no source scope", () => {
    const rules = fw(` 0  chain=input action=accept protocol=tcp dst-port=22`);
    expect(servicePortRestricted("22", rules)).toBe(false);
  });

  test("is false for a rule in a non-input chain", () => {
    const rules = fw(
      ` 0  chain=forward action=accept protocol=tcp dst-port=22 src-address=10.0.0.0/8`,
    );
    expect(servicePortRestricted("22", rules)).toBe(false);
  });
});

// ── 4.7  Connection-tracking helpers ────────────────────────────────────────

describe("connection_tracking_helpers", () => {
  test("auto-fixes an enabled pptp helper when no pptp server or client exists", () => {
    const s = state({ servicePorts: detail(` 0  name=pptp`) });
    const f = auditCategory("connection_tracking_helpers", s).find(
      (x) => x.finding_id === "helper:pptp",
    )!;
    expect(f.fix![0]).toBe("/ip firewall service-port disable pptp");
  });

  test("does not flag pptp helper when a pptp-server is enabled", () => {
    const s = state({ servicePorts: detail(` 0  name=pptp`), pptpServer: { enabled: "yes" } });
    expect(ids(auditCategory("connection_tracking_helpers", s))).not.toContain("helper:pptp");
  });

  test("flags h323/sip helpers as manual review (no auto-fix)", () => {
    const s = state({
      servicePorts: detail(`
 0  name=h323
 1  name=sip
`),
    });
    const f = auditCategory("connection_tracking_helpers", s);
    expect(f.find((x) => x.finding_id === "helper:h323")!.status).toBe("needs_manual_review");
    expect(f.find((x) => x.finding_id === "helper:sip")!.fix).toBeUndefined();
  });

  test("ignores a disabled helper", () => {
    const s = state({
      servicePorts: detail(`
Flags: X - disabled
 0 X  name=h323
`),
    });
    expect(auditCategory("connection_tracking_helpers", s)).toHaveLength(0);
  });

  test("ignores helpers not on the suspect list (e.g. ftp)", () => {
    const s = state({ servicePorts: detail(` 0  name=ftp`) });
    expect(auditCategory("connection_tracking_helpers", s)).toHaveLength(0);
  });
});

// ── 4.8  Management-plane exposure ──────────────────────────────────────────

describe("management_plane_exposure", () => {
  test("flags mac-server allowed-interface-list=all as report-only", () => {
    const s = state({ macServer: { "allowed-interface-list": "all" } });
    const f = auditCategory("management_plane_exposure", s).find(
      (x) => x.finding_id === "mgmt:mac-server",
    )!;
    expect(f.status).toBe("needs_manual_review");
    expect(f.fix).toBeUndefined();
  });

  test("auto-fixes an unrestricted, enabled bandwidth-server", () => {
    const s = state({ bandwidthServer: { enabled: "yes", "allowed-addresses4": "" } });
    const f = auditCategory("management_plane_exposure", s).find(
      (x) => x.finding_id === "mgmt:bandwidth-server",
    )!;
    expect(f.fix![0]).toBe("/tool bandwidth-server set enabled=no");
  });

  test("flags an enabled romon as informational manual review", () => {
    const s = state({ romon: { enabled: "yes" } });
    expect(ids(auditCategory("management_plane_exposure", s))).toContain("mgmt:romon");
  });

  test("flags a default-named SNMP community with open addresses even while SNMP is off", () => {
    const s = state({
      snmp: { enabled: "no" },
      snmpCommunity: detail(` 0  name=public addresses=::/0`),
    });
    expect(ids(auditCategory("management_plane_exposure", s))).toContain(
      "mgmt:snmp-community:public",
    );
  });

  test("flags neighbor discovery scoped to all/static for live verification", () => {
    const s = state({ discoverySettings: { "discover-interface-list": "all" } });
    const f = auditCategory("management_plane_exposure", s).find(
      (x) => x.finding_id === "mgmt:neighbor-discovery",
    )!;
    expect(f.confidence).toBe("needs_live_verification");
  });
});

// ── 4.9  Account hygiene ────────────────────────────────────────────────────

describe("account_hygiene", () => {
  test("flags a minimum-password-length below 12 with a narrow auto-fix", () => {
    const s = state({ userSettings: { "minimum-password-length": "8" } });
    const f = auditCategory("account_hygiene", s).find(
      (x) => x.finding_id === "account:min-password-length",
    )!;
    expect(f.fix![0]).toBe("/user settings set minimum-password-length=12");
  });

  test("flags minimum-categories below 3", () => {
    const s = state({ userSettings: { "minimum-categories": "1" } });
    expect(ids(auditCategory("account_hygiene", s))).toContain("account:min-categories");
  });

  test("flags an enabled suspiciously-named account as manual review (never auto-deleted)", () => {
    const s = state({ users: detail(` 0  name=test group=full disabled=no`) });
    const f = auditCategory("account_hygiene", s).find((x) =>
      x.finding_id.startsWith("account:suspicious"),
    )!;
    expect(f.status).toBe("needs_manual_review");
    expect(f.fix).toBeUndefined();
  });

  test("flags a literal 'admin' username", () => {
    const s = state({ users: detail(` 0  name=admin group=full disabled=no`) });
    expect(ids(auditCategory("account_hygiene", s)).some((i) => i.includes("admin"))).toBe(true);
  });

  test("does not flag a disabled suspicious account", () => {
    const s = state({
      users: detail(`
Flags: X - disabled
 0 X  name=guest disabled=yes
`),
    });
    expect(
      ids(auditCategory("account_hygiene", s)).some((i) => i.startsWith("account:suspicious")),
    ).toBe(false);
  });

  test("flags a read-tier group granted broad protocol access as a review item", () => {
    const s = state({
      userGroups: detail(` 0  name=readonly policy=ssh,winbox,api,read,test`),
    });
    const f = auditCategory("account_hygiene", s).find((x) =>
      x.finding_id.startsWith("account:group-policy"),
    )!;
    expect(f.status).toBe("needs_manual_review");
  });
});

// ── 4.10  Certificate hygiene ───────────────────────────────────────────────

describe("certificate_hygiene", () => {
  test("flags crl-use=no when a cert-verifying OpenVPN server is in use", () => {
    const s = state({
      certSettings: { "crl-use": "no", "crl-download": "no" },
      ovpnServers: detail(` 0  require-client-certificate=yes`),
    });
    const f = auditCategory("certificate_hygiene", s).find(
      (x) => x.finding_id === "cert:crl-policy",
    )!;
    expect(f.fix![0]).toBe("/certificate settings set crl-use=yes crl-download=yes");
  });

  test("returns nothing when no cert-based service is in use", () => {
    const s = state({ certSettings: { "crl-use": "no" } });
    expect(auditCategory("certificate_hygiene", s)).toHaveLength(0);
  });

  test("returns nothing when CRL checking is already on", () => {
    const s = state({
      certSettings: { "crl-use": "yes", "crl-download": "yes" },
      ovpnServers: detail(` 0  require-client-certificate=yes`),
    });
    expect(auditCategory("certificate_hygiene", s)).toHaveLength(0);
  });
});

// ── 4.11  Network segmentation ──────────────────────────────────────────────

describe("network_segmentation", () => {
  test("flags a single physical interface carrying a server subnet and a DHCP client pool", () => {
    const s = state({
      ipAddresses: detail(`
 0  address=10.0.0.1/24 interface=ether1
 1  address=192.168.1.1/24 interface=ether1
`),
      dhcpNetworks: detail(` 0  address=192.168.1.0/24 dns-server=192.168.1.1`),
    });
    const f = auditCategory("network_segmentation", s).find(
      (x) => x.finding_id === "segmentation:ether1",
    )!;
    expect(f).toBeDefined();
    expect(f.status).toBe("needs_manual_review");
    expect(f.fix).toBeUndefined();
    // Topology fact proven; isolation claim explicitly needs_live_verification.
    expect(f.detail).toContain("TOPOLOGY FACT (proven)");
    expect(f.detail).toContain("needs_live_verification");
  });

  test("does NOT flag a VLAN-segmented topology (addresses live on VLAN interfaces)", () => {
    const s = state({
      bridges: detail(` 0  name=bridge`),
      vlans: detail(`
 0  name=vlan10 interface=bridge vlan-id=10
 1  name=vlan20 interface=bridge vlan-id=20
`),
      ipAddresses: detail(`
 0  address=10.0.0.1/24 interface=vlan10
 1  address=192.168.1.1/24 interface=vlan20
`),
      dhcpNetworks: detail(` 0  address=192.168.1.0/24`),
    });
    expect(auditCategory("network_segmentation", s)).toHaveLength(0);
  });

  test("does not flag a physical interface with a single subnet", () => {
    const s = state({ ipAddresses: detail(` 0  address=192.168.1.1/24 interface=ether1`) });
    expect(auditCategory("network_segmentation", s)).toHaveLength(0);
  });
});

// ── 4.12  DNS resolver exposure ─────────────────────────────────────────────

describe("dns_resolver_exposure", () => {
  test("flags an open resolver with neither transport restricted", () => {
    const s = state({ dns: { "allow-remote-requests": "yes" } });
    const f = auditCategory("dns_resolver_exposure", s).find(
      (x) => x.finding_id === "dns:remote-requests",
    )!;
    expect(f.severity).toBe("high");
  });

  test("still flags when only UDP/53 is restricted but TCP/53 is not (field trap)", () => {
    const s = state({
      dns: { "allow-remote-requests": "yes" },
      firewallFilter: fw(
        ` 0  chain=input action=drop protocol=udp dst-port=53 src-address-list=!trusted`,
      ),
    });
    // The UDP rule has a source scope, but TCP/53 is unrestricted → still flagged.
    expect(ids(auditCategory("dns_resolver_exposure", s))).toContain("dns:remote-requests");
  });

  test("recommends disabling remote requests when the router serves its own DHCP clients", () => {
    const s = state({
      dns: { "allow-remote-requests": "yes" },
      dhcpNetworks: detail(` 0  address=192.168.1.0/24 dns-server=192.168.1.1`),
    });
    const f = auditCategory("dns_resolver_exposure", s).find(
      (x) => x.finding_id === "dns:remote-requests",
    )!;
    expect(f.fix![0]).toBe("/ip dns set allow-remote-requests=no");
  });

  test("returns nothing when allow-remote-requests is off", () => {
    expect(
      auditCategory("dns_resolver_exposure", state({ dns: { "allow-remote-requests": "no" } })),
    ).toHaveLength(0);
  });

  test("returns nothing when both TCP and UDP port 53 are restricted", () => {
    const s = state({
      dns: { "allow-remote-requests": "yes" },
      firewallFilter: fw(`
 0  chain=input action=accept protocol=udp dst-port=53 src-address-list=trusted
 1  chain=input action=accept protocol=tcp dst-port=53 src-address-list=trusted
`),
    });
    expect(auditCategory("dns_resolver_exposure", s)).toHaveLength(0);
  });
});

// ── Orchestrator + idempotency ──────────────────────────────────────────────

describe("runSecurityHardeningAudit", () => {
  test("an already-hardened router produces ZERO findings across every category", () => {
    const report = runSecurityHardeningAudit(hardenedState());
    expect(report.total).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  test("ranks findings critical-first and tallies the summary", () => {
    const s = state({
      firewallFilter: fw(` 0  chain=input action=accept`),
      ipSettings: { "tcp-syncookies": "no" },
    });
    const report = runSecurityHardeningAudit(s);
    expect(report.findings[0].severity).toBe("critical");
    expect(report.summary.critical).toBeGreaterThanOrEqual(1);
    expect(report.total).toBe(report.findings.length);
  });

  test("honours a category filter", () => {
    const s = state({
      ipSettings: { "tcp-syncookies": "no" },
      dns: { "allow-remote-requests": "yes" },
    });
    const report = runSecurityHardeningAudit(s, ["kernel_ip_hardening"]);
    expect(report.findings.every((f) => f.category === "kernel_ip_hardening")).toBe(true);
  });

  test("renders a clean-pass report for zero findings", () => {
    const text = renderHardeningReport(runSecurityHardeningAudit(hardenedState()), "test-router");
    expect(text).toContain("No findings");
  });

  test("renders confidence and finding_id in the report body", () => {
    const s = state({ dns: { "allow-remote-requests": "yes" } });
    const text = renderHardeningReport(runSecurityHardeningAudit(s), "test-router");
    expect(text).toContain("id=dns:remote-requests");
    expect(text).toContain("confidence=");
  });
});

// ── Tool-layer helpers ──────────────────────────────────────────────────────

const SAMPLE_FINDINGS: Finding[] = [
  {
    finding_id: "default_deny:input",
    category: "firewall_default_deny",
    severity: "critical",
    confidence: "proven",
    status: "fail",
    title: "x",
    target: "t",
    current: "c",
    proposed: "p",
    fix: ["/ip firewall filter add chain=input action=drop"],
  },
  {
    finding_id: "service:www",
    category: "ip_service_exposure",
    severity: "high",
    confidence: "needs_live_verification",
    status: "fail",
    title: "x",
    target: "t",
    current: "c",
    proposed: "p",
    fix: ["/ip service set www address=192.168.0.0/16"],
  },
  {
    finding_id: "account:suspicious:/user:test",
    category: "account_hygiene",
    severity: "high",
    confidence: "proven",
    status: "needs_manual_review",
    title: "x",
    target: "t",
    current: "c",
    proposed: "p",
    // no fix — manual review
  },
];

describe("selectFindings", () => {
  test("selects only requested ids that carry an automated fix", () => {
    const { selected } = selectFindings(SAMPLE_FINDINGS, ["default_deny:input"]);
    expect(selected.map((f) => f.finding_id)).toEqual(["default_deny:input"]);
  });

  test("reports an unknown finding_id instead of throwing", () => {
    const { unknown, selected } = selectFindings(SAMPLE_FINDINGS, ["does_not_exist"]);
    expect(unknown).toEqual(["does_not_exist"]);
    expect(selected).toHaveLength(0);
  });

  test("routes a manual-review finding (no fix) to skippedManual, not selected", () => {
    const { selected, skippedManual } = selectFindings(SAMPLE_FINDINGS, [
      "account:suspicious:/user:test",
    ]);
    expect(selected).toHaveLength(0);
    expect(skippedManual).toEqual(["account:suspicious:/user:test"]);
  });

  test("honours a gate predicate (fix_password_policy narrowing)", () => {
    const found: Finding[] = [
      {
        ...SAMPLE_FINDINGS[0],
        finding_id: "account:min-password-length",
        category: "account_hygiene",
      },
      { ...SAMPLE_FINDINGS[0], finding_id: "account:something-else", category: "account_hygiene" },
    ];
    const gate = (f: Finding): boolean => f.finding_id.startsWith("account:min-");
    const { selected, unknown } = selectFindings(
      found,
      ["account:min-password-length", "account:something-else"],
      gate,
    );
    expect(selected.map((f) => f.finding_id)).toEqual(["account:min-password-length"]);
    expect(unknown).toEqual(["account:something-else"]);
  });
});

describe("orderFindingsForApply", () => {
  test("orders firewall default-deny before service exposure before account hygiene", () => {
    const ordered = orderFindingsForApply([
      SAMPLE_FINDINGS[1],
      SAMPLE_FINDINGS[2],
      SAMPLE_FINDINGS[0],
    ]);
    expect(ordered.map((f) => f.category)).toEqual([
      "firewall_default_deny",
      "ip_service_exposure",
      "account_hygiene",
    ]);
  });
});

// ── Parser robustness ───────────────────────────────────────────────────────

describe("parser robustness", () => {
  test("handles a print with wrapped continuation lines without throwing", () => {
    const rules = fw(`
Flags: X - disabled, D - dynamic
 0    chain=input action=accept comment="allow established"
      connection-state=established,related,untracked protocol=tcp
 1    chain=input action=drop
`);
    expect(rules).toHaveLength(2);
    expect(rules[0].match["connection-state"]).toContain("established");
    // A wrapped, fully-parsed chain with a final drop still audits clean.
    expect(
      auditCategory("firewall_default_deny", state({ firewallFilter: rules })),
    ).not.toContainEqual(expect.objectContaining({ finding_id: "default_deny:input" }));
  });

  test("tolerates a rule row missing its action field", () => {
    const rules = fw(` 0  chain=input protocol=tcp dst-port=22`);
    expect(() =>
      auditCategory("firewall_default_deny", state({ firewallFilter: rules })),
    ).not.toThrow();
  });

  test("tolerates empty / unreadable command output for every category", () => {
    const empty = emptySecurityState();
    for (const cat of [
      "firewall_default_deny",
      "address_list_enforcement",
      "kernel_ip_hardening",
      "ipv6_firewall_baseline",
      "ssh_hardening",
      "ip_service_exposure",
      "connection_tracking_helpers",
      "management_plane_exposure",
      "account_hygiene",
      "certificate_hygiene",
      "network_segmentation",
      "dns_resolver_exposure",
    ] as const) {
      expect(() => auditCategory(cat, empty)).not.toThrow();
    }
  });
});
