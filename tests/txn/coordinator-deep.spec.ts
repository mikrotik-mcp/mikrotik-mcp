/** Offline protocol checks at the coordinator's injected device boundary. */
import { describe, expect, test } from "vite-plus/test";
import { runTransaction } from "../../src/txn/coordinator";
import type { TxnExecutor } from "../../src/txn/coordinator";
import { beginTransaction } from "../../src/txn/model";

function rig(fail: Partial<Record<keyof TxnExecutor, string>> = {}) {
  const calls: string[] = [];
  const executor: TxnExecutor = {
    snapshot: async (device) => {
      calls.push(`snapshot:${device}`);
      if (fail.snapshot) throw new Error(fail.snapshot);
      return `before-${device}`;
    },
    prepare: async (device, steps) => {
      calls.push(`prepare:${device}:${steps.join(",")}`);
      if (fail.prepare) throw new Error(fail.prepare);
    },
    verify: async (assertions) => {
      calls.push(`verify:${assertions.length}`);
      if (fail.verify) throw new Error(fail.verify);
      return assertions.map((assertion) => ({ assertion, ok: true, detail: "reachable" }));
    },
    commit: async (device) => {
      calls.push(`commit:${device}`);
      if (fail.commit) throw new Error(fail.commit);
    },
    rollback: async (device) => {
      calls.push(`rollback:${device}`);
      if (fail.rollback) throw new Error(fail.rollback);
    },
    restore: async (device, snapshotId) => {
      calls.push(`restore:${device}:${snapshotId}`);
      if (fail.restore) throw new Error(fail.restore);
    },
  };
  return { calls, executor };
}

const txn = () =>
  beginTransaction({
    id: "deep",
    devices: ["edge"],
    assertions: [{ kind: "reachable", device: "edge" }],
  });

describe("coordinator failure outcomes", () => {
  test("snapshot rejection prevents any prepare and reports the cause", async () => {
    const { calls, executor } = rig({ snapshot: "disk full" });
    const run = await runTransaction({ txn: txn(), steps: { edge: ["change"] }, executor });
    expect(calls).toEqual(["snapshot:edge", "rollback:edge"]);
    expect(run.state).toBe("ABORTED");
    expect(run.summary.join(" ")).toContain("snapshot failed: disk full");
  });

  test("verifier rejection becomes a failed assertion and rolls back staged work", async () => {
    const { calls, executor } = rig({ verify: "probe crashed" });
    const run = await runTransaction({ txn: txn(), steps: { edge: ["change"] }, executor });
    expect(run.state).toBe("ABORTED");
    expect(run.txn.results).toMatchObject([
      { ok: false, detail: "verification error: probe crashed" },
    ]);
    expect(calls).toEqual(["snapshot:edge", "prepare:edge:change", "verify:1", "rollback:edge"]);
  });

  test("pause before commit keeps the snapshot and resumes without repeating preparation", async () => {
    const { calls, executor } = rig();
    const first = await runTransaction({
      txn: txn(),
      steps: { edge: ["change"] },
      executor,
      stopWhen: (action) => action.kind === "commit",
    });
    expect(first.state).toBeUndefined();
    expect(first.txn.participants[0]).toMatchObject({
      stage: "prepared",
      snapshotId: "before-edge",
    });
    expect(calls).toEqual(["snapshot:edge", "prepare:edge:change", "verify:1"]);
    const resumed = await runTransaction({ txn: first.txn, steps: {}, executor });
    expect(resumed.state).toBe("COMMITTED");
    expect(calls.at(-1)).toBe("commit:edge");
    expect(calls.filter((call) => call.startsWith("snapshot"))).toHaveLength(1);
  });

  test("observer receives the updated participant state after each action", async () => {
    const { executor } = rig();
    const observed: string[] = [];
    await runTransaction({
      txn: txn(),
      steps: {},
      executor,
      onEvent: ({ action, txn: current }) =>
        observed.push(`${action.kind}:${current.participants[0].stage}`),
    });
    expect(observed).toEqual(["prepare:prepared", "verify:prepared", "commit:committed"]);
  });
});
