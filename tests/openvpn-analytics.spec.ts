import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import {
  analyzeOpenVpnUsage,
  buildOpenVpnAnalyticsCommand,
  computeOpenVpnUsageReport,
  formatOpenVpnUsageReport,
  normalizeOpenVpnQuery,
  normalizeRouterDateTime,
  normalizeSessionHexId,
  parseAccountingUptimeSeconds,
  parseRouterOpenVpnPayload,
} from "../src/core/openvpn-analytics";
import type { RawRouterOpenVpnPayload } from "../src/core/openvpn-analytics";
import { openvpnTools } from "../src/tools/openvpn";

const { run, allowed } = vi.hoisted(() => ({
  run: vi.fn(),
  allowed: vi.fn(),
}));

vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
vi.mock("../src/core/scoped-access", () => ({ assertDeviceAccess: allowed }));
vi.mock("../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/runtime")>();
  return {
    ...actual,
    resolveDeviceName: (name?: string) => name ?? "home-ax3",
    getConfig: () =>
      ({
        ...actual.getConfig(),
        dashboard: {
          ...actual.getConfig().dashboard,
          dbPath: "/tmp/non-existent-mikrotik-mcp-test/audit.db",
        },
      }) as ReturnType<typeof actual.getConfig>,
  };
});

describe("OpenVPN usage & accounting analytics", () => {
  beforeEach(() => {
    run.mockReset();
    allowed.mockReset();
  });

  test("normalizes dates, aliases, user lists, and status shortcuts", () => {
    expect(normalizeRouterDateTime("2026-11-26", "start")).toBe("2026-11-26 00:00:00");
    expect(normalizeRouterDateTime("2026-11-26", "end")).toBe("2026-11-26 23:59:59");
    expect(normalizeRouterDateTime("2026-11-26T14:05", "start")).toBe("2026-11-26 14:05:00");

    const q = normalizeOpenVpnQuery({
      day: "2026-11-26",
      username: "baba, fereshteh",
      users: ["baba", "maman"],
      client_ip: "5.113.12.177",
      tunnel_ip: "10.10.6.215",
      active_only: true,
    } as any);

    expect(q.from).toBe("2026-11-26 00:00:00");
    expect(q.to).toBe("2026-11-26 23:59:59");
    expect(q.users).toEqual(["baba", "fereshteh", "maman"]);
    expect(q.callerId).toBe("5.113.12.177");
    expect(q.address).toBe("10.10.6.215");
    expect(q.status).toBe("active");

    expect(() =>
      normalizeOpenVpnQuery({
        from: "2026-11-26",
        to: "2026-11-20",
      } as any),
    ).toThrow(/after 'to'/);
  });

  test("parses RouterOS User Manager uptimes including >=24h 1970-01-DD serialized timestamps", () => {
    expect(parseAccountingUptimeSeconds("00:30:26")).toBe(1826);
    expect(parseAccountingUptimeSeconds("1d02:03:04")).toBe(93784);
    expect(parseAccountingUptimeSeconds("1970-01-02 00:00:00")).toBe(86400);
    expect(parseAccountingUptimeSeconds("1970-01-03 05:30:10")).toBe(
      2 * 86400 + 5 * 3600 + 30 * 60 + 10,
    );
    expect(parseAccountingUptimeSeconds("")).toBeNull();
  });

  test("converts decimal and 0x-prefixed PPP session-id values to lowercase 8-char hex matching acct-session-id", () => {
    expect(normalizeSessionHexId("2168457740")).toBe("81400a0c");
    expect(normalizeSessionHexId("0x81400A0C")).toBe("81400a0c");
    expect(normalizeSessionHexId("81400a0c")).toBe("81400a0c");
  });

  test("builds a safe one-shot RouterOS JSON command with dynamic :parse guard for User Manager", () => {
    const q = normalizeOpenVpnQuery({
      from: "2026-11-20",
      to: "2026-11-26",
      user: "baba",
      status: "closed",
    } as any);
    const cmd = buildOpenVpnAnalyticsCommand(q);
    expect(cmd).toContain(":parse");
    expect(cmd).toContain("on-error={}");
    expect(cmd).toContain("/ppp active print detail as-value where service=ovpn");
    expect(cmd).toContain('started>=\\"2026-11-20 00:00:00\\"');
    expect(cmd).toContain('started<=\\"2026-11-26 23:59:59\\"');
    expect(cmd).toContain('user=\\"baba\\"');
    expect(cmd).toContain("active=no");
  });

  test("merges User Manager accounting with live /ppp active + <ovpn-*> byte counters without double counting", () => {
    const samplePayload: RawRouterOpenVpnPayload = {
      clock: {
        date: "2026-11-26",
        time: "19:30:00",
        "gmt-offset": 12600,
        "time-zone-name": "Asia/Tehran",
      },
      cutStr: "2026-11-25 00:00:00",
      hasUserManager: true,
      umUsers: [
        { name: "baba", disabled: false, group: "default" },
        { name: "fereshteh", disabled: false, group: "default" },
        { name: "unused-user", disabled: false, group: "default" },
      ],
      pppSecrets: [],
      umSessions: [
        // Day 1: baba closed session with traffic
        {
          ".id": "*1",
          "acct-session-id": "81400100",
          user: "baba",
          "calling-station-id": "185.132.82.68",
          "user-address": "10.10.6.215",
          started: "2026-11-25 10:00:00",
          ended: "2026-11-25 11:00:00",
          uptime: "01:00:00",
          download: 100_000_000,
          upload: 20_000_000,
          active: false,
          "terminate-cause": "idle-timeout",
          status: ["start", "stop", "close-acked"],
        },
        // Day 2: baba 0-byte retry
        {
          ".id": "*2",
          "acct-session-id": "81400101",
          user: "baba",
          "calling-station-id": "185.132.82.68",
          "user-address": "10.10.6.215",
          started: "2026-11-26 08:00:00",
          ended: "2026-11-26 08:00:05",
          uptime: "00:00:05",
          download: 0,
          upload: 0,
          active: false,
          "terminate-cause": "lost-carrier",
          status: ["start", "stop"],
        },
        // Day 2: baba currently active session (acct-session-id 81400a0c == decimal 2168457740 in /ppp active)
        {
          ".id": "*3",
          "acct-session-id": "81400a0c",
          user: "baba",
          "calling-station-id": "185.132.82.69",
          "user-address": "10.10.6.215",
          started: "2026-11-26 18:00:00",
          uptime: "01:20:00",
          download: 50_000_000,
          upload: 10_000_000,
          active: true,
          status: ["start", "interim"],
        },
        // Day 2: fereshteh closed session with >=24h serialized uptime
        {
          ".id": "*4",
          "acct-session-id": "81400200",
          user: "fereshteh",
          "calling-station-id": "5.113.12.177",
          "user-address": "10.10.6.120",
          started: "2026-11-25 09:00:00",
          ended: "2026-11-26 10:00:00",
          uptime: "1970-01-02 01:00:00",
          download: 300_000_000,
          upload: 50_000_000,
          active: false,
          "terminate-cause": "user-request",
          status: ["start", "stop"],
        },
      ],
      pppActive: [
        // Matches baba's active UM session *3 via session-id 2168457740 -> 81400a0c, with fresher live interface bytes!
        {
          ".id": "*A1",
          name: "baba",
          service: "ovpn",
          "caller-id": "185.132.82.69",
          address: "10.10.6.215",
          uptime: "1h30m",
          "session-id": "2168457740",
          encoding: "AES-256-CBC/SHA512",
          // Note: RouterOS interface tx-byte = bytes sent to client (client download), rx-byte = client upload
          "tx-byte": 80_000_000,
          "rx-byte": 15_000_000,
        },
      ],
    };

    const query = normalizeOpenVpnQuery({ days: 2 } as any);
    const report = computeOpenVpnUsageReport("home-ax3", samplePayload, query);

    // 4 sessions total (baba's active session was merged, not duplicated!)
    expect(report.summary.totalConnections).toBe(4);
    expect(report.summary.nonZeroTrafficConnections).toBe(3);
    expect(report.summary.zeroTrafficConnections).toBe(1);
    expect(report.summary.activeConnections).toBe(1);
    expect(report.summary.closedConnections).toBe(3);
    expect(report.summary.uniqueUsersConnected).toBe(2);
    expect(report.summary.configuredUsersCount).toBe(3);

    // Exact byte math:
    // baba: (100M dl + 20M ul) + (0 + 0) + live-merged (80M dl + 15M ul) = 180M dl, 35M ul, 215M total
    // fereshteh: 300M dl + 50M ul = 350M total
    // grand total: 480M dl + 85M ul = 565M total
    expect(report.summary.downloadBytes).toBe(480_000_000);
    expect(report.summary.uploadBytes).toBe(85_000_000);
    expect(report.summary.totalBytes).toBe(565_000_000);

    // Duration math:
    // baba: 3600s + 5s + 5400s (live 1h30m > 1h20m) = 9005s
    // fereshteh: 90000s (1d 1h)
    // total: 99005s
    expect(report.summary.totalDurationSeconds).toBe(99_005);

    const fereshteh = report.users.find((u) => u.user === "fereshteh")!;
    const baba = report.users.find((u) => u.user === "baba")!;
    expect(fereshteh.totalBytes).toBe(350_000_000);
    expect(baba.totalBytes).toBe(215_000_000);
    expect(baba.connections).toBe(3);
    expect(baba.nonZeroTrafficConnections).toBe(2);
    expect(baba.zeroTrafficConnections).toBe(1);
    expect(baba.activeSessions).toBe(1);
    expect(baba.distinctDaysConnected).toBe(2);
    expect(baba.uniqueCallerIds).toBe(2);
    expect(baba.dailyBreakdown).toHaveLength(2);

    const babaDay2 = baba.dailyBreakdown!.find((d) => d.day === "2026-11-26")!;
    expect(babaDay2.connections).toBe(2);
    expect(babaDay2.nonZeroTrafficConnections).toBe(1);
    expect(babaDay2.zeroTrafficConnections).toBe(1);
    expect(babaDay2.downloadBytes).toBe(80_000_000);
    expect(babaDay2.uploadBytes).toBe(15_000_000);
    expect(babaDay2.totalBytes).toBe(95_000_000);

    // Test exclude_zero_traffic filter
    const nonZeroReport = computeOpenVpnUsageReport(
      "home-ax3",
      samplePayload,
      normalizeOpenVpnQuery({ days: 2, exclude_zero_traffic: true } as any),
    );
    expect(nonZeroReport.summary.totalConnections).toBe(3);
    expect(nonZeroReport.summary.zeroTrafficConnections).toBe(0);
    expect(nonZeroReport.summary.totalBytes).toBe(565_000_000);

    // Test formatted Markdown output includes all 6 sections
    const md = formatOpenVpnUsageReport(report);
    expect(md).toContain("## 1. All-Users Aggregate Summary");
    expect(md).toContain("## 2. Per-User Aggregated Summary");
    expect(md).toContain("## 3. All-Users Daily Totals");
    expect(md).toContain("## 4. Per-User Daily Breakdown");
    expect(md).toContain("## 5. Individual OpenVPN Sessions");
    expect(md).toContain("## 6. Structured JSON Data");
  });

  test("analyzeOpenVpnUsage executes end-to-end and analyze_ovpn_usage has no MCP App UI metadata", async () => {
    const tool = openvpnTools.find((t) => t.name === "analyze_ovpn_usage");
    expect(tool).toBeDefined();
    expect(tool?.ui).toBeUndefined();

    run.mockResolvedValueOnce(
      JSON.stringify({
        clock: { date: "2026-11-26", time: "19:35:00", "gmt-offset": 12600 },
        cutStr: "2026-11-26 00:00:00",
        hasUserManager: true,
        umUsers: [{ name: "ali", disabled: false }],
        umSessions: [
          {
            ".id": "*10",
            "acct-session-id": "81400999",
            user: "ali",
            "calling-station-id": "198.51.100.42",
            "user-address": "10.10.6.10",
            started: "2026-11-26 12:00:00",
            ended: "2026-11-26 12:30:00",
            uptime: "00:30:00",
            download: 10_485_760,
            upload: 2_097_152,
            active: false,
            "terminate-cause": "user-request",
            status: ["start", "stop"],
          },
        ],
        pppActive: [],
        pppSecrets: [],
        ovpnServers: [],
      }),
    );

    const ctx = createContext(undefined, "home-ax3");
    const { report, text } = await analyzeOpenVpnUsage({ days: 1 } as any, ctx);
    expect(allowed).toHaveBeenCalledWith(["home-ax3"], "analyze_ovpn_usage", "READ");
    expect(report.summary.totalConnections).toBe(1);
    expect(report.summary.totalBytes).toBe(12_582_912);
    expect(text).toContain("ali");
    expect(parseRouterOpenVpnPayload('noise\n{"hasUserManager":false}\n').hasUserManager).toBe(
      false,
    );
  });
});
