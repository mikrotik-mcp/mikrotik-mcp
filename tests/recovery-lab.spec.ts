import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildRecoverySubset,
  capabilitiesSchema,
  REQUIRED_CHECKS,
  resultState,
  sha256,
  validateRunnerResult,
} from "../src/recovery-lab/model";
import type { RecoveryRun, RunnerResult } from "../src/recovery-lab/model";
import { runnerConfig, callRunner } from "../src/recovery-lab/runner";
const run = {
  id: "00000000-0000-4000-8000-000000000001",
  runnerId: "isolated",
  requestSha256: sha256("request"),
  version: "7.20.1",
} as RecoveryRun;
const result: RunnerResult = {
  protocol: "mikrotik-recovery/v1",
  id: run.id,
  runnerId: "isolated",
  requestSha256: run.requestSha256!,
  version: "7.20.1",
  isolated: true,
  productionNetworkAccess: false,
  state: "completed",
  cleanup: "pending",
  checks: REQUIRED_CHECKS.map((name) => ({ name, state: "pass", detail: "observed" })),
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("recovery lab safety", () => {
  it("builds literal portable commands, excludes secrets, scripts and unsupported fields", () => {
    const a = buildRecoverySubset(
      '/interface bridge\nadd name=lab comment="private note"\n/ip address\nadd address=10.0.0.1/24 interface=lab\n/user\nadd name=admin password=secret\n/system script\nadd name=bad source=":put secret"\n/ip route\nadd dst-address=0.0.0.0/0 gateway=10.0.0.2 unsafe=value',
    );
    expect(a.commands).toEqual([
      "/interface bridge add name=lab",
      "/ip address add address=10.0.0.1/24 interface=lab",
    ]);
    expect(JSON.stringify(a)).not.toContain("password=secret");
    expect(a.coverage.reduce((n, c) => n + c.excluded, 0)).toBe(3);
  });
  it("never forwards expressions, raw commands or positional set selectors", () => {
    for (const text of [
      '/interface bridge\nadd name="$secret"',
      "/interface bridge\nadd name=[/system identity get name]",
      "/interface bridge\nset [find] name=x",
      '/system script\nadd name=foo source="/system reboot"',
      "/routing table\nadd fib name=lab",
    ])
      expect(buildRecoverySubset(text).commands).toHaveLength(0);
    expect(() => buildRecoverySubset("x".repeat(512001))).toThrow(/limit/);
  });
  it("requires every check and rejects mismatched identity, version, hash or isolation", () => {
    expect(resultState(validateRunnerResult(result, run))).toBe("passed");
    expect(resultState({ ...result, checks: result.checks.slice(1) })).toBe("uncertain");
    expect(
      resultState({ ...result, checks: [{ name: "import", state: "fail", detail: "rejected" }] }),
    ).toBe("failed");
    for (const change of [
      { version: "7.21.1" },
      { runnerId: "wrong" },
      { requestSha256: sha256("wrong") },
      { productionNetworkAccess: true },
      { checks: [result.checks[0], result.checks[0]] },
      { state: "destroyed", cleanup: "pending" },
    ])
      expect(() => validateRunnerResult({ ...result, ...change }, run)).toThrow();
  });
  it("requires fail-closed isolation claims and pinned image digests", () => {
    const caps = {
      protocol: "mikrotik-recovery/v1",
      runnerId: "lab",
      isolated: true,
      productionNetworkAccess: false,
      disposable: true,
      enforcesTtl: true,
      versions: [{ version: "7.20.1", imageSha256: "a".repeat(64), architecture: "x86_64" }],
    };
    expect(capabilitiesSchema.safeParse(caps).success).toBe(true);
    expect(capabilitiesSchema.safeParse({ ...caps, enforcesTtl: false }).success).toBe(false);
    expect(
      capabilitiesSchema.safeParse({ ...caps, versions: [...caps.versions, ...caps.versions] })
        .success,
    ).toBe(false);
  });
  it("only accepts administrator-set origins and protects auth from redirects", async () => {
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_URL", "");
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_TOKEN", "");
    expect(runnerConfig()).toBeUndefined();
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_TOKEN", "a".repeat(32));
    for (const url of [
      "http://192.168.1.2",
      "https://user:pass@example.com",
      "https://example.com/redirect",
      "https://example.com/?token=x",
    ]) {
      vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_URL", url);
      expect(() => runnerConfig()).toThrow();
    }
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_URL", "http://127.0.0.1:4444");
    expect(runnerConfig()?.base).toBe("http://127.0.0.1:4444");
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await callRunner("GET", "/v1/capabilities");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4444/v1/capabilities",
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(callRunner("GET", "/v1/runs/../secrets")).rejects.toThrow();
  });
  it("rejects oversized runner evidence without trusting an HTTP 200", async () => {
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_URL", "https://example.com");
    vi.stubEnv("MIKROTIK_RECOVERY_RUNNER_TOKEN", "a".repeat(32));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(" ".repeat(66000))),
    );
    await expect(callRunner("GET", "/v1/capabilities")).rejects.toThrow(/64 KB/);
  });
});
