/**
 * Compliance audit engine — pure analysis, zero device I/O.
 *
 * Receives an already-fetched {@link DeviceComplianceState} and evaluates 31
 * security checks across 9 categories, producing a scored report with
 * per-check pass/fail/warn status, details, and RouterOS fix commands.
 *
 * The tool layer (`src/tools/compliance-audit.ts`) handles fetching; this
 * module is intentionally import-free of `connector.ts` so it stays testable
 * without a live device.
 */
import { isYes } from "../utils/yes";

// ── Severity & Scoring ──────────────────────────────────────────────────────

export type ComplianceSeverity = "critical" | "high" | "medium" | "low";

export const SEVERITY_WEIGHT: Record<ComplianceSeverity, number> = {
  critical: 10,
  high: 5,
  medium: 3,
  low: 1,
};

const SEVERITY_ORDER: Record<ComplianceSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Categories ──────────────────────────────────────────────────────────────

export const COMPLIANCE_CATEGORIES = [
  "ssh_security",
  "management_services",
  "firewall_posture",
  "user_security",
  "dns_security",
  "certificate_health",
  "network_services",
  "snmp_security",
  "system_hardening",
  "vpn_security",
] as const;

export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ComplianceCategory, string> = {
  ssh_security: "SSH Security",
  management_services: "Management Services",
  firewall_posture: "Firewall Posture",
  user_security: "User Security",
  dns_security: "DNS Security",
  certificate_health: "Certificate Health",
  network_services: "Network Services",
  snmp_security: "SNMP Security",
  system_hardening: "System Hardening",
  vpn_security: "VPN Security",
};

// ── Check result types ──────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  status: CheckStatus;
  /** One-line label shown after the status icon. */
  label: string;
  /** Extra context shown on failure/warn. */
  detail?: string;
  /** Suggested RouterOS fix command. */
  fix?: string;
}

export interface ComplianceCheck {
  id: string;
  category: ComplianceCategory;
  severity: ComplianceSeverity;
  title: string;
  evaluate: (state: DeviceComplianceState) => CheckResult;
}

// ── Device state (populated by the tool layer) ──────────────────────────────

export interface CertInfo {
  name: string;
  daysLeft: number | null;
}

export interface DeviceComplianceState {
  ssh: Record<string, string>;
  services: Record<string, string>[];
  firewallFilter: Record<string, string>[];
  users: Record<string, string>[];
  dns: Record<string, string>;
  certificates: CertInfo[];
  upnp: string;
  socks: string;
  proxy: string;
  macServer: string;
  macWinbox: string;
  identity: Record<string, string>;
  ntpClient: string;
  discoverySettings: string;
  bandwidthServer: string;
  pptpServer: string;
  snmp: string;
  snmpCommunity: Record<string, string>[];
}

// ── Report types ────────────────────────────────────────────────────────────

export interface ComplianceScore {
  earned: number;
  total: number;
  percentage: number;
  grade: string;
}

export interface EvaluatedCheck {
  check: Omit<ComplianceCheck, "evaluate">;
  result: CheckResult;
}

export interface CategoryReport {
  category: ComplianceCategory;
  label: string;
  passCount: number;
  totalCount: number;
  findings: EvaluatedCheck[];
}

export interface ComplianceReport {
  score: ComplianceScore;
  totalChecks: number;
  passCount: number;
  failCount: number;
  warnCount: number;
  skipCount: number;
  categories: CategoryReport[];
  evaluatedChecks: EvaluatedCheck[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True when raw `print` text contains `enabled: yes` or `enabled=yes`. */
function textHasEnabled(text: string): boolean {
  return /enabled\s*[=:]\s*yes/i.test(text);
}

/** Find a service row by name. */
function findService(
  services: Record<string, string>[],
  name: string,
): Record<string, string> | undefined {
  return services.find((s) => s.name === name);
}

/** True when a service row is disabled (X flag or disabled=true/yes). */
function serviceDisabled(row: Record<string, string>): boolean {
  return (row.flags ?? "").includes("X") || isYes(row.disabled);
}

function letterGrade(pct: number): string {
  if (pct >= 97) return "A+";
  if (pct >= 93) return "A";
  if (pct >= 90) return "A-";
  if (pct >= 87) return "B+";
  if (pct >= 83) return "B";
  if (pct >= 80) return "B-";
  if (pct >= 70) return "C";
  if (pct >= 60) return "D";
  return "F";
}

const SEV_TAG: Record<ComplianceSeverity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
};

// ── All 31 checks ──────────────────────────────────────────────────────────

export const ALL_CHECKS: ComplianceCheck[] = [
  // ── SSH Security ────────────────────────────────────────────────────────
  {
    id: "ssh-strong-crypto",
    category: "ssh_security",
    severity: "high",
    title: "Strong crypto enabled",
    evaluate: (s) => {
      const v = s.ssh["strong-crypto"];
      if (v === undefined) return { status: "skip", label: "SSH settings not available" };
      return isYes(v)
        ? { status: "pass", label: "Strong crypto enabled" }
        : {
            status: "fail",
            label: "Strong crypto disabled",
            detail: `strong-crypto=${v}`,
            fix: "/ip ssh set strong-crypto=yes",
          };
    },
  },
  {
    id: "ssh-none-crypto",
    category: "ssh_security",
    severity: "critical",
    title: "None-crypto disabled",
    evaluate: (s) => {
      const v = s.ssh["allow-none-crypto"];
      if (v === undefined) return { status: "skip", label: "SSH settings not available" };
      return isYes(v)
        ? {
            status: "fail",
            label: "allow-none-crypto is enabled — connections without encryption are accepted",
            detail: `allow-none-crypto=${v}`,
            fix: "/ip ssh set allow-none-crypto=no",
          }
        : { status: "pass", label: "None-crypto disabled" };
    },
  },
  {
    id: "ssh-forwarding",
    category: "ssh_security",
    severity: "medium",
    title: "SSH forwarding disabled",
    evaluate: (s) => {
      const v = s.ssh["forwarding-enabled"];
      if (v === undefined) return { status: "skip", label: "SSH settings not available" };
      const t = v.trim().toLowerCase();
      if (t === "no") return { status: "pass", label: "SSH forwarding disabled" };
      return {
        status: t === "local" ? "warn" : "fail",
        label: `SSH forwarding enabled (${v})`,
        detail: `forwarding-enabled=${v}`,
        fix: "/ip ssh set forwarding-enabled=no",
      };
    },
  },
  {
    id: "ssh-host-key-type",
    category: "ssh_security",
    severity: "low",
    title: "Host key type is Ed25519",
    evaluate: (s) => {
      const v = s.ssh["host-key-type"];
      if (v === undefined) return { status: "skip", label: "SSH settings not available" };
      const t = v.trim().toLowerCase();
      if (t === "ed25519") return { status: "pass", label: "Host key type is Ed25519" };
      return {
        status: "warn",
        label: `Host key type is ${v} (consider Ed25519)`,
        detail: `host-key-type=${v}`,
        fix: "/ip ssh set host-key-type=ed25519",
      };
    },
  },

  // ── Management Services ─────────────────────────────────────────────────
  {
    id: "svc-telnet-disabled",
    category: "management_services",
    severity: "critical",
    title: "Telnet disabled",
    evaluate: (s) => {
      const row = findService(s.services, "telnet");
      if (!row) return { status: "pass", label: "Telnet service not present" };
      return serviceDisabled(row)
        ? { status: "pass", label: "Telnet disabled" }
        : {
            status: "fail",
            label: "Telnet enabled — cleartext management protocol",
            fix: "/ip service disable telnet",
          };
    },
  },
  {
    id: "svc-ftp-disabled",
    category: "management_services",
    severity: "high",
    title: "FTP disabled",
    evaluate: (s) => {
      const row = findService(s.services, "ftp");
      if (!row) return { status: "pass", label: "FTP service not present" };
      return serviceDisabled(row)
        ? { status: "pass", label: "FTP disabled" }
        : {
            status: "fail",
            label: "FTP enabled — cleartext file transfer protocol",
            fix: "/ip service disable ftp",
          };
    },
  },
  {
    id: "svc-api-ssl",
    category: "management_services",
    severity: "high",
    title: "API uses SSL",
    evaluate: (s) => {
      const api = findService(s.services, "api");
      const apiSsl = findService(s.services, "api-ssl");
      if (!api) return { status: "pass", label: "API service not present" };
      if (serviceDisabled(api)) return { status: "pass", label: "API disabled" };
      if (apiSsl && !serviceDisabled(apiSsl))
        return {
          status: "warn",
          label: "Both API and API-SSL enabled — disable plaintext API",
          fix: "/ip service disable api",
        };
      return {
        status: "fail",
        label: "API enabled without API-SSL — cleartext API access",
        fix: "/ip service disable api",
      };
    },
  },
  {
    id: "svc-www-disabled",
    category: "management_services",
    severity: "high",
    title: "HTTP management disabled",
    evaluate: (s) => {
      const row = findService(s.services, "www");
      if (!row) return { status: "pass", label: "HTTP service not present" };
      return serviceDisabled(row)
        ? { status: "pass", label: "HTTP management disabled" }
        : {
            status: "fail",
            label: "HTTP management enabled — cleartext web interface",
            fix: "/ip service disable www",
          };
    },
  },
  {
    id: "svc-winbox-restricted",
    category: "management_services",
    severity: "medium",
    title: "Winbox has address restriction",
    evaluate: (s) => {
      const row = findService(s.services, "winbox");
      if (!row) return { status: "pass", label: "Winbox service not present" };
      if (serviceDisabled(row)) return { status: "pass", label: "Winbox disabled" };
      const addr = (row.address ?? "").trim();
      return addr
        ? { status: "pass", label: `Winbox restricted to ${addr}` }
        : {
            status: "warn",
            label: "Winbox has no address restriction — accessible from any IP",
            detail: "Set an address restriction to limit management access",
          };
    },
  },
  {
    id: "svc-btest-disabled",
    category: "management_services",
    severity: "medium",
    title: "Bandwidth-test server disabled",
    evaluate: (s) => {
      if (!s.bandwidthServer)
        return { status: "skip", label: "Bandwidth-test server settings not available" };
      return textHasEnabled(s.bandwidthServer)
        ? {
            status: "warn",
            label: "Bandwidth-test server enabled — can be abused for DDoS amplification",
            fix: "/tool bandwidth-server set enabled=no",
          }
        : { status: "pass", label: "Bandwidth-test server disabled" };
    },
  },
  {
    id: "svc-ssh-restricted",
    category: "management_services",
    severity: "medium",
    title: "SSH has address restriction",
    evaluate: (s) => {
      const row = findService(s.services, "ssh");
      if (!row) return { status: "pass", label: "SSH service not present" };
      if (serviceDisabled(row)) return { status: "pass", label: "SSH disabled" };
      const addr = (row.address ?? "").trim();
      return addr
        ? { status: "pass", label: `SSH restricted to ${addr}` }
        : {
            status: "warn",
            label: "SSH has no address restriction — accessible from any IP including WAN",
            detail: "Set an address restriction to limit SSH access to management subnets",
          };
    },
  },
  {
    id: "svc-www-ssl-restricted",
    category: "management_services",
    severity: "medium",
    title: "HTTPS management restricted",
    evaluate: (s) => {
      const row = findService(s.services, "www-ssl");
      if (!row) return { status: "pass", label: "HTTPS service not present" };
      if (serviceDisabled(row)) return { status: "pass", label: "HTTPS management disabled" };
      const addr = (row.address ?? "").trim();
      return addr
        ? { status: "pass", label: `HTTPS restricted to ${addr}` }
        : {
            status: "warn",
            label: "HTTPS management has no address restriction — WebFig accessible from WAN",
            detail: "Set an address restriction to limit HTTPS management access",
          };
    },
  },

  // ── Firewall Posture ────────────────────────────────────────────────────
  {
    id: "fw-input-rules-exist",
    category: "firewall_posture",
    severity: "critical",
    title: "Input chain has rules",
    evaluate: (s) => {
      const inputRules = s.firewallFilter.filter((r) => r.chain === "input");
      return inputRules.length > 0
        ? { status: "pass", label: `Input chain has ${inputRules.length} rule(s)` }
        : {
            status: "fail",
            label: "No input chain rules — router management ports are wide open",
          };
    },
  },
  {
    id: "fw-input-default-drop",
    category: "firewall_posture",
    severity: "critical",
    title: "Input chain has default drop",
    evaluate: (s) => {
      const inputRules = s.firewallFilter.filter((r) => r.chain === "input");
      if (inputRules.length === 0) return { status: "fail", label: "No input chain rules at all" };
      const hasDrop = inputRules.some((r) => {
        const action = (r.action ?? "").toLowerCase();
        if (action !== "drop" && action !== "reject") return false;
        // A catch-all has no narrowing match conditions
        const narrowing = [
          "src-address",
          "dst-address",
          "protocol",
          "dst-port",
          "src-port",
          "in-interface",
          "in-interface-list",
        ];
        return narrowing.every((k) => !r[k]);
      });
      return hasDrop
        ? { status: "pass", label: "Input chain has default drop/reject" }
        : {
            status: "fail",
            label: "Input chain has no catch-all drop — unlisted traffic is accepted",
            fix: '/ip firewall filter add chain=input action=drop comment="compliance: default drop"',
          };
    },
  },
  {
    id: "fw-established-accept",
    category: "firewall_posture",
    severity: "high",
    title: "Established/related connections accepted",
    evaluate: (s) => {
      const inputRules = s.firewallFilter.filter((r) => r.chain === "input");
      if (inputRules.length === 0)
        return {
          status: "fail",
          label: "No input chain rules at all",
        };
      const hasEstablished = inputRules.some((r) => {
        const action = (r.action ?? "").toLowerCase();
        const cs = (r["connection-state"] ?? "").toLowerCase();
        return action === "accept" && cs.includes("established");
      });
      return hasEstablished
        ? { status: "pass", label: "Established/related connections accepted" }
        : {
            status: "fail",
            label: "No rule accepting established/related connections on input chain",
            fix: "/ip firewall filter add chain=input action=accept connection-state=established,related,untracked place-before=0",
          };
    },
  },
  {
    id: "fw-forward-rules-exist",
    category: "firewall_posture",
    severity: "medium",
    title: "Forward chain has rules",
    evaluate: (s) => {
      const fwdRules = s.firewallFilter.filter((r) => r.chain === "forward");
      return fwdRules.length > 0
        ? { status: "pass", label: `Forward chain has ${fwdRules.length} rule(s)` }
        : {
            status: "warn",
            label: "No forward chain rules — all transit traffic is allowed",
          };
    },
  },
  {
    id: "fw-forward-default-drop",
    category: "firewall_posture",
    severity: "high",
    title: "Forward chain has default drop",
    evaluate: (s) => {
      const fwdRules = s.firewallFilter.filter((r) => r.chain === "forward");
      if (fwdRules.length === 0) return { status: "fail", label: "No forward chain rules at all" };
      const hasDrop = fwdRules.some((r) => {
        const action = (r.action ?? "").toLowerCase();
        if (action !== "drop" && action !== "reject") return false;
        const narrowing = [
          "src-address",
          "dst-address",
          "protocol",
          "dst-port",
          "src-port",
          "in-interface",
          "in-interface-list",
          "out-interface",
          "out-interface-list",
        ];
        return narrowing.every((k) => !r[k]);
      });
      return hasDrop
        ? { status: "pass", label: "Forward chain has default drop/reject" }
        : {
            status: "fail",
            label: "Forward chain has no catch-all drop — unlisted transit traffic is accepted",
            fix: '/ip firewall filter add chain=forward action=drop comment="compliance: default forward drop"',
          };
    },
  },

  // ── User Security ──────────────────────────────────────────────────────
  {
    id: "user-default-admin",
    category: "user_security",
    severity: "high",
    title: "Default admin account disabled",
    evaluate: (s) => {
      const admin = s.users.find((u) => u.name === "admin");
      if (!admin) return { status: "pass", label: "Default admin user does not exist" };
      if (serviceDisabled(admin))
        return { status: "pass", label: "Default admin user is disabled" };
      return {
        status: "fail",
        label: "Default admin user is active — well-known target for brute-force",
        detail: "Create a new admin user, then disable the default one",
      };
    },
  },
  {
    id: "user-full-no-address",
    category: "user_security",
    severity: "medium",
    title: "Full-access users have address restriction",
    evaluate: (s) => {
      const fullUsers = s.users.filter(
        (u) => (u.group ?? "").toLowerCase() === "full" && !serviceDisabled(u),
      );
      if (fullUsers.length === 0) return { status: "pass", label: "No active full-access users" };
      const unrestricted = fullUsers.filter((u) => !(u.address ?? "").trim());
      return unrestricted.length === 0
        ? { status: "pass", label: "All full-access users have address restrictions" }
        : {
            status: "warn",
            label: `${unrestricted.length} full-access user(s) without address restriction: ${unrestricted.map((u) => u.name).join(", ")}`,
            detail: "Restrict the allowed login source addresses for each user",
          };
    },
  },
  {
    id: "user-multiple-full",
    category: "user_security",
    severity: "low",
    title: "Minimal full-access users",
    evaluate: (s) => {
      const fullUsers = s.users.filter(
        (u) => (u.group ?? "").toLowerCase() === "full" && !serviceDisabled(u),
      );
      return fullUsers.length <= 1
        ? { status: "pass", label: `${fullUsers.length} full-access user(s)` }
        : {
            status: "warn",
            label: `${fullUsers.length} full-access users: ${fullUsers.map((u) => u.name).join(", ")}`,
            detail: "Consider reducing to a single admin and using read/write groups for others",
          };
    },
  },

  // ── DNS Security ───────────────────────────────────────────────────────
  {
    id: "dns-no-open-resolver",
    category: "dns_security",
    severity: "critical",
    title: "Not an open DNS resolver",
    evaluate: (s) => {
      const v = s.dns["allow-remote-requests"];
      if (v === undefined) return { status: "skip", label: "DNS settings not available" };
      return isYes(v)
        ? {
            status: "fail",
            label: "allow-remote-requests is enabled — open DNS resolver (DDoS amplification risk)",
            detail: `allow-remote-requests=${v}`,
            fix: "/ip dns set allow-remote-requests=no",
          }
        : { status: "pass", label: "Not an open DNS resolver" };
    },
  },
  {
    id: "dns-servers-configured",
    category: "dns_security",
    severity: "medium",
    title: "DNS servers explicitly configured",
    evaluate: (s) => {
      const servers = (s.dns.servers ?? "").trim();
      return servers
        ? { status: "pass", label: `DNS servers: ${servers}` }
        : {
            status: "warn",
            label: "No DNS servers configured — using ISP defaults",
            detail: "Set explicit DNS servers (e.g. 1.1.1.1, 8.8.8.8)",
          };
    },
  },

  // ── Certificate Health ─────────────────────────────────────────────────
  {
    id: "cert-no-expired",
    category: "certificate_health",
    severity: "high",
    title: "No expired certificates",
    evaluate: (s) => {
      const expired = s.certificates.filter((c) => c.daysLeft !== null && c.daysLeft < 0);
      return expired.length === 0
        ? { status: "pass", label: "No expired certificates" }
        : {
            status: "fail",
            label: `${expired.length} expired certificate(s): ${expired.map((c) => c.name).join(", ")}`,
            detail: "Remove or renew expired certificates",
          };
    },
  },
  {
    id: "cert-not-expiring-soon",
    category: "certificate_health",
    severity: "medium",
    title: "No certificates expiring within 30 days",
    evaluate: (s) => {
      const expiring = s.certificates.filter(
        (c) => c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= 30,
      );
      return expiring.length === 0
        ? { status: "pass", label: "No certificates expiring within 30 days" }
        : {
            status: "warn",
            label: `${expiring.length} certificate(s) expiring soon: ${expiring.map((c) => `${c.name} (${c.daysLeft}d)`).join(", ")}`,
            detail: "Renew certificates before they expire",
          };
    },
  },

  // ── Network Services ──────────────────────────────────────────────────
  {
    id: "net-upnp-disabled",
    category: "network_services",
    severity: "high",
    title: "UPnP disabled",
    evaluate: (s) => {
      if (!s.upnp) return { status: "skip", label: "UPnP settings not available" };
      return textHasEnabled(s.upnp)
        ? {
            status: "fail",
            label: "UPnP enabled — allows untrusted devices to open firewall ports",
            fix: "/ip upnp set enabled=no",
          }
        : { status: "pass", label: "UPnP disabled" };
    },
  },
  {
    id: "net-socks-disabled",
    category: "network_services",
    severity: "high",
    title: "SOCKS proxy disabled",
    evaluate: (s) => {
      if (!s.socks) return { status: "skip", label: "SOCKS settings not available" };
      return textHasEnabled(s.socks)
        ? {
            status: "fail",
            label: "SOCKS proxy enabled — can be abused as an open proxy",
            fix: "/ip socks set enabled=no",
          }
        : { status: "pass", label: "SOCKS proxy disabled" };
    },
  },
  {
    id: "net-proxy-disabled",
    category: "network_services",
    severity: "medium",
    title: "Web proxy disabled",
    evaluate: (s) => {
      if (!s.proxy) return { status: "skip", label: "Web proxy settings not available" };
      return textHasEnabled(s.proxy)
        ? {
            status: "warn",
            label: "Web proxy enabled — ensure it is intentional and access-restricted",
            fix: "/ip proxy set enabled=no",
          }
        : { status: "pass", label: "Web proxy disabled" };
    },
  },
  {
    id: "net-mac-server-restricted",
    category: "network_services",
    severity: "medium",
    title: "MAC server restricted",
    evaluate: (s) => {
      if (!s.macServer) return { status: "skip", label: "MAC server settings not available" };
      return /allowed-interface-list\s*[=:]\s*all/i.test(s.macServer)
        ? {
            status: "warn",
            label: "MAC server allowed on all interfaces — restrict to management only",
            fix: "/tool mac-server set allowed-interface-list=none",
          }
        : { status: "pass", label: "MAC server interface-restricted" };
    },
  },
  {
    id: "net-mac-winbox-restricted",
    category: "network_services",
    severity: "medium",
    title: "MAC Winbox restricted",
    evaluate: (s) => {
      if (!s.macWinbox) return { status: "skip", label: "MAC Winbox settings not available" };
      return /allowed-interface-list\s*[=:]\s*all/i.test(s.macWinbox)
        ? {
            status: "warn",
            label: "MAC Winbox allowed on all interfaces — restrict to management only",
            fix: "/tool mac-server mac-winbox set allowed-interface-list=none",
          }
        : { status: "pass", label: "MAC Winbox interface-restricted" };
    },
  },

  // ── SNMP Security ───────────────────────────────────────────────────
  {
    id: "snmp-disabled",
    category: "snmp_security",
    severity: "high",
    title: "SNMP disabled or restricted",
    evaluate: (s) => {
      if (!s.snmp) return { status: "skip", label: "SNMP settings not available" };
      return textHasEnabled(s.snmp)
        ? {
            status: "warn",
            label: "SNMP enabled — ensure it is intentional and access-restricted",
            detail: "If SNMP is not needed, disable it to reduce the attack surface",
            fix: "/snmp set enabled=no",
          }
        : { status: "pass", label: "SNMP disabled" };
    },
  },
  {
    id: "snmp-community-not-default",
    category: "snmp_security",
    severity: "critical",
    title: "No default SNMP community strings",
    evaluate: (s) => {
      if (!s.snmp || !textHasEnabled(s.snmp)) return { status: "skip", label: "SNMP not enabled" };
      if (s.snmpCommunity.length === 0)
        return { status: "skip", label: "No SNMP communities configured" };
      const defaults = ["public", "private"];
      const weak = s.snmpCommunity.filter((c) => {
        const name = (c.name ?? "").trim().toLowerCase();
        return defaults.includes(name);
      });
      return weak.length === 0
        ? { status: "pass", label: "No default community strings" }
        : {
            status: "fail",
            label: `Default SNMP community string(s): ${weak.map((c) => c.name).join(", ")} — trivially guessable`,
            detail: "Change or remove default community strings (public/private)",
            fix: `/snmp community set [find name="public"] name=<your-secret>`,
          };
    },
  },
  {
    id: "snmp-write-disabled",
    category: "snmp_security",
    severity: "high",
    title: "SNMP write access disabled",
    evaluate: (s) => {
      if (!s.snmp || !textHasEnabled(s.snmp)) return { status: "skip", label: "SNMP not enabled" };
      if (s.snmpCommunity.length === 0)
        return { status: "skip", label: "No SNMP communities configured" };
      const writable = s.snmpCommunity.filter((c) => {
        const access = (c["read-access"] ?? c.security ?? "").toLowerCase();
        const writeAccess = (c["write-access"] ?? "").toLowerCase();
        return writeAccess === "yes" || access === "read-write";
      });
      return writable.length === 0
        ? { status: "pass", label: "No SNMP communities have write access" }
        : {
            status: "fail",
            label: `${writable.length} SNMP community(s) with write access — remote config modification possible`,
            detail: "Disable write access unless absolutely required",
          };
    },
  },

  // ── System Hardening ──────────────────────────────────────────────────
  {
    id: "sys-identity-changed",
    category: "system_hardening",
    severity: "low",
    title: "System identity changed from default",
    evaluate: (s) => {
      const name = (s.identity.name ?? "").trim();
      if (!name) return { status: "skip", label: "System identity not available" };
      return name.toLowerCase() === "mikrotik"
        ? {
            status: "warn",
            label: 'System identity is default "MikroTik" — reveals device vendor',
            fix: "/system identity set name=my-router",
          }
        : { status: "pass", label: `System identity: ${name}` };
    },
  },
  {
    id: "sys-ntp-configured",
    category: "system_hardening",
    severity: "medium",
    title: "NTP client configured",
    evaluate: (s) => {
      if (!s.ntpClient) return { status: "skip", label: "NTP client settings not available" };
      return textHasEnabled(s.ntpClient)
        ? { status: "pass", label: "NTP client enabled" }
        : {
            status: "warn",
            label: "NTP client not enabled — clock may drift, breaking TLS/certs/logs",
            fix: "/system ntp client set enabled=yes",
          };
    },
  },
  {
    id: "sys-discovery-restricted",
    category: "system_hardening",
    severity: "medium",
    title: "Neighbor discovery restricted",
    evaluate: (s) => {
      if (!s.discoverySettings)
        return { status: "skip", label: "Discovery settings not available" };
      return /discover-interface-list\s*[=:]\s*all/i.test(s.discoverySettings)
        ? {
            status: "warn",
            label: "Neighbor discovery enabled on all interfaces — exposes device info on WAN",
            fix: "/ip neighbor discovery-settings set discover-interface-list=none",
          }
        : { status: "pass", label: "Neighbor discovery interface-restricted" };
    },
  },

  // ── VPN Security ──────────────────────────────────────────────────────
  {
    id: "vpn-pptp-disabled",
    category: "vpn_security",
    severity: "high",
    title: "PPTP server disabled",
    evaluate: (s) => {
      if (!s.pptpServer) return { status: "skip", label: "PPTP server settings not available" };
      return textHasEnabled(s.pptpServer)
        ? {
            status: "fail",
            label: "PPTP server enabled — known broken cryptography (MS-CHAPv2/MPPE)",
            fix: "/interface pptp-server server set enabled=no",
          }
        : { status: "pass", label: "PPTP server disabled" };
    },
  },
];

// ── Scoring ─────────────────────────────────────────────────────────────────

export function computeScore(results: EvaluatedCheck[]): ComplianceScore {
  let earned = 0;
  let total = 0;
  for (const r of results) {
    if (r.result.status === "skip") continue;
    const weight = SEVERITY_WEIGHT[r.check.severity];
    total += weight;
    if (r.result.status === "pass") earned += weight;
  }
  const percentage = total > 0 ? Math.round((earned / total) * 100) : 100;
  return { earned, total, percentage, grade: letterGrade(percentage) };
}

// ── Main entry point ────────────────────────────────────────────────────────

export function runComplianceAudit(
  state: DeviceComplianceState,
  options?: {
    categories?: ComplianceCategory[];
    severityThreshold?: ComplianceSeverity;
  },
): ComplianceReport {
  let checks = ALL_CHECKS;

  if (options?.categories?.length) {
    const cats = new Set(options.categories);
    checks = checks.filter((c) => cats.has(c.category));
  }

  if (options?.severityThreshold) {
    const threshold = SEVERITY_ORDER[options.severityThreshold];
    checks = checks.filter((c) => SEVERITY_ORDER[c.severity] <= threshold);
  }

  const evaluated: EvaluatedCheck[] = checks.map((c) => ({
    check: { id: c.id, category: c.category, severity: c.severity, title: c.title },
    result: c.evaluate(state),
  }));

  const score = computeScore(evaluated);

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let skipCount = 0;
  for (const e of evaluated) {
    if (e.result.status === "pass") passCount++;
    else if (e.result.status === "fail") failCount++;
    else if (e.result.status === "warn") warnCount++;
    else skipCount++;
  }

  // Group by category (preserve category order)
  const categoryMap = new Map<ComplianceCategory, EvaluatedCheck[]>();
  for (const e of evaluated) {
    const arr = categoryMap.get(e.check.category) ?? [];
    arr.push(e);
    categoryMap.set(e.check.category, arr);
  }

  const categories: CategoryReport[] = [];
  for (const cat of COMPLIANCE_CATEGORIES) {
    const items = categoryMap.get(cat);
    if (!items?.length) continue;
    const catPass = items.filter((e) => e.result.status === "pass").length;
    categories.push({
      category: cat,
      label: CATEGORY_LABELS[cat],
      passCount: catPass,
      totalCount: items.length,
      findings: items,
    });
  }

  return {
    score,
    totalChecks: evaluated.length,
    passCount,
    failCount,
    warnCount,
    skipCount,
    categories,
    evaluatedChecks: evaluated,
  };
}

// ── Report renderer ─────────────────────────────────────────────────────────

export function renderComplianceReport(
  report: ComplianceReport,
  device: string,
  options?: { generateFixScript?: boolean },
): string {
  const lines: string[] = [];

  lines.push(`NETWORK COMPLIANCE AUDIT — ${device}`);
  lines.push(
    `Score: ${report.score.percentage}/100 (${report.score.grade})  |  ` +
      `${report.totalChecks} checks: ${report.passCount} pass · ${report.failCount} fail · ` +
      `${report.warnCount} warn · ${report.skipCount} skip`,
  );
  lines.push("");

  for (const cat of report.categories) {
    lines.push(
      `─── ${cat.label.toUpperCase()} (${cat.passCount}/${cat.totalCount} pass) ${"─".repeat(Math.max(0, 50 - cat.label.length))}`,
    );

    for (const e of cat.findings) {
      const { status, label, detail, fix } = e.result;
      if (status === "pass") {
        lines.push(`  PASS  ${label}`);
      } else if (status === "skip") {
        lines.push(`  SKIP  ${label}`);
      } else {
        const tag = SEV_TAG[e.check.severity];
        const icon = status === "fail" ? "FAIL" : "WARN";
        lines.push(`  ${icon}  [${tag}] ${label}`);
        if (detail) lines.push(`        ${detail}`);
        if (fix) lines.push(`        Fix: ${fix}`);
      }
    }
    lines.push("");
  }

  if (options?.generateFixScript) {
    const fixes = report.evaluatedChecks
      .filter((e) => e.result.fix && e.result.status !== "pass" && e.result.status !== "skip")
      .map((e) => e.result.fix!);

    if (fixes.length > 0) {
      lines.push("═══ FIX SCRIPT ═════════════════════════════════════════════════");
      lines.push("# Auto-generated — review each command before applying.");
      lines.push("# Run via run_routeros_command or paste into a RouterOS terminal.");
      for (const f of fixes) lines.push(f);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}
