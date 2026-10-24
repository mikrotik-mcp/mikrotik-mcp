import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { txnTools } from "../src/tools/txn";

const mocks = vi.hoisted(() => ({
  busy: vi.fn(),
  run: vi.fn(),
  executor: vi.fn(),
  publish: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  log: vi.fn(),
  id: vi.fn(),
  persist: vi.fn(),
  put: vi.fn(),
  drop: vi.fn(),
}));
vi.mock("../src/txn/coordinator", () => ({
  busyDevices: mocks.busy,
  createDeviceExecutor: mocks.executor,
  runTransaction: mocks.run,
}));
vi.mock("../src/observability/txn-hub", () => ({ publishTxn: mocks.publish }));
vi.mock("../src/txn/session", () => ({
  getTxn: mocks.get,
  listTxns: mocks.list,
  logTxnEvent: mocks.log,
  newTxnId: mocks.id,
  persistTxn: mocks.persist,
  putTxn: mocks.put,
  dropTxn: mocks.drop,
}));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
let entry: {
  txn: {
    id: string;
    devices: string[];
    commitOrder: string[];
    assertions: unknown[];
    results: unknown[];
    warnings: string[];
    participants: { device: string; stage: string }[];
    phase: string;
    state: string;
  };
  steps: Record<string, string[]>;
  ts: number;
};

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = txnTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown txn tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 }, peer: { host: "192.0.2.2", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.busy.mockReturnValue([]);
  mocks.id.mockReturnValue("txn-test");
  mocks.list.mockReturnValue([]);
  mocks.persist.mockResolvedValue(undefined);
  mocks.executor.mockReturnValue({});
  mocks.put.mockImplementation((value) => {
    entry = value;
    return value;
  });
  mocks.get.mockImplementation((id) => (id === "txn-test" ? entry : null));
  entry = {
    txn: {
      id: "txn-test",
      devices: ["fixture", "peer"],
      commitOrder: ["peer", "fixture"],
      assertions: [],
      results: [],
      warnings: [],
      participants: [
        { device: "fixture", stage: "pending" },
        { device: "peer", stage: "pending" },
      ],
      phase: "prepare",
      state: "OPEN",
    },
    steps: {},
    ts: Date.now(),
  };
  mocks.run.mockImplementation(async ({ txn }) => ({
    txn,
    summary: ["fixture: prepared", "peer: prepared"],
    state: undefined,
  }));
});
afterEach(() => setConfig(initial));

test("begin refuses busy devices before queuing any transaction", async () => {
  mocks.busy.mockReturnValueOnce(["peer"]);
  expect(await call("begin_transaction", { devices: ["fixture", "peer"] })).toContain(
    "Safe Mode is already active on peer",
  );
  expect(mocks.put).not.toHaveBeenCalled();
});

test("begin records explicit commit order, assertions and jump-host warning without router I/O", async () => {
  const report = await call("begin_transaction", {
    devices: ["fixture", "peer"],
    commit_order: ["fixture", "peer"],
    jump_host: "fixture",
    assertions: [{ kind: "reachable", device: "peer" }],
    label: "peer migration",
  });
  expect(report).toContain("Transaction txn-test opened");
  expect(report).toContain("Commit order: fixture → peer");
  expect(report).toContain("reachable");
  expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ label: "peer migration" }));
  expect(mocks.run).not.toHaveBeenCalled();
});

test("step queue rejects missing, nonparticipant and already-prepared transactions", async () => {
  expect(
    await call("add_transaction_step", {
      txn_id: "missing",
      target_device: "peer",
      command: "/ip route print",
    }),
  ).toContain("No open transaction");
  entry.txn.devices = ["fixture"];
  expect(
    await call("add_transaction_step", {
      txn_id: "txn-test",
      target_device: "peer",
      command: "/ip route print",
    }),
  ).toContain("not a participant");
  entry.txn.devices = ["fixture", "peer"];
  entry.txn.phase = "verify";
  expect(
    await call("add_transaction_step", {
      txn_id: "txn-test",
      target_device: "peer",
      command: "/ip route print",
    }),
  ).toContain("already past PREPARE");
  expect(entry.steps).toEqual({});
});

test("step queue preserves per-device order and never invokes a router before verification", async () => {
  for (const command of ["/ip route add dst-address=192.0.2.0/24", "/ip route print"]) {
    expect(
      await call("add_transaction_step", { txn_id: "txn-test", target_device: "peer", command }),
    ).toContain("Nothing has run yet");
  }
  expect(entry.steps.peer).toEqual(["/ip route add dst-address=192.0.2.0/24", "/ip route print"]);
  expect(mocks.run).not.toHaveBeenCalled();
});

test("verify never claims assertions passed when none were declared", async () => {
  const report = await call("verify_transaction", { txn_id: "txn-test" });
  expect(report).toContain("correctness is UNVERIFIED");
  expect(report).toContain("NOT committed");
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({ stopWhen: expect.any(Function) }),
  );
  expect(mocks.persist).toHaveBeenCalledOnce();
  expect(mocks.drop).not.toHaveBeenCalled();
});

test("verify reports aborted and asserted outcomes with participant evidence", async () => {
  mocks.run.mockResolvedValueOnce({
    txn: entry.txn,
    summary: ["peer: rolled back"],
    state: "ABORTED",
  });
  expect(await call("verify_transaction", { txn_id: "txn-test" })).toContain("ABORTED");
  expect(mocks.drop).toHaveBeenCalledWith("txn-test");
  entry.txn.assertions = [{ kind: "reachable", device: "peer" }];
  expect(await call("verify_transaction", { txn_id: "txn-test" })).toContain(
    "PREPARED and VERIFIED",
  );
});

test.each([
  ["COMMITTED", "COMMITTED — every device"],
  ["ABORTED", "ABORTED — the transaction failed"],
  ["PARTIAL", "PARTIAL — NEEDS A HUMAN"],
] as const)("commit reports %s without hiding a partial result", async (state, headline) => {
  mocks.run.mockResolvedValueOnce({ txn: entry.txn, summary: ["peer: outcome"], state });
  expect(await call("commit_transaction", { txn_id: "txn-test" })).toContain(headline);
  expect(mocks.drop).toHaveBeenCalledWith("txn-test");
});

test("abort carries the operator reason through the state machine", async () => {
  mocks.run.mockResolvedValueOnce({
    txn: entry.txn,
    summary: ["peer: rolled back"],
    state: "ABORTED",
  });
  expect(await call("abort_transaction", { txn_id: "txn-test", reason: "cancelled" })).toContain(
    "ABORTED",
  );
  expect(mocks.persist).toHaveBeenCalledOnce();
});
