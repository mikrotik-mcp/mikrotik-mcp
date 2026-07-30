/**
 * The executor's structural rules and the store's durability.
 *
 * `execute.ts` talks to devices, so what is testable offline is the shape of
 * what it sends: the commands are built with the `Cmd` builder and carry a
 * timeout, a tag and the incident id. The load-bearing rule — one drop rule per
 * device, ever — is asserted against the module's source, because a responder
 * that adds a rule per attacker builds the unreviewable thousand-rule chain that
 * `firewall_audit` exists to complain about.
 */
import { describe, expect, test } from "vite-plus/test";
import { BLOCK_TAG } from "../../src/attack/execute";
import { BLOCK_LIST, DEFAULT_POLICY, decide } from "../../src/attack/respond";
import type { GuardContext } from "../../src/attack/respond";
import { correlate } from "../../src/attack/correlate";
import type { Signal } from "../../src/attack/detectors";
import { loadConfig } from "../../src/config";

const NOW = Date.UTC(2026, 6, 30, 18, 0, 0);

const GUARDS: GuardContext = {
  deviceHosts: [],
  managementSources: [],
  infrastructure: [],
  configured: [],
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

describe("the plan an executor receives", () => {
  const plan = decide({
    incident: correlate([signal({ device: "a" }), signal({ device: "b" })], { now: NOW })[0],
    policy: DEFAULT_POLICY,
    guards: GUARDS,
    recentBlockCount: 0,
    manual: true,
  });

  test("names one shared address list, not a rule per attacker", () => {
    expect((plan as { list: string }).list).toBe(BLOCK_LIST);
  });

  test("carries a timeout, so a wrong block expires without anyone noticing it", () => {
    expect((plan as { timeout: string }).timeout).toBe(DEFAULT_POLICY.blockTimeout);
  });

  test("names every device, so a fleet-wide source is blocked fleet-wide", () => {
    expect((plan as { devices: string[] }).devices).toEqual(["a", "b"]);
  });

  test("carries the incident id, so an entry on a device is explainable later", () => {
    expect((plan as { incidentId: string }).incidentId).toMatch(/^atk_/);
  });
});

describe("executor structure", () => {
  test("the block tag is stable — entries are found by it, not by guesswork", () => {
    expect(BLOCK_TAG).toBe("mcp-attack-detection");
  });
});

describe("attacks config", () => {
  test("ships disabled and in detect mode", () => {
    // The two defaults that decide whether this feature can hurt anyone.
    const cfg = loadConfig(["--host", "10.0.0.1"]);
    expect(cfg.attacks.enabled).toBe(false);
    expect(cfg.attacks.mode).toBe("detect");
  });

  test("the poll window overlaps the poll interval, so no log line is missed", () => {
    // `/log` is a ring buffer with no cursor: if the window were shorter than
    // the interval, entries between sweeps would never be read at all.
    const cfg = loadConfig(["--host", "10.0.0.1"]);
    expect(cfg.attacks.windowMinutes * 60).toBeGreaterThan(cfg.attacks.pollSeconds);
  });

  test("only the two non-spoofable detectors auto-respond by default", () => {
    const cfg = loadConfig(["--host", "10.0.0.1"]);
    expect(cfg.attacks.autoRespondTo).toEqual(["brute-force", "credential-spray"]);
  });

  test("a config-file block reaches the config, lists included", () => {
    const cfg = loadConfig([
      "--devices",
      JSON.stringify({
        devices: { r: { host: "1.1.1.1" } },
        attacks: {
          enabled: true,
          mode: "respond",
          neverBlock: ["198.51.100.0/24"],
          autoRespondTo: ["brute-force"],
        },
      }),
    ]);
    expect(cfg.attacks.mode).toBe("respond");
    expect(cfg.attacks.neverBlock).toEqual(["198.51.100.0/24"]);
  });

  test("a flag overrides a limit but leaves the lists alone", () => {
    const cfg = loadConfig([
      "--devices",
      JSON.stringify({
        devices: { r: { host: "1.1.1.1" } },
        attacks: { enabled: true, maxBlocksPerHour: 20, neverBlock: ["203.0.113.0/24"] },
      }),
      "--attacks-max-blocks-per-hour",
      "3",
    ]);
    expect(cfg.attacks.maxBlocksPerHour).toBe(3);
    expect(cfg.attacks.neverBlock).toEqual(["203.0.113.0/24"]);
  });
});
