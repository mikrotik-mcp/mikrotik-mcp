/**
 * Config-source feature blocks (`alerts`, `flows`, `policy`, `schedules`) must
 * survive the load.
 *
 * Same class of bug as the top-level toggles: `parseDevicesSource` enumerates
 * what it lifts out of the source, so a block it did not name parsed cleanly and
 * was then dropped — `cli.ts` checks `cfg.alerts?.enabled`, saw `undefined`, and
 * never started the engine. A rule or job list has no sensible CLI-flag
 * equivalent, so the config source is the ONLY way to set these; ignoring it
 * silently is the whole bug.
 *
 * Written against inline `--devices` JSON rather than a temp file: it exercises
 * the same `parseDevicesSource`, and the pre-commit typecheck has no Node types.
 */
import { describe, expect, test } from "vite-plus/test";
import { loadConfig } from "../../src/config";

const DEVICES = { defaultDevice: "r", devices: { r: { host: "1.1.1.1", username: "admin" } } };

/** Load from an inline config source, as `--devices '<json>'` does. */
function load(source: unknown, ...flags: string[]) {
  return loadConfig(["--devices", JSON.stringify(source), ...flags]);
}

describe("loadConfig — config-source feature blocks", () => {
  test("an `alerts` block reaches the config instead of being dropped", () => {
    const cfg = load({
      ...DEVICES,
      alerts: {
        enabled: true,
        rules: [{ id: "x", when: { event: "drift" }, channels: ["slack"] }],
        channels: { slack: { url: "https://hooks.slack.com/services/T/B/x" } },
      },
    });
    expect(cfg.alerts?.enabled).toBe(true);
    expect(cfg.alerts?.rules).toHaveLength(1);
    expect(cfg.alerts?.channels.slack?.url).toContain("hooks.slack.com");
  });

  test("alerts stays undefined when nothing configures it (the feature is opt-in)", () => {
    expect(load(DEVICES).alerts).toBeUndefined();
  });

  test("a `schedules` block, jobs included, reaches the config", () => {
    const cfg = load({
      ...DEVICES,
      schedules: {
        enabled: true,
        concurrency: 8,
        jobs: [{ id: "nightly", cron: "0 3 * * *", tool: "run_security_hardening_audit" }],
      },
    });
    expect(cfg.schedules.enabled).toBe(true);
    expect(cfg.schedules.concurrency).toBe(8);
    expect(cfg.schedules.jobs).toHaveLength(1);
  });

  test("schedules defaults are sane and OFF when nothing is configured", () => {
    const cfg = load(DEVICES);
    expect(cfg.schedules.enabled).toBe(false);
    expect(cfg.schedules.jobs).toEqual([]);
    expect(cfg.schedules.concurrency).toBe(4);
    expect(cfg.schedules.timeoutMs).toBe(600_000);
  });

  test("a flag overrides a scheduling limit but leaves the job list alone", () => {
    const cfg = load(
      { ...DEVICES, schedules: { enabled: true, concurrency: 8, jobs: [{ id: "nightly" }] } },
      "--schedules-concurrency",
      "2",
    );
    expect(cfg.schedules.concurrency).toBe(2);
    expect(cfg.schedules.jobs).toHaveLength(1);
    expect(cfg.schedules.enabled).toBe(true);
  });

  test("`flows` and `policy` blocks survive too", () => {
    const cfg = load({
      ...DEVICES,
      flows: { enabled: true, port: 9995 },
      policy: { paths: ["/etc/policies/*.yaml"], includeStarterPack: false },
    });
    expect(cfg.flows.enabled).toBe(true);
    expect(cfg.flows.port).toBe(9995);
    expect(cfg.policy.paths).toEqual(["/etc/policies/*.yaml"]);
    expect(cfg.policy.includeStarterPack).toBe(false);
  });

  test("a device literally named `schedules` in a BARE map is not mistaken for config", () => {
    // The bare form is a device map, so every key is a device name. Reading
    // blocks out of it would delete someone's router from their fleet.
    const cfg = load({ schedules: { host: "9.9.9.9" } });
    expect(cfg.devices.schedules?.host).toBe("9.9.9.9");
    expect(cfg.schedules.enabled).toBe(false);
  });
});
