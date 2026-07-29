/**
 * The rollout runner against fake devices — the §8 scenarios end-to-end through
 * `runRollout` (snapshot → apply → gate → soak → next wave, or halt and revert),
 * plus the cases that only appear once I/O can fail: a snapshot that cannot be
 * taken, a health check that throws, and a revert that itself fails.
 */
import { describe, expect, test } from "vite-plus/test";
import { beginRollout, requestAbort, requestHold, resume } from "../../src/rollout/model";
import type { HealthResult, RolloutState, WaveStrategy } from "../../src/rollout/model";
import { runRollout } from "../../src/rollout/runner";
import type { RolloutExecutor } from "../../src/rollout/runner";
import { toRecord } from "../../src/rollout/store";

const COMMANDS = ["/system ntp client set enabled=yes primary-ntp=10.0.0.1"];

function devices(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `rtr-${String(i + 1).padStart(2, "0")}`);
}

function open(
  count: number,
  strategy: WaveStrategy = {},
  baseline?: Record<string, boolean>,
): RolloutState {
  return beginRollout({
    id: "r1",
    devices: devices(count),
    // Soak is real time in the runner; the fake executor makes it instant, but
    // most cases don't need it at all.
    strategy: { soakSeconds: 0, ...strategy },
    baseline,
  });
}

interface FakeOptions {
  snapshotFails?: string[];
  applyFails?: Record<string, string>;
  /** Devices reported unreachable by the health check. */
  unhealthy?: string[];
  healthThrows?: boolean;
  revertFails?: string[];
}

function fake(opts: FakeOptions = {}): { executor: RolloutExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: RolloutExecutor = {
    snapshot(device) {
      calls.push(`snapshot:${device}`);
      return opts.snapshotFails?.includes(device)
        ? Promise.reject(new Error("export failed"))
        : Promise.resolve(`snap-${device}`);
    },
    apply(device, commands) {
      calls.push(`apply:${device}(${commands.length})`);
      const error = opts.applyFails?.[device];
      return error ? Promise.reject(new Error(error)) : Promise.resolve();
    },
    health(changed, untouched) {
      calls.push(`health:[${changed.join(",")}]+[${untouched.join(",")}]`);
      if (opts.healthThrows) return Promise.reject(new Error("probe exploded"));
      const all = [...changed, ...untouched];
      const results: HealthResult[] = all.map((device) => ({
        device,
        reachable: !opts.unhealthy?.includes(device),
        detail: opts.unhealthy?.includes(device) ? "SSH probe failed" : undefined,
      }));
      return Promise.resolve(results);
    },
    soak(seconds) {
      calls.push(`soak:${seconds}`);
      return Promise.resolve();
    },
    revert(device, snapshotId) {
      calls.push(`revert:${device}:${snapshotId ?? "none"}`);
      return opts.revertFails?.includes(device)
        ? Promise.reject(new Error("restore failed"))
        : Promise.resolve();
    },
  };
  return { executor, calls };
}

describe("a clean rollout", () => {
  test("snapshots each device before changing it, then gates each wave", async () => {
    const { executor, calls } = fake();
    const run = await runRollout({ state: open(6), commands: COMMANDS, executor });

    expect(run.outcome).toBe("completed");
    expect(calls.slice(0, 4)).toEqual([
      "snapshot:rtr-01",
      "apply:rtr-01(1)",
      "health:[rtr-01]+[rtr-02,rtr-03,rtr-04,rtr-05,rtr-06]",
      "snapshot:rtr-02",
    ]);
    expect(calls.filter((c) => c.startsWith("health"))).toHaveLength(3);
    expect(run.state.devices.every((d) => d.stage === "applied")).toBe(true);
  });

  test("the soak runs between waves when configured", async () => {
    const { executor, calls } = fake();
    const run = await runRollout({
      state: open(4, { soakSeconds: 30 }),
      commands: COMMANDS,
      executor,
    });
    expect(run.outcome).toBe("completed");
    expect(calls.filter((c) => c === "soak:30")).toHaveLength(3);
  });

  test("per-device commands override the shared plan", async () => {
    const { executor, calls } = fake();
    await runRollout({
      state: open(2),
      commands: COMMANDS,
      perDevice: { "rtr-02": ["/ip dns set servers=1.1.1.1", "/ip dns cache flush"] },
      executor,
    });
    expect(calls).toContain("apply:rtr-01(1)");
    expect(calls).toContain("apply:rtr-02(2)");
  });
});

describe("failures halt and revert", () => {
  test("the canary going unhealthy reverts only the canary", async () => {
    const { executor, calls } = fake({ unhealthy: ["rtr-01"] });
    const run = await runRollout({ state: open(8), commands: COMMANDS, executor });

    expect(run.outcome).toBe("reverted");
    expect(calls.filter((c) => c.startsWith("revert"))).toEqual(["revert:rtr-01:snap-rtr-01"]);
    expect(calls.filter((c) => c.startsWith("apply"))).toHaveLength(1);
    expect(run.state.devices.filter((d) => d.stage === "skipped")).toHaveLength(7);
  });

  test("a failed apply reverts the devices that COMMITTED, newest first", async () => {
    // rtr-03 is in wave 2 (rtr-02 + rtr-03 of 6). Its own change was rolled back
    // by Safe Mode, so only the devices that committed get reverted — 02 then 01.
    const { executor, calls } = fake({ applyFails: { "rtr-03": "bad command name" } });
    const run = await runRollout({ state: open(6), commands: COMMANDS, executor });

    expect(run.outcome).toBe("reverted");
    const reverts = calls.filter((c) => c.startsWith("revert")).map((c) => c.split(":")[1]);
    expect(reverts).toEqual(["rtr-02", "rtr-01"]);
    expect(reverts).not.toContain("rtr-03");
  });

  test("a snapshot that cannot be taken stops before the device is touched", async () => {
    const { executor, calls } = fake({ snapshotFails: ["rtr-01"] });
    const run = await runRollout({ state: open(4), commands: COMMANDS, executor });

    // Nothing was changed and nothing can be reverted — the honest outcome is
    // "halted", not a revert of a device that was never touched.
    expect(run.outcome).toBe("halted");
    expect(calls).not.toContain("apply:rtr-01(1)");
    expect(calls.some((c) => c.startsWith("revert"))).toBe(false);
    expect(run.summary.join("\n")).toContain("snapshot failed");
  });

  test("an untouched device going dark halts the rollout as collateral damage", async () => {
    const { executor } = fake({ unhealthy: ["rtr-05"] });
    const run = await runRollout({ state: open(8), commands: COMMANDS, executor });

    expect(run.outcome).toBe("reverted");
    expect(run.state.gates[0].collateral).toBe(true);
    expect(run.state.notes.join(" ")).toContain("untouched device");
  });

  test("a device already down before the rollout does not halt it", async () => {
    const { executor } = fake({ unhealthy: ["rtr-05"] });
    const run = await runRollout({
      state: open(8, {}, { "rtr-05": false }),
      commands: COMMANDS,
      executor,
    });
    expect(run.outcome).toBe("completed");
  });

  test("a health check that throws is a FAILED gate, never a pass", async () => {
    const { executor } = fake({ healthThrows: true });
    const run = await runRollout({ state: open(6), commands: COMMANDS, executor });

    expect(run.outcome).toBe("reverted");
    expect(run.state.gates[0].failures[0].reason).toContain("health check error");
  });

  test("a revert that itself fails is needs-attention, with the snapshot named", async () => {
    const { executor } = fake({ unhealthy: ["rtr-01"], revertFails: ["rtr-01"] });
    const run = await runRollout({ state: open(4), commands: COMMANDS, executor });

    expect(run.outcome).toBe("needs-attention");
    expect(run.summary.join("\n")).toContain("snap-rtr-01");
    expect(run.summary.join("\n")).toContain("restore failed");
  });
});

describe("onFailure modes through the runner", () => {
  test("halt-and-hold changes nothing back", async () => {
    const { executor, calls } = fake({ unhealthy: ["rtr-01"] });
    const run = await runRollout({
      state: open(6, { onFailure: "halt-and-hold" }),
      commands: COMMANDS,
      executor,
    });

    expect(run.outcome).toBe("halted");
    expect(calls.some((c) => c.startsWith("revert"))).toBe(false);
  });

  test("continue rolls on and reports completed-with-failures", async () => {
    const { executor, calls } = fake({ unhealthy: ["rtr-01"] });
    const run = await runRollout({
      state: open(6, { onFailure: "continue" }),
      commands: COMMANDS,
      executor,
    });

    expect(run.outcome).toBe("completed-with-failures");
    expect(calls.filter((c) => c.startsWith("apply"))).toHaveLength(6);
    expect(calls.some((c) => c.startsWith("revert"))).toBe(false);
  });
});

describe("hold, resume and abort", () => {
  test("a held rollout parks and can be resumed to completion", async () => {
    const { executor } = fake();
    // Held before it started: "start nothing new" means nothing is applied.
    const first = await runRollout({
      state: requestHold(open(6)),
      commands: COMMANDS,
      executor,
    });

    expect(first.outcome).toBeUndefined();
    expect(first.state.devices.filter((d) => d.stage === "applied")).toHaveLength(0);

    const second = await runRollout({
      state: resume(first.state),
      commands: COMMANDS,
      executor,
    });
    expect(second.outcome).toBe("completed");
  });

  test("stopWhen parks the run without touching the next device", async () => {
    const { executor, calls } = fake();
    const run = await runRollout({
      state: open(6),
      commands: COMMANDS,
      executor,
      stopWhen: (action) => action.kind === "apply" && action.device === "rtr-02",
    });

    expect(run.outcome).toBeUndefined();
    expect(calls).not.toContain("apply:rtr-02(1)");
  });

  test("aborting mid-flight reverts what was applied", async () => {
    const { executor } = fake();
    const first = await runRollout({
      state: open(6),
      commands: COMMANDS,
      executor,
      stopWhen: (action) => action.kind === "apply" && action.device === "rtr-02",
    });

    const aborted = await runRollout({
      state: requestAbort(first.state, "operator stopped it"),
      commands: COMMANDS,
      executor,
    });
    expect(aborted.outcome).toBe("aborted");
    expect(aborted.state.devices.filter((d) => d.stage === "reverted")).toHaveLength(1);
  });
});

describe("observability", () => {
  test("every action is reported to onEvent", async () => {
    const { executor } = fake();
    const seen: string[] = [];
    await runRollout({
      state: open(4),
      commands: COMMANDS,
      executor,
      onEvent: ({ action }) => seen.push(action.kind),
    });
    expect(seen.filter((k) => k === "apply")).toHaveLength(4);
    expect(seen.filter((k) => k === "gate")).toHaveLength(3);
  });

  test("toRecord captures a JSON-serialisable history row", async () => {
    const { executor } = fake();
    const run = await runRollout({ state: open(3), commands: COMMANDS, executor });
    const record = toRecord(run.state, 1_700_000_000_000, {
      label: "ntp",
      commands: COMMANDS,
    });

    expect(record).toMatchObject({ id: "r1", outcome: "completed", label: "ntp" });
    expect(record.waves).toHaveLength(3);
    expect(() => JSON.stringify(record)).not.toThrow();
  });
});
