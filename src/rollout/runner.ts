/**
 * Staged rollout runner — the I/O shell around the pure model in `./model.ts`.
 *
 * The loop is: ask the model what to do, do exactly that, fold the outcome back
 * in. Every decision (which wave, does the gate pass, what to revert) stays in
 * the model, so the runner has no policy of its own and the risky logic remains
 * testable offline against fakes.
 *
 * How a device is changed: the commands run inside **Safe Mode**, are verified
 * to leave the device reachable, and only then committed. A device whose change
 * fails mid-way is reverted by RouterOS itself when the session closes — so a
 * failed apply leaves that router untouched rather than half-changed, and the
 * rollout's own revert only has to deal with devices that committed cleanly.
 *
 * How a device is reverted: by replaying its pre-change `/export` snapshot,
 * again under Safe Mode. This is the same mechanism `config_reconcile` already
 * ships, and it is the reason `halt-and-revert` can be the default — but it is
 * not free, so a revert that fails is surfaced loudly as `needs-attention`
 * rather than being retried into a worse state.
 */
import { exportToCommands } from "../backups/vault";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { looksLikeError } from "../core/routeros";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { logger } from "../logger";
import { probeDevice } from "../observability/health";
import { captureSnapshot } from "../snapshots/capture";
import { openSnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { getSafeModeManager } from "../ssh/safe-mode";
import { applyEvent, evaluateGate, nextAction, summarize } from "./model";
import type { HealthResult, RolloutAction, RolloutOutcome, RolloutState } from "./model";

/**
 * The device side of a rollout, injected so the whole progression can be driven
 * against fakes. Every method REJECTS on failure; the runner turns a rejection
 * into the model event that drives the halt/revert paths.
 */
export interface RolloutExecutor {
  /** Capture the pre-change snapshot; its id is the only way back. */
  snapshot(device: string): Promise<string>;
  /** Apply the plan's commands to one device (Safe Mode, verify, commit). */
  apply(device: string, commands: string[]): Promise<void>;
  /** Health of the devices just changed plus the ones not yet touched. */
  health(changed: string[], untouched: string[]): Promise<HealthResult[]>;
  /** Wait out the soak. Separate so tests can make it instant. */
  soak(seconds: number): Promise<void>;
  /** Restore a device from its pre-change snapshot. */
  revert(device: string, snapshotId: string | undefined): Promise<void>;
}

export type RolloutObserver = (event: { action: RolloutAction; state: RolloutState }) => void;

export interface RunRolloutInput {
  state: RolloutState;
  /** Commands to apply, per device. A device with no entry gets `commands`. */
  commands: string[];
  perDevice?: Record<string, string[]>;
  executor: RolloutExecutor;
  onEvent?: RolloutObserver;
  /** Stop before performing an action this returns true for (used by Hold). */
  stopWhen?: (action: RolloutAction) => boolean;
}

export interface RolloutRun {
  /** The terminal outcome, or undefined when the run paused (hold / stopWhen). */
  outcome?: RolloutOutcome;
  state: RolloutState;
  summary: string[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run a rollout to completion (or until it parks). Never throws for a
 * device-side failure — a failure is an event, and the outcome is the answer.
 */
export async function runRollout(input: RunRolloutInput): Promise<RolloutRun> {
  const { commands, perDevice, executor, onEvent, stopWhen } = input;
  let state = input.state;
  // Every device needs at most snapshot+apply+revert, plus a gate and soak per
  // wave; the cap only exists so a model bug fails loudly instead of spinning.
  const maxSteps = state.devices.length * 4 + state.waves.length * 4 + 20;

  for (let i = 0; i < maxSteps; i++) {
    const action = nextAction(state);
    if (action.kind === "done") {
      return { outcome: action.outcome, state, summary: summarize(state) };
    }
    // A hold is a park, not a failure: the caller keeps the state and resumes.
    if (action.kind === "hold" || stopWhen?.(action) === true) {
      return { outcome: undefined, state, summary: summarize(state) };
    }

    switch (action.kind) {
      case "apply": {
        const device = action.device;
        let snapshotId: string | undefined;
        try {
          // Snapshot BEFORE touching the device: without it the device cannot be
          // reverted, which turns a recoverable halt into needs-attention.
          snapshotId = await executor.snapshot(device);
        } catch (e) {
          state = applyEvent(state, {
            kind: "applied",
            device,
            ok: false,
            error: `snapshot failed: ${message(e)}`,
          });
          break;
        }
        try {
          await executor.apply(device, perDevice?.[device] ?? commands);
          state = applyEvent(state, { kind: "applied", device, ok: true, snapshotId });
        } catch (e) {
          state = applyEvent(state, {
            kind: "applied",
            device,
            ok: false,
            snapshotId,
            error: message(e),
          });
        }
        break;
      }

      case "gate": {
        let results: HealthResult[];
        try {
          results = await executor.health(action.changed, action.untouched);
        } catch (e) {
          // A health check that blew up is a FAILED gate, never a pass: the
          // whole point is that we do not proceed on missing evidence.
          results = action.changed.map((device) => ({
            device,
            reachable: false,
            detail: `health check error: ${message(e)}`,
          }));
        }
        state = applyEvent(state, {
          kind: "gate",
          result: evaluateGate(action.wave, results, {
            changed: action.changed,
            baseline: state.baseline,
          }),
        });
        break;
      }

      case "soak":
        await executor.soak(action.seconds);
        state = applyEvent(state, { kind: "soaked", wave: action.wave });
        break;

      case "revert":
        try {
          await executor.revert(action.device, action.snapshotId);
          state = applyEvent(state, { kind: "reverted", device: action.device, ok: true });
        } catch (e) {
          state = applyEvent(state, {
            kind: "reverted",
            device: action.device,
            ok: false,
            error: message(e),
          });
        }
        break;
    }
    onEvent?.({ action, state });
  }

  throw new Error(`Rollout ${state.id} did not terminate within ${maxSteps} steps.`);
}

// ── The live executor ───────────────────────────────────────────────────────

/** Per-device context clone — device commands target `ctx.device`. */
function on(ctx: ToolContext, device: string): ToolContext {
  return { ...ctx, device };
}

/** Apply a list of commands to one device under Safe Mode, verify, commit. */
async function applyUnderSafeMode(device: string, commands: string[]): Promise<void> {
  const safe = getSafeModeManager(device);
  const enabled = await safe.enable();
  if (enabled.startsWith("Error")) throw new Error(enabled);

  try {
    for (const command of commands) {
      const out = await safe.execute(command);
      if (looksLikeError(out)) throw new Error(`${command} -> ${out.trim()}`);
    }
    // Reachability gate before committing: if the device stopped answering,
    // closing the session reverts it automatically — which is exactly what we
    // want, and far better than committing a change that locked us out.
    const probe = await safe.execute("/system identity print");
    if (looksLikeError(probe)) {
      throw new Error("device stopped responding after the change (not committed)");
    }
  } catch (e) {
    await safe.rollback().catch(() => {
      /* the session is going away either way */
    });
    throw e;
  }

  const committed = await safe.commit();
  if (!committed.ok) throw new Error(committed.message);
}

/** Snapshot store, opened lazily and shared for the process. */
let snapshotStorePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  snapshotStorePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return snapshotStorePromise;
}

/** Reachability for every device, used as the rollout's baseline and gates. */
export async function probeReachability(devices: string[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    devices.map(async (name) => {
      try {
        const status = await probeDevice(name, getDevice(name));
        return [name, status.reachable === true] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** The real device side: snapshots, Safe-Mode applies, SSH health probes. */
export function createDeviceExecutor(ctx: ToolContext, rolloutId: string): RolloutExecutor {
  return {
    async snapshot(device) {
      return captureSnapshot(on(ctx, device), `pre-rollout ${rolloutId}`);
    },

    async apply(device, commands) {
      if (commands.length === 0) throw new Error("no commands to apply");
      await applyUnderSafeMode(resolveDeviceName(device), commands);
    },

    async health(changed, untouched) {
      // Both sets matter: the changed devices might be broken BY the change, and
      // an untouched one going dark means the change broke the wider fleet.
      const all = [...new Set([...changed, ...untouched])];
      const reach = await probeReachability(all);
      return all.map((device) => ({
        device,
        reachable: reach[device] ?? false,
        detail: reach[device] ? undefined : "SSH probe failed",
      }));
    },

    async soak(seconds) {
      if (seconds <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    },

    async revert(device, snapshotId) {
      if (!snapshotId) {
        throw new Error(
          `no pre-change snapshot for '${device}' — restore it by hand (list_config_snapshots)`,
        );
      }
      const snapshot = (await snapshots()).get(snapshotId);
      if (!snapshot) {
        throw new Error(`snapshot ${snapshotId} is gone — restore '${device}' by hand`);
      }
      const commands = exportToCommands(snapshot.body);
      if (commands.length === 0) {
        throw new Error(`snapshot ${snapshotId} contains no applicable commands`);
      }
      logger.info(`Rollout ${rolloutId}: reverting ${device} from ${snapshotId}`);
      await applyUnderSafeMode(resolveDeviceName(device), commands);
    },
  };
}

/** Resolve `executeMikrotikCommand` for callers that only need a probe. */
export async function deviceAnswers(ctx: ToolContext, device: string): Promise<boolean> {
  try {
    const out = await executeMikrotikCommand("/system identity print", on(ctx, device));
    return !looksLikeError(out) && out.trim() !== "";
  } catch {
    return false;
  }
}
