/**
 * The cross-device transaction state machine, driven end-to-end with fake
 * participants — the seven scenarios of `docs/tasks/03-cross-device-transactions.md`
 * §8. No device, no I/O: every decision under test is pure.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  applyOutcome,
  beginTransaction,
  classify,
  isKnownAssertionKind,
  nextAction,
  summarize,
} from "../../src/txn/model";
import type { Action, Assertion, Outcome, TerminalState, Txn } from "../../src/txn/model";

const ASSERTIONS: Assertion[] = [{ kind: "ping", from: "a", to: "10.0.0.2" }];

function open(
  devices = ["a", "b", "c"],
  extra: Partial<Parameters<typeof beginTransaction>[0]> = {},
) {
  return beginTransaction({ id: "t1", devices, assertions: ASSERTIONS, ...extra });
}

/**
 * Run the coordinator loop against a fake device: `respond` decides each
 * outcome, and the actions taken are recorded so ordering can be asserted.
 * Bounded so a machine that never terminates fails the test instead of hanging.
 */
function drive(
  txn: Txn,
  respond: (action: Action) => Outcome,
): { state: TerminalState; txn: Txn; actions: Action[] } {
  const actions: Action[] = [];
  let current = txn;
  for (let i = 0; i < 100; i++) {
    const action = nextAction(current);
    actions.push(action);
    if (action.kind === "done") return { state: action.state, txn: current, actions };
    current = applyOutcome(current, respond(action));
  }
  throw new Error("state machine did not terminate");
}

/** Everything succeeds. */
function allOk(action: Action): Outcome {
  switch (action.kind) {
    case "prepare":
      return {
        phase: "prepare",
        device: action.device,
        ok: true,
        snapshotId: `snap-${action.device}`,
      };
    case "verify":
      return {
        phase: "verify",
        results: action.assertions.map((assertion) => ({ assertion, ok: true, detail: "0% loss" })),
      };
    case "commit":
      return { phase: "commit", device: action.device, ok: true };
    case "rollback":
      return { phase: "rollback", device: action.device, ok: true };
    case "restore":
      return { phase: "restore", device: action.device, ok: true };
    case "done":
      throw new Error("unreachable");
  }
}

describe("happy path", () => {
  test("three devices prepare, verify and commit → COMMITTED", () => {
    const { state, txn, actions } = drive(open(), allOk);
    expect(state).toBe("COMMITTED");
    expect(txn.participants.every((p) => p.stage === "committed")).toBe(true);
    expect(actions.map((a) => a.kind)).toEqual([
      "prepare",
      "prepare",
      "prepare",
      "verify",
      "commit",
      "commit",
      "commit",
      "done",
    ]);
  });

  test("the pre-change snapshot of every participant is retained", () => {
    const { txn } = drive(open(), allOk);
    expect(txn.participants.map((p) => p.snapshotId)).toEqual(["snap-a", "snap-b", "snap-c"]);
  });
});

describe("prepare fails", () => {
  test("device 2 cannot prepare → everything rolls back, no commit is issued → ABORTED", () => {
    const { state, txn, actions } = drive(open(), (action) =>
      action.kind === "prepare" && action.device === "b"
        ? { phase: "prepare", device: "b", ok: false, error: "bad parameter" }
        : allOk(action),
    );
    expect(state).toBe("ABORTED");
    expect(actions.some((a) => a.kind === "commit")).toBe(false);
    // 'c' was never prepared, so there is nothing to roll back on it.
    expect(actions.filter((a) => a.kind === "rollback").map((a) => a.device)).toEqual(["a", "b"]);
    expect(txn.participants.map((p) => p.stage)).toEqual(["rolled-back", "rolled-back", "pending"]);
  });

  test("the device error survives its rollback so the report can name it", () => {
    const { txn } = drive(open(), (action) =>
      action.kind === "prepare" && action.device === "b"
        ? { phase: "prepare", device: "b", ok: false, error: "bad parameter" }
        : allOk(action),
    );
    expect(summarize(txn)[1]).toContain("bad parameter");
  });
});

describe("verification fails", () => {
  test("a failed assertion aborts before anyone commits", () => {
    const { state, actions } = drive(open(), (action) =>
      action.kind === "verify"
        ? {
            phase: "verify",
            results: action.assertions.map((assertion) => ({
              assertion,
              ok: false,
              detail: "100% packet loss",
            })),
          }
        : allOk(action),
    );
    expect(state).toBe("ABORTED");
    expect(actions.some((a) => a.kind === "commit")).toBe(false);
    expect(actions.filter((a) => a.kind === "rollback")).toHaveLength(3);
  });

  test("assertion results are kept for the report", () => {
    const { txn } = drive(open(), (action) =>
      action.kind === "verify"
        ? {
            phase: "verify",
            results: action.assertions.map((assertion) => ({
              assertion,
              ok: false,
              detail: "no route",
            })),
          }
        : allOk(action),
    );
    expect(txn.results).toHaveLength(1);
    expect(txn.results[0].detail).toBe("no route");
  });
});

describe("commit fails", () => {
  test("device 3 of 3 fails → 1 and 2 are compensated from their snapshots → PARTIAL", () => {
    const { state, txn, actions } = drive(open(), (action) =>
      action.kind === "commit" && action.device === "c"
        ? { phase: "commit", device: "c", ok: false, error: "failure: already have such entry" }
        : allOk(action),
    );
    expect(state).toBe("PARTIAL");
    // Compensation runs in REVERSE commit order, and restores use the snapshot.
    const restores = actions.filter((a) => a.kind === "restore");
    expect(restores.map((a) => a.device)).toEqual(["b", "a"]);
    expect(restores.map((a) => (a.kind === "restore" ? a.snapshotId : undefined))).toEqual([
      "snap-b",
      "snap-a",
    ]);
    expect(txn.participants.map((p) => p.stage)).toEqual(["restored", "restored", "rolled-back"]);
  });

  test("a restored fleet is never reported as clean", () => {
    const { state } = drive(open(), (action) =>
      action.kind === "commit" && action.device === "c"
        ? { phase: "commit", device: "c", ok: false, error: "boom" }
        : allOk(action),
    );
    // Every undo succeeded, yet the fleet WAS inconsistent for a window — that
    // is materially different from ABORTED and must stay visible.
    expect(state).toBe("PARTIAL");
  });

  test("the FIRST commit failing changed nothing → ABORTED", () => {
    const { state, actions } = drive(open(), (action) =>
      action.kind === "commit" && action.device === "a"
        ? { phase: "commit", device: "a", ok: false, error: "boom" }
        : allOk(action),
    );
    expect(state).toBe("ABORTED");
    expect(actions.some((a) => a.kind === "restore")).toBe(false);
  });
});

describe("compensating rollback also fails", () => {
  test("both undone-and-failed devices are flagged, still PARTIAL", () => {
    const { state, txn } = drive(open(), (action) => {
      if (action.kind === "commit" && action.device === "c") {
        return { phase: "commit", device: "c", ok: false, error: "boom" };
      }
      if (action.kind === "restore") {
        return { phase: "restore", device: action.device, ok: false, error: "restore failed" };
      }
      return allOk(action);
    });
    expect(state).toBe("PARTIAL");
    const flagged = txn.participants.filter((p) => p.stage === "rollback-failed");
    expect(flagged.map((p) => p.device)).toEqual(["a", "b"]);
    expect(summarize(txn)[0]).toContain("restore failed");
    // The snapshot id has to survive so a human can restore by hand.
    expect(summarize(txn)[0]).toContain("snap-a");
  });
});

describe("session drops during prepare", () => {
  test("counts as a vote to abort and needs no rollback of its own", () => {
    const { state, txn, actions } = drive(open(), (action) =>
      action.kind === "prepare" && action.device === "b"
        ? {
            phase: "prepare",
            device: "b",
            ok: false,
            error: "session closed",
            sessionLost: true,
          }
        : allOk(action),
    );
    expect(state).toBe("ABORTED");
    // RouterOS reverted 'b' by itself; only 'a' is rolled back explicitly.
    expect(actions.filter((a) => a.kind === "rollback").map((a) => a.device)).toEqual(["a"]);
    expect(summarize(txn)[1]).toContain("session lost");
  });
});

describe("commit order", () => {
  test("commits follow commitOrder, not declaration order", () => {
    const txn = open(["a", "b", "c"], { commitOrder: ["c", "b", "a"] });
    const { actions } = drive(txn, allOk);
    expect(actions.filter((a) => a.kind === "prepare").map((a) => a.device)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(actions.filter((a) => a.kind === "commit").map((a) => a.device)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  test("a jump host that is not committed last raises a warning", () => {
    const txn = open(["a", "b", "c"], { jumpHost: "a" });
    expect(txn.warnings).toHaveLength(1);
    expect(txn.warnings[0]).toContain("'a'");
    expect(open(["a", "b", "c"], { jumpHost: "c" }).warnings).toEqual([]);
  });
});

describe("input validation", () => {
  test("rejects an unknown assertion kind instead of silently passing it", () => {
    expect(isKnownAssertionKind("ping")).toBe(true);
    expect(isKnownAssertionKind("vibes")).toBe(false);
    expect(() =>
      beginTransaction({
        id: "t",
        devices: ["a"],
        assertions: [{ kind: "vibes" } as unknown as Assertion],
      }),
    ).toThrow(/Unknown assertion kind/);
  });

  test("rejects an incoherent participant set", () => {
    expect(() => beginTransaction({ id: "t", devices: [] })).toThrow(/at least one device/);
    expect(() => beginTransaction({ id: "t", devices: ["a", "a"] })).toThrow(/Duplicate device/);
    expect(() => beginTransaction({ id: "t", devices: ["a"], commitOrder: ["b"] })).toThrow(
      /not participants/,
    );
    expect(() => beginTransaction({ id: "t", devices: ["a", "b"], commitOrder: ["a"] })).toThrow(
      /missing participants/,
    );
    expect(() => beginTransaction({ id: "t", devices: ["a"], jumpHost: "z" })).toThrow(/jumpHost/);
  });
});

describe("machine invariants", () => {
  test("nextAction is idempotent until an outcome is applied", () => {
    const txn = open();
    expect(nextAction(txn)).toEqual(nextAction(txn));
    const after = applyOutcome(txn, { phase: "prepare", device: "a", ok: true });
    expect(nextAction(after)).toEqual({ kind: "prepare", device: "b" });
  });

  test("applying an outcome does not mutate the previous transaction", () => {
    const txn = open();
    applyOutcome(txn, { phase: "prepare", device: "a", ok: true, snapshotId: "s" });
    expect(txn.participants[0]).toEqual({ device: "a", stage: "pending" });
    expect(txn.phase).toBe("prepare");
  });

  test("a finished transaction refuses further outcomes", () => {
    const { txn } = drive(open(["a"]), allOk);
    expect(classify(txn)).toBe("COMMITTED");
    expect(() => applyOutcome(txn, { phase: "commit", device: "a", ok: true })).toThrow(
      /already finished/,
    );
  });

  test("an outcome for a device outside the transaction is an error", () => {
    expect(() => applyOutcome(open(), { phase: "prepare", device: "zz", ok: true })).toThrow(
      /not a participant/,
    );
  });
});
