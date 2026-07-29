/**
 * Staged fleet rollout — the PURE wave/gate state machine.
 *
 * Applying one change to fifty routers is not fifty independent changes: the
 * point is to find out on device 1 what would otherwise be discovered on device
 * 50. So a rollout runs **canary → wave → fleet**, and between waves it stops at
 * a gate.
 *
 * **The gate is the feature.** After each wave it checks the devices just
 * changed AND the ones not touched yet (a change that breaks routing shows up as
 * an untouched device going dark), then soaks before continuing — without a
 * soak, a change that kills connectivity ten seconds later rolls straight
 * through the whole fleet while every immediate check still says "fine".
 *
 * Related but deliberately separate from `src/txn/` (task 03): that makes a
 * change atomic across devices that must AGREE (both ends of a tunnel); this
 * makes a change safe across devices that are INDEPENDENT (the same NTP server
 * everywhere). All-or-nothing and simultaneous versus sequential and
 * progressive — same snapshot/Safe-Mode primitives, different state machines.
 *
 * Everything here is pure: which wave next, does the gate pass, what has to be
 * reverted. `src/rollout/runner.ts` performs the I/O.
 */

/** What to do when a wave fails its gate. */
export type OnFailure = "halt-and-revert" | "halt-and-hold" | "continue";

export interface WaveStrategy {
  /** Devices in the first wave. The canary is the whole point — default 1. */
  canary?: number;
  /** Percent of the REMAINING devices in the second wave (default 25). */
  wavePercent?: number;
  /** Seconds to wait after each wave's health check before continuing. */
  soakSeconds?: number;
  onFailure?: OnFailure;
}

export interface Wave {
  /** 0-based. */
  index: number;
  devices: string[];
  /** True for the first wave — rendered differently because it matters most. */
  isCanary: boolean;
}

export type DeviceStage =
  | "pending"
  | "applied"
  | "failed"
  | "reverted"
  | "revert-failed"
  | "skipped";

export interface DeviceState {
  device: string;
  wave: number;
  stage: DeviceStage;
  /** Pre-change snapshot; the only way back once the device has been changed. */
  snapshotId?: string;
  error?: string;
  /** Order in which this device was applied, for newest-first reverting. */
  appliedSeq?: number;
}

/** One device's post-change health, as the gate sees it. */
export interface HealthResult {
  device: string;
  reachable: boolean;
  /** Plan-declared assertions, when the plan has any. Undefined = none run. */
  assertionsPassed?: boolean;
  detail?: string;
}

export interface GateResult {
  wave: number;
  ok: boolean;
  /** Devices that failed the gate, with the reason. */
  failures: { device: string; reason: string }[];
  results: HealthResult[];
  /** Set when the gate failed because an UNTOUCHED device went dark. */
  collateral?: boolean;
}

export type RolloutOutcome =
  | "completed"
  | "completed-with-failures"
  | "halted"
  | "reverted"
  | "needs-attention"
  | "aborted";

export type RolloutPhase = "apply" | "gate" | "soak" | "revert" | "held" | "done";

export interface RolloutState {
  id: string;
  waves: Wave[];
  devices: DeviceState[];
  phase: RolloutPhase;
  /** Index of the wave being applied / gated. */
  currentWave: number;
  onFailure: OnFailure;
  soakSeconds: number;
  /**
   * Reachability at the moment the rollout started. The gate compares against
   * this so a router that was already offline doesn't halt every rollout, while
   * one that goes dark DURING the rollout does.
   */
  baseline: Record<string, boolean>;
  gates: GateResult[];
  /** Set when a human pressed Hold; the machine parks at the next decision. */
  holdRequested?: boolean;
  /** Set when abort was requested; treated as a failure with revert. */
  abortRequested?: boolean;
  outcome?: RolloutOutcome;
  /** Increments per applied device, so reverts can go newest-first. */
  applyCounter: number;
  notes: string[];
}

export type RolloutAction =
  | { kind: "apply"; device: string; wave: number }
  | { kind: "gate"; wave: number; changed: string[]; untouched: string[] }
  | { kind: "soak"; wave: number; seconds: number }
  | { kind: "revert"; device: string; snapshotId?: string }
  | { kind: "hold" }
  | { kind: "done"; outcome: RolloutOutcome };

export type RolloutEvent =
  | { kind: "applied"; device: string; ok: boolean; snapshotId?: string; error?: string }
  | { kind: "gate"; result: GateResult }
  | { kind: "soaked"; wave: number }
  | { kind: "reverted"; device: string; ok: boolean; error?: string };

const DEFAULT_STRATEGY: Required<Omit<WaveStrategy, "onFailure">> & { onFailure: OnFailure } = {
  canary: 1,
  wavePercent: 25,
  soakSeconds: 30,
  onFailure: "halt-and-revert",
};

/**
 * Split devices into canary → percentage wave → the rest.
 *
 * Deliberately three waves rather than "keep taking 25% until done": the value
 * is in the first blast radius being tiny and the gate between stages, not in
 * having many stages. `wavePercent: 100` collapses it to canary + rest.
 * The device ORDER is preserved — callers put the router they most want to keep
 * (the one they connect through) last, and the plan must not reshuffle that.
 */
export function planWaves(devices: string[], strategy: WaveStrategy = {}): Wave[] {
  const canarySize = Math.max(1, Math.floor(strategy.canary ?? DEFAULT_STRATEGY.canary));
  const percent = Math.min(100, Math.max(1, strategy.wavePercent ?? DEFAULT_STRATEGY.wavePercent));
  if (devices.length === 0) return [];

  const waves: Wave[] = [];
  const canary = devices.slice(0, canarySize);
  waves.push({ index: 0, devices: canary, isCanary: true });

  let remaining = devices.slice(canary.length);
  if (remaining.length === 0) return waves;

  const secondSize = Math.min(
    remaining.length,
    Math.max(1, Math.ceil((remaining.length * percent) / 100)),
  );
  waves.push({ index: 1, devices: remaining.slice(0, secondSize), isCanary: false });
  remaining = remaining.slice(secondSize);

  if (remaining.length > 0) {
    waves.push({ index: 2, devices: remaining, isCanary: false });
  }
  return waves;
}

export interface BeginRolloutInput {
  id: string;
  devices: string[];
  strategy?: WaveStrategy;
  /** Reachability per device at start; anything missing counts as reachable. */
  baseline?: Record<string, boolean>;
}

export function beginRollout(input: BeginRolloutInput): RolloutState {
  if (input.devices.length === 0) throw new Error("A rollout needs at least one device.");
  if (new Set(input.devices).size !== input.devices.length) {
    throw new Error(`Duplicate device in rollout: ${input.devices.join(", ")}`);
  }

  const waves = planWaves(input.devices, input.strategy);
  const devices: DeviceState[] = waves.flatMap((w) =>
    w.devices.map((device) => ({ device, wave: w.index, stage: "pending" as const })),
  );

  return {
    id: input.id,
    waves,
    devices,
    phase: "apply",
    currentWave: 0,
    onFailure: input.strategy?.onFailure ?? DEFAULT_STRATEGY.onFailure,
    soakSeconds: Math.max(0, input.strategy?.soakSeconds ?? DEFAULT_STRATEGY.soakSeconds),
    baseline: input.baseline ?? {},
    gates: [],
    applyCounter: 0,
    notes: [],
  };
}

function state(rollout: RolloutState, device: string): DeviceState {
  const found = rollout.devices.find((d) => d.device === device);
  if (!found) throw new Error(`Device '${device}' is not part of rollout ${rollout.id}.`);
  return found;
}

function patch(rollout: RolloutState, device: string, change: Partial<DeviceState>): RolloutState {
  state(rollout, device);
  return {
    ...rollout,
    devices: rollout.devices.map((d) => (d.device === device ? { ...d, ...change } : d)),
  };
}

/** Devices this rollout changed and has not yet undone, newest first. */
export function revertSet(rollout: RolloutState): DeviceState[] {
  return rollout.devices
    .filter((d) => d.stage === "applied" || d.stage === "failed")
    .sort((a, b) => (b.appliedSeq ?? 0) - (a.appliedSeq ?? 0));
}

/** Devices in later waves that were never touched. */
function untouched(rollout: RolloutState): string[] {
  return rollout.devices
    .filter((d) => d.wave > rollout.currentWave && d.stage === "pending")
    .map((d) => d.device);
}

/**
 * Evaluate a gate.
 *
 * Two independent ways to fail, and the second is the one people forget:
 *   1. a device just changed is unreachable or failed the plan's assertions;
 *   2. a device NOT yet touched went dark — the change broke something for the
 *      rest of the fleet (routing, a firewall rule on a shared path), which is
 *      exactly the failure a per-device check cannot see.
 *
 * A device that was already unreachable at the start of the rollout does not
 * count against the gate; halting a fleet change because one router has been
 * off since yesterday is how a safety feature earns itself a `--force`.
 */
export function evaluateGate(
  wave: number,
  results: HealthResult[],
  opts: { changed: string[]; baseline?: Record<string, boolean> } = { changed: [] },
): GateResult {
  const baseline = opts.baseline ?? {};
  const changed = new Set(opts.changed);
  const failures: { device: string; reason: string }[] = [];
  let collateral = false;

  for (const r of results) {
    const wasReachable = baseline[r.device] ?? true;
    if (!r.reachable) {
      if (!wasReachable) continue; // already down before we started
      failures.push({
        device: r.device,
        reason: changed.has(r.device)
          ? `unreachable after the change${r.detail ? ` — ${r.detail}` : ""}`
          : `went unreachable although it was never touched${r.detail ? ` — ${r.detail}` : ""}`,
      });
      if (!changed.has(r.device)) collateral = true;
      continue;
    }
    if (r.assertionsPassed === false) {
      failures.push({
        device: r.device,
        reason: `assertions failed${r.detail ? ` — ${r.detail}` : ""}`,
      });
    }
  }

  return {
    wave,
    ok: failures.length === 0,
    failures,
    results,
    collateral: collateral || undefined,
  };
}

/** Terminal classification once nothing is left to do. */
function classify(rollout: RolloutState): RolloutOutcome {
  const stages = rollout.devices.map((d) => d.stage);
  if (stages.some((s) => s === "revert-failed")) return "needs-attention";
  if (rollout.abortRequested) return "aborted";
  if (stages.some((s) => s === "reverted")) return "reverted";
  const gateFailed = rollout.gates.some((g) => !g.ok);
  if (stages.some((s) => s === "failed")) {
    return rollout.onFailure === "continue" ? "completed-with-failures" : "halted";
  }
  // Every device applied — but a gate that failed and was overridden by
  // `continue` must still show in the outcome, or the report claims a clean run
  // over a fleet where something was already known to be broken.
  if (stages.every((s) => s === "applied")) {
    return gateFailed ? "completed-with-failures" : "completed";
  }
  // Some devices never ran (halt-and-hold, or a gate stopped the rollout).
  return stages.some((s) => s === "applied") ? "halted" : "aborted";
}

/**
 * The next thing to do, derived purely from the current state. Calling it twice
 * without applying an event returns the same action.
 */
export function nextAction(rollout: RolloutState): RolloutAction {
  if (rollout.outcome) return { kind: "done", outcome: rollout.outcome };

  if (rollout.phase === "revert") {
    const next = revertSet(rollout)[0];
    return next
      ? { kind: "revert", device: next.device, snapshotId: next.snapshotId }
      : { kind: "done", outcome: classify(rollout) };
  }

  // A hold parks the machine at the next decision point rather than mid-device:
  // stopping half-way through applying one router is the one place a pause makes
  // things worse.
  if (rollout.holdRequested && rollout.phase !== "apply") return { kind: "hold" };

  const wave = rollout.waves[rollout.currentWave];
  if (!wave) return { kind: "done", outcome: classify(rollout) };

  switch (rollout.phase) {
    case "apply": {
      const pending = wave.devices.find((d) => state(rollout, d).stage === "pending");
      if (pending) return { kind: "apply", device: pending, wave: wave.index };
      return {
        kind: "gate",
        wave: wave.index,
        changed: wave.devices.filter((d) => state(rollout, d).stage === "applied"),
        untouched: untouched(rollout),
      };
    }
    case "gate":
      return {
        kind: "gate",
        wave: wave.index,
        changed: wave.devices.filter((d) => state(rollout, d).stage === "applied"),
        untouched: untouched(rollout),
      };
    case "soak":
      return { kind: "soak", wave: wave.index, seconds: rollout.soakSeconds };
    case "held":
      return { kind: "hold" };
    case "done":
      return { kind: "done", outcome: classify(rollout) };
  }
}

/** Mark every not-yet-applied device as skipped — used when a rollout stops early. */
function skipRemaining(rollout: RolloutState): RolloutState {
  return {
    ...rollout,
    devices: rollout.devices.map((d) => (d.stage === "pending" ? { ...d, stage: "skipped" } : d)),
  };
}

/** Enter the failure path appropriate to `onFailure`. */
function handleFailure(rollout: RolloutState, note: string): RolloutState {
  const noted = { ...skipRemaining(rollout), notes: [...rollout.notes, note] };
  switch (rollout.onFailure) {
    case "continue":
      // Explicitly opted into: record the failure and carry on to the next wave
      // exactly as a passing gate would — including the soak, since the point of
      // waiting is unchanged by having decided not to halt.
      return proceed({
        ...rollout,
        notes: [...rollout.notes, `${note} (continuing: onFailure=continue)`],
      });
    case "halt-and-hold":
      // Stop where we are and change nothing back — for when a human wants to
      // inspect the broken device before deciding.
      return { ...noted, phase: "done", outcome: classify({ ...noted, phase: "done" }) };
    case "halt-and-revert":
      return revertSet(noted).length === 0
        ? { ...noted, phase: "done", outcome: classify({ ...noted, phase: "done" }) }
        : { ...noted, phase: "revert" };
  }
}

/** Move past a completed gate: soak first when configured, else next wave. */
function proceed(rollout: RolloutState): RolloutState {
  return rollout.soakSeconds > 0 ? { ...rollout, phase: "soak" } : advance(rollout);
}

/** Advance to the next wave, or finish. */
function advance(rollout: RolloutState): RolloutState {
  const next = rollout.currentWave + 1;
  if (next >= rollout.waves.length) {
    return { ...rollout, phase: "done", outcome: classify(rollout) };
  }
  return { ...rollout, currentWave: next, phase: "apply" };
}

/** Fold one outcome into the rollout. This is where the protocol lives. */
export function applyEvent(rollout: RolloutState, event: RolloutEvent): RolloutState {
  if (rollout.outcome)
    throw new Error(`Rollout ${rollout.id} already finished as ${rollout.outcome}.`);

  switch (event.kind) {
    case "applied": {
      const seq = rollout.applyCounter + 1;
      const next = {
        ...patch(rollout, event.device, {
          stage: event.ok ? "applied" : "failed",
          snapshotId: event.snapshotId,
          error: event.error,
          appliedSeq: seq,
        }),
        applyCounter: seq,
      };
      if (event.ok) return next;
      // A device that could not be changed is a wave failure immediately — no
      // point gating a wave we already know is broken.
      if (next.onFailure === "continue") {
        return {
          ...next,
          notes: [...next.notes, `${event.device} failed to apply (continuing)`],
        };
      }
      return handleFailure(next, `${event.device} failed to apply: ${event.error ?? "unknown"}`);
    }

    case "gate": {
      const next = { ...rollout, gates: [...rollout.gates, event.result] };
      // Soak BEFORE the next wave. A change that breaks things ten seconds
      // later must not have already reached the whole fleet by then.
      if (event.result.ok) return proceed(next);
      const reasons = event.result.failures.map((f) => `${f.device}: ${f.reason}`).join("; ");
      const prefix = event.result.collateral
        ? `Wave ${event.result.wave} gate FAILED on an untouched device (the change affected the wider fleet)`
        : `Wave ${event.result.wave} gate FAILED`;
      return handleFailure(next, `${prefix} — ${reasons}`);
    }

    case "soaked":
      return advance(rollout);

    case "reverted": {
      const next = patch(rollout, event.device, {
        stage: event.ok ? "reverted" : "revert-failed",
        error: event.ok ? state(rollout, event.device).error : event.error,
      });
      const remaining = revertSet(next);
      return remaining.length === 0 ? { ...next, phase: "done", outcome: classify(next) } : next;
    }
  }
}

/** Freeze the rollout at the next decision point (a human pressed Hold). */
export function requestHold(rollout: RolloutState): RolloutState {
  if (rollout.outcome) return rollout;
  return { ...rollout, holdRequested: true, notes: [...rollout.notes, "Hold requested"] };
}

/** Release a hold and continue from where the rollout parked. */
export function resume(rollout: RolloutState): RolloutState {
  if (rollout.outcome) return rollout;
  return {
    ...rollout,
    holdRequested: false,
    phase: rollout.phase === "held" ? "apply" : rollout.phase,
    notes: [...rollout.notes, "Resumed"],
  };
}

/**
 * Stop now and undo what this rollout applied. Unlike a gate failure, this is
 * unconditional — `onFailure` describes what to do about a BROKEN wave, not
 * about a human deciding to stop.
 */
export function requestAbort(rollout: RolloutState, reason?: string): RolloutState {
  if (rollout.outcome) return rollout;
  const noted = {
    ...skipRemaining(rollout),
    abortRequested: true,
    notes: [...rollout.notes, reason ? `Aborted: ${reason}` : "Aborted"],
  };
  return revertSet(noted).length === 0
    ? { ...noted, phase: "done", outcome: classify({ ...noted, phase: "done" }) }
    : { ...noted, phase: "revert" };
}

/** One line per device — the report a `needs-attention` rollout is judged by. */
export function summarize(rollout: RolloutState): string[] {
  return rollout.devices.map((d) => {
    const snap = d.snapshotId ? ` (snapshot ${d.snapshotId})` : "";
    const why = d.error ? ` — ${d.error}` : "";
    return `wave ${d.wave + 1} · ${d.device}: ${d.stage}${snap}${why}`;
  });
}

/** Rough wall-clock estimate for `plan_rollout`, in seconds. */
export function estimateSeconds(
  waves: Wave[],
  opts: { perDeviceSeconds?: number; soakSeconds?: number; gateSeconds?: number } = {},
): number {
  const perDevice = opts.perDeviceSeconds ?? 8;
  const soak = opts.soakSeconds ?? DEFAULT_STRATEGY.soakSeconds;
  const gate = opts.gateSeconds ?? 5;
  const devices = waves.reduce((n, w) => n + w.devices.length, 0);
  // The final wave's soak is real time too: the rollout is not "done" until the
  // last wave has been observed to survive.
  return devices * perDevice + waves.length * (gate + soak);
}
