/**
 * The staged-rollout wave/gate machine, driven with fake outcomes — the
 * scenarios in `docs/tasks/05-staged-fleet-rollout.md` §8 plus the cases that
 * decide whether this is a safety feature or a liability: a gate failing on an
 * UNTOUCHED device, a device that was already down before the rollout started,
 * and a revert that itself fails.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  applyEvent,
  beginRollout,
  estimateSeconds,
  evaluateGate,
  nextAction,
  planWaves,
  requestAbort,
  requestHold,
  resume,
  revertSet,
  summarize,
} from "../../src/rollout/model";
import type {
  HealthResult,
  RolloutAction,
  RolloutOutcome,
  RolloutState,
  WaveStrategy,
} from "../../src/rollout/model";

function devices(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `rtr-${String(i + 1).padStart(2, "0")}`);
}

function open(count: number, strategy: WaveStrategy = {}, baseline?: Record<string, boolean>) {
  return beginRollout({ id: "r1", devices: devices(count), strategy, baseline });
}

/** How a scripted run answers each action. */
interface Script {
  applyFails?: Record<string, string>;
  gateFails?: Record<number, HealthResult[]>;
  revertFails?: string[];
}

/**
 * Run the whole machine against fakes. Returns the terminal outcome plus every
 * action taken, so ordering (newest-first reverts, gate before soak) is testable.
 */
function drive(
  start: RolloutState,
  script: Script = {},
): { outcome: RolloutOutcome; state: RolloutState; actions: RolloutAction[] } {
  let rollout = start;
  const actions: RolloutAction[] = [];
  for (let i = 0; i < 500; i++) {
    const action = nextAction(rollout);
    actions.push(action);
    switch (action.kind) {
      case "done":
        return { outcome: action.outcome, state: rollout, actions };
      case "hold":
        // A driven run releases the hold immediately; the hold itself is tested
        // separately.
        rollout = resume(rollout);
        break;
      case "apply": {
        const error = script.applyFails?.[action.device];
        rollout = applyEvent(rollout, {
          kind: "applied",
          device: action.device,
          ok: !error,
          snapshotId: `snap-${action.device}`,
          error,
        });
        break;
      }
      case "gate": {
        const scripted = script.gateFails?.[action.wave];
        const results: HealthResult[] =
          scripted ??
          [...action.changed, ...action.untouched].map((device) => ({ device, reachable: true }));
        rollout = applyEvent(rollout, {
          kind: "gate",
          result: evaluateGate(action.wave, results, {
            changed: action.changed,
            baseline: rollout.baseline,
          }),
        });
        break;
      }
      case "soak":
        rollout = applyEvent(rollout, { kind: "soaked", wave: action.wave });
        break;
      case "revert": {
        const fails = script.revertFails?.includes(action.device);
        rollout = applyEvent(rollout, {
          kind: "reverted",
          device: action.device,
          ok: !fails,
          error: fails ? "restore failed" : undefined,
        });
        break;
      }
    }
  }
  throw new Error("rollout did not terminate");
}

// ── Wave planning ───────────────────────────────────────────────────────────

describe("planWaves", () => {
  test("one device is a canary and nothing else", () => {
    const waves = planWaves(devices(1));
    expect(waves).toHaveLength(1);
    expect(waves[0]).toMatchObject({ index: 0, devices: ["rtr-01"], isCanary: true });
  });

  test("two devices are canary then the rest", () => {
    const waves = planWaves(devices(2));
    expect(waves.map((w) => w.devices)).toEqual([["rtr-01"], ["rtr-02"]]);
  });

  test("50 devices split 1 / 25% of the remainder / rest", () => {
    const waves = planWaves(devices(50));
    expect(waves.map((w) => w.devices.length)).toEqual([1, 13, 36]);
    expect(waves.reduce((n, w) => n + w.devices.length, 0)).toBe(50);
    expect(waves[0].isCanary).toBe(true);
    expect(waves[1].isCanary).toBe(false);
  });

  test("device order is preserved — the router you connect through stays last", () => {
    const waves = planWaves(["a", "b", "c", "d", "core-rtr"]);
    expect(waves.flatMap((w) => w.devices)).toEqual(["a", "b", "c", "d", "core-rtr"]);
    expect(waves.at(-1)?.devices.at(-1)).toBe("core-rtr");
  });

  test("a bigger canary and a different percentage are honoured", () => {
    expect(
      planWaves(devices(20), { canary: 3, wavePercent: 50 }).map((w) => w.devices.length),
    ).toEqual([3, 9, 8]);
  });

  test("wavePercent 100 collapses to canary + rest", () => {
    expect(planWaves(devices(10), { wavePercent: 100 }).map((w) => w.devices.length)).toEqual([
      1, 9,
    ]);
  });

  test("no devices means no waves", () => {
    expect(planWaves([])).toEqual([]);
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("a clean rollout", () => {
  test("applies every wave, gating and soaking between them", () => {
    const { outcome, state, actions } = drive(open(6));
    expect(outcome).toBe("completed");
    expect(state.devices.every((d) => d.stage === "applied")).toBe(true);

    // Each wave: apply its devices, then gate, then soak.
    const kinds = actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === "gate")).toHaveLength(3);
    expect(kinds.filter((k) => k === "soak")).toHaveLength(3);
    expect(kinds.indexOf("gate")).toBeLessThan(kinds.indexOf("soak"));
  });

  test("the gate sees the changed devices AND the untouched ones", () => {
    const { actions } = drive(open(6));
    const firstGate = actions.find((a) => a.kind === "gate");
    expect(firstGate).toMatchObject({ wave: 0, changed: ["rtr-01"] });
    expect(firstGate?.kind === "gate" && firstGate.untouched).toEqual([
      "rtr-02",
      "rtr-03",
      "rtr-04",
      "rtr-05",
      "rtr-06",
    ]);
  });

  test("soakSeconds 0 skips the soak entirely", () => {
    const { actions, outcome } = drive(open(3, { soakSeconds: 0 }));
    expect(outcome).toBe("completed");
    expect(actions.some((a) => a.kind === "soak")).toBe(false);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe("the canary fails", () => {
  test("the revert set is just the canary and nothing else is touched", () => {
    const { outcome, state, actions } = drive(open(10), {
      gateFails: { 0: [{ device: "rtr-01", reachable: false, detail: "no ssh" }] },
    });

    expect(outcome).toBe("reverted");
    expect(actions.filter((a) => a.kind === "revert").map((a) => a.device)).toEqual(["rtr-01"]);
    expect(state.devices.filter((d) => d.stage === "skipped")).toHaveLength(9);
    expect(actions.filter((a) => a.kind === "apply")).toHaveLength(1);
  });

  test("a device that cannot even be applied halts immediately, before any gate", () => {
    const { outcome, actions } = drive(open(10), { applyFails: { "rtr-01": "bad command" } });
    expect(outcome).toBe("reverted");
    expect(actions.some((a) => a.kind === "gate")).toBe(false);
  });
});

describe("a later wave fails", () => {
  test("the revert set is the canary plus that wave, newest first", () => {
    const { outcome, state, actions } = drive(open(6), {
      gateFails: {
        1: [
          { device: "rtr-01", reachable: true },
          { device: "rtr-02", reachable: false },
        ],
      },
    });

    expect(outcome).toBe("reverted");
    const reverted = actions.filter((a) => a.kind === "revert").map((a) => a.device);
    // Wave 1 was rtr-01; wave 2 was rtr-02 (25% of 5 → 2 devices: rtr-02, rtr-03).
    expect(reverted[0]).not.toBe("rtr-01"); // newest first
    expect(reverted.at(-1)).toBe("rtr-01");
    expect(state.devices.filter((d) => d.stage === "reverted").length).toBe(reverted.length);
  });

  test("reverts carry each device's own snapshot id", () => {
    const { actions } = drive(open(4), {
      gateFails: { 0: [{ device: "rtr-01", reachable: false }] },
    });
    const revert = actions.find((a) => a.kind === "revert");
    expect(revert?.kind === "revert" && revert.snapshotId).toBe("snap-rtr-01");
  });
});

describe("gate failures on untouched devices", () => {
  test("a device that goes dark although it was never touched halts the rollout", () => {
    const { outcome, state } = drive(open(8), {
      gateFails: {
        0: [
          { device: "rtr-01", reachable: true },
          { device: "rtr-05", reachable: false, detail: "no route to host" },
        ],
      },
    });

    expect(outcome).toBe("reverted");
    expect(state.gates[0].collateral).toBe(true);
    expect(state.notes.join(" ")).toContain("untouched device");
  });

  test("a device already offline BEFORE the rollout does not fail the gate", () => {
    const baseline = { "rtr-05": false };
    const { outcome } = drive(open(8, {}, baseline), {
      gateFails: {
        0: [
          { device: "rtr-01", reachable: true },
          { device: "rtr-05", reachable: false },
        ],
      },
    });
    expect(outcome).toBe("completed");
  });

  test("failed plan assertions fail the gate even when the device answers", () => {
    const gate = evaluateGate(
      0,
      [{ device: "a", reachable: true, assertionsPassed: false, detail: "ntp not synced" }],
      { changed: ["a"] },
    );
    expect(gate.ok).toBe(false);
    expect(gate.failures[0].reason).toContain("assertions failed");
    expect(gate.collateral).toBeUndefined();
  });

  test("a healthy gate passes", () => {
    const gate = evaluateGate(0, [{ device: "a", reachable: true, assertionsPassed: true }], {
      changed: ["a"],
    });
    expect(gate).toMatchObject({ ok: true, failures: [] });
  });
});

// ── onFailure modes ─────────────────────────────────────────────────────────

describe("onFailure modes", () => {
  test("`continue` ignores a failure and finishes the fleet", () => {
    const { outcome, state, actions } = drive(open(6, { onFailure: "continue" }), {
      gateFails: { 0: [{ device: "rtr-01", reachable: false }] },
    });

    expect(outcome).toBe("completed-with-failures");
    expect(actions.some((a) => a.kind === "revert")).toBe(false);
    expect(state.devices.filter((d) => d.stage === "applied")).toHaveLength(6);
  });

  test("`continue` also survives a device that fails to apply", () => {
    const { outcome, state } = drive(open(4, { onFailure: "continue" }), {
      applyFails: { "rtr-02": "syntax error" },
    });
    expect(outcome).toBe("completed-with-failures");
    expect(state.devices.find((d) => d.device === "rtr-02")?.stage).toBe("failed");
  });

  test("`halt-and-hold` stops and reverts NOTHING", () => {
    const { outcome, state, actions } = drive(open(6, { onFailure: "halt-and-hold" }), {
      gateFails: { 0: [{ device: "rtr-01", reachable: false }] },
    });

    expect(outcome).toBe("halted");
    expect(actions.some((a) => a.kind === "revert")).toBe(false);
    // The changed device is left changed — deliberately, for inspection.
    expect(state.devices.find((d) => d.device === "rtr-01")?.stage).toBe("applied");
    expect(state.devices.filter((d) => d.stage === "skipped")).toHaveLength(5);
  });

  test("`halt-and-revert` is the default", () => {
    expect(open(3).onFailure).toBe("halt-and-revert");
  });
});

// ── Revert failures ─────────────────────────────────────────────────────────

describe("a revert that itself fails", () => {
  test("is the only outcome that demands a human", () => {
    const { outcome, state } = drive(open(6), {
      gateFails: {
        1: [
          { device: "rtr-02", reachable: false },
          { device: "rtr-01", reachable: true },
        ],
      },
      revertFails: ["rtr-02"],
    });

    expect(outcome).toBe("needs-attention");
    const flagged = state.devices.filter((d) => d.stage === "revert-failed");
    expect(flagged.map((d) => d.device)).toEqual(["rtr-02"]);
    // The report has to name the snapshot to restore by hand.
    expect(summarize(state).join("\n")).toContain("snap-rtr-02");
    expect(summarize(state).join("\n")).toContain("restore failed");
  });
});

// ── Hold / resume / abort ───────────────────────────────────────────────────

describe("hold, resume and abort", () => {
  test("a hold parks the machine at the next decision, not mid-device", () => {
    let rollout = open(6);
    // Apply the canary, then hold: the next action must be the hold, not a gate.
    rollout = applyEvent(rollout, {
      kind: "applied",
      device: "rtr-01",
      ok: true,
      snapshotId: "snap-1",
    });
    rollout = requestHold(rollout);
    // Still in the apply phase for this wave → the canary's wave finishes first.
    expect(nextAction(rollout).kind).toBe("gate");

    const gated = applyEvent(rollout, {
      kind: "gate",
      result: evaluateGate(0, [{ device: "rtr-01", reachable: true }], { changed: ["rtr-01"] }),
    });
    expect(nextAction(gated).kind).toBe("hold");
  });

  test("resume continues from where it parked", () => {
    let rollout = open(4);
    rollout = applyEvent(rollout, { kind: "applied", device: "rtr-01", ok: true });
    rollout = requestHold(rollout);
    rollout = applyEvent(rollout, {
      kind: "gate",
      result: evaluateGate(0, [{ device: "rtr-01", reachable: true }], { changed: ["rtr-01"] }),
    });
    expect(nextAction(rollout).kind).toBe("hold");

    rollout = resume(rollout);
    expect(nextAction(rollout).kind).toBe("soak");
    expect(rollout.notes).toContain("Resumed");
  });

  test("abort reverts what was applied, regardless of onFailure", () => {
    let rollout = open(6, { onFailure: "halt-and-hold" });
    rollout = applyEvent(rollout, {
      kind: "applied",
      device: "rtr-01",
      ok: true,
      snapshotId: "snap-1",
    });
    rollout = requestAbort(rollout, "operator stopped it");

    expect(rollout.phase).toBe("revert");
    expect(nextAction(rollout)).toMatchObject({ kind: "revert", device: "rtr-01" });
    expect(rollout.notes.join(" ")).toContain("operator stopped it");
  });

  test("aborting before anything was applied changes nothing", () => {
    const rollout = requestAbort(open(4));
    expect(rollout.outcome).toBe("aborted");
    expect(rollout.devices.every((d) => d.stage === "skipped")).toBe(true);
  });
});

// ── Machine invariants ──────────────────────────────────────────────────────

describe("machine invariants", () => {
  test("nextAction is idempotent until an event is applied", () => {
    const rollout = open(5);
    expect(nextAction(rollout)).toEqual(nextAction(rollout));
  });

  test("applying an event does not mutate the previous state", () => {
    const rollout = open(3);
    applyEvent(rollout, { kind: "applied", device: "rtr-01", ok: true, snapshotId: "s" });
    expect(rollout.devices[0].stage).toBe("pending");
    expect(rollout.applyCounter).toBe(0);
  });

  test("a finished rollout refuses further events", () => {
    const { state } = drive(open(2));
    expect(() => applyEvent(state, { kind: "applied", device: "rtr-01", ok: true })).toThrow(
      /already finished/,
    );
  });

  test("an event for an unknown device is an error", () => {
    expect(() => applyEvent(open(2), { kind: "applied", device: "nope", ok: true })).toThrow(
      /not part of rollout/,
    );
  });

  test("duplicate or empty device lists are rejected up front", () => {
    expect(() => beginRollout({ id: "x", devices: [] })).toThrow(/at least one device/);
    expect(() => beginRollout({ id: "x", devices: ["a", "a"] })).toThrow(/Duplicate device/);
  });

  test("revertSet is newest-first and excludes already-reverted devices", () => {
    let rollout = open(4, { soakSeconds: 0 });
    rollout = applyEvent(rollout, { kind: "applied", device: "rtr-01", ok: true });
    rollout = applyEvent(rollout, {
      kind: "gate",
      result: evaluateGate(0, [{ device: "rtr-01", reachable: true }], { changed: ["rtr-01"] }),
    });
    rollout = applyEvent(rollout, { kind: "applied", device: "rtr-02", ok: true });
    expect(revertSet(rollout).map((d) => d.device)).toEqual(["rtr-02", "rtr-01"]);

    rollout = requestAbort(rollout);
    rollout = applyEvent(rollout, { kind: "reverted", device: "rtr-02", ok: true });
    expect(revertSet(rollout).map((d) => d.device)).toEqual(["rtr-01"]);
  });
});

describe("estimates", () => {
  test("counts every device plus a gate and soak per wave", () => {
    const waves = planWaves(devices(10));
    const seconds = estimateSeconds(waves, {
      perDeviceSeconds: 10,
      soakSeconds: 30,
      gateSeconds: 5,
    });
    expect(seconds).toBe(10 * 10 + 3 * 35);
  });

  test("a zero soak makes a small rollout quick", () => {
    expect(
      estimateSeconds(planWaves(devices(2)), {
        perDeviceSeconds: 5,
        soakSeconds: 0,
        gateSeconds: 1,
      }),
    ).toBe(2 * 5 + 2 * 1);
  });
});
