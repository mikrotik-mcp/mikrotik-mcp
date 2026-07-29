/**
 * The coordinator against fake participants — the §8 scenarios again, this time
 * through the real `runTransaction` loop (snapshot → prepare → verify → commit →
 * compensate) with the device side injected. Offline by construction: the fake
 * executor is the only thing that would have touched a router.
 */
import { describe, expect, test } from "vite-plus/test";
import { beginTransaction } from "../../src/txn/model";
import type { Assertion, AssertionResult } from "../../src/txn/model";
import { isSessionLost, runTransaction } from "../../src/txn/coordinator";
import type { TxnExecutor } from "../../src/txn/coordinator";
import { toRecord } from "../../src/txn/store";

const ASSERTIONS: Assertion[] = [{ kind: "ping", from: "a", to: "10.0.0.2" }];

interface FakeOptions {
  /** Devices whose prepare rejects. */
  prepareFails?: Record<string, string>;
  /** Devices whose commit rejects. */
  commitFails?: Record<string, string>;
  /** Devices whose rollback rejects. */
  rollbackFails?: string[];
  /** Devices whose compensating restore rejects. */
  restoreFails?: string[];
  /** Fail verification with this detail. */
  verifyFails?: string;
  /** Devices whose snapshot capture rejects. */
  snapshotFails?: string[];
}

/** A scripted device side plus the call log the assertions read. */
function fake(opts: FakeOptions = {}): { executor: TxnExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: TxnExecutor = {
    snapshot(device) {
      calls.push(`snapshot:${device}`);
      if (opts.snapshotFails?.includes(device)) return Promise.reject(new Error("export failed"));
      return Promise.resolve(`snap-${device}`);
    },
    prepare(device, steps) {
      calls.push(`prepare:${device}(${steps.length})`);
      const err = opts.prepareFails?.[device];
      return err ? Promise.reject(new Error(err)) : Promise.resolve();
    },
    verify(assertions) {
      calls.push(`verify(${assertions.length})`);
      const results: AssertionResult[] = assertions.map((assertion) => ({
        assertion,
        ok: opts.verifyFails === undefined,
        detail: opts.verifyFails ?? "0% packet loss",
      }));
      return Promise.resolve(results);
    },
    commit(device) {
      calls.push(`commit:${device}`);
      const err = opts.commitFails?.[device];
      return err ? Promise.reject(new Error(err)) : Promise.resolve();
    },
    rollback(device) {
      calls.push(`rollback:${device}`);
      return opts.rollbackFails?.includes(device)
        ? Promise.reject(new Error("rollback failed"))
        : Promise.resolve();
    },
    restore(device, snapshotId) {
      calls.push(`restore:${device}:${snapshotId ?? "none"}`);
      return opts.restoreFails?.includes(device)
        ? Promise.reject(new Error("restore failed"))
        : Promise.resolve();
    },
  };
  return { executor, calls };
}

const STEPS = {
  a: ["/ip address add address=10.0.0.1/30 interface=wg"],
  b: ["/ip address add address=10.0.0.2/30 interface=wg"],
  c: ["/ip route add dst-address=10.0.0.0/30 gateway=wg"],
};

function open(devices = ["a", "b", "c"], extra = {}) {
  return beginTransaction({ id: "t1", devices, assertions: ASSERTIONS, ...extra });
}

describe("happy path", () => {
  test("three devices → COMMITTED, each snapshotted before it is touched", async () => {
    const { executor, calls } = fake();
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("COMMITTED");
    expect(calls).toEqual([
      "snapshot:a",
      "prepare:a(1)",
      "snapshot:b",
      "prepare:b(1)",
      "snapshot:c",
      "prepare:c(1)",
      "verify(1)",
      "commit:a",
      "commit:b",
      "commit:c",
    ]);
    expect(run.summary[0]).toContain("snap-a");
  });

  test("a device with no steps still participates", async () => {
    const { executor, calls } = fake();
    const run = await runTransaction({ txn: open(["a", "b"]), steps: { a: STEPS.a }, executor });
    expect(run.state).toBe("COMMITTED");
    expect(calls).toContain("prepare:b(0)");
  });
});

describe("prepare fails", () => {
  test("rolls every prepared device back and never commits", async () => {
    const { executor, calls } = fake({ prepareFails: { b: "bad parameter" } });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("ABORTED");
    expect(calls.filter((c) => c.startsWith("commit"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("rollback"))).toEqual(["rollback:a", "rollback:b"]);
    expect(run.summary[1]).toContain("bad parameter");
  });

  test("a snapshot that cannot be captured aborts before the device is touched", async () => {
    const { executor, calls } = fake({ snapshotFails: ["b"] });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("ABORTED");
    expect(calls).not.toContain("prepare:b(1)");
    expect(run.summary[1]).toContain("snapshot failed");
  });
});

describe("verification fails", () => {
  test("aborts while everything is still uncommitted", async () => {
    const { executor, calls } = fake({ verifyFails: "100% packet loss" });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("ABORTED");
    expect(calls.filter((c) => c.startsWith("commit"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("rollback"))).toHaveLength(3);
    expect(run.txn.results[0].detail).toBe("100% packet loss");
  });

  test("a verifier that throws is a failed assertion, never a pass", async () => {
    const { executor } = fake();
    const throwing: TxnExecutor = {
      ...executor,
      verify: () => Promise.reject(new Error("ssh died")),
    };
    const run = await runTransaction({ txn: open(), steps: STEPS, executor: throwing });

    expect(run.state).toBe("ABORTED");
    expect(run.txn.results[0].detail).toContain("ssh died");
  });
});

describe("commit fails", () => {
  test("device 3 of 3 → compensating restores of 1 and 2 in reverse order → PARTIAL", async () => {
    const { executor, calls } = fake({ commitFails: { c: "failure: already have such entry" } });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("PARTIAL");
    expect(calls.filter((c) => c.startsWith("restore"))).toEqual([
      "restore:b:snap-b",
      "restore:a:snap-a",
    ]);
    // 'c' never committed, so its Safe Mode session is simply closed.
    expect(calls.at(-1)).toBe("rollback:c");
  });

  test("the FIRST commit failing changed nothing → ABORTED, no restore attempted", async () => {
    const { executor, calls } = fake({ commitFails: { a: "boom" } });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("ABORTED");
    expect(calls.some((c) => c.startsWith("restore"))).toBe(false);
  });

  test("compensating restore ALSO fails → PARTIAL with both devices flagged", async () => {
    const { executor } = fake({ commitFails: { c: "boom" }, restoreFails: ["a", "b"] });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("PARTIAL");
    const flagged = run.txn.participants.filter((p) => p.stage === "rollback-failed");
    expect(flagged.map((p) => p.device)).toEqual(["a", "b"]);
    // The snapshot id has to survive into the report for a manual restore.
    expect(run.summary[0]).toContain("snap-a");
    expect(run.summary[0]).toContain("restore failed");
  });

  test("the real executor refuses to auto-restore a committed device", async () => {
    // createDeviceExecutor deliberately rejects `restore` with the manual
    // recovery instructions; the transaction must still terminate as PARTIAL
    // rather than hang or throw out of runTransaction.
    const { executor } = fake({ commitFails: { c: "boom" }, restoreFails: ["a", "b"] });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });
    expect(run.state).toBe("PARTIAL");
  });
});

describe("session drops during prepare", () => {
  test("is treated as a vote to abort, with no rollback of its own", async () => {
    const { executor, calls } = fake({
      prepareFails: { b: "Safe Mode session dropped — RouterOS auto-reverted every staged change" },
    });
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });

    expect(run.state).toBe("ABORTED");
    expect(calls.filter((c) => c.startsWith("rollback"))).toEqual(["rollback:a"]);
    expect(run.summary[1]).toContain("session lost");
  });

  test("isSessionLost separates a dead session from a rejected command", () => {
    expect(isSessionLost("Safe Mode session dropped")).toBe(true);
    expect(isSessionLost("safe mode session is not active")).toBe(true);
    expect(isSessionLost("read ECONNRESET")).toBe(true);
    expect(isSessionLost("bad parameter type (line 1 column 5)")).toBe(false);
  });
});

describe("commit order", () => {
  test("commits follow commitOrder while prepares follow declaration order", async () => {
    const { executor, calls } = fake();
    const txn = open(["a", "b", "c"], { commitOrder: ["c", "b", "a"] });
    await runTransaction({ txn, steps: STEPS, executor });

    expect(calls.filter((c) => c.startsWith("prepare"))).toEqual([
      "prepare:a(1)",
      "prepare:b(1)",
      "prepare:c(1)",
    ]);
    expect(calls.filter((c) => c.startsWith("commit"))).toEqual([
      "commit:c",
      "commit:b",
      "commit:a",
    ]);
  });

  test("a jump host not committed last is warned about, not blocked", async () => {
    const { executor } = fake();
    const txn = open(["a", "b", "c"], { jumpHost: "a" });
    const run = await runTransaction({ txn, steps: STEPS, executor });
    expect(run.state).toBe("COMMITTED");
    expect(run.txn.warnings[0]).toContain("not last in the commit order");
  });
});

describe("observability", () => {
  test("every action is reported to onEvent with its outcome", async () => {
    const { executor } = fake({ commitFails: { c: "boom" } });
    const seen: string[] = [];
    const run = await runTransaction({
      txn: open(),
      steps: STEPS,
      executor,
      onEvent: ({ action, outcome }) =>
        seen.push(`${action.kind}:${"ok" in outcome ? String(outcome.ok) : "results"}`),
    });

    expect(run.state).toBe("PARTIAL");
    expect(seen.slice(0, 4)).toEqual([
      "prepare:true",
      "prepare:true",
      "prepare:true",
      "verify:results",
    ]);
    expect(seen).toContain("commit:false");
    expect(seen).toContain("restore:true");
  });

  test("toRecord captures the model state for the txn log", async () => {
    const { executor } = fake();
    const run = await runTransaction({ txn: open(), steps: STEPS, executor });
    const record = toRecord(run.txn, 1_700_000_000_000, "tunnel");

    expect(record.state).toBe("COMMITTED");
    expect(record.devices).toEqual(["a", "b", "c"]);
    expect(record.participants).toHaveLength(3);
    expect(record.label).toBe("tunnel");
    // JSON-serialisable, since that is how the store persists it.
    expect(() => JSON.stringify(record)).not.toThrow();
  });
});
