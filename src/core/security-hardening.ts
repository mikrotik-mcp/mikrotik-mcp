/**
 * Security-Hardening engine — pure analysis, zero device I/O.
 *
 * ── Introduction ────────────────────────────────────────────────────────────
 * This module implements the detection half of the Security-Hardening suite: a
 * set of RouterOS 7.x security checks distilled from a manual audit of a real
 * production small-office router (hAP ax3, dual-WAN, RouterOS 7.23). Each check
 * targets a concrete class of misconfiguration that leaves a router exposed —
 * a firewall chain with no enforced default-deny, address-lists that are
 * populated but never blocked, kernel IP settings that permit spoofing, an
 * IPv6 stack that forwards with no filter, weak SSH crypto, management services
 * reachable from the internet, connection-tracking helpers with no matching
 * service, and so on. The checks are written to run against ANY device this MCP
 * manages, not the one router they were discovered on.
 *
 * ── Implementation ──────────────────────────────────────────────────────────
 * The engine is intentionally free of any `connector.ts` import so it stays
 * unit-testable without a live device: the tool layer
 * (`src/tools/security-hardening.ts`) fetches the {@link DeviceSecurityState}
 * and hands it here. Every auditor returns {@link Finding} objects — one per
 * problem, none for a clean device. A finding carries its own remediation
 * commands (`fix`), so detection and remediation live together (DRY): the fix
 * tools re-run the audit, filter by `finding_id`, and execute `fix`.
 *
 * Firewall parsing/matching reuses the battle-tested normaliser from
 * `firewall-audit.ts` ({@link rulesFromRows}, {@link cidrContains}); the
 * cross-rule matching helpers here (address-list producer/consumer graph,
 * chain-ordered default-deny analysis, service-port firewall cross-reference)
 * are the only firewall logic this module adds, and they are shared across
 * every auditor rather than duplicated per check.
 *
 * ── Analysis ────────────────────────────────────────────────────────────────
 * The design mirrors `compliance-checks.ts` (a proven pattern in this repo):
 * pure engine + thin tool layer. The key departure is the `confidence` axis.
 * Some findings are PROVEN from static config alone (e.g. `tcp-syncookies=no`
 * is unambiguous). Others are latent or depend on runtime chain/NAT interaction
 * that static config cannot fully settle (e.g. an IPv6 forward-enabled stack
 * with no address assigned yet, or whether a firewall rule actually shadows a
 * service). Those are tagged `needs_live_verification` in both the code and the
 * output, and NEVER blended with proven findings. This honours the rule that a
 * finding must never be reported as certain when it rests on interaction the
 * config can't prove.
 *
 * ── Testing ─────────────────────────────────────────────────────────────────
 * `tests/core/security-hardening.spec.ts` drives this engine with realistic
 * RouterOS fixtures built from the field patterns — the "accept-then-disabled-
 * drop" Winbox trap, populated-but-unenforced scanner lists next to a correctly
 * enforced staged SSH blacklist ladder, an already-hardened router (must yield
 * zero findings — the idempotency guarantee), single- vs dual-WAN rp-filter
 * branches, IPv6 latent-vs-active exposure, and segmented-vs-flat topology.
 */
import { cidrContains } from "./firewall-audit";
import type { FirewallRule } from "./firewall-audit";
import { isYes } from "../utils/yes";

// ── Core result types ───────────────────────────────────────────────────────

/**
 * Whether a finding is settled by static config alone (`proven`) or rests on
 * runtime behaviour the config can't fully determine (`needs_live_verification`).
 * This is surfaced verbatim in tool output so a proven and a speculative finding
 * are never presented with the same certainty.
 */
export type Confidence = "proven" | "needs_live_verification";

/**
 * A finding's disposition. `fail` — a concrete misconfiguration with (usually)
 * an automated fix. `needs_manual_review` — a real risk whose remediation is a
 * human/business decision (account deletion, group policy, VLAN topology) and is
 * never auto-applied. (`pass`/`not_applicable` are represented by the ABSENCE of
 * a finding; a clean device yields an empty findings list.)
 */
export type FindingStatus = "fail" | "needs_manual_review";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** The twelve audit categories, each a tool-facing slug. */
export const HARDENING_CATEGORIES = [
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
] as const;

export type HardeningCategory = (typeof HARDENING_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<HardeningCategory, string> = {
  firewall_default_deny: "Firewall Default-Deny",
  address_list_enforcement: "Address-List Enforcement",
  kernel_ip_hardening: "Kernel IP Hardening",
  ipv6_firewall_baseline: "IPv6 Firewall Baseline",
  ssh_hardening: "SSH Hardening",
  ip_service_exposure: "IP Service Exposure",
  connection_tracking_helpers: "Connection-Tracking Helpers",
  management_plane_exposure: "Management-Plane Exposure",
  account_hygiene: "Account Hygiene",
  certificate_hygiene: "Certificate Hygiene",
  network_segmentation: "Network Segmentation",
  dns_resolver_exposure: "DNS Resolver Exposure",
};

/**
 * One evidence-based finding. Every finding names the exact RouterOS `.id` or a
 * reconstructed rule signature it applies to (`target`), the literal current
 * value (`current`), the proposed value/action (`proposed`), a `confidence`, and
 * — when it is safe to automate — the exact `fix` commands. Findings with no
 * `fix` are `needs_manual_review`.
 */
export interface Finding {
  /** Stable across runs for the same config, so a fix call can name it later. */
  finding_id: string;
  category: HardeningCategory;
  severity: Severity;
  confidence: Confidence;
  status: FindingStatus;
  title: string;
  /** The `.id`, list name, service name, or reconstructed rule signature. */
  target: string;
  /** Literal current value/state observed. */
  current: string;
  /** Proposed value or action. */
  proposed: string;
  /** Extra human-readable context (RouterOS quirks, speculative labels, options). */
  detail?: string;
  /**
   * RouterOS commands that remediate this finding. Absent for report-only /
   * manual-review findings. Present findings are what the fix tools execute.
   */
  fix?: string[];
}

export interface HardeningReport {
  findings: Finding[];
  summary: Record<Severity, number>;
  /** Total findings across every requested category. */
  total: number;
}

/** Comment prefix stamped on every rule this suite creates (for audit/rollback). */
export const HARDENING_TAG = "security-hardening";

// ── Device state (populated by the tool layer) ──────────────────────────────

/**
 * Everything the engine needs, already fetched and parsed by the tool layer.
 * Firewall tables are pre-normalised through {@link rulesFromRows}; singleton
 * `print` outputs are `key → value` maps; multi-row prints are arrays of maps.
 */
export interface DeviceSecurityState {
  firewallFilter: FirewallRule[];
  firewallRaw: FirewallRule[];
  ipv6Filter: FirewallRule[];
  ipSettings: Record<string, string>;
  ipv6Settings: Record<string, string>;
  /** Count of assigned IPv6 addresses (`/ipv6 address print count-only`). */
  ipv6AddressCount: number;
  /** Active default routes (`dst-address=0.0.0.0/0`) — for multi-WAN detection. */
  routes: Record<string, string>[];
  ssh: Record<string, string>;
  services: Record<string, string>[];
  servicePorts: Record<string, string>[];
  macServer: Record<string, string>;
  macWinbox: Record<string, string>;
  bandwidthServer: Record<string, string>;
  romon: Record<string, string>;
  discoverySettings: Record<string, string>;
  snmp: Record<string, string>;
  snmpCommunity: Record<string, string>[];
  userSettings: Record<string, string>;
  users: Record<string, string>[];
  pppSecrets: Record<string, string>[];
  userManagerUsers: Record<string, string>[];
  userGroups: Record<string, string>[];
  certSettings: Record<string, string>;
  ovpnServers: Record<string, string>[];
  ovpnClients: Record<string, string>[];
  sstpClients: Record<string, string>[];
  dns: Record<string, string>;
  dhcpNetworks: Record<string, string>[];
  ipAddresses: Record<string, string>[];
  bridges: Record<string, string>[];
  vlans: Record<string, string>[];
  bridgeVlans: Record<string, string>[];
  bridgeSettings: Record<string, string>;
  interfaces: Record<string, string>[];
  pptpServer: Record<string, string>;
  pptpClients: Record<string, string>[];
}

/** An empty state — every slice absent. Handy for tests and partial audits. */
export function emptySecurityState(): DeviceSecurityState {
  return {
    firewallFilter: [],
    firewallRaw: [],
    ipv6Filter: [],
    ipSettings: {},
    ipv6Settings: {},
    ipv6AddressCount: 0,
    routes: [],
    ssh: {},
    services: [],
    servicePorts: [],
    macServer: {},
    macWinbox: {},
    bandwidthServer: {},
    romon: {},
    discoverySettings: {},
    snmp: {},
    snmpCommunity: [],
    userSettings: {},
    users: [],
    pppSecrets: [],
    userManagerUsers: [],
    userGroups: [],
    certSettings: {},
    ovpnServers: [],
    ovpnClients: [],
    sstpClients: [],
    dns: {},
    dhcpNetworks: [],
    ipAddresses: [],
    bridges: [],
    vlans: [],
    bridgeVlans: [],
    bridgeSettings: {},
    interfaces: [],
    pptpServer: {},
    pptpClients: [],
  };
}

// ── Shared low-level helpers ────────────────────────────────────────────────

const CATCH_ALL_ADDR = new Set(["0.0.0.0/0", "::/0"]);
const TERMINAL_DROP = new Set(["drop", "reject", "tarpit"]);

/**
 * Re-exported so existing importers keep working; the implementation now lives
 * in `src/utils/yes.ts` as the single copy.
 */
export { isYes };

/** True when a rule matches every packet (no conditions, or only catch-all addrs). */
export function matchesAll(rule: FirewallRule): boolean {
  for (const [k, v] of Object.entries(rule.match)) {
    if ((k === "src-address" || k === "dst-address") && CATCH_ALL_ADDR.has(v)) continue;
    return false;
  }
  return true;
}

/** Group rules by chain in their printed order. */
export function indexByChain(rules: FirewallRule[]): Map<string, FirewallRule[]> {
  const byChain = new Map<string, FirewallRule[]>();
  for (const r of rules) {
    let list = byChain.get(r.chain);
    if (!list) {
      list = [];
      byChain.set(r.chain, list);
    }
    list.push(r);
  }
  return byChain;
}

/**
 * Build a RouterOS `where` clause fragment that uniquely (enough) identifies a
 * rule for a `[find …]` remediation, from its most distinctive match fields.
 * Used when we must re-enable/insert relative to a rule whose `.id`/ordinal is
 * unstable across runs. Values are emitted bare (they come from `print` and are
 * already device-side tokens).
 */
export function ruleSignature(rule: FirewallRule): string {
  const parts = [`chain=${rule.chain}`, `action=${rule.action}`];
  for (const k of ["protocol", "dst-port", "src-port", "dst-address-list", "src-address-list"]) {
    if (rule.match[k]) parts.push(`${k}=${rule.match[k]}`);
  }
  return parts.join(" ");
}

// ── 4.1  Firewall default-deny ──────────────────────────────────────────────

/**
 * Analyse one chain's default-deny posture.
 *
 * `enabledDefaultDeny` — an ACTIVE unconditional drop/reject exists (the chain is
 * genuinely closed). `disabledEnforcementDrops` — drop/reject rules that are
 * DISABLED yet sit immediately after an `accept` sharing their port/protocol:
 * the "accept-then-disabled-drop" trap — the chain looks protected but the drop
 * is off, so everything falls through. This is a distinct, more severe finding
 * than "no default-deny at all".
 */
export function analyzeChainDefaultDeny(chainRules: FirewallRule[]): {
  enabledDefaultDeny: boolean;
  disabledEnforcementDrops: FirewallRule[];
  hasEstablishedAccept: boolean;
  hasInvalidDrop: boolean;
} {
  const active = chainRules.filter((r) => !r.disabled && !r.dynamic);
  const enabledDefaultDeny = active.some((r) => TERMINAL_DROP.has(r.action) && matchesAll(r));
  const hasEstablishedAccept = active.some(
    (r) => r.action === "accept" && /established/.test(r.match["connection-state"] ?? ""),
  );
  const hasInvalidDrop = active.some(
    (r) => r.action === "drop" && (r.match["connection-state"] ?? "") === "invalid",
  );

  // Find disabled drop/reject rules preceded (in printed order, disabled rules
  // included) by an accept rule sharing dst-port or protocol — the field trap.
  const disabledEnforcementDrops: FirewallRule[] = [];
  for (let i = 0; i < chainRules.length; i++) {
    const r = chainRules[i];
    if (!(r.disabled && TERMINAL_DROP.has(r.action))) continue;
    const prev = chainRules[i - 1];
    if (!prev || prev.action !== "accept") continue;
    const samePort = prev.match["dst-port"] && prev.match["dst-port"] === r.match["dst-port"];
    const sameProto = prev.match.protocol && prev.match.protocol === r.match.protocol;
    if (samePort || sameProto) disabledEnforcementDrops.push(r);
  }
  return { enabledDefaultDeny, disabledEnforcementDrops, hasEstablishedAccept, hasInvalidDrop };
}

function auditDefaultDeny(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  const byChain = indexByChain(state.firewallFilter);

  for (const chain of ["input", "forward"] as const) {
    const rules = byChain.get(chain) ?? [];
    // An empty chain is a "no default-deny" finding too (RouterOS default policy
    // is ACCEPT), but a device with a zero-rule filter is better served by the
    // broader firewall_audit — still, flag the gap here for completeness.
    const a = analyzeChainDefaultDeny(rules);

    // Distinct, higher-severity finding: a disabled catch-all/port drop that
    // makes the chain LOOK protected. Individually confirmable (separate id).
    for (const drop of a.disabledEnforcementDrops) {
      findings.push({
        finding_id: `disabled_enforcement:${chain}:${drop.index}`,
        category: "firewall_default_deny",
        severity: "critical",
        confidence: "proven",
        status: "fail",
        title: `Disabled enforcement drop in ${chain} chain`,
        target: `${chain} rule #${drop.index} (${ruleSignature(drop)})`,
        current: "disabled=yes — the drop does not run, so the preceding accept has no backstop",
        proposed: "re-enable the drop rule",
        detail:
          "The chain appears protected (an accept is followed by a matching drop) but the drop " +
          "is disabled=yes, so unmatched traffic falls through. Re-enabling is offered separately " +
          "from inserting a new default-deny because an admin may have disabled it deliberately.",
        fix: [`/ip firewall filter enable [find ${ruleSignature(drop)} disabled=yes]`],
      });
    }

    if (!a.enabledDefaultDeny) {
      // Build only the missing tail rules so a re-run (after applying) finds
      // nothing and adds nothing — idempotency comes from the audit gate, not
      // from the add command (RouterOS `add` is not itself idempotent).
      const fix: string[] = [];
      if (!a.hasEstablishedAccept) {
        fix.push(
          `/ip firewall filter add chain=${chain} action=accept ` +
            `connection-state=established,related,untracked ` +
            `comment="${HARDENING_TAG}: accept established/related/untracked"`,
        );
      }
      if (!a.hasInvalidDrop) {
        fix.push(
          `/ip firewall filter add chain=${chain} action=drop connection-state=invalid ` +
            `comment="${HARDENING_TAG}: drop invalid"`,
        );
      }
      fix.push(
        `/ip firewall filter add chain=${chain} action=drop ` +
          `comment="${HARDENING_TAG}: default deny ${chain}"`,
      );
      findings.push({
        finding_id: `default_deny:${chain}`,
        category: "firewall_default_deny",
        severity: chain === "input" ? "critical" : "high",
        confidence: "proven",
        status: "fail",
        title: `No enforced default-deny on ${chain} chain`,
        target: `/ip firewall filter chain=${chain}`,
        current:
          rules.length === 0
            ? "chain is empty — RouterOS default policy is ACCEPT"
            : "no final unconditional drop/reject; unmatched traffic is ACCEPTED",
        proposed:
          "append accept established/related/untracked → drop invalid → final unconditional drop",
        fix,
      });
    }
  }
  return findings;
}

// ── 4.2  Address-list enforcement ───────────────────────────────────────────

interface ListGraph {
  /** Lists that are targets of add-src/dst-to-address-list (populated). */
  produced: Set<string>;
  /** Lists referenced positively by a drop/reject/tarpit rule (directly enforced). */
  directlyEnforced: Set<string>;
  /** Escalation edges A → B: "being in A leads to being added to B". */
  edges: Map<string, Set<string>>;
  /** Whether the list is a src- or dst- list (drives the enforcement rule shape). */
  side: Map<string, "src" | "dst">;
  /** Chain a list was populated in (for the enforcement rule we generate). */
  chain: Map<string, string>;
}

/** Strip a leading `!` (RouterOS negation) from an address-list match value. */
function positiveList(value: string | undefined): { name: string; negated: boolean } | null {
  if (!value) return null;
  const negated = value.startsWith("!");
  const name = negated ? value.slice(1) : value;
  return name ? { name, negated } : null;
}

/** Build the producer/consumer graph across filter + raw tables. */
export function buildListGraph(rules: FirewallRule[]): ListGraph {
  const g: ListGraph = {
    produced: new Set(),
    directlyEnforced: new Set(),
    edges: new Map(),
    side: new Map(),
    chain: new Map(),
  };
  for (const r of rules) {
    if (r.disabled || r.dynamic) continue;
    const target = r.transform["address-list"];
    const isAdd = r.action === "add-src-to-address-list" || r.action === "add-dst-to-address-list";
    if (isAdd && target) {
      g.produced.add(target);
      g.side.set(target, r.action === "add-src-to-address-list" ? "src" : "dst");
      if (!g.chain.has(target)) g.chain.set(target, r.chain);
      // Escalation edge: this add rule is gated on membership of another list.
      const from =
        positiveList(r.match["src-address-list"]) ?? positiveList(r.match["dst-address-list"]);
      if (from && !from.negated) {
        let set = g.edges.get(from.name);
        if (!set) {
          set = new Set();
          g.edges.set(from.name, set);
        }
        set.add(target);
      }
    }
    // Direct enforcement: a terminal drop that positively matches a list.
    if (TERMINAL_DROP.has(r.action)) {
      for (const key of ["src-address-list", "dst-address-list"]) {
        const ref = positiveList(r.match[key]);
        if (ref && !ref.negated) g.directlyEnforced.add(ref.name);
      }
    }
  }
  return g;
}

/**
 * A list is EFFECTIVELY enforced if it is directly matched by a drop, or it
 * escalates (transitively) into a list that is. Fixpoint over the edge set.
 * The staged `stage1→stage2→stage3→blacklist` ladder is fully enforced when
 * `blacklist` has a drop — so none of the stages are flagged.
 */
export function effectivelyEnforced(g: ListGraph): Set<string> {
  const enforced = new Set(g.directlyEnforced);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, tos] of g.edges) {
      if (enforced.has(from)) continue;
      for (const to of tos) {
        if (enforced.has(to)) {
          enforced.add(from);
          changed = true;
          break;
        }
      }
    }
  }
  return enforced;
}

function auditAddressListEnforcement(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  const all = [...state.firewallFilter, ...state.firewallRaw];
  const g = buildListGraph(all);
  const enforced = effectivelyEnforced(g);

  for (const list of [...g.produced].sort()) {
    if (enforced.has(list)) continue; // staged ladders & enforced lists pass
    const side = g.side.get(list) ?? "src";
    const chain = g.chain.get(list) ?? "input";
    const key = side === "src" ? "src-address-list" : "dst-address-list";
    findings.push({
      finding_id: `unenforced_list:${list}`,
      category: "address_list_enforcement",
      severity: "high",
      confidence: "proven",
      status: "fail",
      title: `Address-list "${list}" is populated but never blocked`,
      target: `address-list ${list} (${side})`,
      current: "list is written to by an add-*-to-address-list rule but no drop rule matches it",
      proposed: `add a drop rule matching ${key}=${list} in the ${chain} chain`,
      detail:
        "A list that is only ever written and never read by an enforcement rule provides no " +
        "protection (the classic 'we detect scanners/DDoS but never drop them' gap).",
      fix: [
        `/ip firewall filter add chain=${chain} action=drop ${key}=${list} ` +
          `place-before=[find chain=${chain} action=drop !src-address-list !dst-address-list !protocol] ` +
          `comment="${HARDENING_TAG}: enforce ${list}"`,
      ],
    });
  }

  // 4.9-bis footnote: heavy scan/DDoS detection entirely in filter with none in
  // raw — a low-severity recommendation, folded into THIS report (no own tool).
  const detectionInFilter = state.firewallFilter.some(
    (r) =>
      r.action.startsWith("add-") &&
      (r.match.psd || r.match["connection-limit"] || r.match["tcp-flags"]),
  );
  const anyRaw = state.firewallRaw.some((r) => !r.dynamic);
  if (detectionInFilter && !anyRaw) {
    findings.push({
      finding_id: "raw_table_usage:none",
      category: "address_list_enforcement",
      severity: "low",
      confidence: "needs_live_verification",
      status: "needs_manual_review",
      title: "Scan/DDoS detection lives entirely in filter; /ip firewall raw is empty",
      target: "/ip firewall raw",
      current: "detection logic runs after connection tracking",
      proposed:
        "consider moving early drops to /ip firewall raw (runs before conntrack, cheaper under flood)",
      detail:
        "Speculative (needs_live_verification): raw-table rules run before connection tracking " +
        "and are cheaper under active scanning/flood load. This is a recommendation, not a defect.",
    });
  }
  return findings;
}

// ── 4.3  Kernel IP hardening ────────────────────────────────────────────────

/** Count active default routes to infer multi-WAN / asymmetric routing. */
export function defaultRouteCount(routes: Record<string, string>[]): number {
  return routes.filter(
    (r) =>
      (r["dst-address"] ?? "").trim() === "0.0.0.0/0" &&
      !(r.flags ?? "").includes("X") &&
      !isYes(r.disabled),
  ).length;
}

function auditKernelIpHardening(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  const s = state.ipSettings;
  if (Object.keys(s).length === 0) return findings; // no /ip settings fetched
  const multiWan = defaultRouteCount(state.routes) > 1;

  const push = (
    id: string,
    field: string,
    current: string,
    want: string,
    severity: Severity,
    detail?: string,
  ): void => {
    findings.push({
      finding_id: `kernel:${id}`,
      category: "kernel_ip_hardening",
      severity,
      confidence: "proven",
      status: "fail",
      title: `/ip settings ${field}=${current} (recommended: ${want})`,
      target: `/ip settings ${field}`,
      current,
      proposed: want,
      detail,
      fix: [`/ip settings set ${field}=${want}`],
    });
  };

  if (s["tcp-syncookies"] !== undefined && !isYes(s["tcp-syncookies"])) {
    push(
      "tcp-syncookies",
      "tcp-syncookies",
      s["tcp-syncookies"],
      "yes",
      "medium",
      "SYN cookies mitigate SYN-flood exhaustion.",
    );
  }
  const rp = s["rp-filter"];
  const wantRp = multiWan ? "loose" : "strict";
  if (rp !== undefined && rp !== "strict" && rp !== "loose") {
    push(
      "rp-filter",
      "rp-filter",
      rp,
      wantRp,
      "medium",
      multiWan
        ? "Multi-WAN / asymmetric routing detected (>1 default route) → 'loose' avoids dropping legitimate asymmetric replies."
        : "Single-WAN → 'strict' reverse-path filtering blocks spoofed sources.",
    );
  } else if (rp === "loose" && !multiWan) {
    push(
      "rp-filter",
      "rp-filter",
      rp,
      "strict",
      "low",
      "Single default route (no multi-WAN detected) → 'strict' is safe and stronger.",
    );
  }
  if (isYes(s["accept-source-route"])) {
    push(
      "accept-source-route",
      "accept-source-route",
      "yes",
      "no",
      "high",
      "Source routing lets a sender dictate the return path — a spoofing vector.",
    );
  }
  if (isYes(s["accept-redirects"]) && multiWan) {
    push(
      "accept-redirects",
      "accept-redirects",
      "yes",
      "no",
      "medium",
      "On a multi-WAN router, honouring ICMP redirects can be abused to reroute traffic.",
    );
  }

  // IPv6 equivalents where present.
  const v6 = state.ipv6Settings;
  if (isYes(v6["accept-redirects"])) {
    findings.push({
      finding_id: "kernel:ipv6-accept-redirects",
      category: "kernel_ip_hardening",
      severity: "low",
      confidence: "proven",
      status: "fail",
      title: "/ipv6 settings accept-redirects=yes (recommended: no)",
      target: "/ipv6 settings accept-redirects",
      current: "yes",
      proposed: "no",
      fix: ["/ipv6 settings set accept-redirects=no"],
    });
  }
  return findings;
}

// ── 4.4  IPv6 firewall baseline ─────────────────────────────────────────────

/** RFC 4890 ICMPv6 types that MUST be permitted for IPv6 to keep working. */
const ICMPV6_KEEP = "icmp6-type=1,2,3,4,128,129,133,134,135,136,137";

function auditIpv6FirewallBaseline(state: DeviceSecurityState): Finding[] {
  const v6 = state.ipv6Settings;
  const ipv6Enabled = v6["disable-ipv6"] !== undefined && !isYes(v6["disable-ipv6"]);
  const forwarding = isYes(v6.forward);
  if (!ipv6Enabled && !forwarding) return []; // IPv6 off → not applicable

  const chain = indexByChain(state.ipv6Filter).get("forward") ?? [];
  const inputChain = indexByChain(state.ipv6Filter).get("input") ?? [];
  const hasFilter = state.ipv6Filter.length > 0;
  const forwardClosed = analyzeChainDefaultDeny(chain).enabledDefaultDeny;
  const inputClosed = analyzeChainDefaultDeny(inputChain).enabledDefaultDeny;
  if (hasFilter && forwardClosed && inputClosed) return []; // already filtered

  // Latent when forwarding is on but no IPv6 address is assigned yet — the
  // exposure is real (forward is enabled) but not active until SLAAC/PD fires.
  const latent = state.ipv6AddressCount === 0;
  const confidence: Confidence = latent ? "needs_live_verification" : "proven";

  const findings: Finding[] = [];

  // Option A — bootstrap a minimal safe IPv6 filter (accept est/rel/untracked,
  // keep RFC 4890 ICMPv6, then default-deny). Mutually exclusive with Option B.
  const bootstrap: string[] = [];
  for (const c of ["input", "forward"] as const) {
    bootstrap.push(
      `/ipv6 firewall filter add chain=${c} action=accept ` +
        `connection-state=established,related,untracked comment="${HARDENING_TAG}: v6 accept est/rel"`,
      `/ipv6 firewall filter add chain=${c} action=drop connection-state=invalid ` +
        `comment="${HARDENING_TAG}: v6 drop invalid"`,
      `/ipv6 firewall filter add chain=${c} action=accept protocol=icmpv6 ` +
        `comment="${HARDENING_TAG}: v6 accept ICMPv6 (RFC 4890: ${ICMPV6_KEEP})"`,
      `/ipv6 firewall filter add chain=${c} action=drop comment="${HARDENING_TAG}: v6 default deny ${c}"`,
    );
  }
  findings.push({
    finding_id: "ipv6_baseline:bootstrap",
    category: "ipv6_firewall_baseline",
    severity: "high",
    confidence,
    status: "fail",
    title: "IPv6 forwarding enabled with no filter baseline — Option A: bootstrap filter",
    target: "/ipv6 firewall filter",
    current: `disable-ipv6=${v6["disable-ipv6"] ?? "?"}, forward=${v6.forward ?? "?"}, filter rules=${state.ipv6Filter.length}`,
    proposed:
      "bootstrap a minimal safe IPv6 filter (accept est/rel, keep RFC 4890 ICMPv6, default-deny)",
    detail: `${
      latent
        ? "needs_live_verification: no IPv6 address is currently assigned, so the exposure is LATENT " +
          "(activates on ISP PD / LAN SLAAC) — but forwarding is already enabled, so it is a real gap. "
        : "proven: IPv6 addresses are assigned and forwarding is enabled with no default-deny. "
    }MUTUALLY EXCLUSIVE with ipv6_baseline:disable — apply exactly one.`,
    fix: bootstrap,
  });

  // Option B — if IPv6 is demonstrably unused, disable it instead of filtering.
  const noV6InUse = state.ipv6AddressCount === 0;
  findings.push({
    finding_id: "ipv6_baseline:disable",
    category: "ipv6_firewall_baseline",
    severity: noV6InUse ? "high" : "medium",
    confidence,
    status: "fail",
    title: "IPv6 forwarding enabled with no filter baseline — Option B: disable IPv6 forwarding",
    target: "/ipv6 settings",
    current: `forward=${v6.forward ?? "?"}, assigned IPv6 addresses=${state.ipv6AddressCount}`,
    proposed: noV6InUse
      ? "set forward=no (RECOMMENDED — no IPv6 addresses in use)"
      : "set forward=no ONLY if IPv6 is genuinely unused",
    detail: `MUTUALLY EXCLUSIVE with ipv6_baseline:bootstrap — apply exactly one. ${
      noV6InUse
        ? "Recommended: zero IPv6 addresses are assigned, so disabling forwarding removes the exposure with no service impact."
        : "IPv6 addresses ARE assigned — prefer Option A (bootstrap) unless you are certain IPv6 is unused."
    }`,
    fix: ["/ipv6 settings set forward=no"],
  });
  return findings;
}

// ── 4.5  SSH hardening ──────────────────────────────────────────────────────

function auditSshHardening(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  const ssh = state.ssh;
  if (Object.keys(ssh).length === 0) return findings;

  if (ssh["strong-crypto"] !== undefined && !isYes(ssh["strong-crypto"])) {
    findings.push({
      finding_id: "ssh:strong-crypto",
      category: "ssh_hardening",
      severity: "high",
      confidence: "proven",
      status: "fail",
      title: "/ip ssh strong-crypto=no",
      target: "/ip ssh strong-crypto",
      current: "no",
      proposed: "yes",
      detail: "strong-crypto disables weak ciphers/MACs/DH groups and enforces larger keys.",
      fix: ["/ip ssh set strong-crypto=yes"],
    });
  }

  const keyType = (ssh["host-key-type"] ?? "").toLowerCase();
  const keySize = Number.parseInt(ssh["host-key-size"] ?? "", 10);
  if (keyType === "rsa" && Number.isFinite(keySize) && keySize < 2048) {
    findings.push({
      finding_id: "ssh:host-key-size",
      category: "ssh_hardening",
      severity: "medium",
      confidence: "proven",
      status: "needs_manual_review",
      title: `/ip ssh host-key RSA ${keySize}-bit is below 2048`,
      target: "/ip ssh host-key-type/size",
      current: `rsa ${keySize}-bit`,
      proposed: "regenerate ≥2048-bit RSA, or migrate to ed25519 (stronger & faster)",
      detail:
        "Report-only: regenerating the host key invalidates every client's known_hosts entry, so " +
        "this needs the admin's explicit go-ahead — not auto-applied.",
    });
  }
  if (isYes(ssh["always-allow-password-login"])) {
    findings.push({
      finding_id: "ssh:password-login",
      category: "ssh_hardening",
      severity: "medium",
      confidence: "needs_live_verification",
      status: "needs_manual_review",
      title: "/ip ssh always-allow-password-login=yes",
      target: "/ip ssh always-allow-password-login",
      current: "yes",
      proposed: "no — once every admin user has an SSH public key configured",
      detail:
        "needs_live_verification: only safe to disable password login after confirming all admin " +
        "users have working public keys, or you will lock yourself out.",
    });
  }
  return findings;
}

// ── 4.6  IP service exposure ────────────────────────────────────────────────

/**
 * Is a TCP service port restricted to trusted sources by an active input rule?
 * A port counts as restricted when some active input rule matches its dst-port
 * AND carries a source scope (src-address or src-address-list). This is the
 * cross-reference the spec calls for so a firewall-gated service (address="" at
 * the service level but scoped by the filter) is NOT a false positive.
 */
export function servicePortRestricted(port: string, filter: FirewallRule[]): boolean {
  if (!port) return false;
  return filter.some((r) => {
    if (r.disabled || r.dynamic || r.chain !== "input") return false;
    const dp = r.match["dst-port"] ?? "";
    const matchesPort = dp
      .split(",")
      .map((p) => p.trim())
      .includes(port);
    if (!matchesPort) return false;
    return Boolean(r.match["src-address"] || r.match["src-address-list"]);
  });
}

/** Distinct WAN-tagged interfaces (by interface-list membership heuristic). */
function wanInterfaceCount(state: DeviceSecurityState): number {
  // Proxy: count default routes' gateways' distinct interfaces isn't in state;
  // use assigned-address interfaces that also carry a default route count.
  return defaultRouteCount(state.routes);
}

function auditIpServiceExposure(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  for (const svc of state.services) {
    const name = svc.name ?? "";
    const disabled = (svc.flags ?? "").includes("X") || isYes(svc.disabled);
    if (!name) continue;
    const address = (svc.address ?? "").trim();
    const port = (svc.port ?? "").trim();

    // Telnet: always flag if enabled — cleartext, recommend disabling outright.
    if (name === "telnet" && !disabled) {
      findings.push({
        finding_id: "service:telnet",
        category: "ip_service_exposure",
        severity: "high",
        confidence: "proven",
        status: "fail",
        title: "Telnet service is enabled (cleartext protocol)",
        target: "/ip service telnet",
        current: `enabled, address="${address || "(unrestricted)"}"`,
        proposed: "disable telnet entirely (use SSH)",
        fix: ["/ip service disable telnet"],
      });
      continue;
    }

    if (disabled) continue;
    const unrestrictedAtService = address === "";
    if (!unrestrictedAtService) continue; // service-level restriction already present

    // reverse-proxy (RouterOS 7.15+) — flag with a multi-WAN caveat.
    if (name === "reverse-proxy") {
      const multiWan = wanInterfaceCount(state) > 1;
      findings.push({
        finding_id: "service:reverse-proxy",
        category: "ip_service_exposure",
        severity: "high",
        confidence: "needs_live_verification",
        status: "fail",
        title: 'reverse-proxy service enabled with address="" (unrestricted)',
        target: "/ip service reverse-proxy",
        current: 'enabled, address="" (all sources)',
        proposed: "restrict address= to a trusted CIDR/list, or disable if unused",
        detail: `${
          multiWan
            ? "needs_live_verification: this device has more than one WAN-facing path — a NAT rule may " +
              "only cover ONE of them, leaving reverse-proxy reachable on the interface nobody scoped. "
            : "needs_live_verification: verify no WAN path reaches this service. "
        }Static config cannot fully prove per-interface reachability.`,
        fix: ["/ip service disable reverse-proxy"],
      });
      continue;
    }

    // Any other enabled, service-level-unrestricted service: a finding ONLY if
    // the firewall doesn't already restrict its port (avoids the Winbox false
    // positive — that was gated by the filter; the real bug was 4.1's disabled drop).
    if (servicePortRestricted(port, state.firewallFilter)) continue;
    findings.push({
      finding_id: `service:${name}`,
      category: "ip_service_exposure",
      severity: "high",
      confidence: "needs_live_verification",
      status: "fail",
      title: `Service "${name}" enabled with address="" and no firewall restriction`,
      target: `/ip service ${name}`,
      current: `enabled, address="", port=${port || "?"}`,
      proposed: `set address= to a trusted CIDR/list, or disable ${name} if unused`,
      detail:
        "needs_live_verification: no active input rule scopes this port to trusted sources, so it " +
        "is reachable from anywhere the interface is. Confirm the intended trust boundary before applying.",
      fix: [`/ip service set ${name} address=192.168.0.0/16`],
    });
  }
  return findings;
}

// ── 4.7  Connection-tracking helpers ────────────────────────────────────────

/** Helpers that are frequently enabled by default but rarely actually needed. */
const SUSPECT_HELPERS = new Set([
  "h323",
  "sip",
  "pptp",
  "irc",
  "rtsp",
  "udplite",
  "dccp",
  "sctp",
  "tftp",
]);

function auditConnectionTrackingHelpers(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];
  for (const h of state.servicePorts) {
    const name = h.name ?? "";
    const disabled = (h.flags ?? "").includes("X") || isYes(h.disabled);
    if (!name || disabled || !SUSPECT_HELPERS.has(name)) continue;

    // The one helper we can argue about from static config: pptp needs a
    // pptp-server or a pptp-client interface. Absent both → auto-fixable.
    if (name === "pptp") {
      const serverOn = isYes(state.pptpServer.enabled);
      const clients = state.pptpClients.filter((c) => !(c.flags ?? "").includes("X")).length;
      if (serverOn || clients > 0) continue; // in use
      findings.push({
        finding_id: "helper:pptp",
        category: "connection_tracking_helpers",
        severity: "low",
        confidence: "needs_live_verification",
        status: "fail",
        title: "pptp connection-tracking helper enabled with no PPTP server/client",
        target: "/ip firewall service-port pptp",
        current: "enabled, no pptp-server and no pptp-client configured",
        proposed: "disable the pptp helper",
        detail: "needs_live_verification: confirm no transient PPTP use before disabling.",
        fix: ["/ip firewall service-port disable pptp"],
      });
      continue;
    }
    // Others: flag as manual review (static config can't prove they're unused).
    findings.push({
      finding_id: `helper:${name}`,
      category: "connection_tracking_helpers",
      severity: "low",
      confidence: "needs_live_verification",
      status: "needs_manual_review",
      title: `${name} connection-tracking helper enabled — verify it is needed`,
      target: `/ip firewall service-port ${name}`,
      current: "enabled",
      proposed: `disable the ${name} helper if no matching service uses it`,
      detail:
        "needs_live_verification: an unused helper enlarges the attack surface (helpers have a " +
        "history of parsing bugs). Disable only after confirming no service depends on it: " +
        `\`/ip firewall service-port disable ${name}\`.`,
    });
  }
  return findings;
}

// ── 4.8  Management-plane exposure ──────────────────────────────────────────

function auditManagementPlane(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];

  const macList = state.macServer["allowed-interface-list"];
  if (macList === "all") {
    findings.push({
      finding_id: "mgmt:mac-server",
      category: "management_plane_exposure",
      severity: "medium",
      confidence: "proven",
      status: "needs_manual_review",
      title: "/tool mac-server allowed-interface-list=all",
      target: "/tool mac-server",
      current: "all",
      proposed: "restrict to a LAN-only interface list (e.g. LAN)",
      detail:
        "Report-only: the correct LAN interface-list name is site-specific, so we don't auto-apply. " +
        "Suggested: `/tool mac-server set allowed-interface-list=LAN`.",
    });
  }
  const winboxList = state.macWinbox["allowed-interface-list"];
  if (winboxList === "all") {
    findings.push({
      finding_id: "mgmt:mac-winbox",
      category: "management_plane_exposure",
      severity: "medium",
      confidence: "proven",
      status: "needs_manual_review",
      title: "/tool mac-server mac-winbox allowed-interface-list=all",
      target: "/tool mac-server mac-winbox",
      current: "all",
      proposed: "restrict to a LAN-only interface list",
      detail: "Report-only (site-specific list name). Suggested: set allowed-interface-list=LAN.",
    });
  }

  const bwEnabled = isYes(state.bandwidthServer.enabled);
  const bwAddrs = (state.bandwidthServer["allowed-addresses4"] ?? "").trim();
  if (bwEnabled && bwAddrs === "") {
    findings.push({
      finding_id: "mgmt:bandwidth-server",
      category: "management_plane_exposure",
      severity: "low",
      confidence: "proven",
      status: "fail",
      title: '/tool bandwidth-server enabled with allowed-addresses4="" (unrestricted)',
      target: "/tool bandwidth-server",
      current: 'enabled, allowed-addresses4=""',
      proposed: "disable if unused (or restrict allowed-addresses4)",
      fix: ["/tool bandwidth-server set enabled=no"],
    });
  }

  if (isYes(state.romon.enabled)) {
    findings.push({
      finding_id: "mgmt:romon",
      category: "management_plane_exposure",
      severity: "low",
      confidence: "proven",
      status: "needs_manual_review",
      title: "/tool romon is enabled",
      target: "/tool romon",
      current: "enabled",
      proposed: "disable RoMON unless actively used for L2 management",
      detail: "Informational — RoMON is commonly disabled. `/tool romon set enabled=no` if unused.",
    });
  }

  const disc = state.discoverySettings["discover-interface-list"];
  if (disc === "all" || disc === "static") {
    findings.push({
      finding_id: "mgmt:neighbor-discovery",
      category: "management_plane_exposure",
      severity: "low",
      confidence: "needs_live_verification",
      status: "needs_manual_review",
      title: `/ip neighbor discovery-settings discover-interface-list=${disc}`,
      target: "/ip neighbor discovery-settings",
      current: disc,
      proposed: "use a LAN-only interface list so neighbor discovery isn't answered on WAN",
      detail:
        "needs_live_verification: confirm whether the chosen list includes any WAN-tagged interface; " +
        "if so, MNDP/CDP replies leak device info to the internet.",
    });
  }

  for (const c of state.snmpCommunity) {
    const cname = (c.name ?? "").toLowerCase();
    const addrs = (c.addresses ?? "").trim();
    if (
      (cname === "public" || cname === "private") &&
      (addrs === "" || addrs === "::/0" || addrs === "0.0.0.0/0")
    ) {
      findings.push({
        finding_id: `mgmt:snmp-community:${c.name}`,
        category: "management_plane_exposure",
        severity: "low",
        confidence: "proven",
        status: "needs_manual_review",
        title: `SNMP community "${c.name}" uses a default name with open addresses`,
        target: `/snmp community ${c.name}`,
        current: `name=${c.name}, addresses=${addrs || "(any)"}`,
        proposed:
          "rename off the default and restrict addresses (defense-in-depth even while SNMP is disabled)",
        detail:
          "Configuration hygiene: a default-named, open community is a latent risk if SNMP is ever re-enabled.",
      });
    }
  }
  return findings;
}

// ── 4.9  Account hygiene (audit-only + narrow password-policy fix) ───────────

const SUSPICIOUS_NAMES = new Set(["test", "demo", "temp", "guest", "admin"]);

function auditAccountHygiene(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];

  const minLen = Number.parseInt(state.userSettings["minimum-password-length"] ?? "", 10);
  if (Number.isFinite(minLen) && minLen < 12) {
    findings.push({
      finding_id: "account:min-password-length",
      category: "account_hygiene",
      severity: "medium",
      confidence: "proven",
      status: "fail",
      title: `/user settings minimum-password-length=${minLen} (recommended ≥12)`,
      target: "/user settings minimum-password-length",
      current: String(minLen),
      proposed: "12",
      fix: ["/user settings set minimum-password-length=12"],
    });
  }
  const minCat = Number.parseInt(state.userSettings["minimum-categories"] ?? "", 10);
  if (Number.isFinite(minCat) && minCat < 3) {
    findings.push({
      finding_id: "account:min-categories",
      category: "account_hygiene",
      severity: "medium",
      confidence: "proven",
      status: "fail",
      title: `/user settings minimum-categories=${minCat} (recommended ≥3)`,
      target: "/user settings minimum-categories",
      current: String(minCat),
      proposed: "3",
      fix: ["/user settings set minimum-categories=3"],
    });
  }

  const scanAccounts = (rows: Record<string, string>[], kind: string): void => {
    for (const u of rows) {
      const uname = (u.name ?? "").toLowerCase();
      const disabled = (u.flags ?? "").includes("X") || isYes(u.disabled);
      if (!uname || disabled) continue;
      if (SUSPICIOUS_NAMES.has(uname)) {
        findings.push({
          finding_id: `account:suspicious:${kind}:${u.name}`,
          category: "account_hygiene",
          severity: "high",
          confidence: "proven",
          status: "needs_manual_review",
          title: `Suspicious ${kind} account "${u.name}" is enabled`,
          target: `${kind} ${u.name}`,
          current: "enabled, name matches a temporary-identifier denylist",
          proposed: "verify the account is intentional; remove if it is a leftover",
          detail:
            "Report-only by design: account deletion is high-blast-radius and always a human decision.",
        });
      }
    }
  };
  scanAccounts(state.users, "/user");
  scanAccounts(state.pppSecrets, "/ppp secret");
  scanAccounts(state.userManagerUsers, "/user-manager user");

  for (const grp of state.userGroups) {
    const policy = grp.policy ?? "";
    const broadAccess = /ssh/.test(policy) && /winbox/.test(policy) && /api/.test(policy);
    const readTier = (grp.name ?? "").toLowerCase().includes("read");
    if (broadAccess && readTier) {
      findings.push({
        finding_id: `account:group-policy:${grp.name}`,
        category: "account_hygiene",
        severity: "medium",
        confidence: "needs_live_verification",
        status: "needs_manual_review",
        title: `/user group "${grp.name}" grants broad protocol access to a read-tier group`,
        target: `/user group ${grp.name}`,
        current: policy,
        proposed:
          "review whether ssh/telnet/winbox/api/rest-api access is justified for this group",
        detail: "Report-only: group policy is a business decision, not a pure security bug.",
      });
    }
  }
  return findings;
}

// ── 4.10  Certificate hygiene (CRL policy) ──────────────────────────────────

function certBasedServicesInUse(state: DeviceSecurityState): boolean {
  const ovpn = [...state.ovpnServers, ...state.ovpnClients].some(
    (r) => isYes(r["require-client-certificate"]) || isYes(r["verify-server-certificate"]),
  );
  const sstp = state.sstpClients.some(
    (c) => (c.certificate ?? "") !== "" && (c.certificate ?? "") !== "none",
  );
  return ovpn || sstp;
}

function auditCertificateHygiene(state: DeviceSecurityState): Finding[] {
  if (!certBasedServicesInUse(state)) return [];
  const s = state.certSettings;
  const crlUse = s["crl-use"];
  const crlDl = s["crl-download"];
  const needFix =
    (crlUse !== undefined && !isYes(crlUse)) || (crlDl !== undefined && !isYes(crlDl));
  if (!needFix) return [];
  return [
    {
      finding_id: "cert:crl-policy",
      category: "certificate_hygiene",
      severity: "medium",
      confidence: "proven",
      status: "fail",
      title: "Certificate CRL checking is off while cert-based services are in use",
      target: "/certificate settings",
      current: `crl-use=${crlUse ?? "?"}, crl-download=${crlDl ?? "?"}`,
      proposed: "crl-use=yes, crl-download=yes",
      detail:
        "Without CRL checking a revoked peer certificate is still accepted. NOTE: enabling CRL " +
        "download needs outbound reachability to the CRL distribution point — you may need a " +
        "firewall allowance (cross-reference firewall_default_deny / address_list_enforcement).",
      fix: ["/certificate settings set crl-use=yes crl-download=yes"],
    },
  ];
}

// ── 4.11  Network segmentation (report-only) ────────────────────────────────

function auditNetworkSegmentation(state: DeviceSecurityState): Finding[] {
  const findings: Finding[] = [];

  // Physical interfaces = interfaces that are not bridges and not VLANs.
  const bridgeNames = new Set(state.bridges.map((b) => b.name).filter(Boolean));
  const vlanNames = new Set(state.vlans.map((v) => v.name).filter(Boolean));

  // Group /ip address entries by the physical interface they sit on.
  const byIface = new Map<string, string[]>();
  for (const a of state.ipAddresses) {
    const iface = a.interface ?? "";
    const network = (a.address ?? "").trim();
    if (!iface || !network) continue;
    if (bridgeNames.has(iface) || vlanNames.has(iface)) continue; // not a bare physical port
    let list = byIface.get(iface);
    if (!list) {
      list = [];
      byIface.set(iface, list);
    }
    list.push(network);
  }

  const dhcpSubnets = new Set(
    state.dhcpNetworks.map((n) => (n.address ?? "").trim()).filter(Boolean),
  );

  for (const [iface, addrs] of byIface) {
    // Need ≥2 distinct subnets on one physical interface.
    const distinct = [...new Set(addrs)];
    if (distinct.length < 2) continue;

    // At least one subnet is a DHCP client pool AND at least one hosts a
    // dst-nat target (a "server" subnet). We approximate the latter as "any of
    // the interface's subnets that is NOT a DHCP-served pool".
    const servedByDhcp = distinct.filter((s) =>
      [...dhcpSubnets].some((d) => cidrContains(s, d) || cidrContains(d, s)),
    );
    const hasClientPool = servedByDhcp.length > 0;
    const hasNonDhcp = servedByDhcp.length < distinct.length;
    if (!(hasClientPool && hasNonDhcp)) continue;

    const isolationVerified =
      isYes(state.bridgeSettings["use-ip-firewall"]) &&
      state.firewallFilter.some((r) => r.chain === "forward" && TERMINAL_DROP.has(r.action));

    findings.push({
      finding_id: `segmentation:${iface}`,
      category: "network_segmentation",
      severity: "medium",
      confidence: "proven",
      status: "needs_manual_review",
      title: `Physical interface ${iface} carries multiple subnets with no VLAN isolation`,
      target: `/interface ${iface}`,
      current: `subnets on one L2 domain: ${distinct.join(", ")}`,
      proposed: "move server and client subnets onto separate VLANs / bridges",
      detail:
        "TOPOLOGY FACT (proven): these subnets share one physical interface with no VLAN/bridge object. " +
        `ISOLATION CLAIM (${isolationVerified ? "some inter-subnet filtering present — verify coverage" : "needs_live_verification"}): ` +
        "static config cannot fully prove no firewall enforces isolation between them. " +
        "Suggested VLAN plan: keep the server subnet on the native/untagged bridge, move the client " +
        `pool (${servedByDhcp.join(", ")}) to a new VLAN (e.g. vlan-id 20) via /interface vlan + ` +
        "/interface bridge vlan, then add a forward-chain rule dropping client→server except allowed " +
        "ports. NEVER auto-applied — this is planned network work, not a bug fix.",
    });
  }
  return findings;
}

// ── 4.12  DNS resolver exposure ─────────────────────────────────────────────

function auditDnsResolverExposure(state: DeviceSecurityState): Finding[] {
  if (!isYes(state.dns["allow-remote-requests"])) return [];
  // Protocol-aware: RouterOS `dst-port` requires an explicit protocol, so a
  // rule scoping udp/53 does NOT restrict tcp/53 — that's the field trap where a
  // rule covers only one transport. Each transport must be restricted on its own.
  const restrictedFor = (proto: "tcp" | "udp"): boolean =>
    state.firewallFilter.some((r) => {
      if (r.disabled || r.dynamic || r.chain !== "input") return false;
      if ((r.match.protocol ?? "") !== proto) return false;
      const dp = (r.match["dst-port"] ?? "").split(",").map((p) => p.trim());
      return dp.includes("53") && Boolean(r.match["src-address"] || r.match["src-address-list"]);
    });
  const tcpRestricted = restrictedFor("tcp");
  const udpRestricted = restrictedFor("udp");
  if (tcpRestricted && udpRestricted) return [];

  // Recommend disabling remote requests when the resolver only serves the
  // router's own DHCP clients (i.e. DHCP networks point at this router for DNS).
  const servesOwnDhcpOnly = state.dhcpNetworks.some((n) => (n["dns-server"] ?? "").trim() !== "");

  const missing = [!tcpRestricted && "TCP/53", !udpRestricted && "UDP/53"]
    .filter(Boolean)
    .join(" and ");
  return [
    {
      finding_id: "dns:remote-requests",
      category: "dns_resolver_exposure",
      severity: "high",
      confidence: "proven",
      status: "fail",
      title: "DNS resolver accepts remote requests without a full firewall restriction",
      target: "/ip dns allow-remote-requests",
      current: `allow-remote-requests=yes; ${missing} not restricted to trusted sources`,
      proposed: servesOwnDhcpOnly
        ? "set allow-remote-requests=no (clients use the router via DHCP-provided DNS, not direct queries)"
        : "restrict input UDP+TCP port 53 to a trusted address-list",
      detail:
        `An open resolver is a DNS-amplification reflector. NOTE the field trap: a rule may cover ` +
        `only ONE transport (TCP or UDP) — both must be restricted. ${
          servesOwnDhcpOnly
            ? "DHCP hands out this router as DNS, so disabling remote requests is the cleaner fix."
            : "No DHCP DNS pointer found — prefer a firewall restriction to a trusted list."
        }`,
      fix: servesOwnDhcpOnly
        ? ["/ip dns set allow-remote-requests=no"]
        : [
            `/ip firewall filter add chain=input protocol=udp dst-port=53 action=drop ` +
              `place-before=[find chain=input action=drop !protocol] comment="${HARDENING_TAG}: restrict DNS udp/53"`,
            `/ip firewall filter add chain=input protocol=tcp dst-port=53 action=drop ` +
              `place-before=[find chain=input action=drop !protocol] comment="${HARDENING_TAG}: restrict DNS tcp/53"`,
          ],
    },
  ];
}

// ── Category dispatch ───────────────────────────────────────────────────────

/** Map of category → auditor. The single source of truth for what runs. */
export const AUDITORS: Record<HardeningCategory, (s: DeviceSecurityState) => Finding[]> = {
  firewall_default_deny: auditDefaultDeny,
  address_list_enforcement: auditAddressListEnforcement,
  kernel_ip_hardening: auditKernelIpHardening,
  ipv6_firewall_baseline: auditIpv6FirewallBaseline,
  ssh_hardening: auditSshHardening,
  ip_service_exposure: auditIpServiceExposure,
  connection_tracking_helpers: auditConnectionTrackingHelpers,
  management_plane_exposure: auditManagementPlane,
  account_hygiene: auditAccountHygiene,
  certificate_hygiene: auditCertificateHygiene,
  network_segmentation: auditNetworkSegmentation,
  dns_resolver_exposure: auditDnsResolverExposure,
};

/** Run a single category's auditor. */
export function auditCategory(category: HardeningCategory, state: DeviceSecurityState): Finding[] {
  return AUDITORS[category](state);
}

/** Run every requested category (default: all) and merge into one ranked report. */
export function runSecurityHardeningAudit(
  state: DeviceSecurityState,
  categories: HardeningCategory[] = [...HARDENING_CATEGORIES],
): HardeningReport {
  const findings: Finding[] = [];
  for (const c of categories) findings.push(...AUDITORS[c](state));

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.category.localeCompare(b.category) ||
      a.finding_id.localeCompare(b.finding_id),
  );

  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity]++;
  return { findings, summary, total: findings.length };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const SEV_TAG: Record<Severity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
};

/** Plain-text report for text-only hosts. */
export function renderHardeningReport(report: HardeningReport, device: string): string {
  const head =
    `SECURITY HARDENING AUDIT — ${device}\n` +
    `${report.total} finding(s): ${report.summary.critical} critical, ${report.summary.high} high, ` +
    `${report.summary.medium} medium, ${report.summary.low} low`;
  if (report.total === 0) {
    return `${head}\n\nNo findings — the device passes every hardening check. ✓`;
  }
  const body = report.findings
    .map((f, i) => {
      const auto = f.fix ? `auto-fix (${f.fix.length} cmd)` : "manual review";
      return (
        `${i + 1}. [${SEV_TAG[f.severity]}] ${f.title}\n` +
        `   id=${f.finding_id}  category=${f.category}  confidence=${f.confidence}  ${auto}\n` +
        `   target : ${f.target}\n` +
        `   current: ${f.current}\n` +
        `   propose: ${f.proposed}${f.detail ? `\n   note   : ${f.detail}` : ""}`
      );
    })
    .join("\n\n");
  return `${head}\n\n${body}`;
}
