/**
 * Root-cause analysis engine — pure analysis, zero device I/O.
 *
 * Receives diagnostic evidence collected across multiple dimensions (logs,
 * interfaces, routes, firewall, ARP/DHCP, system resources, connectivity)
 * and correlates it to produce a ranked list of probable root causes with
 * confidence levels, plain-language explanations, and fix commands.
 *
 * The tool layer (`src/tools/root-cause.ts`) handles all device interaction;
 * this module stays import-free of `connector.ts` so it's testable without a
 * live device.
 */
import { isIpAddress, isPrivateIp } from "../utils/ip";

// ── Diagnostic dimensions ───────────────────────────────────────────────────

export type DiagnosticDimension =
  | "connectivity"
  | "interfaces"
  | "routing"
  | "firewall"
  | "nat"
  | "arp_dhcp"
  | "dns"
  | "resources"
  | "logs"
  | "vpn";

export const ALL_DIMENSIONS: DiagnosticDimension[] = [
  "connectivity",
  "interfaces",
  "routing",
  "firewall",
  "nat",
  "arp_dhcp",
  "dns",
  "resources",
  "logs",
  "vpn",
];

export const DIMENSION_LABELS: Record<DiagnosticDimension, string> = {
  connectivity: "Connectivity & Reachability",
  interfaces: "Interface State & Counters",
  routing: "Routing Table & Neighbors",
  firewall: "Firewall Rules & Hit Counters",
  nat: "NAT & Connection Tracking",
  arp_dhcp: "ARP / DHCP State",
  dns: "DNS Resolution",
  resources: "System Resources",
  logs: "System Logs & Events",
  vpn: "VPN / Tunnel State",
};

// ── Evidence types ──────────────────────────────────────────────────────────

export type EvidenceSeverity = "critical" | "warning" | "info" | "ok";

/** A single piece of diagnostic evidence from one dimension. */
export interface Evidence {
  dimension: DiagnosticDimension;
  severity: EvidenceSeverity;
  /** One-line finding. */
  summary: string;
  /** Additional detail or raw data. */
  detail?: string;
  /** Related RouterOS object (rule number, interface name, etc.). */
  reference?: string;
}

/** Raw diagnostic data collected by the tool layer. */
export interface DiagnosticData {
  /** Target being investigated (IP, hostname, or symptom description). */
  target: string;

  // ── Connectivity ──────────────────────────────────────────────────────
  ping?: { sent: number; received: number; lossPct: number; avgRtt?: number };
  traceroute?: string;

  // ── Interfaces ────────────────────────────────────────────────────────
  interfaces: InterfaceSnapshot[];

  // ── Routing ───────────────────────────────────────────────────────────
  routeCount: number;
  defaultRouteExists: boolean;
  activeRoutes: RouteSnapshot[];
  ospfNeighbors: RoutingNeighbor[];
  bgpPeers: RoutingNeighbor[];

  // ── Firewall ──────────────────────────────────────────────────────────
  /** Filter rules matching the target (by src/dst address). */
  matchingFilterRules: FirewallRuleSnapshot[];
  /** Total input/forward chain rule count. */
  filterRuleCount: number;

  // ── NAT ───────────────────────────────────────────────────────────────
  natRules: FirewallRuleSnapshot[];
  connectionCount: number;

  // ── ARP / DHCP ────────────────────────────────────────────────────────
  arpEntries: ArpEntry[];
  dhcpLeases: DhcpLease[];

  // ── DNS ───────────────────────────────────────────────────────────────
  dnsResolveResult?: string;
  dnsServers: string;
  dnsAllowRemote: boolean;

  // ── Resources ─────────────────────────────────────────────────────────
  cpuLoad: number;
  memoryUsedPct: number;
  uptime: string;
  rosVersion: string;

  // ── Logs ───────────────────────────────────────────────────────────────
  /** Recent log entries (last 10 minutes) that relate to the target/symptom. */
  relevantLogs: LogEntry[];

  // ── VPN / tunnels ─────────────────────────────────────────────────────
  tunnelInterfaces: InterfaceSnapshot[];
  /** Mangle rules — used to detect a TCP MSS clamp (`action=change-mss`). */
  mangleRules: FirewallRuleSnapshot[];
  /** WireGuard peers, for the persistent-keepalive / NAT-timeout check. */
  wireguardPeers: WireguardPeerSnapshot[];
  /**
   * Names of PPP profiles with `change-tcp-mss` NOT enabled. PPP-family tunnels
   * (l2tp/pptp/sstp/ovpn/pppoe) clamp MSS via their profile rather than mangle.
   */
  pppProfilesMissingMssClamp: string[];
}

export interface InterfaceSnapshot {
  name: string;
  type: string;
  running: boolean;
  disabled: boolean;
  txBytes: number;
  rxBytes: number;
  txErrors: number;
  rxErrors: number;
  linkDowns: number;
  lastLinkDownTime?: string;
  mtu: number;
  /** Negotiated/effective MTU. RouterOS reports `mtu=auto` on some tunnel types. */
  actualMtu?: number;
  /** `clamp-tcp-mss` — present on GRE/IPIP/EoIP. */
  clampTcpMss?: boolean;
}

export interface WireguardPeerSnapshot {
  interface: string;
  publicKey: string;
  endpoint?: string;
  /** Seconds; 0 / undefined means keepalive is off. */
  persistentKeepalive: number;
  disabled: boolean;
}

export interface RouteSnapshot {
  dst: string;
  gateway: string;
  distance: number;
  active: boolean;
  dynamic: boolean;
}

export interface RoutingNeighbor {
  id: string;
  address: string;
  state: string;
  interface: string;
  uptime?: string;
}

export interface FirewallRuleSnapshot {
  index: number;
  chain: string;
  action: string;
  srcAddress?: string;
  dstAddress?: string;
  protocol?: string;
  dstPort?: string;
  bytes: number;
  packets: number;
  disabled: boolean;
  comment?: string;
}

export interface ArpEntry {
  address: string;
  macAddress: string;
  interface: string;
  complete: boolean;
  dynamic: boolean;
}

export interface DhcpLease {
  address: string;
  macAddress: string;
  hostName: string;
  status: string;
  lastSeen?: string;
  server: string;
}

export interface LogEntry {
  time: string;
  topics: string;
  message: string;
}

// ── Root cause types ────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface RootCause {
  /** Short label. */
  cause: string;
  /** Plain-language explanation of why this is likely the issue. */
  explanation: string;
  /** Confidence based on corroborating evidence. */
  confidence: Confidence;
  /** The evidence that supports this conclusion. */
  evidence: Evidence[];
  /** Exact RouterOS fix commands (when known). */
  fixes: string[];
  /** Affected dimension(s). */
  dimensions: DiagnosticDimension[];
}

export interface DiagnosisReport {
  target: string;
  timestamp: string;
  /** Collected evidence across all dimensions. */
  allEvidence: Evidence[];
  /** Ranked root causes (most likely first). */
  rootCauses: RootCause[];
  /** Per-dimension health summary. */
  dimensionSummary: { dimension: DiagnosticDimension; label: string; status: EvidenceSeverity }[];
}

// ── Analysis engine ─────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Run the full root-cause analysis on collected diagnostic data. */
export function analyzeRootCause(data: DiagnosticData): DiagnosisReport {
  const evidence: Evidence[] = [];
  const rootCauses: RootCause[] = [];

  // ── 1. Connectivity analysis ──────────────────────────────────────────
  if (data.ping) {
    if (data.ping.lossPct === 100) {
      evidence.push({
        dimension: "connectivity",
        severity: "critical",
        summary: `Target ${data.target} is completely unreachable (100% packet loss)`,
        detail: `${data.ping.sent} packets sent, 0 received`,
      });
    } else if (data.ping.lossPct > 0) {
      evidence.push({
        dimension: "connectivity",
        severity: "warning",
        summary: `Partial packet loss to ${data.target}: ${data.ping.lossPct}%`,
        detail: `${data.ping.received}/${data.ping.sent} received`,
      });
    } else {
      evidence.push({
        dimension: "connectivity",
        severity: "ok",
        summary: `Target ${data.target} is reachable (0% loss)`,
      });
    }
  }

  // ── 2. Interface analysis ─────────────────────────────────────────────
  const downInterfaces = data.interfaces.filter((i) => !i.running && !i.disabled);
  const errorInterfaces = data.interfaces.filter((i) => i.txErrors > 0 || i.rxErrors > 0);
  const highLinkDowns = data.interfaces.filter((i) => i.linkDowns > 5);

  for (const iface of downInterfaces) {
    evidence.push({
      dimension: "interfaces",
      severity: "critical",
      summary: `Interface ${iface.name} is down (not running, not disabled)`,
      detail: `Type: ${iface.type}, link-downs: ${iface.linkDowns}`,
      reference: iface.name,
    });
  }

  for (const iface of errorInterfaces) {
    evidence.push({
      dimension: "interfaces",
      severity: "warning",
      summary: `Interface ${iface.name} has errors: TX=${iface.txErrors} RX=${iface.rxErrors}`,
      reference: iface.name,
    });
  }

  for (const iface of highLinkDowns) {
    if (!downInterfaces.includes(iface)) {
      evidence.push({
        dimension: "interfaces",
        severity: "warning",
        summary: `Interface ${iface.name} is flapping: ${iface.linkDowns} link-downs`,
        detail: iface.lastLinkDownTime ? `Last down: ${iface.lastLinkDownTime}` : undefined,
        reference: iface.name,
      });
    }
  }

  if (downInterfaces.length === 0 && errorInterfaces.length === 0) {
    // A live device always has at least one interface (loopback). Zero
    // interfaces means the collector failed silently (e.g. a parse error on
    // the RouterOS output) — flag it so the user doesn't see a clean bill of
    // health when the data is actually missing.
    if (data.interfaces.length === 0) {
      evidence.push({
        dimension: "interfaces",
        severity: "warning",
        summary:
          "Interface data unavailable — the device returned no parseable interface records. " +
          "Run `/interface print detail` manually to verify.",
      });
    } else {
      evidence.push({
        dimension: "interfaces",
        severity: "ok",
        summary: `All ${data.interfaces.length} interfaces healthy`,
      });
    }
  }

  // ── 3. Routing analysis ───────────────────────────────────────────────
  if (data.routeCount === 0) {
    // Zero routes on a live device means the collector returned nothing.
    evidence.push({
      dimension: "routing",
      severity: "warning",
      summary:
        "Route data unavailable — the device returned no parseable route records. " +
        "Run `/ip route print detail` manually to verify.",
    });
  } else if (!data.defaultRouteExists) {
    evidence.push({
      dimension: "routing",
      severity: "critical",
      summary: "No default route — device cannot reach the internet",
    });
  } else {
    evidence.push({
      dimension: "routing",
      severity: "ok",
      summary: `Default route present, ${data.routeCount} total routes`,
    });
  }

  // OSPF neighbor issues — skip entries with empty id/address (parse artifacts from
  // unconfigured OSPF returning empty or header-only output).
  const ospfDown = data.ospfNeighbors.filter(
    (n) => (n.id || n.address) && n.state.toLowerCase() !== "full",
  );
  for (const n of ospfDown) {
    evidence.push({
      dimension: "routing",
      severity: n.state.toLowerCase() === "init" ? "critical" : "warning",
      summary: `OSPF neighbor ${n.id} on ${n.interface} is ${n.state} (not Full)`,
      reference: n.id,
    });
  }

  // BGP peer issues — skip entries with empty id/address (parse artifacts).
  const bgpDown = data.bgpPeers.filter(
    (p) => (p.id || p.address) && !p.state.toLowerCase().includes("established"),
  );
  for (const p of bgpDown) {
    evidence.push({
      dimension: "routing",
      severity: "critical",
      summary: `BGP peer ${p.address} is ${p.state} (not Established)`,
      reference: p.id,
    });
  }

  // ── 4. Firewall analysis ──────────────────────────────────────────────
  const blockingRules = data.matchingFilterRules.filter(
    (r) => !r.disabled && (r.action === "drop" || r.action === "reject") && r.packets > 0,
  );
  for (const rule of blockingRules) {
    evidence.push({
      dimension: "firewall",
      severity: "warning",
      summary: `Firewall rule #${rule.index} (${rule.chain}) is actively dropping traffic: ${rule.packets} packets`,
      detail: formatRule(rule),
      reference: `#${rule.index}`,
    });
  }

  if (blockingRules.length === 0 && data.matchingFilterRules.length > 0) {
    evidence.push({
      dimension: "firewall",
      severity: "ok",
      summary: `${data.matchingFilterRules.length} matching firewall rules — none actively blocking`,
    });
  }

  // ── 5. NAT analysis ──────────────────────────────────────────────────
  const masquerade = data.natRules.some((r) => r.action === "masquerade" && !r.disabled);
  const srcNat = data.natRules.some((r) => r.action === "src-nat" && !r.disabled);
  if (!masquerade && !srcNat && data.natRules.length > 0) {
    evidence.push({
      dimension: "nat",
      severity: "info",
      summary: "No masquerade/src-nat rule active — LAN clients may lack internet",
    });
  } else if (masquerade || srcNat) {
    evidence.push({
      dimension: "nat",
      severity: "ok",
      summary: "Source NAT/masquerade present",
    });
  }

  evidence.push({
    dimension: "nat",
    severity: "info",
    summary: `${data.connectionCount} active connection tracking entries`,
  });

  // ── 6. ARP / DHCP analysis ───────────────────────────────────────────
  const incompleteArp = data.arpEntries.filter((e) => !e.complete);
  if (incompleteArp.length > 0) {
    evidence.push({
      dimension: "arp_dhcp",
      severity: "warning",
      summary: `${incompleteArp.length} incomplete ARP entries — hosts not responding`,
      detail: incompleteArp
        .slice(0, 5)
        .map((e) => `${e.address} on ${e.interface}`)
        .join(", "),
    });
  }

  // DHCP exhaustion check
  const boundLeases = data.dhcpLeases.filter((l) => l.status === "bound");
  if (data.dhcpLeases.length > 0) {
    evidence.push({
      dimension: "arp_dhcp",
      severity: "ok",
      summary: `${boundLeases.length} active DHCP leases`,
    });
  }

  // Target-specific DHCP/ARP check — only meaningful for local (private) IPs.
  // External IPs like 8.8.8.8 are routed, so they'll never have a local ARP
  // entry or DHCP lease — checking them would produce false "may be offline".
  if (isIpAddress(data.target) && isPrivateIp(data.target)) {
    const lease = data.dhcpLeases.find((l) => l.address === data.target);
    const arp = data.arpEntries.find((e) => e.address === data.target);

    if (!lease && !arp) {
      evidence.push({
        dimension: "arp_dhcp",
        severity: "warning",
        summary: `Target ${data.target} has no DHCP lease and no ARP entry — device may be offline`,
      });
    } else if (arp && !arp.complete) {
      evidence.push({
        dimension: "arp_dhcp",
        severity: "warning",
        summary: `ARP entry for ${data.target} is incomplete — host not responding at L2`,
      });
    }
  }

  // ── 7. DNS analysis ──────────────────────────────────────────────────
  if (data.dnsResolveResult !== undefined) {
    if (!data.dnsResolveResult) {
      evidence.push({
        dimension: "dns",
        severity: "warning",
        summary: "DNS resolution failed",
        detail: `Servers: ${data.dnsServers || "none configured"}`,
      });
    } else {
      evidence.push({
        dimension: "dns",
        severity: "ok",
        summary: `DNS resolves to ${data.dnsResolveResult}`,
      });
    }
  }

  if (!data.dnsServers) {
    evidence.push({
      dimension: "dns",
      severity: "warning",
      summary: "No DNS servers configured",
    });
  }

  // ── 8. Resource analysis ──────────────────────────────────────────────
  // If CPU and memory are both exactly 0 and no version/uptime was parsed, the
  // resource collector likely failed silently — warn rather than reporting "ok".
  if (data.cpuLoad === 0 && data.memoryUsedPct === 0 && !data.rosVersion && !data.uptime) {
    evidence.push({
      dimension: "resources",
      severity: "warning",
      summary:
        "System resource data unavailable — CPU 0%, memory 0%, no version or uptime. " +
        "The `/system resource print` output may not have been parsed correctly.",
    });
  } else if (data.cpuLoad > 90) {
    evidence.push({
      dimension: "resources",
      severity: "critical",
      summary: `CPU critically overloaded: ${data.cpuLoad}%`,
    });
  } else if (data.cpuLoad > 70) {
    evidence.push({
      dimension: "resources",
      severity: "warning",
      summary: `CPU under pressure: ${data.cpuLoad}%`,
    });
  } else {
    evidence.push({
      dimension: "resources",
      severity: "ok",
      summary: `CPU load: ${data.cpuLoad}%`,
    });
  }

  // Skip individual memory check when resource data is entirely absent (already warned above).
  if (data.rosVersion || data.uptime || data.cpuLoad > 0 || data.memoryUsedPct > 0) {
    if (data.memoryUsedPct > 90) {
      evidence.push({
        dimension: "resources",
        severity: "critical",
        summary: `Memory critically low: ${data.memoryUsedPct}% used`,
      });
    } else if (data.memoryUsedPct > 75) {
      evidence.push({
        dimension: "resources",
        severity: "warning",
        summary: `Memory pressure: ${data.memoryUsedPct}% used`,
      });
    } else {
      evidence.push({
        dimension: "resources",
        severity: "ok",
        summary: `Memory: ${data.memoryUsedPct}% used`,
      });
    }
  }

  // ── 9. Log analysis ──────────────────────────────────────────────────
  const errorLogs = data.relevantLogs.filter(
    (l) =>
      l.topics.includes("error") || l.topics.includes("critical") || l.topics.includes("warning"),
  );
  const firewallLogs = data.relevantLogs.filter((l) => l.topics.includes("firewall"));
  const authLogs = data.relevantLogs.filter(
    (l) =>
      l.message.toLowerCase().includes("login") ||
      l.message.toLowerCase().includes("denied") ||
      l.message.toLowerCase().includes("failed"),
  );

  if (errorLogs.length > 0) {
    evidence.push({
      dimension: "logs",
      severity: "warning",
      summary: `${errorLogs.length} error/warning log entries in the last 10 minutes`,
      detail: errorLogs
        .slice(0, 3)
        .map((l) => `[${l.time}] ${l.topics}: ${l.message}`)
        .join("\n"),
    });
  }

  if (firewallLogs.length > 0) {
    evidence.push({
      dimension: "logs",
      severity: "info",
      summary: `${firewallLogs.length} firewall log entries — traffic being logged/blocked`,
    });
  }

  if (authLogs.length > 0) {
    evidence.push({
      dimension: "logs",
      severity: "warning",
      summary: `${authLogs.length} authentication-related log entries`,
      detail: authLogs
        .slice(0, 3)
        .map((l) => `[${l.time}] ${l.message}`)
        .join("\n"),
    });
  }

  if (errorLogs.length === 0 && firewallLogs.length === 0) {
    evidence.push({
      dimension: "logs",
      severity: "ok",
      summary: "No concerning log entries in the last 10 minutes",
    });
  }

  // ── 10. VPN / tunnel analysis ─────────────────────────────────────────
  // Server-side tunnel bindings (l2tp-in, pptp-in, ovpn-in, sstp-in, etc.)
  // are idle when no client is connected — that's normal, not critical.
  const isServerBinding = (t: InterfaceSnapshot): boolean =>
    /-(in|server)$/.test(t.type) || t.name.startsWith("<");
  const downTunnels = data.tunnelInterfaces.filter((t) => !t.running && !t.disabled);
  for (const t of downTunnels) {
    if (isServerBinding(t)) {
      evidence.push({
        dimension: "vpn",
        severity: "info",
        summary: `Server binding ${t.name} (${t.type}) is idle — no active client session`,
        reference: t.name,
      });
    } else {
      evidence.push({
        dimension: "vpn",
        severity: "critical",
        summary: `Tunnel ${t.name} (${t.type}) is down`,
        reference: t.name,
      });
    }
  }

  if (data.tunnelInterfaces.length > 0 && downTunnels.length === 0) {
    evidence.push({
      dimension: "vpn",
      severity: "ok",
      summary: `All ${data.tunnelInterfaces.length} tunnel(s) running`,
    });
  }

  // ── 11. MTU / MSS black-hole analysis ─────────────────────────────────
  const mtuFindings = analyzeTunnelMtu(data);
  evidence.push(...mtuFindings.evidence);

  // ── Correlate evidence into root causes ───────────────────────────────
  correlateRootCauses(data, evidence, rootCauses);

  // ── Consistency pass ─────────────────────────────────────────────────
  // If ping succeeded (0% loss), connectivity-dependent hypotheses like
  // "missing default route" or "missing NAT" are contradicted by evidence.
  // Downgrade their confidence so they don't mislead the user with a
  // simultaneous "target reachable" and "cannot reach internet".
  if (data.ping && data.ping.lossPct === 0) {
    const contradicted = new Set([
      "Missing default route",
      "Missing source NAT / masquerade",
      "Interface link failure",
    ]);
    for (const rc of rootCauses) {
      if (contradicted.has(rc.cause) && rc.confidence !== "low") {
        rc.confidence = "low";
        rc.explanation +=
          " (Note: ping to the target succeeded with 0% loss, which contradicts this hypothesis.)";
      }
    }
  }

  // Sort: high confidence first
  rootCauses.sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]);

  // Build dimension summary
  const dimensionSummary = ALL_DIMENSIONS.map((dim) => {
    const dimEvidence = evidence.filter((e) => e.dimension === dim);
    let status: EvidenceSeverity = "ok";
    if (dimEvidence.some((e) => e.severity === "critical")) status = "critical";
    else if (dimEvidence.some((e) => e.severity === "warning")) status = "warning";
    else if (dimEvidence.length === 0) status = "info";
    return { dimension: dim, label: DIMENSION_LABELS[dim], status };
  });

  return {
    target: data.target,
    timestamp: new Date().toISOString(),
    allEvidence: evidence,
    rootCauses,
    dimensionSummary,
  };
}

// ── MTU / MSS analysis ──────────────────────────────────────────────────────

interface TunnelOverhead {
  /** Matched against the RouterOS `type` field as a substring. */
  match: string;
  bytes: number;
  label: string;
  /**
   * RouterOS menu whose `set … mtu=` takes a plain MTU. Absent for the PPP
   * family, where the knob is `max-mtu`/`max-mru` on the client interface or
   * the server settings — a server-side session interface is dynamic and
   * cannot be set at all, so no single command fits.
   */
  path?: string;
}

/**
 * Encapsulation overhead in bytes per tunnel type, matched against the RouterOS
 * `type` field as a substring. Ordered longest-match-first is unnecessary — the
 * keys don't overlap.
 */
const TUNNEL_OVERHEAD: TunnelOverhead[] = [
  { match: "gre", bytes: 24, label: "GRE", path: "/interface gre" },
  { match: "ipip", bytes: 20, label: "IPIP", path: "/interface ipip" },
  { match: "eoip", bytes: 42, label: "EoIP", path: "/interface eoip" },
  { match: "vxlan", bytes: 50, label: "VXLAN", path: "/interface vxlan" },
  { match: "wg", bytes: 60, label: "WireGuard", path: "/interface wireguard" },
  // PPP-family: PPP/L2TP/PPTP/SSTP/OVPN headers plus (commonly) an IPsec wrap.
  { match: "l2tp", bytes: 100, label: "L2TP" },
  { match: "pptp", bytes: 100, label: "PPTP" },
  { match: "sstp", bytes: 100, label: "SSTP" },
  { match: "ovpn", bytes: 100, label: "OpenVPN" },
];

/** Tunnel types whose MSS is clamped by the PPP profile, not by mangle. */
const PPP_FAMILY = /l2tp|pptp|sstp|ovpn|pppoe/;

function tunnelOverhead(type: string): TunnelOverhead | undefined {
  const t = type.toLowerCase();
  return TUNNEL_OVERHEAD.find((o) => t.includes(o.match));
}

export interface MtuFindings {
  evidence: Evidence[];
  /** Running tunnels with no MSS clamp reaching them. */
  unclamped: InterfaceSnapshot[];
  /** Running tunnels whose MTU leaves no room for their own encapsulation. */
  oversizedMtu: { iface: InterfaceSnapshot; effective: number; budget: number; label: string }[];
  /** Enabled WireGuard peers with persistent-keepalive off. */
  keepaliveOff: WireguardPeerSnapshot[];
}

/**
 * Detect the PMTU black-hole trio: oversized tunnel MTU, missing TCP MSS clamp,
 * and WireGuard peers with no persistent-keepalive.
 *
 * Pure — safe to call more than once on the same data.
 */
export function analyzeTunnelMtu(data: DiagnosticData): MtuFindings {
  const evidence: Evidence[] = [];
  const unclamped: InterfaceSnapshot[] = [];
  const oversizedMtu: MtuFindings["oversizedMtu"] = [];

  const tunnels = data.tunnelInterfaces.filter((t) => !t.disabled);

  // A clamp rule anywhere in forward/postrouting covers every forwarded flow,
  // so it is checked once rather than per tunnel.
  const clampRules = data.mangleRules.filter((r) => r.action === "change-mss" && !r.disabled);
  const globalClamp = clampRules.some(
    (r) => r.chain === "forward" || r.chain === "postrouting" || r.chain === "output",
  );
  const strandedClamp = clampRules.length > 0 && !globalClamp;

  // PPPoE on the WAN costs another 8 bytes on top of the tunnel's own overhead.
  const pppoeWan = data.interfaces.some((i) => i.type.toLowerCase().includes("pppoe"));
  const pathBudget = pppoeWan ? 1492 : 1500;

  // Every PPP profile clamping means whichever profile a PPP tunnel uses clamps,
  // without needing to resolve the interface→profile mapping.
  // ponytail: if some profiles clamp and others don't we warn and name them —
  // per-interface profile resolution would need a query per tunnel.
  const pppClampedEverywhere = data.pppProfilesMissingMssClamp.length === 0;

  for (const t of tunnels) {
    const overhead = tunnelOverhead(t.type);
    if (!overhead) continue;

    const effective = t.actualMtu ?? t.mtu;
    const budget = pathBudget - overhead.bytes;
    if (effective > budget) {
      oversizedMtu.push({ iface: t, effective, budget, label: overhead.label });
      evidence.push({
        dimension: "vpn",
        severity: "warning",
        summary:
          `Tunnel ${t.name} MTU ${effective} exceeds the ${budget}-byte budget for ` +
          `${overhead.label} (${overhead.bytes} B overhead${pppoeWan ? " + PPPoE 8 B" : ""})`,
        detail:
          "Packets at this size need fragmentation the transit path will not perform, " +
          "so they are dropped silently.",
        reference: t.name,
      });
    }

    const covered =
      t.clampTcpMss === true ||
      globalClamp ||
      (PPP_FAMILY.test(t.type.toLowerCase()) && pppClampedEverywhere);
    if (!covered) {
      unclamped.push(t);
      evidence.push({
        dimension: "vpn",
        severity: "warning",
        summary: `Tunnel ${t.name} (${overhead.label}) has no TCP MSS clamp`,
        detail:
          "Hosts derive their MSS from their own LAN MTU and set DF, so full-size " +
          "segments enter the tunnel and are dropped in transit. Small flows (ping, " +
          "logins) work; large ones (file transfer, photo/video upload, TLS) stall.",
        reference: t.name,
      });
    }
  }

  if (strandedClamp) {
    evidence.push({
      dimension: "vpn",
      severity: "warning",
      summary:
        `A change-mss rule exists but only in chain '${clampRules[0].chain}' — ` +
        "transit traffic is clamped in forward/postrouting, not there",
    });
  }

  if (data.pppProfilesMissingMssClamp.length > 0 && tunnels.some((t) => PPP_FAMILY.test(t.type))) {
    evidence.push({
      dimension: "vpn",
      severity: "warning",
      summary: `PPP profile(s) without change-tcp-mss: ${data.pppProfilesMissingMssClamp.join(", ")}`,
      detail:
        "PPP-family tunnels (L2TP/PPTP/SSTP/OpenVPN/PPPoE) clamp MSS through their " +
        "profile. Sessions using these profiles are unprotected.",
    });
  }

  const keepaliveOff = data.wireguardPeers.filter((p) => !p.disabled && p.persistentKeepalive <= 0);
  if (keepaliveOff.length > 0) {
    evidence.push({
      dimension: "vpn",
      severity: "warning",
      summary: `${keepaliveOff.length} WireGuard peer(s) have persistent-keepalive off`,
      detail:
        "NAT and stateful firewalls drop idle UDP mappings after ~30 s. Without " +
        "keepalive the peer becomes unreachable from this side until it transmits.",
      reference: keepaliveOff[0].interface,
    });
  }

  if (
    tunnels.length > 0 &&
    unclamped.length === 0 &&
    oversizedMtu.length === 0 &&
    keepaliveOff.length === 0
  ) {
    evidence.push({
      dimension: "vpn",
      severity: "ok",
      summary: `MTU/MSS sane on all ${tunnels.length} tunnel(s)`,
    });
  }

  return { evidence, unclamped, oversizedMtu, keepaliveOff };
}

/** Suggested MTU for a tunnel type, given the path budget. */
function suggestedMtu(type: string, pppoeWan: boolean): number | undefined {
  const o = tunnelOverhead(type);
  return o ? (pppoeWan ? 1492 : 1500) - o.bytes : undefined;
}

/**
 * The RouterOS command that lowers one tunnel's MTU. Each tunnel type lives in
 * its own menu, so the menu comes from the overhead table rather than being
 * guessed — `/interface ethernet set [find name="gre-1"]` matches nothing.
 * PPP-family tunnels have no `path` and get a pointer instead of a command.
 */
function mtuFixCommand(iface: InterfaceSnapshot, mtu: number): string {
  const o = tunnelOverhead(iface.type);
  if (o?.path) return `${o.path} set [find name="${iface.name}"] mtu=${mtu}`;
  return (
    `# ${iface.name} (${o?.label ?? iface.type}): set max-mtu=${mtu} max-mru=${mtu} on the ` +
    "client interface, or on the server settings for an inbound session"
  );
}

// ── Correlation engine ──────────────────────────────────────────────────────

function correlateRootCauses(
  data: DiagnosticData,
  evidence: Evidence[],
  causes: RootCause[],
): void {
  const criticals = evidence.filter((e) => e.severity === "critical");
  const warnings = evidence.filter((e) => e.severity === "warning");

  // ── Pattern: Interface down → connectivity loss
  const downIfaces = data.interfaces.filter((i) => !i.running && !i.disabled);
  if (downIfaces.length > 0 && data.ping?.lossPct === 100) {
    causes.push({
      cause: "Interface link failure",
      explanation:
        `Interface(s) ${downIfaces.map((i) => i.name).join(", ")} are down. ` +
        "This is the most likely cause of complete connectivity loss. Check physical " +
        "cables, SFP modules, and remote switch ports.",
      confidence: "high",
      evidence: evidence.filter((e) => e.dimension === "interfaces" && e.severity === "critical"),
      fixes: downIfaces.map((i) => `/interface enable [find name="${i.name}"]`),
      dimensions: ["interfaces", "connectivity"],
    });
  }

  // ── Pattern: No default route → no internet
  if (!data.defaultRouteExists) {
    const relEvidence = evidence.filter(
      (e) => e.dimension === "routing" && e.severity === "critical",
    );
    causes.push({
      cause: "Missing default route",
      explanation:
        "No default route (0.0.0.0/0) is present in the routing table. " +
        "Without a default route, the device cannot reach any destination outside " +
        "its directly connected networks. This commonly occurs after a WAN interface " +
        "goes down or a DHCP client loses its lease.",
      confidence: data.ping?.lossPct === 100 ? "high" : "medium",
      evidence: relEvidence,
      fixes: [
        "# Check WAN interface DHCP client:",
        "/ip dhcp-client print",
        "# Or add a static default route:",
        '/ip route add dst-address=0.0.0.0/0 gateway=<WAN-GATEWAY-IP> comment="default route"',
      ],
      dimensions: ["routing"],
    });
  }

  // ── Pattern: OSPF neighbors down → routing convergence failure
  const ospfDown = data.ospfNeighbors.filter((n) => n.state.toLowerCase() !== "full");
  if (ospfDown.length > 0) {
    causes.push({
      cause: "OSPF adjacency failure",
      explanation:
        `${ospfDown.length} OSPF neighbor(s) are not in Full state: ` +
        `${ospfDown.map((n) => `${n.id} (${n.state})`).join(", ")}. ` +
        "This prevents route exchange and can cause reachability loss to remote networks.",
      confidence: ospfDown.length > 1 ? "high" : "medium",
      evidence: evidence.filter((e) => e.dimension === "routing" && e.severity !== "ok"),
      fixes: [
        "/routing ospf neighbor print detail",
        "/routing ospf interface-template print detail",
      ],
      dimensions: ["routing"],
    });
  }

  // ── Pattern: BGP peers down → route loss
  const bgpDown = data.bgpPeers.filter((p) => !p.state.toLowerCase().includes("established"));
  if (bgpDown.length > 0) {
    causes.push({
      cause: "BGP session failure",
      explanation:
        `${bgpDown.length} BGP peer(s) not established: ` +
        `${bgpDown.map((p) => `${p.address} (${p.state})`).join(", ")}. ` +
        "This can cause loss of learned routes and reachability to advertised networks.",
      confidence: "high",
      evidence: evidence.filter((e) => e.dimension === "routing" && e.severity === "critical"),
      fixes: ["/routing bgp session print", "/routing bgp connection print detail"],
      dimensions: ["routing"],
    });
  }

  // ── Pattern: Firewall dropping target traffic
  const blockingRules = data.matchingFilterRules.filter(
    (r) => !r.disabled && (r.action === "drop" || r.action === "reject") && r.packets > 0,
  );
  if (blockingRules.length > 0) {
    const isTarget100Loss = data.ping?.lossPct === 100;
    causes.push({
      cause: "Firewall blocking traffic",
      explanation:
        `${blockingRules.length} firewall rule(s) are actively dropping packets ` +
        `matching the target. Rule(s): ${blockingRules
          .map((r) => `#${r.index} (${r.chain}, ${r.packets} pkts)`)
          .join(", ")}. Review whether these rules are intentional or overly broad.`,
      confidence: isTarget100Loss ? "high" : "medium",
      evidence: evidence.filter((e) => e.dimension === "firewall" && e.severity !== "ok"),
      fixes: blockingRules.map((r) => `/ip firewall filter disable [find where .id=${r.index}]`),
      dimensions: ["firewall"],
    });
  }

  // ── Pattern: No NAT → LAN clients can't reach internet
  const hasMasq = data.natRules.some(
    (r) => (r.action === "masquerade" || r.action === "src-nat") && !r.disabled,
  );
  if (!hasMasq && data.ping?.lossPct === 100 && data.defaultRouteExists) {
    causes.push({
      cause: "Missing source NAT / masquerade",
      explanation:
        "The default route exists but no masquerade or src-nat rule is active. " +
        "LAN clients' private IPs are not being translated, so return traffic from " +
        "the internet has no path back. Add a masquerade rule on the WAN interface.",
      confidence: "medium",
      evidence: evidence.filter((e) => e.dimension === "nat"),
      fixes: [
        '/ip firewall nat add chain=srcnat action=masquerade out-interface=<WAN> comment="masquerade LAN"',
      ],
      dimensions: ["nat"],
    });
  }

  // ── Pattern: DNS failure → name resolution broken
  if (data.dnsResolveResult === "") {
    causes.push({
      cause: "DNS resolution failure",
      explanation:
        "DNS queries are failing. This could be caused by missing DNS servers, " +
        "an unreachable upstream DNS, or a firewall rule blocking UDP/53.",
      confidence: data.dnsServers ? "medium" : "high",
      evidence: evidence.filter((e) => e.dimension === "dns"),
      fixes: data.dnsServers
        ? ["/ip dns print", `/ping ${data.dnsServers.split(",")[0].trim()} count=3`]
        : ["/ip dns set servers=1.1.1.1,8.8.8.8"],
      dimensions: ["dns"],
    });
  }

  // ── Pattern: CPU/memory exhaustion → general degradation
  if (data.cpuLoad > 90 || data.memoryUsedPct > 90) {
    const metric =
      data.cpuLoad > 90 && data.memoryUsedPct > 90
        ? "CPU and memory"
        : data.cpuLoad > 90
          ? "CPU"
          : "Memory";
    causes.push({
      cause: `${metric} exhaustion`,
      explanation:
        `The device's ${metric.toLowerCase()} is critically overloaded ` +
        `(CPU: ${data.cpuLoad}%, memory: ${data.memoryUsedPct}% used). ` +
        "This can cause packet drops, connection timeouts, and general service degradation.",
      confidence: data.ping && data.ping.lossPct > 0 ? "medium" : "low",
      evidence: evidence.filter((e) => e.dimension === "resources" && e.severity !== "ok"),
      fixes: [
        "/system resource print",
        "/tool profile cpu=all duration=5",
        "/ip firewall connection print count-only",
      ],
      dimensions: ["resources"],
    });
  }

  // ── Pattern: ARP incomplete → L2 issue (only for local/private targets)
  if (isIpAddress(data.target) && isPrivateIp(data.target)) {
    const arp = data.arpEntries.find((e) => e.address === data.target);
    if (arp && !arp.complete && data.ping?.lossPct === 100) {
      causes.push({
        cause: "ARP resolution failure (Layer 2)",
        explanation:
          `The ARP entry for ${data.target} is incomplete — the device is not responding ` +
          `to ARP requests on interface ${arp.interface}. This indicates a Layer 2 issue: ` +
          "the target device may be powered off, on a different VLAN, or the cable is disconnected.",
        confidence: "high",
        evidence: evidence.filter((e) => e.dimension === "arp_dhcp" && e.severity !== "ok"),
        fixes: [`/ping ${data.target} count=3`, `/ip arp print where address="${data.target}"`],
        dimensions: ["arp_dhcp"],
      });
    }
  }

  // ── Pattern: Tunnel down → VPN connectivity loss
  // Exclude server-side bindings (*-in types) — they're idle, not broken.
  const isServerTunnel = (t: InterfaceSnapshot): boolean =>
    /-(in|server)$/.test(t.type) || t.name.startsWith("<");
  const realDownTunnels = data.tunnelInterfaces.filter(
    (t) => !t.running && !t.disabled && !isServerTunnel(t),
  );
  if (realDownTunnels.length > 0) {
    causes.push({
      cause: "VPN/tunnel interface down",
      explanation:
        `Tunnel(s) ${realDownTunnels.map((t) => `${t.name} (${t.type})`).join(", ")} are down. ` +
        "Traffic destined for remote networks over these tunnels will be black-holed.",
      confidence: "high",
      evidence: evidence.filter((e) => e.dimension === "vpn" && e.severity === "critical"),
      fixes: realDownTunnels.map((t) => `/interface enable [find name="${t.name}"]`),
      dimensions: ["vpn"],
    });
  }

  // ── Pattern: MTU/MSS mismatch → tunnel black-holes large packets
  // Recomputed rather than threaded through — analyzeTunnelMtu is pure and the
  // interface list is a handful of rows.
  const mtu = analyzeTunnelMtu(data);
  const pppoeWan = data.interfaces.some((i) => i.type.toLowerCase().includes("pppoe"));
  if (mtu.unclamped.length > 0 || mtu.oversizedMtu.length > 0) {
    const names = [
      ...new Set([...mtu.unclamped, ...mtu.oversizedMtu.map((o) => o.iface)].map((t) => t.name)),
    ];
    // Reachable-but-broken is the signature: small packets pass, large ones die.
    const bothProblems = mtu.unclamped.length > 0 && mtu.oversizedMtu.length > 0;
    const pingOk = data.ping?.lossPct === 0;
    causes.push({
      cause: "MTU/MSS black hole on tunnel",
      explanation:
        `Tunnel(s) ${names.join(", ")} carry traffic larger than the path can deliver. ` +
        "Encapsulation shrinks the usable MTU, but hosts still negotiate a TCP MSS from " +
        "their own LAN MTU and set the don't-fragment bit; transit routers drop the " +
        "oversized packets and the ICMP 'fragmentation needed' reply is commonly filtered, " +
        "so the sender never learns to back off. The result is a tunnel that pings clean " +
        "and passes logins while file transfers, media uploads and some HTTPS sites hang.",
      confidence: bothProblems || pingOk ? "high" : "medium",
      evidence: mtu.evidence.filter((e) => e.severity === "warning"),
      fixes: [
        ...mtu.oversizedMtu.map((o) =>
          mtuFixCommand(o.iface, suggestedMtu(o.iface.type, pppoeWan) ?? o.budget),
        ),
        ...(mtu.unclamped.length > 0
          ? [
              "# Clamp TCP MSS for every forwarded flow (covers all tunnel types):",
              "/ip firewall mangle add chain=forward protocol=tcp tcp-flags=syn " +
                'tcp-mss=1400-65535 action=change-mss new-mss=clamp-to-pmtu comment="clamp MSS to PMTU"',
              "# PPP-family tunnels (L2TP/PPTP/SSTP/OVPN) can clamp via their profile instead:",
              "/ppp profile set [find] change-tcp-mss=yes",
            ]
          : []),
      ],
      dimensions: ["vpn", "firewall"],
    });
  }

  // ── Pattern: WireGuard peer with no keepalive → NAT mapping expires
  if (mtu.keepaliveOff.length > 0) {
    causes.push({
      cause: "WireGuard peer unreachable after idle (no persistent-keepalive)",
      explanation:
        `${mtu.keepaliveOff.length} enabled peer(s) have persistent-keepalive off: ` +
        `${mtu.keepaliveOff.map((p) => `${p.interface}/${p.publicKey.slice(0, 12)}…`).join(", ")}. ` +
        "WireGuard is silent when idle, so the NAT/firewall mapping the peer punched " +
        "expires (typically ~30 s) and this side can no longer initiate. The tunnel " +
        "appears to work whenever the peer starts the traffic and to be down otherwise.",
      confidence: "medium",
      evidence: evidence.filter((e) => e.dimension === "vpn" && e.severity === "warning"),
      fixes: mtu.keepaliveOff.map(
        (p) =>
          `/interface wireguard peers set [find public-key="${p.publicKey}"] persistent-keepalive=25s`,
      ),
      dimensions: ["vpn"],
    });
  }

  // ── Pattern: Interface flapping → intermittent loss
  const flapping = data.interfaces.filter((i) => i.linkDowns > 5 && i.running);
  if (flapping.length > 0 && data.ping && data.ping.lossPct > 0 && data.ping.lossPct < 100) {
    causes.push({
      cause: "Interface link flapping",
      explanation:
        `Interface(s) ${flapping.map((i) => `${i.name} (${i.linkDowns} link-downs)`).join(", ")} ` +
        "show excessive link transitions. This causes intermittent packet loss as the " +
        "link repeatedly goes up and down. Check cables, SFPs, and switch port settings.",
      confidence: "medium",
      evidence: evidence.filter((e) => e.dimension === "interfaces" && e.severity === "warning"),
      fixes: flapping.map((i) => `/interface monitor ${i.name} once`),
      dimensions: ["interfaces", "connectivity"],
    });
  }

  // ── Fallback: no strong root cause found
  if (causes.length === 0 && criticals.length === 0 && warnings.length === 0) {
    causes.push({
      cause: "No anomalies detected",
      explanation:
        "All diagnostic dimensions appear healthy. The issue may be transient, " +
        "external to this device, or require deeper inspection of specific traffic flows.",
      confidence: "low",
      evidence: [],
      fixes: [],
      dimensions: [],
    });
  } else if (causes.length === 0 && (criticals.length > 0 || warnings.length > 0)) {
    causes.push({
      cause: "Multiple anomalies — manual investigation needed",
      explanation:
        `Found ${criticals.length} critical and ${warnings.length} warning indicators ` +
        "but no single clear root cause pattern. Review the evidence below and " +
        "investigate the critical findings first.",
      confidence: "low",
      evidence: [...criticals, ...warnings],
      fixes: [],
      dimensions: [...new Set([...criticals, ...warnings].map((e) => e.dimension))],
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRule(r: FirewallRuleSnapshot): string {
  const parts = [`chain=${r.chain}`, `action=${r.action}`];
  if (r.srcAddress) parts.push(`src=${r.srcAddress}`);
  if (r.dstAddress) parts.push(`dst=${r.dstAddress}`);
  if (r.protocol) parts.push(`proto=${r.protocol}`);
  if (r.dstPort) parts.push(`port=${r.dstPort}`);
  parts.push(`pkts=${r.packets}`);
  if (r.comment) parts.push(`"${r.comment}"`);
  return parts.join(" ");
}

// ── Report renderer ─────────────────────────────────────────────────────────

export function renderDiagnosisReport(report: DiagnosisReport, device: string): string {
  const lines: string[] = [];

  lines.push("╔═══════════════════════════════════════════════════════════════╗");
  lines.push("║            INTELLIGENT ROOT-CAUSE ANALYSIS                  ║");
  lines.push("╚═══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`  Device:    ${device}`);
  lines.push(`  Target:    ${report.target}`);
  lines.push(`  Time:      ${report.timestamp}`);
  lines.push("");

  // Dimension health matrix
  lines.push("── DIAGNOSTIC DIMENSIONS ──────────────────────────────────────");
  for (const dim of report.dimensionSummary) {
    const icon =
      dim.status === "ok"
        ? " OK "
        : dim.status === "critical"
          ? "CRIT"
          : dim.status === "warning"
            ? "WARN"
            : "INFO";
    lines.push(`  ${icon}  ${dim.label}`);
  }
  lines.push("");

  // Root causes
  if (report.rootCauses.length > 0) {
    lines.push("── ROOT CAUSE ANALYSIS ────────────────────────────────────────");
    for (let i = 0; i < report.rootCauses.length; i++) {
      const rc = report.rootCauses[i];
      const conf = rc.confidence.toUpperCase();
      lines.push("");
      lines.push(`  #${i + 1} [${conf} CONFIDENCE] ${rc.cause}`);
      lines.push(`     ${rc.explanation}`);

      if (rc.evidence.length > 0) {
        lines.push("     Evidence:");
        for (const e of rc.evidence.slice(0, 5)) {
          lines.push(`       - ${e.summary}`);
        }
      }

      if (rc.fixes.length > 0) {
        lines.push("     Fix commands:");
        for (const f of rc.fixes) {
          lines.push(`       ${f}`);
        }
      }
    }
    lines.push("");
  }

  // All evidence (detailed)
  lines.push("── EVIDENCE LOG ───────────────────────────────────────────────");
  for (const e of report.allEvidence) {
    const sev =
      e.severity === "ok"
        ? " OK "
        : e.severity === "critical"
          ? "CRIT"
          : e.severity === "warning"
            ? "WARN"
            : "INFO";
    lines.push(
      `  ${sev}  [${DIMENSION_LABELS[e.dimension].substring(0, 16).padEnd(16)}]  ${e.summary}`,
    );
    if (e.detail) {
      for (const dl of e.detail.split("\n")) {
        lines.push(`        ${dl}`);
      }
    }
  }

  return lines.join("\n");
}
