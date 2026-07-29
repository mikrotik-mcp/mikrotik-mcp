/**
 * Cross-device transaction coordinator — the thin I/O shell around the pure
 * state machine in `./model.ts`.
 *
 * `runTransaction` is a loop: ask the model what to do, do exactly that one
 * thing, fold the outcome back in, repeat until the model says `done`. Every
 * decision (what next, when to abandon, which terminal state) stays in the
 * model, so this file has no branching policy of its own and the risky logic
 * remains testable without a device.
 *
 * **Safe Mode sessions and the connection pool.** `SafeModeManager.enable()`
 * opens its OWN `MikroTikSSHClient` and holds it for the life of the session —
 * it never borrows from `src/core/connection-pool.ts`, which only manages the
 * one-shot exec connections `runOnce()` uses. So holding N concurrent Safe Mode
 * sessions is N independent SSH connections that the pool can neither reap nor
 * hand to another caller, and the coordinator needs no special pool handling.
 * (Blocker in `docs/tasks/03-cross-device-transactions.md` — resolved here.)
 *
 * What the coordinator DOES have to guard is the manager registry: Safe Mode is
 * one session per device, so enlisting a device that already has an active
 * session (a human ran `enable_safe_mode`, or another transaction is live) would
 * silently share — and later commit — someone else's pending changes. That is
 * refused up front.
 */
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { looksLikeError } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { captureSnapshot } from "../snapshots/capture";
import { getSafeModeManager } from "../ssh/safe-mode";
import { applyOutcome, nextAction, summarize } from "./model";
import type { Action, Assertion, AssertionResult, Outcome, TerminalState, Txn } from "./model";

/**
 * The device side of a transaction, injected so the whole protocol can be run
 * against fakes offline. Every method REJECTS on failure — the coordinator turns
 * a rejection into the corresponding "not ok" outcome, which is what drives the
 * model's abandon/compensate paths.
 */
export interface TxnExecutor {
  /** Capture the pre-change snapshot; its id is the only way back post-commit. */
  snapshot(device: string): Promise<string>;
  /** Enable Safe Mode and apply this participant's steps. */
  prepare(device: string, steps: string[]): Promise<void>;
  /** Run the plan's assertions against the prepared-but-uncommitted fleet. */
  verify(assertions: Assertion[]): Promise<AssertionResult[]>;
  /** Commit (exit Safe Mode, persisting the staged changes). */
  commit(device: string): Promise<void>;
  /** Close the Safe Mode session so RouterOS reverts the staged changes. */
  rollback(device: string): Promise<void>;
  /** Compensating undo of an ALREADY COMMITTED device, from its snapshot. */
  restore(device: string, snapshotId: string | undefined): Promise<void>;
}

/** Progress callback — one call per action taken, for the live dashboard lane. */
export type TxnObserver = (event: { action: Action; outcome: Outcome; txn: Txn }) => void;

export interface RunTransactionInput {
  txn: Txn;
  /** Commands to apply per device during PREPARE. */
  steps: Record<string, string[]>;
  executor: TxnExecutor;
  onEvent?: TxnObserver;
}

export interface TxnRun {
  state: TerminalState;
  txn: Txn;
  /** One line per participant — the report a PARTIAL transaction is judged by. */
  summary: string[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * True when a failure means the Safe Mode SESSION died rather than the command
 * being rejected. RouterOS reverts a dropped session's changes by itself, so the
 * model treats it as a vote to abort and issues no rollback for that device —
 * rolling back a session that no longer exists would only produce a second error.
 */
export function isSessionLost(error: string): boolean {
  return /session (?:dropped|closed|is not active)|auto-reverted|not connected|ECONNRESET|EPIPE/i.test(
    error,
  );
}

/**
 * Run a transaction to completion. Never throws for a device-side failure — a
 * failure is an outcome, and the terminal state is the answer.
 */
export async function runTransaction(input: RunTransactionInput): Promise<TxnRun> {
  const { steps, executor, onEvent } = input;
  let txn = input.txn;
  // Every participant needs at most one snapshot + prepare + verify + commit +
  // one undo; the cap only exists so a model bug fails loudly instead of
  // spinning forever against real devices.
  const maxSteps = txn.devices.length * 4 + 10;

  for (let i = 0; i < maxSteps; i++) {
    const action = nextAction(txn);
    if (action.kind === "done") {
      return { state: action.state, txn, summary: summarize(txn) };
    }
    const outcome = await perform(action, steps, executor);
    txn = applyOutcome(txn, outcome);
    onEvent?.({ action, outcome, txn });
  }
  throw new Error(
    `Transaction ${txn.id} did not terminate within ${maxSteps} steps (phase ${txn.phase}).`,
  );
}

/** Do exactly one action and describe what happened. */
async function perform(
  action: Action,
  steps: Record<string, string[]>,
  executor: TxnExecutor,
): Promise<Outcome> {
  switch (action.kind) {
    case "prepare": {
      const device = action.device;
      // Snapshot BEFORE touching the device: without it a committed participant
      // has no compensating undo, which is the difference between PARTIAL that
      // can be repaired and PARTIAL that cannot.
      let snapshotId: string | undefined;
      try {
        snapshotId = await executor.snapshot(device);
      } catch (e) {
        return { phase: "prepare", device, ok: false, error: `snapshot failed: ${message(e)}` };
      }
      try {
        await executor.prepare(device, steps[device] ?? []);
        return { phase: "prepare", device, ok: true, snapshotId };
      } catch (e) {
        const error = message(e);
        return {
          phase: "prepare",
          device,
          ok: false,
          snapshotId,
          error,
          sessionLost: isSessionLost(error),
        };
      }
    }
    case "verify": {
      try {
        return { phase: "verify", results: await executor.verify(action.assertions) };
      } catch (e) {
        // A verifier that blew up is a failed verification, never a pass.
        return {
          phase: "verify",
          results: [
            {
              assertion: action.assertions[0] ?? { kind: "reachable", device: "?" },
              ok: false,
              detail: `verification error: ${message(e)}`,
            },
          ],
        };
      }
    }
    case "commit":
      try {
        await executor.commit(action.device);
        return { phase: "commit", device: action.device, ok: true };
      } catch (e) {
        return { phase: "commit", device: action.device, ok: false, error: message(e) };
      }
    case "rollback":
      try {
        await executor.rollback(action.device);
        return { phase: "rollback", device: action.device, ok: true };
      } catch (e) {
        return { phase: "rollback", device: action.device, ok: false, error: message(e) };
      }
    case "restore":
      try {
        await executor.restore(action.device, action.snapshotId);
        return { phase: "restore", device: action.device, ok: true };
      } catch (e) {
        return { phase: "restore", device: action.device, ok: false, error: message(e) };
      }
    case "done":
      throw new Error("perform() called with a terminal action");
  }
}

// The live executor

/** Per-device context clone — device commands target `ctx.device`. */
function on(ctx: ToolContext, device: string): ToolContext {
  return { ...ctx, device };
}

/**
 * Refuse to enlist a device whose Safe Mode session is already open. Sharing it
 * would mean committing changes this transaction never staged (and rolling back
 * changes it never made). Returns the offending devices.
 */
export function busyDevices(devices: string[]): string[] {
  return devices.filter((d) => getSafeModeManager(resolveDeviceName(d)).isActive);
}

/**
 * The real device side: Safe Mode per participant, `/export terse` snapshots via
 * the shared snapshot store, and the declarative assertion runner.
 */
export function createDeviceExecutor(ctx: ToolContext, txnId: string): TxnExecutor {
  return {
    async snapshot(device) {
      return captureSnapshot(on(ctx, device), `pre-txn ${txnId}`);
    },

    async prepare(device, steps) {
      const safe = getSafeModeManager(resolveDeviceName(device));
      const enabled = await safe.enable();
      if (enabled.startsWith("Error")) throw new Error(enabled);
      for (const command of steps) {
        const out = await safe.execute(command);
        // A device-reported rejection is a prepare failure: the model then rolls
        // the whole fleet back before anything is committed.
        if (looksLikeError(out)) throw new Error(`${command} -> ${out.trim()}`);
      }
    },

    async verify(assertions) {
      const results: AssertionResult[] = [];
      for (const assertion of assertions) {
        results.push(await runAssertion(ctx, assertion));
      }
      return results;
    },

    async commit(device) {
      const result = await getSafeModeManager(resolveDeviceName(device)).commit();
      if (!result.ok) throw new Error(result.message);
    },

    async rollback(device) {
      await getSafeModeManager(resolveDeviceName(device)).rollback();
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async restore(device, snapshotId) {
      if (!snapshotId) {
        throw new Error(
          `No pre-change snapshot for '${device}' — restore it by hand from list_config_snapshots.`,
        );
      }
      // Deliberately NOT automated: replaying a full `/export` over a live
      // router is itself a high-risk operation and the device has already
      // committed, so the honest move is to hand a human the exact restore
      // point rather than to improvise a second uncontrolled change.
      throw new Error(
        `'${device}' already COMMITTED and must be restored manually from snapshot ${snapshotId} ` +
          `(diff_config_snapshots ${snapshotId} live, then config_reconcile or restore_backup).`,
      );
    },
  };
}

/**
 * Evaluate one declarative assertion against the prepared-but-uncommitted fleet.
 * An unknown kind can never reach here (the model rejects it at
 * `beginTransaction`), and any device error is a FAILED assertion, never a pass.
 */
export async function runAssertion(
  ctx: ToolContext,
  assertion: Assertion,
): Promise<AssertionResult> {
  const fail = (detail: string): AssertionResult => ({ assertion, ok: false, detail });
  try {
    switch (assertion.kind) {
      case "ping": {
        const out = await executeMikrotikCommand(
          `/ping ${assertion.to} count=3`,
          on(ctx, assertion.from),
          { maxMs: 10_000 },
        );
        if (looksLikeError(out)) return fail(out.trim());
        const received = Number(/received=(\d+)/.exec(out)?.[1] ?? "0");
        return { assertion, ok: received > 0, detail: out.trim() };
      }
      case "wireguard-peer-handshake": {
        const out = await executeMikrotikCommand(
          `/interface wireguard peers print detail where public-key="${assertion.peer}"`,
          on(ctx, assertion.device),
        );
        if (looksLikeError(out)) return fail(out.trim());
        // RouterOS omits last-handshake entirely until the tunnel has come up.
        return { assertion, ok: /last-handshake=/.test(out), detail: out.trim() };
      }
      case "route-present": {
        const out = await executeMikrotikCommand(
          `/ip route print count-only where dst-address="${assertion.dst}"`,
          on(ctx, assertion.device),
        );
        if (looksLikeError(out)) return fail(out.trim());
        return { assertion, ok: Number(out.trim()) > 0, detail: out.trim() };
      }
      case "reachable": {
        const out = await executeMikrotikCommand(
          "/system identity print",
          on(ctx, assertion.device),
        );
        return { assertion, ok: !looksLikeError(out) && out.trim() !== "", detail: out.trim() };
      }
    }
  } catch (e) {
    return fail(message(e));
  }
}
