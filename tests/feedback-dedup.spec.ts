import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { closeFeedbackStore, getFeedbackStore } from "../src/feedback/accessor";
import {
  computeFeedbackFingerprint,
  higherImpact,
  normalizeOperation,
  scoreFeedbackSimilarity,
  stripVolatileTokens,
  tokenizeCanonical,
} from "../src/feedback/dedup";
import { openFeedbackStore } from "../src/feedback/store";
import { sanitizeFeedbackText } from "../src/feedback/types";

vi.mock("../src/feedback/store", () => ({ openFeedbackStore: vi.fn() }));

afterEach(() => {
  closeFeedbackStore();
  vi.clearAllMocks();
});

describe("feedback deduplication engine", () => {
  test("normalizes MCP tool names and RouterOS CLI paths", () => {
    expect(normalizeOperation("mcp__mikrotik-mcp__list_firewall_rules")).toBe(
      "list_firewall_rules",
    );
    expect(normalizeOperation("mikrotik:create_wireguard_peer")).toBe("create_wireguard_peer");
    expect(normalizeOperation("/ip firewall filter print where chain=input")).toBe(
      "/ip/firewall/filter",
    );
    expect(normalizeOperation("  /ip/dns/cache/ ")).toBe("/ip/dns/cache");
  });

  test("strips volatile runtime tokens (IPs, MACs, RouterOS IDs, interfaces, line numbers)", () => {
    const a = stripVolatileTokens(
      "failure: peer 192.168.88.12/32 on wg0 (*1A) mac AA:BB:CC:DD:EE:FF failed at (line 1 column 24)",
    );
    const b = stripVolatileTokens(
      "failure: peer 10.20.30.40/24 on wg2 (*2f) mac 11:22:33:44:55:66 failed at (line 3 column 9)",
    );
    expect(a).toBe(b);
  });

  test("computes identical fingerprints for equivalent reports across different routers and IPs", () => {
    const fp1 = computeFeedbackFingerprint({
      kind: "bug",
      operation: "mcp__mikrotik-mcp__create_wireguard_peer",
      title: "create_wireguard_peer fails for 10.0.0.2/32 on wg1",
      actualError: "input does not match any value of interface wg1 (line 1 column 18)",
    });
    const fp2 = computeFeedbackFingerprint({
      kind: "bug",
      operation: "create_wireguard_peer",
      title: "create_wireguard_peer fails for 172.16.5.9/32 on wg0",
      actualError: "input does not match any value of interface wg0 (line 2 column 42)",
    });
    expect(fp1).toBe(fp2);
  });

  test("fuzzy similarity matches paraphrased reports for the same tool and separates unrelated tools", () => {
    const existing = {
      kind: "missing_param" as const,
      operation: "list_dhcp_leases",
      title: "list_dhcp_leases is missing server filter parameter",
      detail: "Cannot filter DHCP leases by DHCP server name without fetching all leases first.",
      actualError: null,
    };

    const similar = scoreFeedbackSimilarity(
      {
        kind: "missing_param",
        operation: "mcp__mikrotik-mcp__list_dhcp_leases",
        title: "Need a server parameter on list_dhcp_leases to filter leases",
        detail:
          "Had to filter DHCP leases client-side because list_dhcp_leases lacks server filter.",
      },
      existing,
    );
    expect(similar.matches).toBe(true);
    expect(similar.score).toBeGreaterThanOrEqual(0.64);

    const differentOp = scoreFeedbackSimilarity(
      {
        kind: "missing_param",
        operation: "list_firewall_rules",
        title: "list_firewall_rules is missing server filter parameter",
        detail: "Cannot filter rules.",
      },
      existing,
    );
    expect(differentOp.matches).toBe(false);
    expect(differentOp.score).toBe(0);
  });

  test("escalates impact to the highest severity when merging", () => {
    expect(higherImpact("suggestion", "friction")).toBe("friction");
    expect(higherImpact("degraded", "friction")).toBe("degraded");
    expect(higherImpact("degraded", "blocker")).toBe("blocker");
  });

  test("rejects or redacts unsafe secret material in feedback text", () => {
    expect(() => sanitizeFeedbackText("-----BEGIN OPENSSH PRIVATE KEY----- AAAA")).toThrow(
      /credential vault/,
    );
    expect(tokenizeCanonical("The router tool failed on 192.168.1.1")).toEqual(["fail"]);
  });
});

describe("feedback store accessor", () => {
  test("a failed open is retryable and disabling feedback blocks access", async () => {
    setConfig(
      MikrotikConfigSchema.parse({
        devices: { demo: { host: "127.0.0.1" } },
        defaultDevice: "demo",
        feedback: { enabled: true, dbPath: ":memory:" },
      }),
    );
    const store = { close: vi.fn() };
    vi.mocked(openFeedbackStore)
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(store as never);
    await expect(getFeedbackStore()).rejects.toThrow("busy");
    await expect(getFeedbackStore()).resolves.toBe(store);
    setConfig({ ...getConfig(), feedback: { ...getConfig().feedback, enabled: false } });
    await expect(getFeedbackStore()).rejects.toThrow("disabled");
    expect(openFeedbackStore).toHaveBeenCalledTimes(2);
  });
});
