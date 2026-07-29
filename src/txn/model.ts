/**
 * Cross-device transaction — the PURE state machine.
 *
 * Coordinating Safe Mode across several routers is a best-effort distributed
 * commit, not ACID (see `docs/tasks/03-cross-device-transactions.md` §2): commits
 * are issued sequentially, so a failure part-way through leaves a small window
 * where the fleet is inconsistent and already-committed devices must be restored
 * from their pre-change snapshot. All of the risky decisions in that dance —
 * what to do next, when to abandon, which terminal state was reached — live
 * here, with no I/O whatsoever, so they can be exercised against fake
 * participants offline (`tests/txn/model.spec.ts`).
 *
 * The coordinator (Phase 2) is a thin loop:
 *
 * ```ts
 * let txn = beginTransaction({ id, devices });
 * for (;;) {
 *   const action = nextAction(txn);
 *   if (action.kind === "done") return action.state;
 *   txn = applyOutcome(txn, await perform(action));  // the only I/O
 * }
 * ```
 *
 * The protocol is PREPARE → VERIFY → COMMIT, with verification doing the heavy
 * lifting while everything is still uncommitted, so the commit phase is as close
 * to trivial as possible.
 */

/** Assertions are declarative so the verify phase needs no free-form commands. */
export type Assertion =
  | { kind: "ping"; from: string; to: string }
  | { kind: "wireguard-peer-handshake"; device: string; peer: string }
  | { kind: "route-present"; device: string; dst: string }
  | { kind: "reachable"; device: string };

export type AssertionKind = Assertion["kind"];

/**
 * Every assertion kind the verify phase knows how to run. An unknown kind is a
 * HARD ERROR, never a silent pass — an assertion nobody evaluates would let a
 * broken change commit while reporting that it was verified.
 */
export const ASSERTION_KINDS: readonly AssertionKind[] = [
  "ping",
  "wireguard-peer-handshake",
  "route-present",
  "reachable",
];

export function isKnownAssertionKind(kind: string): kind is AssertionKind {
  return (ASSERTION_KINDS as readonly string[]).includes(kind);
}

export interface AssertionResult {
  assertion: Assertion;
  ok: boolean;
  /** Raw device output (or the reason) that decided it — surfaced in the UI. */
  detail: string;
}

/**
 * Where one participant currently stands.
 *
 * `failed` means the device rejected its own prepare/commit; `rolled-back` and
 * `restored` are the two undo paths — Safe Mode rollback for a device that never
 * committed, snapshot restore (compensating) for one that did. `rollback-failed`
 * is the case a human must see: the undo itself did not work.
 */
export type ParticipantStage =
  | "pending"
  | "prepared"
  | "committed"
  | "rolled-back"
  | "restored"
  | "failed"
  | "rollback-failed";

export interface Participant {
  device: string;
  stage: ParticipantStage;
  /** Pre-change snapshot id — the only way back once a device has committed. */
  snapshotId?: string;
  error?: string;
  /**
   * The Safe Mode session dropped. RouterOS reverts the device by itself in that
   * case, so this is the GOOD failure: it counts as a vote to abort and needs no
   * rollback action of its own.
   */
  sessionLost?: boolean;
}

export type TxnPhase = "prepare" | "verify" | "commit" | "rollback" | "compensate" | "done";

/** The three outcomes a transaction can end in; the tool output must name one. */
export type TerminalState = "COMMITTED" | "ABORTED" | "PARTIAL";

export interface Txn {
  id: string;
  /** Declaration order — the order devices are prepared in. */
  devices: string[];
  /** Order commits are issued in; defaults to declaration order. */
  commitOrder: string[];
  /** Device reached through a jump host — safest to commit LAST. */
  jumpHost?: string;
  assertions: Assertion[];
  participants: Participant[];
  phase: TxnPhase;
  state?: TerminalState;
  results: AssertionResult[];
  warnings: string[];
}

/** What the coordinator should do next. `done` carries the terminal state. */
export type Action =
  | { kind: "prepare"; device: string }
  | { kind: "verify"; assertions: Assertion[] }
  | { kind: "commit"; device: string }
  /** Safe Mode rollback — the device never committed. */
  | { kind: "rollback"; device: string }
  /** Compensating restore — the device DID commit; undo means its snapshot. */
  | { kind: "restore"; device: string; snapshotId?: string }
  | { kind: "done"; state: TerminalState };

export type Outcome =
  | {
      phase: "prepare";
      device: string;
      ok: boolean;
      snapshotId?: string;
      error?: string;
      sessionLost?: boolean;
    }
  | { phase: "verify"; results: AssertionResult[] }
  | { phase: "commit"; device: string; ok: boolean; error?: string }
  | { phase: "rollback"; device: string; ok: boolean; error?: string }
  | { phase: "restore"; device: string; ok: boolean; error?: string };

export interface BeginTransactionInput {
  id: string;
  devices: string[];
  commitOrder?: string[];
  jumpHost?: string;
  assertions?: Assertion[];
}

/**
 * Open a transaction. Throws on inputs that could only ever produce a confusing
 * run — no devices, duplicates, a `commitOrder`/`jumpHost` naming a device that
 * is not a participant, or an assertion kind nothing can evaluate.
 */
export function beginTransaction(input: BeginTransactionInput): Txn {
  const devices = input.devices;
  if (devices.length === 0) throw new Error("A transaction needs at least one device.");
  if (new Set(devices).size !== devices.length) {
    throw new Error(`Duplicate device in transaction: ${devices.join(", ")}`);
  }
  const commitOrder = input.commitOrder ?? [...devices];
  const unknown = commitOrder.filter((d) => !devices.includes(d));
  if (unknown.length > 0) {
    throw new Error(`commitOrder names devices that are not participants: ${unknown.join(", ")}`);
  }
  const missing = devices.filter((d) => !commitOrder.includes(d));
  if (missing.length > 0) {
    throw new Error(`commitOrder is missing participants: ${missing.join(", ")}`);
  }
  if (input.jumpHost !== undefined && !devices.includes(input.jumpHost)) {
    throw new Error(`jumpHost '${input.jumpHost}' is not a participant.`);
  }
  const assertions = input.assertions ?? [];
  for (const a of assertions) {
    if (!isKnownAssertionKind(a.kind)) {
      throw new Error(
        `Unknown assertion kind '${String(a.kind)}' — expected one of ${ASSERTION_KINDS.join(", ")}.`,
      );
    }
  }

  const warnings: string[] = [];
  // Commit the device you are least likely to lose contact with LAST: if the
  // jump host commits early and its change severs the path, every later commit
  // is unreachable and the transaction ends PARTIAL with no way to compensate.
  if (input.jumpHost !== undefined && commitOrder.at(-1) !== input.jumpHost) {
    warnings.push(
      `Jump-host device '${input.jumpHost}' is not last in the commit order — commit it last so a ` +
        "lost path cannot strand the devices reached through it.",
    );
  }

  return {
    id: input.id,
    devices: [...devices],
    commitOrder,
    jumpHost: input.jumpHost,
    assertions,
    participants: devices.map((device) => ({ device, stage: "pending" })),
    phase: "prepare",
    results: [],
    warnings,
  };
}

function find(txn: Txn, device: string): Participant {
  const p = txn.participants.find((x) => x.device === device);
  if (!p) throw new Error(`Device '${device}' is not a participant of transaction ${txn.id}.`);
  return p;
}

/** Replace one participant, returning a new transaction (nothing is mutated). */
function patch(txn: Txn, device: string, change: Partial<Participant>): Txn {
  find(txn, device);
  return {
    ...txn,
    participants: txn.participants.map((p) => (p.device === device ? { ...p, ...change } : p)),
  };
}

/** Participants that still hold uncommitted changes in a Safe Mode session. */
function needsRollback(p: Participant): boolean {
  // A dropped session already reverted the device by itself — rolling back a
  // session that no longer exists would just error.
  if (p.sessionLost === true) return false;
  return p.stage === "prepared" || p.stage === "failed";
}

/**
 * The next thing to do, derived purely from the current phase and participant
 * stages. Calling it twice without applying an outcome returns the same action.
 */
export function nextAction(txn: Txn): Action {
  if (txn.state !== undefined) return { kind: "done", state: txn.state };

  switch (txn.phase) {
    case "prepare": {
      const pending = txn.devices.find((d) => find(txn, d).stage === "pending");
      if (pending !== undefined) return { kind: "prepare", device: pending };
      return { kind: "verify", assertions: txn.assertions };
    }
    case "verify":
      return { kind: "verify", assertions: txn.assertions };
    case "commit": {
      const next = txn.commitOrder.find((d) => find(txn, d).stage === "prepared");
      if (next !== undefined) return { kind: "commit", device: next };
      return { kind: "done", state: classify(txn) };
    }
    case "rollback": {
      const next = txn.participants.find(needsRollback);
      if (next !== undefined) return { kind: "rollback", device: next.device };
      return { kind: "done", state: classify(txn) };
    }
    case "compensate": {
      // Undo in reverse commit order: the last device committed is the first one
      // restored, so the path back to the earlier devices is torn down last.
      const committed = [...txn.commitOrder]
        .reverse()
        .find((d) => find(txn, d).stage === "committed");
      if (committed !== undefined) {
        return { kind: "restore", device: committed, snapshotId: find(txn, committed).snapshotId };
      }
      const stranded = txn.participants.find(needsRollback);
      if (stranded !== undefined) return { kind: "rollback", device: stranded.device };
      return { kind: "done", state: classify(txn) };
    }
    case "done":
      return { kind: "done", state: classify(txn) };
  }
}

/**
 * Terminal classification: COMMITTED only when every participant committed,
 * ABORTED only when the fleet never changed at all, PARTIAL otherwise.
 *
 * `restored` counts as PARTIAL even when every compensating restore succeeded:
 * those devices really did commit and really were rolled back out of band, the
 * fleet was inconsistent for that window, and a restore-from-snapshot is not the
 * same guarantee as "nothing happened". `rollback-failed` is the loudest case —
 * the undo itself did not work — and is likewise never reported as clean.
 */
export function classify(txn: Txn): TerminalState {
  const stages = txn.participants.map((p) => p.stage);
  if (stages.every((s) => s === "committed")) return "COMMITTED";
  if (stages.some((s) => s === "committed" || s === "restored" || s === "rollback-failed")) {
    return "PARTIAL";
  }
  return "ABORTED";
}

/** True once no participant can make further progress. */
function settled(txn: Txn): boolean {
  const action = nextAction(txn);
  return action.kind === "done";
}

/** Finish the transaction if the current phase has nothing left to do. */
function seal(txn: Txn): Txn {
  if (txn.state !== undefined) return txn;
  if (txn.phase === "prepare" || txn.phase === "verify") return txn;
  if (!settled(txn)) return txn;
  return { ...txn, phase: "done", state: classify(txn) };
}

/**
 * Fold one participant outcome into the transaction. This is where the protocol
 * lives: a prepare failure abandons the run before anything committed, a failed
 * assertion does the same, and a commit failure switches to compensating
 * restores of the devices that already committed.
 */
export function applyOutcome(txn: Txn, outcome: Outcome): Txn {
  if (txn.state !== undefined) {
    throw new Error(`Transaction ${txn.id} already finished as ${txn.state}.`);
  }

  switch (outcome.phase) {
    case "prepare": {
      if (outcome.ok) {
        const next = patch(txn, outcome.device, {
          stage: "prepared",
          snapshotId: outcome.snapshotId,
        });
        // Every device prepared → move on to verification.
        const allPrepared = next.participants.every((p) => p.stage === "prepared");
        return allPrepared ? { ...next, phase: "verify" } : next;
      }
      // One device could not prepare: nothing has committed yet, so the clean
      // move is to roll every prepared device back and abort.
      const failed = patch(txn, outcome.device, {
        stage: "failed",
        error: outcome.error,
        sessionLost: outcome.sessionLost,
      });
      return seal({ ...failed, phase: "rollback" });
    }

    case "verify": {
      const results = [...txn.results, ...outcome.results];
      const failedCount = outcome.results.filter((r) => !r.ok).length;
      if (failedCount > 0) {
        return seal({ ...txn, results, phase: "rollback" });
      }
      return { ...txn, results, phase: "commit" };
    }

    case "commit": {
      if (outcome.ok) {
        const next = patch(txn, outcome.device, { stage: "committed" });
        return seal(next);
      }
      // A commit failed. Devices that already committed have to be compensated
      // from their pre-change snapshot; the rest are still uncommitted and can
      // simply be rolled back.
      const failed = patch(txn, outcome.device, { stage: "failed", error: outcome.error });
      return seal({ ...failed, phase: "compensate" });
    }

    case "rollback": {
      const next = patch(txn, outcome.device, {
        stage: outcome.ok ? "rolled-back" : "rollback-failed",
        error: outcome.ok ? find(txn, outcome.device).error : outcome.error,
      });
      return seal(next);
    }

    case "restore": {
      const next = patch(txn, outcome.device, {
        stage: outcome.ok ? "restored" : "rollback-failed",
        error: outcome.ok ? undefined : outcome.error,
      });
      return seal(next);
    }
  }
}

/**
 * Abandon a transaction on request (`abort_transaction`, or a coordinator that
 * is giving up): switch to the rollback phase so every participant still holding
 * uncommitted changes is reverted. A transaction whose devices have already
 * committed cannot be "aborted" back to clean — it seals as PARTIAL, which is
 * the honest answer.
 */
export function requestAbort(txn: Txn, reason?: string): Txn {
  if (txn.state !== undefined) return txn;
  const warnings = reason ? [...txn.warnings, `Aborted: ${reason}`] : txn.warnings;
  const next: Txn = { ...txn, warnings, phase: "rollback" };
  return nextAction(next).kind === "done"
    ? { ...next, phase: "done", state: classify(next) }
    : next;
}

/**
 * One line per participant for the tool/UI summary — for a PARTIAL transaction
 * this is the only thing that tells a human which device is in which state and
 * which snapshot to restore it from.
 */
export function summarize(txn: Txn): string[] {
  return txn.participants.map((p) => {
    const snap = p.snapshotId ? ` (snapshot ${p.snapshotId})` : "";
    const why = p.error ? ` — ${p.error}` : "";
    const lost = p.sessionLost === true ? " [session lost, device self-reverted]" : "";
    return `${p.device}: ${p.stage}${snap}${lost}${why}`;
  });
}
