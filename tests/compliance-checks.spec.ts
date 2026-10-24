import { describe, expect, test } from "vite-plus/test";
import type { DeviceComplianceState } from "../src/core/compliance-checks";
import {
  ALL_CHECKS,
  computeScore,
  renderComplianceReport,
  runComplianceAudit,
} from "../src/core/compliance-checks";

/** A deliberately hardened router snapshot; every check should pass. */
function hardened(): DeviceComplianceState {
  return {
    ssh: {
      "strong-crypto": "yes",
      "allow-none-crypto": "no",
      "forwarding-enabled": "no",
      "host-key-type": "ed25519",
    },
    services: [
      ...["telnet", "ftp", "api", "www"].map((name) => ({ name, disabled: "yes" })),
      { name: "winbox", disabled: "no", address: "192.0.2.0/24" },
      { name: "ssh", disabled: "no", address: "192.0.2.0/24" },
      { name: "www-ssl", disabled: "no", address: "192.0.2.0/24" },
    ],
    firewallFilter: [
      { chain: "input", action: "accept", "connection-state": "established,related" },
      { chain: "input", action: "drop" },
      { chain: "forward", action: "drop" },
    ],
    users: [{ name: "operator", group: "full", address: "192.0.2.0/24" }],
    dns: { "allow-remote-requests": "no", servers: "1.1.1.1" },
    certificates: [{ name: "host", daysLeft: 90 }],
    upnp: "enabled: no",
    socks: "enabled: no",
    proxy: "enabled: no",
    macServer: "allowed-interface-list: LAN",
    macWinbox: "allowed-interface-list: LAN",
    identity: { name: "edge-router" },
    ntpClient: "enabled: yes",
    discoverySettings: "discover-interface-list: LAN",
    bandwidthServer: "enabled: no",
    pptpServer: "enabled: no",
    snmp: "enabled: no",
    snmpCommunity: [{ name: "private-monitor", "read-access": "yes", "write-access": "no" }],
  };
}

function finding(state: DeviceComplianceState, id: string) {
  const check = ALL_CHECKS.find((entry) => entry.id === id);
  if (!check) throw new Error(`Missing compliance check ${id}`);
  return check.evaluate(state);
}

describe("RouterOS compliance engine", () => {
  test("a hardened snapshot passes every registered check and produces a complete report", () => {
    const report = runComplianceAudit(hardened());
    expect(report.totalChecks).toBe(ALL_CHECKS.length);
    expect(report.failCount).toBe(0);
    expect(report.warnCount).toBe(0);
    expect(report.skipCount).toBe(2); // Community checks do not apply with SNMP disabled.
    expect(report.score).toMatchObject({ percentage: 100, grade: "A+" });
    expect(report.categories.reduce((count, category) => count + category.totalCount, 0)).toBe(
      ALL_CHECKS.length,
    );
    expect(renderComplianceReport(report, "edge-router")).toContain("Score: 100/100 (A+)");
  });

  const insecure: {
    id: string;
    status: "fail" | "warn";
    change: (state: DeviceComplianceState) => void;
    fix?: string;
  }[] = [
    {
      id: "ssh-strong-crypto",
      status: "fail",
      change: (s) => {
        s.ssh["strong-crypto"] = "no";
      },
      fix: "strong-crypto=yes",
    },
    {
      id: "ssh-none-crypto",
      status: "fail",
      change: (s) => {
        s.ssh["allow-none-crypto"] = "yes";
      },
      fix: "allow-none-crypto=no",
    },
    {
      id: "ssh-forwarding",
      status: "warn",
      change: (s) => {
        s.ssh["forwarding-enabled"] = "local";
      },
      fix: "forwarding-enabled=no",
    },
    {
      id: "ssh-host-key-type",
      status: "warn",
      change: (s) => {
        s.ssh["host-key-type"] = "rsa";
      },
      fix: "host-key-type=ed25519",
    },
    {
      id: "svc-telnet-disabled",
      status: "fail",
      change: (s) => {
        s.services[0].disabled = "no";
      },
      fix: "disable telnet",
    },
    {
      id: "svc-ftp-disabled",
      status: "fail",
      change: (s) => {
        s.services[1].disabled = "no";
      },
      fix: "disable ftp",
    },
    {
      id: "svc-api-ssl",
      status: "fail",
      change: (s) => {
        s.services[2].disabled = "no";
      },
      fix: "disable api",
    },
    {
      id: "svc-www-disabled",
      status: "fail",
      change: (s) => {
        s.services[3].disabled = "no";
      },
      fix: "disable www",
    },
    {
      id: "svc-winbox-restricted",
      status: "warn",
      change: (s) => {
        s.services[4].address = "";
      },
    },
    {
      id: "svc-btest-disabled",
      status: "warn",
      change: (s) => {
        s.bandwidthServer = "enabled=yes";
      },
      fix: "enabled=no",
    },
    {
      id: "svc-ssh-restricted",
      status: "warn",
      change: (s) => {
        s.services[5].address = "";
      },
    },
    {
      id: "svc-www-ssl-restricted",
      status: "warn",
      change: (s) => {
        s.services[6].address = "";
      },
    },
    {
      id: "fw-input-rules-exist",
      status: "fail",
      change: (s) => {
        s.firewallFilter = s.firewallFilter.filter((r) => r.chain !== "input");
      },
    },
    {
      id: "fw-input-default-drop",
      status: "fail",
      change: (s) => {
        s.firewallFilter[1]["src-address"] = "192.0.2.1";
      },
      fix: "chain=input action=drop",
    },
    {
      id: "fw-established-accept",
      status: "fail",
      change: (s) => {
        s.firewallFilter.shift();
      },
      fix: "connection-state=established",
    },
    {
      id: "fw-forward-rules-exist",
      status: "warn",
      change: (s) => {
        s.firewallFilter.pop();
      },
    },
    {
      id: "fw-forward-default-drop",
      status: "fail",
      change: (s) => {
        s.firewallFilter[2]["out-interface"] = "ether1";
      },
      fix: "chain=forward action=drop",
    },
    {
      id: "user-default-admin",
      status: "fail",
      change: (s) => {
        s.users.push({ name: "admin", group: "full" });
      },
    },
    {
      id: "user-full-no-address",
      status: "warn",
      change: (s) => {
        s.users[0].address = "";
      },
    },
    {
      id: "user-multiple-full",
      status: "warn",
      change: (s) => {
        s.users.push({ name: "second", group: "full", address: "192.0.2.0/24" });
      },
    },
    {
      id: "dns-no-open-resolver",
      status: "fail",
      change: (s) => {
        s.dns["allow-remote-requests"] = "yes";
      },
      fix: "allow-remote-requests=no",
    },
    {
      id: "dns-servers-configured",
      status: "warn",
      change: (s) => {
        s.dns.servers = "";
      },
    },
    {
      id: "cert-no-expired",
      status: "fail",
      change: (s) => {
        s.certificates[0].daysLeft = -1;
      },
    },
    {
      id: "cert-not-expiring-soon",
      status: "warn",
      change: (s) => {
        s.certificates[0].daysLeft = 30;
      },
    },
    {
      id: "net-upnp-disabled",
      status: "fail",
      change: (s) => {
        s.upnp = "enabled: yes";
      },
      fix: "upnp set enabled=no",
    },
    {
      id: "net-socks-disabled",
      status: "fail",
      change: (s) => {
        s.socks = "enabled: yes";
      },
      fix: "socks set enabled=no",
    },
    {
      id: "net-proxy-disabled",
      status: "warn",
      change: (s) => {
        s.proxy = "enabled: yes";
      },
      fix: "proxy set enabled=no",
    },
    {
      id: "net-mac-server-restricted",
      status: "warn",
      change: (s) => {
        s.macServer = "allowed-interface-list: all";
      },
      fix: "allowed-interface-list=none",
    },
    {
      id: "net-mac-winbox-restricted",
      status: "warn",
      change: (s) => {
        s.macWinbox = "allowed-interface-list: all";
      },
      fix: "allowed-interface-list=none",
    },
    {
      id: "snmp-disabled",
      status: "warn",
      change: (s) => {
        s.snmp = "enabled: yes";
      },
      fix: "snmp set enabled=no",
    },
    {
      id: "snmp-community-not-default",
      status: "fail",
      change: (s) => {
        s.snmp = "enabled: yes";
        s.snmpCommunity[0].name = "public";
      },
      fix: "community set",
    },
    {
      id: "snmp-write-disabled",
      status: "fail",
      change: (s) => {
        s.snmp = "enabled: yes";
        s.snmpCommunity[0]["write-access"] = "yes";
      },
    },
    {
      id: "sys-identity-changed",
      status: "warn",
      change: (s) => {
        s.identity.name = "MikroTik";
      },
      fix: "identity set",
    },
    {
      id: "sys-ntp-configured",
      status: "warn",
      change: (s) => {
        s.ntpClient = "enabled: no";
      },
      fix: "ntp client set",
    },
    {
      id: "sys-discovery-restricted",
      status: "warn",
      change: (s) => {
        s.discoverySettings = "discover-interface-list: all";
      },
      fix: "discover-interface-list=none",
    },
    {
      id: "vpn-pptp-disabled",
      status: "fail",
      change: (s) => {
        s.pptpServer = "enabled: yes";
      },
      fix: "pptp-server server set enabled=no",
    },
  ];

  test.each(insecure)(
    "$id distinguishes unsafe state and gives the expected guidance",
    ({ id, status, change, fix }) => {
      const state = hardened();
      change(state);
      const result = finding(state, id);
      expect(result.status).toBe(status);
      expect(result.label).toBeTruthy();
      if (fix) expect(result.fix).toContain(fix);
      expect(runComplianceAudit(state).score.percentage).toBeLessThan(100);
    },
  );

  test("missing observations are skipped, never silently scored as secure", () => {
    const state = hardened();
    delete state.ssh["strong-crypto"];
    delete state.dns["allow-remote-requests"];
    state.upnp = "";
    state.snmp = "";
    const report = runComplianceAudit(state);
    expect(report.skipCount).toBeGreaterThanOrEqual(4);
    expect(finding(state, "ssh-strong-crypto").status).toBe("skip");
    expect(finding(state, "dns-no-open-resolver").status).toBe("skip");
    expect(finding(state, "net-upnp-disabled").status).toBe("skip");
    expect(finding(state, "snmp-disabled").status).toBe("skip");
    expect(report.score.total).toBeLessThan(runComplianceAudit(hardened()).score.total);
  });

  test("filtered audits preserve category/severity limits and skip fix commands for passing checks", () => {
    const state = hardened();
    state.ssh["strong-crypto"] = "no";
    const report = runComplianceAudit(state, {
      categories: ["ssh_security"],
      severityThreshold: "high",
    });
    expect(report.evaluatedChecks.map((row) => row.check.id)).toEqual([
      "ssh-strong-crypto",
      "ssh-none-crypto",
    ]);
    const output = renderComplianceReport(report, "edge-router", { generateFixScript: true });
    expect(output).toContain("FIX SCRIPT");
    expect(output).toContain("/ip ssh set strong-crypto=yes");
    expect(output).not.toContain("allow-none-crypto=no");
  });

  test("scoring ignores skipped checks and honors severity weights", () => {
    const result = computeScore([
      {
        check: { id: "a", category: "ssh_security", severity: "critical", title: "A" },
        result: { status: "fail", label: "A" },
      },
      {
        check: { id: "b", category: "ssh_security", severity: "low", title: "B" },
        result: { status: "pass", label: "B" },
      },
      {
        check: { id: "c", category: "ssh_security", severity: "high", title: "C" },
        result: { status: "skip", label: "C" },
      },
    ]);
    expect(result).toMatchObject({ earned: 1, total: 11, percentage: 9, grade: "F" });
    expect(computeScore([])).toMatchObject({ percentage: 100, grade: "A+" });
  });
});
